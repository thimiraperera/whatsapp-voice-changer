/*
 * Voice engine test harness (loaded by tests/engine-harness.html after params.js, dsp-core.js and
 * voice-engine.js). Renders each case offline, measures the output and publishes
 * window.__WVC_TEST_RESULTS = { done, pass, cases, summary, env, durationMs }.
 *
 * Pass criteria per case:
 *   - no NaN/Infinity samples, no thrown or reported engine errors
 *   - peak <= 1.0 (after the engine's limiter/ceiling), output not silent (RMS > -60 dBFS)
 *   - pitch presets (normal texture, |pitch| >= 1, no ring mod): f0 moves in the expected direction
 *   - neutral cases: output == input delayed by engine.latency (measured lag within 2 frames, SNR >= 30 dB)
 *   - enabled=false: output matches the undelayed input (SNR >= 60 dB)
 *   - mid-render updates: take effect (pitch drops after switching to "deep") without errors
 */
(function () {
  'use strict';

  const SR = 48000;
  const SECONDS = 3;
  const LENGTH = SR * SECONDS;
  const INPUT_F0 = 140;
  const STEADY = [1.45, 2.45]; // seconds, inside the sustained vowel (input 1.25–2.65 s) even after latency
  const TRANSPARENT_FROM = 0.6; // skip the DynamicsCompressor start-up gain ramp (~0.35 s)
  const MIN_RMS_DB = -60;
  const PITCH_TOLERANCE_ST = 0.5;

  const results = {
    done: false,
    pass: false,
    cases: [],
    summary: null,
    env: { userAgent: navigator.userAgent, sampleRate: SR, seconds: SECONDS, url: location.href },
    durationMs: 0,
  };
  window.__WVC_TEST_RESULTS = results;

  const globalErrors = [];
  window.addEventListener('error', (ev) => globalErrors.push('window error: ' + (ev.message || ev.error)));
  window.addEventListener('unhandledrejection', (ev) => globalErrors.push('unhandled rejection: ' + describe(ev.reason)));

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
  const round = (x, d = 2) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null);

  function describe(err) {
    if (!err) return String(err);
    return err.message ? err.message : String(err);
  }

  /* ------------------------------------------------------------------ *
   * Synthetic voice
   * ------------------------------------------------------------------ */

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Pulse train (with f0 contours) -> glottal roll-off -> formant resonators, syllable envelope. */
  function makeVoice(sr, length) {
    const rand = mulberry32(1234);
    // [start s, end s, f0 start, f0 end]
    const syllables = [
      [0.15, 0.45, 150, 128],
      [0.55, 0.85, 146, 124],
      [0.95, 1.15, 152, 138],
      [1.25, 2.65, INPUT_F0, INPUT_F0], // sustained vowel: the steady part used for f0 analysis
      [2.75, 2.95, 136, 118],
    ];
    const excitation = new Float64Array(length + 2);
    const ramp = 0.03;
    for (const [t0, t1, fa, fb] of syllables) {
      const i0 = Math.round(t0 * sr);
      const i1 = Math.min(length, Math.round(t1 * sr));
      let phase = 0;
      for (let i = i0; i < i1; i++) {
        const u = (i - i0) / Math.max(1, i1 - i0);
        const f0 = fa + (fb - fa) * u;
        const t = i / sr;
        const env = Math.min(1, (t - t0) / ramp, (t1 - t) / ramp);
        const amp = 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, env));
        const prev = phase;
        phase += f0 / sr;
        if (phase >= 1) {
          phase -= 1;
          // Fractional impulse position split across two samples (band-limited-ish, no period jitter).
          const frac = (1 - prev) / (f0 / sr);
          excitation[i] += amp * (1 - frac);
          excitation[i + 1] += amp * frac;
        }
        excitation[i] += amp * 0.004 * (rand() * 2 - 1); // aspiration
      }
    }
    // Glottal roll-off (one-pole low-pass).
    const src = new Float64Array(length);
    let y = 0;
    for (let i = 0; i < length; i++) {
      y = 0.1 * excitation[i] + 0.9 * y;
      src[i] = y;
    }
    // Cascade of formant resonators for an /a/ vowel.
    const formants = [
      [700, 80],
      [1220, 90],
      [2600, 120],
      [3500, 200],
    ];
    let sig = src;
    for (const [f, bw] of formants) {
      const r = Math.exp((-Math.PI * bw) / sr);
      const c1 = 2 * r * Math.cos((2 * Math.PI * f) / sr);
      const c2 = -r * r;
      const g = 1 - r;
      const out = new Float64Array(length);
      let y1 = 0;
      let y2 = 0;
      for (let i = 0; i < length; i++) {
        const v = g * sig[i] + c1 * y1 + c2 * y2;
        out[i] = v;
        y2 = y1;
        y1 = v;
      }
      sig = out;
    }
    let peak = 0;
    for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(sig[i]));
    const x = new Float32Array(length);
    const scale = peak > 0 ? 0.5 / peak : 0;
    for (let i = 0; i < length; i++) x[i] = sig[i] * scale + 1e-4 * (rand() * 2 - 1);
    return x;
  }

  /* ------------------------------------------------------------------ *
   * Analysis
   * ------------------------------------------------------------------ */

  function stats(x) {
    let nan = 0;
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      if (!Number.isFinite(v)) {
        nan++;
        continue;
      }
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
    }
    return { nan, peak, rmsDb: db(Math.sqrt(sum / Math.max(1, x.length - nan))) };
  }

  /** YIN pitch estimate of one frame; null when unvoiced. */
  function yinFrame(x, start, sr) {
    const W = 1024;
    const tauMin = Math.floor(sr / 1000);
    const tauMax = Math.floor(sr / 60);
    if (start < 0 || start + W + tauMax >= x.length) return null;
    let energy = 0;
    for (let j = 0; j < W; j++) energy += x[start + j] * x[start + j];
    if (energy / W < 1e-7) return null;
    const cm = new Float64Array(tauMax + 1);
    let running = 0;
    cm[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const d = x[start + j] - x[start + j + tau];
        s += d * d;
      }
      running += s;
      cm[tau] = running > 0 ? (s * tau) / running : 1;
    }
    let tauEst = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cm[tau] < 0.15) {
        while (tau + 1 <= tauMax && cm[tau + 1] < cm[tau]) tau++;
        tauEst = tau;
        break;
      }
    }
    if (tauEst < 0) {
      let best = Infinity;
      for (let tau = tauMin; tau <= tauMax; tau++) {
        if (cm[tau] < best) {
          best = cm[tau];
          tauEst = tau;
        }
      }
      if (best > 0.45) return null;
    }
    let tau = tauEst;
    if (tau > 1 && tau < tauMax) {
      const a = cm[tau - 1];
      const b = cm[tau];
      const c = cm[tau + 1];
      const denom = a - 2 * b + c;
      if (denom > 0) tau += (0.5 * (a - c)) / denom;
    }
    return sr / tau;
  }

  function estimateF0(x, sr, t0, t1) {
    const values = [];
    for (let t = t0; t < t1; t += 0.05) {
      const f = yinFrame(x, Math.round(t * sr), sr);
      if (f) values.push(f);
    }
    const frames = Math.floor((t1 - t0) / 0.05);
    if (values.length < Math.max(3, frames * 0.3)) return null;
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  }

  // In-place iterative radix-2 complex FFT.
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = ((inverse ? 2 : -2) * Math.PI) / len;
      const wr = Math.cos(ang);
      const wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1;
        let ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k;
          const b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci;
          const ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  /** Lag (0..maxLag) that maximises the cross-correlation of out against ref. */
  function bestLag(ref, out, maxLag) {
    let n = 1;
    while (n < ref.length + maxLag) n <<= 1;
    const ar = new Float64Array(n);
    const ai = new Float64Array(n);
    const br = new Float64Array(n);
    const bi = new Float64Array(n);
    ar.set(ref);
    br.set(out);
    fft(ar, ai, false);
    fft(br, bi, false);
    for (let k = 0; k < n; k++) {
      // conj(A)·B
      const r = ar[k] * br[k] + ai[k] * bi[k];
      const i = ar[k] * bi[k] - ai[k] * br[k];
      ar[k] = r;
      ai[k] = i;
    }
    fft(ar, ai, true);
    let best = -Infinity;
    let lag = 0;
    for (let k = 0; k <= maxLag; k++) {
      if (ar[k] > best) {
        best = ar[k];
        lag = k;
      }
    }
    return lag;
  }

  /** SNR (dB) of out[n + lag] against ref[n] for n in [from, to). */
  function alignedSnr(ref, out, lag, from, to) {
    let sig = 0;
    let err = 0;
    const end = Math.min(to, out.length - lag, ref.length);
    for (let i = from; i < end; i++) {
      const e = out[i + lag] - ref[i];
      sig += ref[i] * ref[i];
      err += e * e;
    }
    if (sig === 0) return null;
    return err === 0 ? Infinity : 10 * Math.log10(sig / err);
  }

  /* ------------------------------------------------------------------ *
   * Cases
   * ------------------------------------------------------------------ */

  function pitchExpectation(params, f0In) {
    if (!params || !f0In) return { expected: null, direction: 0 };
    if (params.texture === 'robot') return { expected: params.robotPitch, direction: 0 };
    if (params.texture === 'whisper') return { expected: null, direction: 0 };
    const expected = f0In * Math.pow(2, params.pitch / 12);
    const direction = Math.abs(params.pitch) >= 1 && params.ringMix === 0 ? Math.sign(params.pitch) : 0;
    return { expected, direction };
  }

  function buildCases() {
    const P = (id) => WVC.presetParams(id);
    const cases = WVC.PRESETS.map((preset) => ({
      name: 'preset: ' + preset.name + ' (' + preset.id + ')',
      params: P(preset.id),
      enabled: true,
      transparent: preset.id === 'natural',
      pitchCheck: true,
    }));
    cases.push({
      name: 'enabled=false from start (demon params)',
      params: P('demon'),
      enabled: false,
      bypassFrom: 0,
    });
    cases.push({
      name: 'mid-render enabled -> false at 1.5 s (robot)',
      params: P('robot'),
      enabled: true,
      actions: [{ at: 1.5, update: { enabled: false } }],
      bypassFrom: 1.5 + 0.1,
    });
    cases.push({
      name: 'mid-render update natural -> deep at 1.9 s',
      params: P('natural'),
      enabled: true,
      actions: [{ at: 1.9, update: { params: P('deep') } }],
      pitchSwitch: { at: 1.9, before: [1.45, 1.85], after: [2.1, 2.55], minDropSt: 2 },
    });
    cases.push({
      name: 'mid-render partial / junk updates',
      params: P('natural'),
      enabled: true,
      actions: [
        { at: 0.5, update: { params: { pitch: 'not-a-number', bogus: 1, echoMix: 0.3, reverbMix: 0.35, staticNoise: 0.2 } } },
        { at: 0.8, update: null },
        { at: 0.9, update: { enabled: 'yes' } },
        { at: 1.0, update: { params: null } },
        { at: 1.1, update: { params: { algorithm: 'nope', texture: 'robot', drive: 0.5, chorusMix: 0.6 } } },
        { at: 1.6, update: { params: { texture: 'normal', pitch: 4, ringMix: 0.4, vibratoDepth: 2, tremoloDepth: 0.5 } } },
        { at: 2.2, update: { params: { drive: 0, chorusMix: 0, ringMix: 0, echoMix: 0, reverbMix: 0, staticNoise: 0 } } },
        { at: 2.4, update: { enabled: false } },
        { at: 2.5, update: { enabled: true } },
      ],
    });
    // Dry/wet blend below 100 %: the dry path must be delayed by exactly the wet latency, otherwise the
    // neutral voice comb-filters (SNR collapses). Covers both algorithms, the ScriptProcessor core and a
    // live algorithm switch (the worklet reports a new latency; the dry delay must follow it).
    const half = (extra) => Object.assign(P('natural'), { mix: 0.5 }, extra || {});
    cases.push({ name: 'dry/wet 50% (spectral) stays aligned', params: half(), enabled: true, transparent: true });
    cases.push({ name: 'dry/wet 50% (granular) stays aligned', params: half({ algorithm: 'granular' }), enabled: true, transparent: true });
    cases.push({
      name: 'dry/wet 50% (script-processor) stays aligned',
      params: half(),
      enabled: true,
      forceScript: true,
      transparent: true,
      expectProcessor: 'script-processor',
    });
    cases.push({
      name: 'dry/wet 50%: algorithm switch at 1.0 s re-aligns dry delay',
      params: half(),
      enabled: true,
      transparent: true,
      transparentFrom: 1.6,
      actions: [
        { at: 1.0, update: { params: { algorithm: 'granular' } } },
        { at: 1.05, waitMs: 80 }, // let the worklet's 'latency' message reach the main thread
      ],
    });
    cases.push({
      name: 'echo time changes (incl. preset jumps) stay finite',
      params: P('cave'),
      enabled: true,
      actions: [
        { at: 0.7, update: { params: { echoTime: 0.03 } } },
        { at: 0.75, update: { params: { echoTime: 0.9, echoFeedback: 0.9, echoMix: 1 } } },
        { at: 1.3, update: { params: { echoTime: 0.1 } } },
        { at: 1.32, update: { params: { echoTime: 1.5 } } },
        { at: 2.0, update: { params: { echoMix: 0, echoTime: 0.4 } } },
        { at: 2.2, update: { params: { echoMix: 0.5 } } },
      ],
    });
    cases.push({
      name: 'script-processor fallback: natural',
      params: P('natural'),
      enabled: true,
      forceScript: true,
      transparent: true,
      expectProcessor: 'script-processor',
    });
    cases.push({
      name: 'script-processor fallback: deep',
      params: P('deep'),
      enabled: true,
      forceScript: true,
      pitchCheck: true,
      expectProcessor: 'script-processor',
    });
    cases.push({
      name: 'script-processor fallback: chipmunk (granular)',
      params: P('chipmunk'),
      enabled: true,
      forceScript: true,
      pitchCheck: true,
      expectProcessor: 'script-processor',
    });
    return cases;
  }

  async function runOfflineCase(c, input, f0In, inputRmsDb) {
    const rec = {
      name: c.name,
      processorType: null,
      latencyMs: null,
      nanCount: null,
      peak: null,
      rmsDb: null,
      levelDb: null,
      f0In: round(f0In, 1),
      f0Out: null,
      f0Expected: null,
      checks: [],
      notes: [],
      errors: [],
      pass: false,
    };
    const errorMark = globalErrors.length;
    const check = (name, ok, detail) => rec.checks.push({ name, pass: !!ok, detail: detail || '' });

    const ctx = new OfflineAudioContext(1, LENGTH, SR);
    const buffer = ctx.createBuffer(1, LENGTH, SR);
    buffer.copyToChannel(input, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;

    let engine = null;
    try {
      engine = await WVC.VoiceEngine.create(ctx, {
        params: c.params,
        enabled: c.enabled,
        _forceScriptProcessor: !!c.forceScript,
      });
    } catch (err) {
      rec.errors.push('create() rejected: ' + describe(err));
      finish(rec, errorMark);
      return rec;
    }
    rec.processorType = engine.processorType;
    rec.latencyMs = round(engine.latency * 1000, 2);

    src.connect(engine.input);
    engine.output.connect(ctx.destination);
    src.start(0);
    for (const action of c.actions || []) {
      ctx
        .suspend(action.at)
        .then(async () => {
          try {
            if ('update' in action) engine.update(action.update);
          } catch (err) {
            rec.errors.push('update() threw at ' + action.at + ' s: ' + describe(err));
          }
          if (action.waitMs) await sleep(action.waitMs);
          return ctx.resume();
        })
        .catch((err) => rec.errors.push('suspend/resume failed: ' + describe(err)));
    }

    let out;
    try {
      const rendered = await ctx.startRendering();
      out = rendered.getChannelData(0);
    } catch (err) {
      rec.errors.push('render failed: ' + describe(err));
      engine.destroy();
      finish(rec, errorMark);
      return rec;
    }

    const latencyFrames = Math.round(engine.latency * SR);
    if (engine.lastError) rec.errors.push('engine.lastError: ' + engine.lastError);
    try {
      engine.destroy();
      engine.destroy(); // must be idempotent
      engine.update({ params: { pitch: 3 } }); // must be a harmless no-op after destroy
    } catch (err) {
      rec.errors.push('destroy()/update() after destroy threw: ' + describe(err));
    }

    const s = stats(out);
    rec.nanCount = s.nan;
    rec.peak = round(s.peak, 4);
    rec.rmsDb = round(s.rmsDb, 1);
    rec.levelDb = round(s.rmsDb - inputRmsDb, 1);

    check('no NaN/Infinity', s.nan === 0, s.nan ? s.nan + ' bad samples' : '');
    check('peak <= 1.0', s.peak <= 1.0, 'peak ' + s.peak.toFixed(4));
    check('not silent', s.rmsDb > MIN_RMS_DB, 'RMS ' + (Number.isFinite(s.rmsDb) ? s.rmsDb.toFixed(1) : '-inf') + ' dBFS');
    if (c.expectProcessor) check('processor = ' + c.expectProcessor, rec.processorType === c.expectProcessor, String(rec.processorType));
    else if (rec.processorType !== 'worklet') rec.notes.push('AudioWorklet unavailable here; ran on the ScriptProcessor fallback');

    if (s.nan === 0) {
      const f0Out = c.bypassFrom === 0 ? null : estimateF0(out, SR, STEADY[0], STEADY[1]);
      rec.f0Out = round(f0Out, 1);
      const exp = pitchExpectation(c.params, f0In);
      rec.f0Expected = round(exp.expected, 1);
      if (c.pitchCheck && exp.direction !== 0) {
        const limit = f0In * Math.pow(2, (exp.direction * PITCH_TOLERANCE_ST) / 12);
        const ok = f0Out !== null && (exp.direction > 0 ? f0Out > limit : f0Out < limit);
        const st = f0Out ? 12 * Math.log2(f0Out / f0In) : null;
        check(
          'pitch moves ' + (exp.direction > 0 ? 'up' : 'down'),
          ok,
          f0Out ? (st >= 0 ? '+' : '') + st.toFixed(2) + ' st (expected ' + c.params.pitch + ' st)' : 'no f0 detected'
        );
        if (ok && Math.abs(st - c.params.pitch) > 1.5) rec.notes.push('f0 shift deviates ' + (st - c.params.pitch).toFixed(2) + ' st from the pitch setting');
      } else if (c.params.texture === 'robot' && f0Out) {
        const dev = 12 * Math.log2(f0Out / c.params.robotPitch);
        if (Math.abs(dev) > 1) rec.notes.push('robot f0 ' + f0Out.toFixed(1) + ' Hz vs robotPitch ' + c.params.robotPitch + ' Hz');
      }

      if (c.transparent) {
        const from = Math.round((c.transparentFrom || TRANSPARENT_FROM) * SR);
        const lag = bestLag(input.subarray(from), out.subarray(from), Math.round(0.25 * SR));
        const snr = alignedSnr(input, out, latencyFrames, from, LENGTH);
        rec.measuredLagMs = round((lag * 1000) / SR, 2);
        rec.snrDb = snr === Infinity ? 'inf' : round(snr, 1);
        check('measured lag = engine.latency', Math.abs(lag - latencyFrames) <= 2, 'measured ' + lag + ' vs reported ' + latencyFrames + ' frames');
        check('neutral output = delayed input', snr !== null && snr >= 30, 'SNR ' + (snr === Infinity ? 'inf' : snr === null ? 'n/a' : snr.toFixed(1)) + ' dB');
      }

      if (typeof c.bypassFrom === 'number') {
        const from = Math.round(c.bypassFrom * SR);
        const snr = alignedSnr(input, out, 0, from, LENGTH);
        rec.snrDb = snr === Infinity ? 'inf' : round(snr, 1);
        check('bypass output = undelayed input', snr !== null && snr >= 60, 'SNR ' + (snr === Infinity ? 'inf' : snr === null ? 'n/a' : snr.toFixed(1)) + ' dB from ' + c.bypassFrom + ' s');
      }

      if (c.pitchSwitch) {
        const ps = c.pitchSwitch;
        const before = estimateF0(out, SR, ps.before[0], ps.before[1]);
        const after = estimateF0(out, SR, ps.after[0], ps.after[1]);
        rec.f0Out = round(after, 1);
        rec.notes.push('f0 before update ' + (before ? before.toFixed(1) : 'n/a') + ' Hz, after ' + (after ? after.toFixed(1) : 'n/a') + ' Hz');
        check('f0 unchanged before update', before !== null && Math.abs(12 * Math.log2(before / f0In)) < 0.5, before ? before.toFixed(1) + ' Hz' : 'no f0');
        check(
          'f0 drops after update',
          before !== null && after !== null && 12 * Math.log2(before / after) >= ps.minDropSt,
          after && before ? (12 * Math.log2(after / before)).toFixed(2) + ' st' : 'no f0'
        );
      }
    }

    finish(rec, errorMark);
    return rec;
  }

  /** Realtime AudioContext: create, junk updates, bypass toggles, double destroy. */
  async function runLifecycleCase() {
    const rec = {
      name: 'realtime AudioContext lifecycle (alien)',
      processorType: null,
      latencyMs: null,
      nanCount: null,
      peak: null,
      rmsDb: null,
      levelDb: null,
      f0In: null,
      f0Out: null,
      f0Expected: null,
      checks: [],
      notes: [],
      errors: [],
      pass: false,
    };
    const errorMark = globalErrors.length;
    const check = (name, ok, detail) => rec.checks.push({ name, pass: !!ok, detail: detail || '' });
    const AC = window.AudioContext || window.webkitAudioContext;
    if (typeof AC !== 'function') {
      rec.notes.push('AudioContext not available; skipped');
      rec.pass = true;
      return rec;
    }
    let ctx;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
    } catch (err) {
      rec.notes.push('AudioContext could not be created here (' + describe(err) + '); skipped');
      rec.pass = true;
      return rec;
    }
    let osc = null;
    try {
      await Promise.race([ctx.resume().catch(() => {}), sleep(600)]);
      const engine = await WVC.VoiceEngine.create(ctx, { params: WVC.presetParams('alien'), enabled: true });
      rec.processorType = engine.processorType;
      rec.latencyMs = round(engine.latency * 1000, 2);
      check('processorType valid', engine.processorType === 'worklet' || engine.processorType === 'script-processor', String(engine.processorType));
      check('input/output/analysers exposed', engine.input instanceof AudioNode && engine.output instanceof AudioNode && engine.inputAnalyser instanceof AnalyserNode && engine.outputAnalyser instanceof AnalyserNode);
      osc = ctx.createOscillator();
      osc.frequency.value = INPUT_F0;
      const level = ctx.createGain();
      level.gain.value = 0.3;
      osc.connect(level).connect(engine.input);
      engine.output.connect(ctx.createMediaStreamDestination()); // pulled, but inaudible
      osc.start();
      await sleep(350);
      let threw = null;
      try {
        engine.update({ params: { pitch: 'nope', unknown: 5, __proto__: { pitch: 9 } } });
        engine.update(null);
        engine.update(undefined);
        engine.update('string');
        engine.update({ enabled: 'yes' });
        engine.update({ params: null });
        engine.update({ params: { reverbMix: 0.5, reverbSize: 3.3 } });
        engine.update({ params: { reverbSize: 5 } });
        engine.update({ enabled: false });
        engine.update({ enabled: true });
        engine.update({ params: WVC.presetParams('robot') });
      } catch (err) {
        threw = err;
      }
      check('update() never throws on junk / partial input', !threw, threw ? describe(threw) : '');
      await sleep(400);
      if (ctx.state === 'running') {
        const data = new Float32Array(engine.outputAnalyser.fftSize);
        engine.outputAnalyser.getFloatTimeDomainData(data);
        const s = stats(data);
        rec.nanCount = s.nan;
        rec.peak = round(s.peak, 4);
        rec.rmsDb = round(s.rmsDb, 1);
        check('live output finite', s.nan === 0);
        check('live output not silent', s.rmsDb > MIN_RMS_DB, 'RMS ' + s.rmsDb.toFixed(1) + ' dBFS');
        check('live output peak <= 1.0', s.peak <= 1.0, 'peak ' + s.peak.toFixed(4));
      } else {
        rec.notes.push('AudioContext is "' + ctx.state + '" (autoplay policy?); live-output checks skipped');
      }
      if (engine.lastError) rec.errors.push('engine.lastError: ' + engine.lastError);
      let destroyThrew = null;
      try {
        engine.destroy();
        engine.destroy();
        engine.update({ params: { pitch: 2 }, enabled: false });
      } catch (err) {
        destroyThrew = err;
      }
      check('destroy() idempotent', !destroyThrew, destroyThrew ? describe(destroyThrew) : '');
      check('destroyed flag set', engine.destroyed === true);
    } catch (err) {
      rec.errors.push(describe(err));
    } finally {
      try {
        if (osc) osc.stop();
      } catch (_) {
        /* not started */
      }
      try {
        await ctx.close();
      } catch (_) {
        /* already closed */
      }
    }
    finish(rec, errorMark);
    return rec;
  }

  /**
   * echoTime change must not warp the repeats already in flight (a gliding delayTime inside the feedback
   * loop plays them back pitch-shifted, even reversed). A 440 Hz burst ends at 1.0 s; echoTime changes at
   * 1.1 s. The tail after the change must match a render without the change.
   */
  async function runEchoTailCase() {
    const rec = { name: 'echoTime change keeps in-flight repeats intact', processorType: null, latencyMs: null, nanCount: null, peak: null, rmsDb: null, levelDb: null, f0In: null, f0Out: null, f0Expected: null, checks: [], notes: [], errors: [], pass: false };
    const errorMark = globalErrors.length;
    const render = async (change) => {
      const ctx = new OfflineAudioContext(1, SR * 2, SR);
      const buf = ctx.createBuffer(1, SR * 2, SR);
      const d = buf.getChannelData(0);
      for (let i = 0; i < SR; i++) d[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR) * Math.min(1, i / 480, (SR - i) / 480);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const engine = await WVC.VoiceEngine.create(ctx, { params: WVC.normalizeParams({ echoMix: 1, echoTime: 0.25, echoFeedback: 0.8 }) });
      rec.processorType = engine.processorType;
      src.connect(engine.input);
      engine.output.connect(ctx.destination);
      if (change) {
        ctx.suspend(1.1).then(() => {
          engine.update({ params: { echoTime: 0.6 } });
          return ctx.resume();
        });
      }
      src.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      if (engine.lastError) rec.errors.push('engine.lastError: ' + engine.lastError);
      engine.destroy();
      return out;
    };
    try {
      const ref = await render(false);
      const out = await render(true);
      const s = stats(out);
      rec.nanCount = s.nan;
      rec.peak = round(s.peak, 4);
      rec.rmsDb = round(s.rmsDb, 1);
      const snr = alignedSnr(ref, out, 0, Math.round(1.1 * SR), SR * 2);
      rec.snrDb = snr === Infinity ? 'inf' : round(snr, 1);
      check(rec, 'tail after the change unchanged', snr !== null && snr >= 40, 'SNR ' + (snr === Infinity ? 'inf' : snr === null ? 'n/a' : snr.toFixed(1)) + ' dB');
      check(rec, 'peak <= 1.0', s.peak <= 1.0, 'peak ' + s.peak.toFixed(4));
    } catch (err) {
      rec.errors.push(describe(err));
    }
    finish(rec, errorMark);
    return rec;
  }

  /** Two engines created concurrently on one context (module loaded once) + create() racing ctx.close(). */
  async function runSharingCase(input) {
    const rec = { name: 'shared context: 2 concurrent engines; create() vs close()', processorType: null, latencyMs: null, nanCount: null, peak: null, rmsDb: null, levelDb: null, f0In: null, f0Out: null, f0Expected: null, checks: [], notes: [], errors: [], pass: false };
    const errorMark = globalErrors.length;
    try {
      const ctx = new OfflineAudioContext(1, LENGTH, SR);
      const buffer = ctx.createBuffer(1, LENGTH, SR);
      buffer.copyToChannel(input, 0);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const [a, b] = await Promise.all([
        WVC.VoiceEngine.create(ctx, { params: WVC.presetParams('deep') }),
        WVC.VoiceEngine.create(ctx, { params: WVC.presetParams('choir') }),
      ]);
      rec.processorType = a.processorType + '+' + b.processorType;
      check(rec, 'both engines use the worklet', a.processorType === 'worklet' && b.processorType === 'worklet', rec.processorType);
      const half = ctx.createGain();
      half.gain.value = 0.5;
      src.connect(a.input);
      src.connect(b.input);
      a.output.connect(half);
      b.output.connect(half);
      half.connect(ctx.destination);
      src.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      for (const e of [a, b]) {
        if (e.lastError) rec.errors.push('engine.lastError: ' + e.lastError);
        e.destroy();
      }
      const s = stats(out);
      rec.nanCount = s.nan;
      rec.peak = round(s.peak, 4);
      rec.rmsDb = round(s.rmsDb, 1);
      check(rec, 'no NaN/Infinity', s.nan === 0);
      check(rec, 'not silent', s.rmsDb > MIN_RMS_DB, 'RMS ' + s.rmsDb.toFixed(1) + ' dBFS');
    } catch (err) {
      rec.errors.push(describe(err));
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (typeof AC === 'function') {
      let ctx = null;
      try {
        ctx = new AC();
      } catch (_) {
        rec.notes.push('AudioContext unavailable; close race skipped');
      }
      if (ctx) {
        const pending = WVC.VoiceEngine.create(ctx, { params: WVC.presetParams('robot') });
        await ctx.close().catch(() => {});
        let engine = null;
        let rejected = false;
        try {
          engine = await pending;
        } catch (_) {
          rejected = true;
        }
        check(rec, 'create() on a context closed mid-flight rejects', rejected, rejected ? '' : 'resolved with an engine on a closed context');
        if (engine) engine.destroy();
      }
    }
    finish(rec, errorMark);
    return rec;
  }

  function check(rec, name, ok, detail) {
    rec.checks.push({ name, pass: !!ok, detail: detail || '' });
  }

  function finish(rec, errorMark) {
    for (const e of globalErrors.slice(errorMark)) rec.errors.push(e);
    rec.pass = rec.errors.length === 0 && rec.checks.every((c) => c.pass);
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  function cell(tr, text, cls) {
    const td = document.createElement('td');
    if (cls) td.className = cls;
    if (text instanceof Node) td.appendChild(text);
    else td.textContent = text === null || text === undefined ? '—' : String(text);
    tr.appendChild(td);
    return td;
  }

  function renderRow(rec, index) {
    const tr = document.createElement('tr');
    if (!rec.pass) tr.className = 'fail';
    cell(tr, index + 1, 'num');
    cell(tr, rec.name);
    const badge = document.createElement('span');
    badge.className = 'badge ' + (rec.pass ? 'pass' : 'fail');
    badge.textContent = rec.pass ? 'PASS' : 'FAIL';
    cell(tr, badge);
    cell(tr, rec.processorType);
    cell(tr, rec.latencyMs, 'num');
    cell(tr, rec.nanCount, 'num');
    cell(tr, rec.peak, 'num');
    cell(tr, rec.rmsDb, 'num');
    cell(tr, rec.levelDb, 'num');
    const f0 = rec.f0In || rec.f0Out ? (rec.f0In ?? '—') + ' → ' + (rec.f0Out ?? '—') + (rec.f0Expected ? ' (' + rec.f0Expected + ')' : '') : null;
    cell(tr, f0, 'num');
    const ul = document.createElement('ul');
    ul.className = 'checks';
    for (const c of rec.checks) {
      const li = document.createElement('li');
      li.className = c.pass ? 'ok' : 'bad';
      li.textContent = (c.pass ? '✓ ' : '✗ ') + c.name + (c.detail ? ' - ' + c.detail : '');
      ul.appendChild(li);
    }
    cell(tr, ul);
    const info = document.createElement('div');
    if (rec.measuredLagMs !== undefined) {
      const d = document.createElement('div');
      d.className = 'notes';
      d.textContent = 'measured lag ' + rec.measuredLagMs + ' ms, SNR ' + rec.snrDb + ' dB';
      info.appendChild(d);
    } else if (rec.snrDb !== undefined) {
      const d = document.createElement('div');
      d.className = 'notes';
      d.textContent = 'SNR ' + rec.snrDb + ' dB';
      info.appendChild(d);
    }
    for (const n of rec.notes) {
      const d = document.createElement('div');
      d.className = 'notes';
      d.textContent = n;
      info.appendChild(d);
    }
    if (rec.errors.length) {
      const d = document.createElement('div');
      d.className = 'errors';
      d.textContent = rec.errors.join('\n');
      info.appendChild(d);
    }
    cell(tr, info);
    $('rows').appendChild(tr);
  }

  function showBanner(text) {
    const b = $('banner');
    b.textContent = text;
    b.style.display = 'block';
  }

  /* ------------------------------------------------------------------ *
   * Main
   * ------------------------------------------------------------------ */

  async function main() {
    const t0 = performance.now();
    const missing = [];
    if (!window.WVC || !WVC.PRESETS) missing.push('src/shared/params.js');
    if (typeof window.wvcDefineDSP !== 'function' || !window.WVCDSP) missing.push('src/engine/dsp-core.js');
    if (!window.WVC || !WVC.VoiceEngine || typeof WVC.VoiceEngine.create !== 'function') missing.push('src/engine/voice-engine.js');
    if (missing.length) showBanner('Missing or broken script(s): ' + missing.join(', '));
    if (!window.WVC || !WVC.VoiceEngine || !WVC.PRESETS) {
      results.fatal = 'Required scripts failed to load: ' + missing.join(', ');
      return;
    }
    if (typeof OfflineAudioContext !== 'function') {
      results.fatal = 'OfflineAudioContext is not supported in this browser';
      showBanner(results.fatal);
      return;
    }

    const input = makeVoice(SR, LENGTH);
    const inStats = stats(input);
    const f0In = estimateF0(input, SR, STEADY[0], STEADY[1]);
    results.env.inputRmsDb = round(inStats.rmsDb, 1);
    results.env.inputPeak = round(inStats.peak, 4);
    results.env.inputF0 = round(f0In, 2);

    const cases = buildCases();
    const total = cases.length + 3;
    for (let i = 0; i < cases.length; i++) {
      $('progress').textContent = 'Case ' + (i + 1) + ' / ' + total + ': ' + cases[i].name;
      let rec;
      try {
        rec = await runOfflineCase(cases[i], input, f0In, inStats.rmsDb);
      } catch (err) {
        rec = { name: cases[i].name, checks: [], notes: [], errors: ['harness error: ' + describe(err)], pass: false };
      }
      results.cases.push(rec);
      renderRow(rec, i);
      await sleep(0);
    }
    $('progress').textContent = 'Case ' + (total - 2) + ' / ' + total + ': shared context';
    const shared = await runSharingCase(input);
    results.cases.push(shared);
    renderRow(shared, results.cases.length - 1);
    $('progress').textContent = 'Case ' + (total - 1) + ' / ' + total + ': echo tail';
    const echo = await runEchoTailCase();
    results.cases.push(echo);
    renderRow(echo, results.cases.length - 1);
    $('progress').textContent = 'Case ' + total + ' / ' + total + ': realtime lifecycle';
    const life = await runLifecycleCase();
    results.cases.push(life);
    renderRow(life, results.cases.length - 1);

    const passed = results.cases.filter((c) => c.pass).length;
    results.summary = { total: results.cases.length, passed, failed: results.cases.length - passed };
    results.pass = passed === results.cases.length;
    results.durationMs = Math.round(performance.now() - t0);
  }

  function publish() {
    const v = $('verdict');
    v.textContent = results.pass ? 'PASS' : 'FAIL';
    v.className = results.pass ? 'pass' : 'fail';
    const s = results.summary;
    $('progress').textContent = s
      ? s.passed + ' / ' + s.total + ' cases passed · input f0 ' + results.env.inputF0 + ' Hz, RMS ' + results.env.inputRmsDb + ' dBFS · ' + (results.durationMs / 1000).toFixed(1) + ' s'
      : results.fatal || 'Harness did not complete';
    results.done = true;
  }

  function start() {
    main()
      .catch((err) => {
        results.fatal = 'Harness crashed: ' + describe(err);
        showBanner(results.fatal);
        results.pass = false;
      })
      .finally(publish);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
