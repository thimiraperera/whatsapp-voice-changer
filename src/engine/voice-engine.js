/*
 * Builds the Web Audio effects graph (WVC.VoiceEngine).
 *
 * Classic script. Requires src/shared/params.js (global WVC) and src/engine/dsp-core.js
 * (globals WVCDSP + wvcDefineDSP) to be loaded first. Parameter notes are in docs/how-it-works.md.
 *
 *   const engine = await WVC.VoiceEngine.create(ctx, { params, enabled, workletURL });
 *
 * Signal flow (mono after the core):
 *
 *   input ─┬─ core (AudioWorklet | ScriptProcessor) ─ +static noise ─ HP ─ LP ─ bass ─ mid ─ treble
 *          │   ─ drive (dry/wet) ─ ring mod (dry/wet) ─ vibrato ─ tremolo ─ chorus (dry + 3 voices)
 *          │   ─ direct + echo send + reverb send ─ compressor ─ trim ─ × mix ─┐
 *          ├─ dry delay (= wet latency) ─ × (1 - mix) ──────────────────────────┴─ volume ─ limiter
 *          │                                                                      ─ ceiling ─ × enabled ─┐
 *          └─ bypass (undelayed) ─ × !enabled ────────────────────────────────────────────────────────────┴─ output
 */
(function (root) {
  'use strict';

  const WVC = (root.WVC = root.WVC || {});

  /* ------------------------------------------------------------------ *
   * Constants
   * ------------------------------------------------------------------ */

  const PROCESSOR_NAME = 'wvc-voice-core';
  const DSP_KEYS = Object.freeze(['pitch', 'formant', 'algorithm', 'texture', 'robotPitch', 'gate', 'bitDepth', 'downsample']);
  const DSP_KEY_SET = new Set(DSP_KEYS);

  const SCRIPT_PROCESSOR_BUFFER = 1024;
  // Chrome double-buffers ScriptProcessorNode I/O, so its output lags its input by two buffers.
  const SCRIPT_PROCESSOR_LATENCY_BUFFERS = 2;

  const ADD_MODULE_TIMEOUT_MS = 4000;
  const READY_TIMEOUT_MS = 300;
  const PROBE_TIMEOUT_MS = 1500;
  const POLL_MS = 200;

  // AudioParam smoothing time constants (seconds).
  const TAU = 0.03;
  const TAU_FILTER = 0.04;
  const TAU_DELAY = 0.05;
  const TAU_DYNAMICS = 0.05;
  const ENABLE_FADE_S = 0.03;
  // An idle effect branch is disconnected (to save CPU) once its fade has fully settled.
  const LINK_OFF_DELAY_S = 0.6;

  // Web Audio lowpass/highpass "Q" is a resonance in dB; -3.01 dB is a true Butterworth Q of 0.707.
  const BUTTERWORTH_Q_DB = 20 * Math.log10(Math.SQRT1_2);

  const EQ_BASS_HZ = 180;
  const EQ_MID_HZ = 1200;
  const EQ_MID_Q = 0.8;
  const EQ_TREBLE_HZ = 4500;

  const DRIVE_CURVE_SCALE = 4; // curve = tanh(4u), u in [-1, 1]
  const DRIVE_CURVE_POINTS = 2049;
  const DRIVE_MIN_GAIN = 2;
  const DRIVE_MAX_GAIN = 40;
  const DRIVE_FULL_WET = 0.15; // drive amount at which the wet path is fully faded in
  const RING_MAKEUP = Math.SQRT2; // x·sin(ωt) loses 3 dB

  const VIBRATO_BASE_S = 0.006;
  const VIBRATO_MAX_DELAY_S = 0.02;

  const CHORUS_VOICES = Object.freeze([
    { delay: 0.018, rate: 1.0, phase: 0 },
    { delay: 0.024, rate: 1.23, phase: 2.2 },
    { delay: 0.029, rate: 0.81, phase: 4.1 },
  ]);
  const CHORUS_MAX_DELAY_S = 0.05;
  const CHORUS_MAX_DEPTH_S = 0.0035;
  const CHORUS_DEPTH_X_RATE = 0.004; // caps depth·rate so fast chorus rates do not become a warble
  const CHORUS_VOICE_GAIN = 0.5;

  const ECHO_MAX_DELAY_S = 2;
  const ECHO_DAMP_HZ = 3800;
  // echoTime changes never move a live delay line (a gliding delayTime inside a feedback loop plays the
  // tail back pitch-warped, even reversed). Two lines instead: new input is routed to the idle line at the
  // new time while the old line's repeats ring out. Swaps are throttled so slider drags stay clean.
  const ECHO_GATE_TAU = 0.01;
  const ECHO_SWAP_MIN_S = 0.25;

  const REVERB_PREDELAY_S = 0.012;
  const REVERB_ENERGY = 2.5; // wet/dry power ratio at full reverbMix (≈ +4 dB)
  const REVERB_DEBOUNCE_MS = 150;
  const REVERB_XFADE_TAU = 0.06;
  const REVERB_MAX_RETIRING = 3;

  const STATIC_BAND_HZ = 2500;
  const STATIC_BAND_Q = 0.7;
  const STATIC_ENV_HZ = 14;
  const STATIC_SCALE = 6;
  const STATIC_NOISE_SECONDS = 1;

  const COMP_KNEE_DB = 6;
  const COMP_ATTACK_S = 0.005;
  const COMP_RELEASE_S = 0.18;
  const COMP_REF_DB = -15; // typical speech envelope level the makeup is calibrated for
  const COMP_BONUS_DB = 1.5; // extra loudness at full compression

  const LIMITER_THRESHOLD_DB = -1;
  const LIMITER_KNEE_DB = 0;
  const LIMITER_RATIO = 20;
  const LIMITER_ATTACK_S = 0.001;
  const LIMITER_RELEASE_S = 0.08;

  const ANALYSER_FFT = 2048;
  const DRY_MAX_DELAY_S = 1;

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const dbToGain = (db) => Math.pow(10, db / 20);
  const gainToDb = (g) => 20 * Math.log10(g);

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function withTimeout(promise, ms, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function errorMessage(err) {
    if (err && typeof err.message === 'string' && err.message) return err.message;
    return String(err);
  }

  function setMono(node) {
    node.channelCount = 1;
    node.channelCountMode = 'explicit';
    node.channelInterpretation = 'speakers';
    return node;
  }

  function sanitizeLatency(value, sampleRate) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > sampleRate) return 0;
    return Math.round(n);
  }

  /** Deterministic PRNG (mulberry32) so noise buffers and impulse responses are reproducible. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Validate one incoming param value; undefined means "ignore this key". */
  function coerceParam(def, raw) {
    if (def.type === 'select') return def.options.some((o) => o.value === raw) ? raw : undefined;
    let n;
    if (typeof raw === 'number') n = raw;
    else if (typeof raw === 'string' && raw.trim() !== '') n = Number(raw);
    else return undefined;
    if (!Number.isFinite(n)) return undefined;
    return WVC.normalizeValue(def, n);
  }

  function pickDsp(params) {
    const out = {};
    for (const key of DSP_KEYS) if (key in params) out[key] = params[key];
    return out;
  }

  /*
   * DynamicsCompressorNode applies an automatic makeup gain of (1 / curve(0 dBFS))^0.6 (Web Audio spec).
   * This reproduces Chrome's static curve (knee solved with the same 15-step geometric search) so the
   * engine can predict and re-shape that makeup exactly.
   */
  function compressorCurve(thresholdDb, kneeDb, ratio) {
    const linThreshold = dbToGain(thresholdDb);
    const knee = (x, k) => (x < linThreshold ? x : linThreshold + (1 - Math.exp(-k * (x - linThreshold))) / k);
    const slopeAt = (x, k) => {
      if (x < linThreshold) return 1;
      const x2 = x * 1.001;
      return (gainToDb(knee(x2, k)) - gainToDb(knee(x, k))) / (gainToDb(x2) - gainToDb(x));
    };
    const kneeEndDb = thresholdDb + kneeDb;
    const kneeEnd = dbToGain(kneeEndDb);
    let minK = 0.1;
    let maxK = 10000;
    let k = 5;
    for (let i = 0; i < 15; i++) {
      if (slopeAt(kneeEnd, k) < 1 / ratio) maxK = k;
      else minK = k;
      k = Math.sqrt(minK * maxK);
    }
    const yKneeEndDb = gainToDb(knee(kneeEnd, k));
    const saturate = (x) => (x < kneeEnd ? knee(x, k) : dbToGain(yKneeEndDb + (gainToDb(x) - kneeEndDb) / ratio));
    return { saturate, builtinMakeupDb: -0.6 * gainToDb(saturate(1)) };
  }

  function compressSettings(amount) {
    const c = clamp(Number(amount) || 0, 0, 1);
    const threshold = -40 * c;
    const ratio = 1 + 11 * c;
    const curve = compressorCurve(threshold, COMP_KNEE_DB, ratio);
    // Makeup that restores a typical speech level (plus a little loudness) instead of the spec's
    // aggressive automatic makeup, which would lift the noise floor by up to ~21 dB.
    const refGain = dbToGain(COMP_REF_DB);
    const reductionDb = COMP_REF_DB - gainToDb(curve.saturate(refGain));
    const trimDb = reductionDb + COMP_BONUS_DB * c - curve.builtinMakeupDb;
    return { threshold, ratio, trim: dbToGain(trimDb) };
  }

  const LIMITER_TRIM = dbToGain(-compressorCurve(LIMITER_THRESHOLD_DB, LIMITER_KNEE_DB, LIMITER_RATIO).builtinMakeupDb);

  /** Effective tanh drive gain for a drive amount in [0, 1]. */
  function driveGain(amount) {
    return DRIVE_MIN_GAIN * Math.pow(DRIVE_MAX_GAIN / DRIVE_MIN_GAIN, clamp(amount, 0, 1));
  }

  /** Makeup that keeps a typical (-20 dBFS RMS) voice at roughly constant loudness as tanh saturation increases. */
  function driveMakeup(gain) {
    return 0.1 / Math.tanh(0.1 * gain);
  }

  function tanhCurve() {
    const curve = new Float32Array(DRIVE_CURVE_POINTS);
    for (let i = 0; i < DRIVE_CURVE_POINTS; i++) {
      const u = (i / (DRIVE_CURVE_POINTS - 1)) * 2 - 1;
      curve[i] = Math.tanh(DRIVE_CURVE_SCALE * u);
    }
    return curve;
  }

  function absCurve() {
    const n = 1025;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) curve[i] = Math.abs((i / (n - 1)) * 2 - 1);
    return curve;
  }

  /** White noise with sparse crackles, looped under the voice for the "radio static" effect. */
  function makeNoiseBuffer(ctx, seed) {
    const sr = ctx.sampleRate;
    const n = Math.max(128, Math.round(sr * STATIC_NOISE_SECONDS));
    const buffer = ctx.createBuffer(1, n, sr);
    const data = buffer.getChannelData(0);
    const rand = mulberry32(seed);
    for (let i = 0; i < n; i++) data[i] = (rand() * 2 - 1) * 0.8;
    const burst = Math.max(4, Math.round(sr * 0.0015));
    const crackles = Math.round(18 * STATIC_NOISE_SECONDS);
    for (let c = 0; c < crackles; c++) {
      const at = Math.floor(rand() * (n - burst));
      const amp = 0.4 + rand() * 0.6;
      for (let j = 0; j < burst; j++) data[at + j] += amp * Math.exp((-4 * j) / burst) * (rand() * 2 - 1);
    }
    for (let i = 0; i < n; i++) data[i] = clamp(data[i], -1, 1);
    return buffer;
  }

  /**
   * Decaying-noise impulse response: -60 dB at `seconds`, a small pre-delay, and a one-pole
   * low-pass whose cutoff falls over the tail (bright early reflections, darker late reverb).
   * Normalised to a fixed energy so every room size has a similar wet level.
   */
  function makeImpulseResponse(ctx, seconds, seed) {
    const sr = ctx.sampleRate;
    const pre = Math.round(REVERB_PREDELAY_S * sr);
    const n = Math.max(64, Math.round(seconds * sr));
    const buffer = ctx.createBuffer(1, pre + n, sr);
    const data = buffer.getChannelData(0);
    const rand = mulberry32(seed);
    const decay = Math.exp(Math.log(0.001) / n);
    const fStart = Math.min(11000, sr * 0.45);
    const fEnd = Math.min(2200, fStart);
    const fStep = Math.pow(fEnd / fStart, 1 / n);
    const fadeIn = Math.max(1, Math.round(0.002 * sr));
    const w = (2 * Math.PI) / sr;
    let env = 1;
    let fc = fStart;
    let lp = 0;
    // Energy of the equivalent unfiltered (white) response: normalising by it fixes the low-frequency
    // gain regardless of how dark the tail is (the one-pole has unity gain at DC).
    let whiteEnergy = 0;
    for (let i = 0; i < n; i++) {
      const white = rand() * 2 - 1;
      lp += (1 - Math.exp(-w * fc)) * (white - lp);
      const ramp = i < fadeIn ? i / fadeIn : 1;
      data[pre + i] = lp * env * ramp;
      whiteEnergy += (white * env * ramp) ** 2;
      env *= decay;
      fc *= fStep;
    }
    const scale = whiteEnergy > 0 ? Math.sqrt(REVERB_ENERGY / whiteEnergy) : 0;
    for (let i = pre; i < pre + n; i++) data[i] *= scale;
    return buffer;
  }

  /* ------------------------------------------------------------------ *
   * Fixed node latencies (compressor look-ahead, oversampled WaveShaper)
   * ------------------------------------------------------------------ */

  const fixedLatencyCache = new Map(); // sampleRate -> Promise<{ compressor, shaper }>

  function defaultFixedLatencies(sampleRate) {
    // Chrome: 6 ms compressor pre-delay (floored to frames); 4x WaveShaper up/down-sampler FIRs = 192 frames.
    return { compressor: Math.floor(0.006 * sampleRate), shaper: 192 };
  }

  /** Measures the real latencies once per sample rate with a tiny offline impulse render. */
  async function measureFixedLatencies(sampleRate) {
    const fallback = defaultFixedLatencies(sampleRate);
    const Offline = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    if (typeof Offline !== 'function') return fallback;
    const at = 128;
    const length = 2048;
    const octx = new Offline(2, length, sampleRate);
    const impulse = octx.createBuffer(1, length, sampleRate);
    impulse.getChannelData(0)[at] = 0.5;
    const src = octx.createBufferSource();
    src.buffer = impulse;
    const comp = octx.createDynamicsCompressor();
    comp.threshold.value = 0;
    comp.ratio.value = 1;
    comp.knee.value = 0;
    const shaper = octx.createWaveShaper();
    shaper.curve = new Float32Array([-1, 1]);
    shaper.oversample = '4x';
    const merger = octx.createChannelMerger(2);
    src.connect(comp).connect(merger, 0, 0);
    src.connect(shaper).connect(merger, 0, 1);
    merger.connect(octx.destination);
    src.start(0);
    const rendered = await octx.startRendering();
    const peakLag = (channel, otherwise) => {
      const data = rendered.getChannelData(channel);
      let best = 0;
      let index = -1;
      for (let i = 0; i < data.length; i++) {
        const a = Math.abs(data[i]);
        if (a > best) {
          best = a;
          index = i;
        }
      }
      const lag = index - at;
      return best > 1e-3 && lag >= 0 && lag < length - at ? lag : otherwise;
    };
    return { compressor: peakLag(0, fallback.compressor), shaper: peakLag(1, fallback.shaper) };
  }

  function getFixedLatencies(sampleRate) {
    let pending = fixedLatencyCache.get(sampleRate);
    if (!pending) {
      pending = withTimeout(measureFixedLatencies(sampleRate), PROBE_TIMEOUT_MS, 'latency probe').catch(() =>
        defaultFixedLatencies(sampleRate)
      );
      fixedLatencyCache.set(sampleRate, pending);
    }
    return pending;
  }

  /* ------------------------------------------------------------------ *
   * AudioWorklet module loading (once per context)
   * ------------------------------------------------------------------ */

  const workletLoads = new WeakMap(); // BaseAudioContext -> { promise: Promise<boolean>|null, tried: Set<string> }
  let dspSourceCache = null;

  function supportsWorklet(ctx) {
    return (
      typeof root.AudioWorkletNode === 'function' &&
      !!ctx.audioWorklet &&
      typeof ctx.audioWorklet.addModule === 'function'
    );
  }

  function dspModuleSource() {
    if (dspSourceCache) return dspSourceCache;
    const define = root.wvcDefineDSP;
    if (typeof define !== 'function') return null;
    try {
      dspSourceCache = '(' + Function.prototype.toString.call(define) + ')(globalThis);';
    } catch (_) {
      return null;
    }
    return dspSourceCache;
  }

  function isExtensionPage() {
    try {
      return !!root.location && root.location.protocol === 'chrome-extension:';
    } catch (_) {
      return false;
    }
  }

  function moduleAttempts(workletURL) {
    const source = dspModuleSource();
    const blob = source && {
      key: 'blob',
      revoke: true,
      url: () => URL.createObjectURL(new Blob([source], { type: 'text/javascript' })),
    };
    const file = workletURL && { key: 'url:' + workletURL, revoke: false, url: () => workletURL };
    const data = source && {
      key: 'data',
      revoke: false,
      url: () => 'data:text/javascript;charset=utf-8,' + encodeURIComponent(source),
    };
    // MV3 extension pages forbid blob:/data: scripts, so the packaged file goes first there.
    const order = isExtensionPage() && file ? [file, blob, data] : [blob, file, data];
    return order.filter(Boolean);
  }

  async function loadFirstModule(ctx, attempts, tried) {
    for (const attempt of attempts) {
      tried.add(attempt.key);
      let url = null;
      try {
        url = attempt.url();
        await withTimeout(ctx.audioWorklet.addModule(url), ADD_MODULE_TIMEOUT_MS, 'addModule');
        return true;
      } catch (_) {
        // Fall through to the next loading strategy.
      } finally {
        if (attempt.revoke && url) {
          try {
            URL.revokeObjectURL(url);
          } catch (_) {
            /* already revoked */
          }
        }
      }
    }
    return false;
  }

  /** Resolves true when the 'wvc-voice-core' module is loaded in ctx. Never rejects. */
  async function ensureWorkletModule(ctx, workletURL) {
    if (!supportsWorklet(ctx)) return false;
    let entry = workletLoads.get(ctx);
    if (!entry) {
      entry = { promise: null, tried: new Set() };
      workletLoads.set(ctx, entry);
    }
    for (;;) {
      if (entry.promise) {
        const current = entry.promise;
        if (await current) return true;
        if (entry.promise !== current) continue; // a concurrent caller started a newer attempt
      }
      // Only strategies not yet tried on this context (e.g. a workletURL supplied by a later caller).
      const pending = moduleAttempts(workletURL).filter((a) => !entry.tried.has(a.key));
      if (!pending.length) return false;
      entry.promise = loadFirstModule(ctx, pending, entry.tried).catch(() => false);
    }
  }

  function estimateCoreLatency(sampleRate, params) {
    const DSP = root.WVCDSP;
    if (!DSP || typeof DSP.VoiceCore !== 'function') return 0;
    try {
      return sanitizeLatency(new DSP.VoiceCore(sampleRate, { ...params }).latencySamples, sampleRate);
    } catch (_) {
      return 0;
    }
  }

  // ScriptProcessorNodes can be garbage-collected (and fall silent) when only the audio graph
  // references them; live ones are pinned here until their engine is destroyed.
  const liveScriptProcessors = new Set();

  const CONSTRUCT = Symbol('VoiceEngine.construct');
  let engineSeed = 0x5eed;

  /* ------------------------------------------------------------------ *
   * VoiceEngine
   * ------------------------------------------------------------------ */

  class VoiceEngine {
    #ctx;
    #sr;
    #params;
    #enabled;
    #fixed;
    #destroyed = false;
    #live = false;
    #lastError = null;
    #loggedErrors = new Set();
    #seed;

    #nodes = [];
    #sources = [];
    #links = [];
    #pollTimer = null;
    #reverbTimer = null;
    #echoTimer = null;
    #echoLastSwap = -Infinity;
    #readyTimer = null;
    #resolveReady = null;

    #processorType = null;
    #worklet = null;
    #scriptNode = null;
    #scriptCore = null;
    #scriptFailed = false;
    #scriptLastLatency = -1;
    #coreLatency = 0;
    #scriptExtra = 0;
    #vibratoBaseSamples;

    #reverb = null;
    #reverbRetiring = [];

    #n = {}; // graph nodes by role

    constructor(token, ctx, params, enabled, fixed) {
      if (token !== CONSTRUCT) throw new TypeError('Use WVC.VoiceEngine.create(audioContext, options)');
      this.#ctx = ctx;
      this.#sr = ctx.sampleRate;
      this.#params = params;
      this.#enabled = enabled;
      this.#fixed = fixed;
      this.#seed = engineSeed;
      engineSeed = (engineSeed + 0x9e37) >>> 0;
      // Integer number of frames so the neutral vibrato delay is an exact (non-interpolated) delay.
      this.#vibratoBaseSamples = Math.max(1, Math.round(VIBRATO_BASE_S * this.#sr));
      this.#build();
    }

    /**
     * Build an engine for `ctx` (AudioContext or OfflineAudioContext).
     * opts: { params, enabled = true, workletURL = null, _forceScriptProcessor = false }
     * `_forceScriptProcessor` is TEST-ONLY: skips the AudioWorklet and runs the core on a ScriptProcessorNode.
     * Never rejects because of the worklet; rejects only if no DSP core can be created at all.
     */
    static async create(ctx, opts) {
      if (!ctx || typeof ctx.createGain !== 'function' || !(ctx.sampleRate > 0)) {
        throw new TypeError('WVC.VoiceEngine.create: an AudioContext or OfflineAudioContext is required');
      }
      if (typeof WVC.normalizeParams !== 'function' || !WVC.PARAM_MAP) {
        throw new Error('WVC.VoiceEngine: src/shared/params.js must be loaded before voice-engine.js');
      }
      if (ctx.state === 'closed') throw new Error('WVC.VoiceEngine.create: the AudioContext is closed');

      const o = opts && typeof opts === 'object' ? opts : {};
      const params = WVC.normalizeParams(o.params);
      const enabled = o.enabled !== false;
      const workletURL = typeof o.workletURL === 'string' && o.workletURL ? o.workletURL : null;
      const forceScript = o._forceScriptProcessor === true;

      const [fixed, workletLoaded] = await Promise.all([
        getFixedLatencies(ctx.sampleRate),
        forceScript ? false : ensureWorkletModule(ctx, workletURL),
      ]);
      if (ctx.state === 'closed') throw new Error('WVC.VoiceEngine.create: the AudioContext was closed while loading');

      const engine = new VoiceEngine(CONSTRUCT, ctx, params, enabled, fixed);
      try {
        await engine.#attachCore(workletLoaded);
        if (ctx.state === 'closed') throw new Error('WVC.VoiceEngine.create: the AudioContext was closed while starting');
      } catch (err) {
        engine.destroy();
        throw err;
      }
      return engine;
    }

    /* ---------------- public surface ---------------- */

    get input() {
      return this.#n.input;
    }

    get output() {
      return this.#n.output;
    }

    get inputAnalyser() {
      return this.#n.inputAnalyser;
    }

    get outputAnalyser() {
      return this.#n.outputAnalyser;
    }

    /** 'worklet' | 'script-processor' (null only if the DSP core failed at runtime and was bypassed). */
    get processorType() {
      return this.#processorType;
    }

    /** Total latency of the processed (enabled) path, in seconds. */
    get latency() {
      return (this.#wetLatencySamples() + this.#fixed.compressor) / this.#sr;
    }

    get context() {
      return this.#ctx;
    }

    get enabled() {
      return this.#enabled;
    }

    get params() {
      return { ...this.#params };
    }

    get destroyed() {
      return this.#destroyed;
    }

    /** Last runtime error message (worklet/processor failures, graph errors) or null. */
    get lastError() {
      return this.#lastError;
    }

    /** Live, click-free update. Both keys optional; `params` may be partial. Never throws. */
    update(opts) {
      if (this.#destroyed || !opts || typeof opts !== 'object') return;
      try {
        if (opts.params && typeof opts.params === 'object') this.#updateParams(opts.params);
        if (typeof opts.enabled === 'boolean' && opts.enabled !== this.#enabled) {
          this.#enabled = opts.enabled;
          this.#applyEnabled(false);
        }
      } catch (err) {
        this.#reportError(err);
      }
    }

    /** Disconnects everything, stops sources, disposes the worklet. Idempotent. */
    destroy() {
      if (this.#destroyed) return;
      this.#destroyed = true;
      clearTimeout(this.#pollTimer);
      clearTimeout(this.#reverbTimer);
      clearTimeout(this.#echoTimer);
      clearTimeout(this.#readyTimer);
      this.#pollTimer = this.#reverbTimer = this.#echoTimer = this.#readyTimer = null;
      if (this.#resolveReady) this.#resolveReady(false);
      this.#teardownWorklet();
      this.#teardownScriptProcessor();
      for (const source of this.#sources) {
        try {
          source.stop();
        } catch (_) {
          /* never started or already stopped */
        }
      }
      if (this.#reverb) this.#disposeReverb(this.#reverb);
      for (const r of this.#reverbRetiring) this.#disposeReverb(r);
      this.#reverb = null;
      this.#reverbRetiring = [];
      for (const node of this.#nodes) {
        try {
          node.disconnect();
        } catch (_) {
          /* already disconnected */
        }
      }
      for (const link of this.#links) link.on = false;
      this.#nodes = [];
      this.#sources = [];
    }

    /* ---------------- graph construction ---------------- */

    #build() {
      const ctx = this.#ctx;
      const n = this.#n;
      const nyquist = this.#sr / 2;
      const keep = (node) => {
        this.#nodes.push(node);
        return node;
      };
      const gain = (value, mono) => {
        const g = keep(ctx.createGain());
        g.gain.value = value;
        if (mono) setMono(g);
        return g;
      };
      const biquad = (type, frequency, q) => {
        const f = keep(ctx.createBiquadFilter());
        f.type = type;
        f.frequency.value = frequency;
        if (q !== undefined) f.Q.value = q;
        return f;
      };
      const delay = (max, time) => {
        const d = keep(ctx.createDelay(max));
        d.delayTime.value = time;
        return d;
      };
      const oscillator = (frequency, phase) => {
        const o = keep(ctx.createOscillator());
        if (phase) {
          // sin(ωt + φ) = sin φ·cos ωt + cos φ·sin ωt
          const real = new Float32Array([0, Math.sin(phase)]);
          const imag = new Float32Array([0, Math.cos(phase)]);
          o.setPeriodicWave(ctx.createPeriodicWave(real, imag, { disableNormalization: true }));
        } else {
          o.type = 'sine';
        }
        o.frequency.value = frequency;
        this.#sources.push(o);
        return o;
      };
      const compressor = (threshold, knee, ratio, attack, release) => {
        const c = keep(ctx.createDynamicsCompressor());
        c.threshold.value = threshold;
        c.knee.value = knee;
        c.ratio.value = ratio;
        c.attack.value = attack;
        c.release.value = release;
        return c;
      };
      const link = (from, to) => {
        const l = { from, to, on: false, offAt: Infinity };
        this.#links.push(l);
        return l;
      };
      const chain = (...nodes) => {
        for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
      };

      // I/O + analysers
      n.input = gain(1, true);
      n.output = gain(1, true);
      n.inputAnalyser = keep(ctx.createAnalyser());
      n.inputAnalyser.fftSize = ANALYSER_FFT;
      n.outputAnalyser = keep(ctx.createAnalyser());
      n.outputAnalyser.fftSize = ANALYSER_FFT;
      n.input.connect(n.inputAnalyser);
      n.output.connect(n.outputAnalyser);

      n.coreOut = gain(1, true);

      // Static noise: looping noise -> bandpass -> VCA whose gain follows the voice envelope.
      n.noiseSource = keep(ctx.createBufferSource());
      n.noiseSource.buffer = makeNoiseBuffer(ctx, this.#seed);
      n.noiseSource.loop = true;
      this.#sources.push(n.noiseSource);
      n.noiseBand = biquad('bandpass', STATIC_BAND_HZ, STATIC_BAND_Q);
      n.noiseVca = gain(0, true);
      n.envRectifier = keep(ctx.createWaveShaper());
      n.envRectifier.curve = absCurve();
      n.envSmoother = biquad('lowpass', STATIC_ENV_HZ, BUTTERWORTH_Q_DB);
      n.staticAmount = gain(0);
      chain(n.noiseBand, n.noiseVca);
      chain(n.envRectifier, n.envSmoother, n.staticAmount);
      n.staticAmount.connect(n.noiseVca.gain);
      n.staticSum = gain(1, true);
      n.coreOut.connect(n.staticSum);
      n.noiseVca.connect(n.staticSum);
      n.noiseLink = link(n.noiseSource, n.noiseBand);
      n.envLink = link(n.coreOut, n.envRectifier);

      // Filters + EQ. Highpass at 0 Hz and lowpass at Nyquist are exact passthroughs.
      n.highpass = biquad('highpass', 0, BUTTERWORTH_Q_DB);
      n.lowpass = biquad('lowpass', nyquist, BUTTERWORTH_Q_DB);
      n.bass = biquad('lowshelf', EQ_BASS_HZ);
      n.mid = biquad('peaking', EQ_MID_HZ, EQ_MID_Q);
      n.treble = biquad('highshelf', EQ_TREBLE_HZ);
      chain(n.staticSum, n.highpass, n.lowpass, n.bass, n.mid, n.treble);

      // Drive: the dry branch is delayed by the oversampler latency so the crossfade never comb-filters.
      const shaperDelay = this.#fixed.shaper / this.#sr;
      n.driveDryDelay = delay(Math.max(0.01, shaperDelay * 2), shaperDelay);
      n.driveDry = gain(1);
      n.drivePre = gain(1);
      n.shaper = keep(ctx.createWaveShaper());
      n.shaper.curve = tanhCurve();
      n.shaper.oversample = '4x';
      n.driveWet = gain(0);
      n.driveSum = gain(1, true);
      chain(n.treble, n.driveDryDelay, n.driveDry, n.driveSum);
      chain(n.drivePre, n.shaper, n.driveWet, n.driveSum);
      n.driveLink = link(n.treble, n.drivePre);

      // Ring modulator: the oscillator is the VCA gain, so out = in · sin(2πft).
      n.ringDry = gain(1);
      n.ringVca = gain(0);
      n.ringWet = gain(0);
      n.ringSum = gain(1, true);
      n.ringOsc = oscillator(this.#params.ringFreq);
      n.ringOsc.connect(n.ringVca.gain);
      chain(n.driveSum, n.ringDry, n.ringSum);
      chain(n.ringVca, n.ringWet, n.ringSum);
      n.ringLink = link(n.driveSum, n.ringVca);

      // Vibrato: constant base delay (constant latency) + LFO modulation of delayTime.
      n.vibratoDelay = delay(VIBRATO_MAX_DELAY_S, this.#vibratoBaseSamples / this.#sr);
      n.vibratoOsc = oscillator(this.#params.vibratoRate);
      n.vibratoDepth = gain(0);
      n.vibratoOsc.connect(n.vibratoDepth);
      n.ringSum.connect(n.vibratoDelay);
      n.vibratoLink = link(n.vibratoDepth, n.vibratoDelay.delayTime);

      // Tremolo: gain = (1 - d/2) + (-d/2)·sin
      n.tremoloVca = gain(1, true);
      n.tremoloOsc = oscillator(this.#params.tremoloRate);
      n.tremoloDepth = gain(0);
      n.tremoloOsc.connect(n.tremoloDepth);
      n.vibratoDelay.connect(n.tremoloVca);
      n.tremoloLink = link(n.tremoloDepth, n.tremoloVca.gain);

      // Chorus: dry + three LFO-modulated short delays with detuned rates and spread phases.
      n.chorusDry = gain(1);
      n.chorusSend = gain(0);
      n.chorusSum = gain(1, true);
      chain(n.tremoloVca, n.chorusDry, n.chorusSum);
      n.chorusVoices = CHORUS_VOICES.map((voice) => {
        const d = delay(CHORUS_MAX_DELAY_S, voice.delay);
        const lfo = oscillator(this.#params.chorusRate * voice.rate, voice.phase);
        const depth = gain(0);
        lfo.connect(depth);
        depth.connect(d.delayTime);
        chain(n.chorusSend, d, n.chorusSum);
        return { voice, lfo, depth };
      });
      n.chorusLink = link(n.tremoloVca, n.chorusSend);

      // Space: direct + echo send (damped feedback delay) + reverb send (convolvers built lazily).
      n.spaceSum = gain(1, true);
      n.chorusSum.connect(n.spaceSum);
      n.echoSend = gain(0);
      n.echoLines = [0, 1].map((i) => {
        const gate = gain(i === 0 ? 1 : 0);
        const d = delay(ECHO_MAX_DELAY_S, this.#params.echoTime);
        const damp = biquad('lowpass', ECHO_DAMP_HZ, BUTTERWORTH_Q_DB);
        const feedback = gain(0);
        chain(n.echoSend, gate, d, damp, n.spaceSum);
        chain(damp, feedback, d);
        return { gate, delay: d, feedback, time: this.#params.echoTime };
      });
      n.echoActive = 0;
      n.echoLink = link(n.chorusSum, n.echoSend);
      n.reverbSend = gain(0, true);
      n.reverbLink = link(n.chorusSum, n.reverbSend);

      // Dynamics
      n.compressor = compressor(0, COMP_KNEE_DB, 1, COMP_ATTACK_S, COMP_RELEASE_S);
      n.compTrim = gain(1);
      chain(n.spaceSum, n.compressor, n.compTrim);

      // Wet / latency-matched dry blend
      n.wetMix = gain(1);
      n.dryDelay = delay(DRY_MAX_DELAY_S, 0);
      n.dryMix = gain(0);
      n.blend = gain(1, true);
      n.volume = gain(1);
      chain(n.compTrim, n.wetMix, n.blend);
      chain(n.input, n.dryDelay, n.dryMix, n.blend);
      n.blend.connect(n.volume);

      // Safety limiter (its automatic makeup is cancelled by limiterTrim) + hard ceiling at ±1.
      n.limiter = compressor(LIMITER_THRESHOLD_DB, LIMITER_KNEE_DB, LIMITER_RATIO, LIMITER_ATTACK_S, LIMITER_RELEASE_S);
      n.limiterTrim = gain(LIMITER_TRIM);
      n.ceiling = keep(ctx.createWaveShaper());
      n.ceiling.curve = new Float32Array([-1, 1]);
      n.wetEnable = gain(this.#enabled ? 1 : 0);
      n.bypass = gain(this.#enabled ? 0 : 1, true);
      chain(n.volume, n.limiter, n.limiterTrim, n.ceiling, n.wetEnable, n.output);
      chain(n.input, n.bypass, n.output);

      const t = ctx.currentTime;
      for (const source of this.#sources) source.start(t);

      for (const def of WVC.PARAMS) {
        if (!DSP_KEY_SET.has(def.id)) this.#applyParam(def.id, true);
      }
      this.#applyEnabled(true);
    }

    /* ---------------- DSP core ---------------- */

    async #attachCore(workletLoaded) {
      if (workletLoaded) {
        try {
          this.#attachWorklet();
        } catch (err) {
          this.#teardownWorklet();
          this.#reportError(err, true);
        }
      }
      if (!this.#worklet) this.#attachScriptProcessor(); // throws only if no core can run at all
      this.#updateDryDelay(true);

      if (this.#worklet) {
        // Wait briefly for the processor's 'ready' (authoritative latency; proves the processor
        // constructed). A crash in its constructor swaps in the ScriptProcessor core meanwhile.
        await new Promise((resolve) => {
          this.#resolveReady = (value) => {
            this.#resolveReady = null;
            clearTimeout(this.#readyTimer);
            this.#readyTimer = null;
            resolve(value);
          };
          this.#readyTimer = setTimeout(() => this.#resolveReady && this.#resolveReady(false), READY_TIMEOUT_MS);
        });
      }
      this.#live = true;
    }

    #attachWorklet() {
      const node = new AudioWorkletNode(this.#ctx, PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { params: { ...this.#params } },
      });
      this.#worklet = node;
      node.port.onmessage = (ev) => this.#onWorkletMessage(ev.data);
      node.onprocessorerror = () => this.#onProcessorError();
      this.#processorType = 'worklet';
      this.#scriptExtra = 0;
      this.#coreLatency = estimateCoreLatency(this.#sr, this.#params);
      this.#n.input.connect(node);
      node.connect(this.#n.coreOut);
    }

    #onWorkletMessage(msg) {
      if (this.#destroyed || !msg || typeof msg !== 'object') return;
      if (msg.type === 'ready' || msg.type === 'latency') {
        this.#setCoreLatency(msg.latencySamples);
        if (msg.type === 'ready' && this.#resolveReady) this.#resolveReady(true);
      } else if (msg.type === 'error') {
        this.#reportError('DSP processor error: ' + String(msg.message || 'unknown'));
        // After an error the processor passes audio through undelayed without announcing a new latency,
        // which would leave the dry path (mix < 100 %) misaligned. Hand over to the main-thread core.
        this.#onProcessorError();
      }
    }

    #onProcessorError() {
      if (this.#destroyed || !this.#worklet) return;
      this.#reportError('The voice processor stopped unexpectedly; switched to the main-thread fallback');
      this.#teardownWorklet();
      try {
        this.#attachScriptProcessor();
      } catch (err) {
        // Last resort: keep the call alive with the unshifted voice through the rest of the chain.
        this.#reportError(err);
        this.#processorType = null;
        this.#coreLatency = 0;
        this.#scriptExtra = 0;
        try {
          this.#n.input.connect(this.#n.coreOut);
        } catch (_) {
          /* context closed */
        }
      }
      this.#updateDryDelay(!this.#live);
      if (this.#resolveReady) this.#resolveReady(false);
    }

    #teardownWorklet() {
      const node = this.#worklet;
      if (!node) return;
      this.#worklet = null;
      try {
        node.port.postMessage({ type: 'dispose' });
      } catch (_) {
        /* port closed */
      }
      try {
        node.port.onmessage = null;
        node.port.close();
      } catch (_) {
        /* port closed */
      }
      node.onprocessorerror = null;
      try {
        this.#n.input.disconnect(node);
      } catch (_) {
        /* not connected */
      }
      try {
        node.disconnect();
      } catch (_) {
        /* not connected */
      }
    }

    #attachScriptProcessor() {
      const DSP = root.WVCDSP;
      if (!DSP || typeof DSP.VoiceCore !== 'function') {
        throw new Error('WVC.VoiceEngine: no DSP core available (AudioWorklet failed and WVCDSP.VoiceCore is missing)');
      }
      const core = new DSP.VoiceCore(this.#sr, { ...this.#params });
      const node = this.#ctx.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 1, 1);
      node.onaudioprocess = (ev) => this.#processScript(ev);
      this.#scriptNode = node;
      this.#scriptCore = core;
      this.#scriptFailed = false;
      liveScriptProcessors.add(node);
      this.#processorType = 'script-processor';
      this.#scriptExtra = SCRIPT_PROCESSOR_BUFFER * SCRIPT_PROCESSOR_LATENCY_BUFFERS;
      this.#scriptLastLatency = core.latencySamples;
      this.#coreLatency = sanitizeLatency(core.latencySamples, this.#sr);
      this.#n.input.connect(node);
      node.connect(this.#n.coreOut);
    }

    #processScript(ev) {
      const out = ev.outputBuffer.getChannelData(0);
      const core = this.#scriptCore;
      if (!core || this.#destroyed) {
        out.fill(0);
        return;
      }
      const inp = ev.inputBuffer.getChannelData(0);
      if (this.#scriptFailed) {
        out.set(inp);
        return;
      }
      try {
        core.process(inp, out);
      } catch (err) {
        this.#scriptFailed = true;
        out.set(inp);
        this.#reportError(err);
        this.#setCoreLatency(0);
        return;
      }
      const latency = core.latencySamples;
      if (latency !== this.#scriptLastLatency) {
        this.#scriptLastLatency = latency;
        this.#setCoreLatency(latency);
      }
    }

    #teardownScriptProcessor() {
      const node = this.#scriptNode;
      if (!node) return;
      this.#scriptNode = null;
      this.#scriptCore = null;
      node.onaudioprocess = null;
      liveScriptProcessors.delete(node);
      try {
        this.#n.input.disconnect(node);
      } catch (_) {
        /* not connected */
      }
      try {
        node.disconnect();
      } catch (_) {
        /* not connected */
      }
    }

    #sendDsp(patch) {
      if (this.#worklet) {
        try {
          this.#worklet.port.postMessage({ type: 'params', params: patch });
        } catch (err) {
          this.#reportError(err);
        }
      } else if (this.#scriptCore && !this.#scriptFailed) {
        try {
          this.#scriptCore.setParams(patch);
          const latency = this.#scriptCore.latencySamples;
          if (latency !== this.#scriptLastLatency) {
            this.#scriptLastLatency = latency;
            this.#setCoreLatency(latency);
          }
        } catch (err) {
          this.#reportError(err);
        }
      }
    }

    #setCoreLatency(samples) {
      const value = sanitizeLatency(samples, this.#sr);
      if (value === this.#coreLatency) return;
      this.#coreLatency = value;
      this.#updateDryDelay(!this.#live);
    }

    /** Latency from input to the dry/wet blend point, in frames. */
    #wetLatencySamples() {
      return (
        this.#coreLatency +
        this.#scriptExtra +
        this.#vibratoBaseSamples +
        this.#fixed.shaper +
        this.#fixed.compressor
      );
    }

    #updateDryDelay(immediate) {
      const seconds = Math.min(DRY_MAX_DELAY_S, this.#wetLatencySamples() / this.#sr);
      this.#set(this.#n.dryDelay.delayTime, seconds, immediate, TAU_DELAY);
    }

    /* ---------------- parameters ---------------- */

    #updateParams(patch) {
      const next = { ...this.#params };
      const changed = [];
      for (const id of Object.keys(patch)) {
        if (!Object.prototype.hasOwnProperty.call(WVC.PARAM_MAP, id)) continue;
        const value = coerceParam(WVC.PARAM_MAP[id], patch[id]);
        if (value === undefined || value === next[id]) continue;
        next[id] = value;
        changed.push(id);
      }
      if (!changed.length) return;
      this.#params = next;
      const dsp = {};
      let dspChanged = false;
      for (const id of changed) {
        if (DSP_KEY_SET.has(id)) {
          dsp[id] = next[id];
          dspChanged = true;
          continue;
        }
        try {
          this.#applyParam(id, false);
        } catch (err) {
          this.#reportError(err);
        }
      }
      if (dspChanged) this.#sendDsp(dsp);
    }

    #applyParam(id, immediate) {
      const n = this.#n;
      const p = this.#params;
      const v = p[id];
      switch (id) {
        case 'highpass':
          this.#set(n.highpass.frequency, v <= WVC.PARAM_MAP.highpass.min ? 0 : v, immediate, TAU_FILTER);
          break;
        case 'lowpass': {
          const nyquist = this.#sr / 2;
          this.#set(n.lowpass.frequency, v >= WVC.PARAM_MAP.lowpass.max ? nyquist : Math.min(v, nyquist), immediate, TAU_FILTER);
          break;
        }
        case 'bass':
          this.#set(n.bass.gain, v, immediate);
          break;
        case 'mid':
          this.#set(n.mid.gain, v, immediate);
          break;
        case 'treble':
          this.#set(n.treble.gain, v, immediate);
          break;
        case 'drive': {
          const wet = clamp(v / DRIVE_FULL_WET, 0, 1);
          const g = driveGain(v);
          this.#set(n.drivePre.gain, g / DRIVE_CURVE_SCALE, immediate);
          this.#set(n.driveWet.gain, wet * driveMakeup(g), immediate);
          this.#set(n.driveDry.gain, 1 - wet, immediate);
          this.#want(n.driveLink, v > 0, immediate);
          break;
        }
        case 'ringMix':
          // Equal-power: the ring-modulated sidebands are uncorrelated with the dry voice.
          this.#set(n.ringDry.gain, v >= 1 ? 0 : Math.cos((v * Math.PI) / 2), immediate);
          this.#set(n.ringWet.gain, Math.sin((v * Math.PI) / 2) * RING_MAKEUP, immediate);
          this.#want(n.ringLink, v > 0, immediate);
          break;
        case 'ringFreq':
          this.#set(n.ringOsc.frequency, v, immediate);
          break;
        case 'vibratoDepth':
          this.#set(n.vibratoDepth.gain, v / 1000, immediate);
          this.#want(n.vibratoLink, v > 0, immediate);
          break;
        case 'vibratoRate':
          this.#set(n.vibratoOsc.frequency, v, immediate);
          break;
        case 'tremoloDepth':
          this.#set(n.tremoloVca.gain, 1 - v / 2, immediate);
          this.#set(n.tremoloDepth.gain, -v / 2, immediate);
          this.#want(n.tremoloLink, v > 0, immediate);
          break;
        case 'tremoloRate':
          this.#set(n.tremoloOsc.frequency, v, immediate);
          break;
        case 'chorusMix':
          this.#set(n.chorusDry.gain, 1 - 0.5 * v, immediate);
          this.#set(n.chorusSend.gain, CHORUS_VOICE_GAIN * v, immediate);
          this.#want(n.chorusLink, v > 0, immediate);
          break;
        case 'chorusRate':
          for (const { voice, lfo, depth } of n.chorusVoices) {
            const rate = v * voice.rate;
            this.#set(lfo.frequency, rate, immediate);
            this.#set(depth.gain, Math.min(CHORUS_MAX_DEPTH_S, CHORUS_DEPTH_X_RATE / rate), immediate);
          }
          break;
        case 'echoMix':
          this.#set(n.echoSend.gain, v, immediate);
          this.#want(n.echoLink, v > 0, immediate);
          break;
        case 'echoTime':
          this.#applyEchoTime(immediate);
          break;
        case 'echoFeedback':
          for (const line of n.echoLines) this.#set(line.feedback.gain, clamp(v, 0, 0.95), immediate);
          break;
        case 'reverbMix':
          this.#applyReverbMix(immediate);
          break;
        case 'reverbSize':
          this.#applyReverbSize(immediate);
          break;
        case 'staticNoise':
          this.#set(n.staticAmount.gain, v * STATIC_SCALE, immediate);
          this.#want(n.noiseLink, v > 0, immediate);
          this.#want(n.envLink, v > 0, immediate);
          break;
        case 'compress': {
          const s = compressSettings(v);
          this.#set(n.compressor.threshold, s.threshold, immediate, TAU_DYNAMICS);
          this.#set(n.compressor.ratio, s.ratio, immediate, TAU_DYNAMICS);
          this.#set(n.compTrim.gain, s.trim, immediate, TAU_DYNAMICS);
          break;
        }
        case 'mix':
          this.#set(n.wetMix.gain, v, immediate);
          this.#set(n.dryMix.gain, 1 - v, immediate);
          break;
        case 'volume':
          this.#set(n.volume.gain, dbToGain(v), immediate);
          break;
        default:
          break; // DSP keys are forwarded to the core, not applied here.
      }
    }

    #applyEnabled(immediate) {
      const on = this.#enabled;
      this.#fade(this.#n.wetEnable.gain, on ? 1 : 0, immediate);
      this.#fade(this.#n.bypass.gain, on ? 0 : 1, immediate);
    }

    /** Smoothly move an AudioParam (setTargetAtTime), or jump when `immediate`. */
    #set(param, value, immediate, tau = TAU) {
      if (!param || !Number.isFinite(value)) return;
      const t = this.#ctx.currentTime;
      try {
        param.cancelScheduledValues(t);
        if (immediate) param.setValueAtTime(value, t);
        else param.setTargetAtTime(value, t, tau);
      } catch (_) {
        try {
          param.value = value;
        } catch (__) {
          /* context closed */
        }
      }
    }

    /** Linear crossfade that lands exactly on `value` (used for the enable/bypass switch). */
    #fade(param, value, immediate) {
      const t = this.#ctx.currentTime;
      try {
        if (immediate) {
          param.cancelScheduledValues(t);
          param.setValueAtTime(value, t);
          return;
        }
        if (typeof param.cancelAndHoldAtTime === 'function') {
          param.cancelAndHoldAtTime(t);
        } else {
          const current = param.value;
          param.cancelScheduledValues(t);
          param.setValueAtTime(current, t);
        }
        param.linearRampToValueAtTime(value, t + ENABLE_FADE_S);
      } catch (_) {
        try {
          param.value = value;
        } catch (__) {
          /* context closed */
        }
      }
    }

    /* ---------------- idle-branch links ---------------- */

    /** Connect an effect branch now, or disconnect it once its (already scheduled) fade-out settled. */
    #want(link, active, immediate) {
      if (active) {
        link.offAt = Infinity;
        if (!link.on) {
          try {
            link.from.connect(link.to);
            link.on = true;
          } catch (err) {
            this.#reportError(err);
          }
        }
      } else if (link.on) {
        if (immediate) {
          this.#cut(link);
        } else {
          link.offAt = this.#ctx.currentTime + LINK_OFF_DELAY_S;
          this.#schedulePoll();
        }
      }
    }

    #cut(link) {
      try {
        link.from.disconnect(link.to);
      } catch (_) {
        /* not connected */
      }
      link.on = false;
      link.offAt = Infinity;
    }

    #schedulePoll() {
      if (this.#pollTimer || this.#destroyed) return;
      this.#pollTimer = setTimeout(() => {
        this.#pollTimer = null;
        this.#poll();
      }, POLL_MS);
    }

    // Deadlines are in context time (not wall-clock) so offline renders and suspended contexts stay correct.
    #poll() {
      if (this.#destroyed || this.#ctx.state === 'closed') return;
      const now = this.#ctx.currentTime;
      let pending = false;
      for (const link of this.#links) {
        if (!link.on || link.offAt === Infinity) continue;
        if (now >= link.offAt) this.#cut(link);
        else pending = true;
      }
      if (this.#reverbRetiring.length) {
        this.#reverbRetiring = this.#reverbRetiring.filter((r) => {
          if (now >= r.retireAt) {
            this.#disposeReverb(r);
            return false;
          }
          pending = true;
          return true;
        });
      }
      if (pending) this.#schedulePoll();
    }

    /* ---------------- echo ---------------- */

    #applyEchoTime(immediate) {
      const n = this.#n;
      const time = clamp(this.#params.echoTime, 0.005, ECHO_MAX_DELAY_S);
      clearTimeout(this.#echoTimer);
      this.#echoTimer = null;
      if (immediate) {
        for (const line of n.echoLines) {
          this.#set(line.delay.delayTime, time, true);
          line.time = time;
        }
        return;
      }
      if (n.echoLines[n.echoActive].time === time) return;
      const wait = (this.#echoLastSwap + ECHO_SWAP_MIN_S - this.#ctx.currentTime) * 1000;
      if (wait > 0 && this.#ctx.state === 'running') {
        this.#echoTimer = setTimeout(() => {
          this.#echoTimer = null;
          if (!this.#destroyed) this.#swapEcho(clamp(this.#params.echoTime, 0.005, ECHO_MAX_DELAY_S));
        }, Math.min(1000, wait + 10));
        return;
      }
      this.#swapEcho(time);
    }

    /** Route new input to the idle echo line (set to `time`) while the active line's repeats ring out. */
    #swapEcho(time) {
      const n = this.#n;
      const from = n.echoLines[n.echoActive];
      if (from.time === time) return;
      n.echoActive = 1 - n.echoActive;
      const to = n.echoLines[n.echoActive];
      if (to.time !== time) {
        // The idle line only holds a decaying tail (or silence): jump, never glide.
        this.#set(to.delay.delayTime, time, true);
        to.time = time;
      }
      this.#set(from.gate.gain, 0, false, ECHO_GATE_TAU);
      this.#set(to.gate.gain, 1, false, ECHO_GATE_TAU);
      this.#echoLastSwap = this.#ctx.currentTime;
    }

    /* ---------------- reverb ---------------- */

    #applyReverbMix(immediate) {
      const mix = this.#params.reverbMix;
      if (mix > 0) {
        if (!this.#reverb) this.#buildReverb(true);
        else if (this.#reverb.size !== this.#params.reverbSize && !this.#reverbTimer) this.#buildReverb(false);
        this.#want(this.#n.reverbLink, true, immediate);
      } else {
        this.#want(this.#n.reverbLink, false, immediate);
      }
      this.#set(this.#n.reverbSend.gain, mix, immediate);
    }

    #applyReverbSize(immediate) {
      // With the reverb off nothing is generated; the IR is (re)built when reverbMix becomes > 0.
      if (this.#params.reverbMix <= 0) return;
      if (this.#reverb && this.#reverb.size === this.#params.reverbSize) return;
      if (immediate || !this.#reverb) {
        this.#buildReverb(!this.#reverb);
        return;
      }
      clearTimeout(this.#reverbTimer);
      this.#reverbTimer = setTimeout(() => {
        this.#reverbTimer = null;
        if (this.#destroyed || this.#params.reverbMix <= 0) return;
        if (!this.#reverb || this.#reverb.size !== this.#params.reverbSize) this.#buildReverb(!this.#reverb);
      }, REVERB_DEBOUNCE_MS);
    }

    /** New convolver for the current reverbSize; crossfades from the previous one unless `instant`. */
    #buildReverb(instant) {
      const ctx = this.#ctx;
      const size = this.#params.reverbSize;
      let conv = null;
      let out = null;
      try {
        this.#seed = (this.#seed + 1) >>> 0;
        const buffer = makeImpulseResponse(ctx, size, this.#seed);
        conv = ctx.createConvolver();
        conv.normalize = false;
        conv.buffer = buffer;
        out = setMono(ctx.createGain());
        out.gain.value = instant ? 1 : 0;
        this.#n.reverbSend.connect(conv);
        conv.connect(out);
        out.connect(this.#n.spaceSum);
      } catch (err) {
        this.#reportError(err);
        if (conv || out) this.#disposeReverb({ conv, gain: out });
        return;
      }
      const previous = this.#reverb;
      this.#reverb = { conv, gain: out, size, retireAt: Infinity };
      if (!instant) this.#set(out.gain, 1, false, REVERB_XFADE_TAU);
      if (!previous) return;
      if (instant) {
        this.#disposeReverb(previous);
        return;
      }
      this.#set(previous.gain.gain, 0, false, REVERB_XFADE_TAU);
      previous.retireAt = ctx.currentTime + 12 * REVERB_XFADE_TAU;
      this.#reverbRetiring.push(previous);
      while (this.#reverbRetiring.length > REVERB_MAX_RETIRING) this.#disposeReverb(this.#reverbRetiring.shift());
      this.#schedulePoll();
    }

    #disposeReverb(r) {
      if (!r) return;
      if (r.conv) {
        try {
          this.#n.reverbSend.disconnect(r.conv);
        } catch (_) {
          /* not connected */
        }
        try {
          r.conv.disconnect();
        } catch (_) {
          /* not connected */
        }
        try {
          r.conv.buffer = null;
        } catch (_) {
          /* some implementations refuse to clear the buffer */
        }
      }
      if (r.gain) {
        try {
          r.gain.disconnect();
        } catch (_) {
          /* not connected */
        }
      }
    }

    /* ---------------- errors ---------------- */

    #reportError(err, quiet) {
      const message = errorMessage(err);
      this.#lastError = message;
      if (quiet || this.#loggedErrors.has(message) || this.#loggedErrors.size > 20) return;
      this.#loggedErrors.add(message);
      try {
        console.warn('[WVC] voice engine:', message);
      } catch (_) {
        /* console unavailable */
      }
    }
  }

  VoiceEngine.DSP_KEYS = DSP_KEYS;
  VoiceEngine.PROCESSOR_NAME = PROCESSOR_NAME;
  VoiceEngine.SCRIPT_PROCESSOR_BUFFER = SCRIPT_PROCESSOR_BUFFER;

  WVC.VoiceEngine = VoiceEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
