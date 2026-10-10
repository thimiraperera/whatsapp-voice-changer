/*
 * Dependency-free Node tests for src/engine/dsp-core.js.
 * Run: node tests/dsp.test.js   (exit code 1 on any failure)
 */
'use strict';

const path = require('path');
const DSP = require(path.join(__dirname, '..', 'src', 'engine', 'dsp-core.js'));
const { VoiceCore, SpectralShifter, GranularShifter, FFT } = DSP;

let passed = 0;
let failed = 0;

function test(name, fn) {
  const t0 = process.hrtime.bigint();
  try {
    const info = fn();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    passed++;
    console.log(`PASS  ${name}${info ? '  - ' + info : ''}  (${ms.toFixed(0)} ms)`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n      ') : err}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

/* ------------------------------ signal helpers ------------------------------ */

function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Two-pole bandpass resonator (zeros at DC and Nyquist, ~unity peak gain). */
function resonate(x, sr, freq, bw) {
  const r = Math.exp((-Math.PI * bw) / sr);
  const a1 = -2 * r * Math.cos((2 * Math.PI * freq) / sr);
  const a2 = r * r;
  const g = 1 - r;
  const y = new Float64Array(x.length);
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = g * (x[i] - (i > 1 ? x[i - 2] : 0)) - a1 * y1 - a2 * y2;
    y[i] = v;
    y2 = y1;
    y1 = v;
  }
  return y;
}

/** Glottal-like pulse train at f0 through formant resonators, normalised to `peak`. */
function makeVoice(sr, seconds, f0, formants, peak) {
  const n = Math.round(sr * seconds);
  const src = new Float64Array(n);
  const period = sr / f0;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    // Rosenberg-like pulse: smooth opening, faster closing, closed phase.
    const t = phase / period;
    let v = 0;
    if (t < 0.4) v = 0.5 - 0.5 * Math.cos((Math.PI * t) / 0.4);
    else if (t < 0.56) v = Math.cos((Math.PI * (t - 0.4)) / 0.32);
    src[i] = v;
    phase += 1;
    if (phase >= period) phase -= period;
  }
  // Differentiate (lip radiation) then sum resonators.
  const d = new Float64Array(n);
  for (let i = 1; i < n; i++) d[i] = src[i] - src[i - 1];
  const fm = formants || [
    [700, 90, 1],
    [1200, 110, 0.5],
    [2600, 160, 0.25],
  ];
  const out = new Float64Array(n);
  for (const [f, bw, g] of fm) {
    const y = resonate(d, sr, f, bw);
    for (let i = 0; i < n; i++) out[i] += g * y[i];
  }
  let m = 0;
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(out[i]));
  const res = new Float32Array(n);
  for (let i = 0; i < n; i++) res[i] = (out[i] / m) * (peak || 0.5);
  return res;
}

function runCore(core, input, block) {
  const out = new Float32Array(input.length);
  const bs = block || 128;
  for (let i = 0; i < input.length; i += bs) {
    const n = Math.min(bs, input.length - i);
    core.process(input.subarray(i, i + n), out.subarray(i, i + n));
  }
  return out;
}

function rms(x, a, b) {
  const s = a || 0;
  const e = b === undefined ? x.length : b;
  let acc = 0;
  for (let i = s; i < e; i++) acc += x[i] * x[i];
  return Math.sqrt(acc / Math.max(1, e - s));
}

const db = (v) => 20 * Math.log10(Math.max(v, 1e-20));

/** Normalised autocorrelation f0 estimate over x[a..b). Returns { f0, peak }. */
function estimateF0(x, sr, a, b, fmin, fmax) {
  const lo = Math.floor(sr / (fmax || 600));
  const hi = Math.ceil(sr / (fmin || 50));
  const n = b - a - hi;
  const r = new Float64Array(hi + 2);
  let e0 = 0;
  for (let i = 0; i < n; i++) e0 += x[a + i] * x[a + i];
  for (let lag = lo - 1; lag <= hi + 1; lag++) {
    let s = 0;
    let el = 0;
    for (let i = 0; i < n; i++) {
      s += x[a + i] * x[a + i + lag];
      el += x[a + i + lag] * x[a + i + lag];
    }
    r[lag] = s / Math.sqrt(e0 * el + 1e-30);
  }
  let best = lo;
  for (let lag = lo; lag <= hi; lag++) if (r[lag] > r[best]) best = lag;
  // Prefer the shortest lag with a strong local peak (avoid sub-octave errors).
  for (let lag = lo; lag < best; lag++) {
    if (r[lag] > 0.9 * r[best] && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) {
      best = lag;
      break;
    }
  }
  const y0 = r[best - 1];
  const y1 = r[best];
  const y2 = r[best + 1];
  const den = y0 - 2 * y1 + y2;
  const off = den !== 0 ? (0.5 * (y0 - y2)) / den : 0;
  return { f0: sr / (best + off), peak: y1 };
}

/** Amplitude of the component at frequency f over x[a..b) (single-bin DFT). */
function toneAmp(x, sr, a, b, f) {
  let re = 0;
  let im = 0;
  const w = (2 * Math.PI * f) / sr;
  for (let i = a; i < b; i++) {
    re += x[i] * Math.cos(w * i);
    im += x[i] * Math.sin(w * i);
  }
  return (2 * Math.hypot(re, im)) / (b - a);
}

/**
 * Spectral envelope of a harmonic signal with known f0: harmonic amplitudes (150 Hz .. maxHz)
 * interpolated in dB on a 10 Hz grid. Returns the envelope peak and power centroid (Hz).
 */
function envelopeStats(x, sr, a, b, f0, maxHz) {
  const top = maxHz || 4000;
  const fs = [];
  const ls = [];
  for (let h = 1; h * f0 <= top + f0; h++) {
    const fh = h * f0;
    if (fh < 150 - f0) continue;
    fs.push(fh);
    ls.push(Math.log(toneAmp(x, sr, a, b, fh) + 1e-9));
  }
  let peakF = 0;
  let peakL = -Infinity;
  let num = 0;
  let den = 0;
  for (let fq = 150; fq <= top; fq += 10) {
    let i = 0;
    while (i < fs.length - 2 && fs[i + 1] < fq) i++;
    const t = Math.min(1, Math.max(0, (fq - fs[i]) / (fs[i + 1] - fs[i])));
    const l = ls[i] + t * (ls[i + 1] - ls[i]);
    if (l > peakL) {
      peakL = l;
      peakF = fq;
    }
    const p = Math.exp(2 * l);
    num += fq * p;
    den += p;
  }
  return { centroid: num / den, peak: peakF };
}

function allFinite(x) {
  for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) return false;
  return true;
}

function maxAbs(x, a, b) {
  let m = 0;
  for (let i = a || 0; i < (b === undefined ? x.length : b); i++) m = Math.max(m, Math.abs(x[i]));
  return m;
}

function maxStep(x, a, b) {
  let m = 0;
  for (let i = Math.max(1, a); i < b; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
}

/* ---------------------------------- tests ---------------------------------- */

test('FFT realForward matches naive DFT and realInverse inverts it', () => {
  for (const n of [4, 8, 64, 1024]) {
    const fft = new FFT(n);
    const rnd = makeRng(n);
    const x = new Float64Array(n).map(() => rnd() - 0.5);
    const re = new Float64Array(n / 2 + 1);
    const im = new Float64Array(n / 2 + 1);
    fft.realForward(x, re, im);
    let err = 0;
    for (let k = 0; k <= n / 2; k++) {
      let r = 0;
      let i = 0;
      for (let t = 0; t < n; t++) {
        r += x[t] * Math.cos((2 * Math.PI * k * t) / n);
        i -= x[t] * Math.sin((2 * Math.PI * k * t) / n);
      }
      err = Math.max(err, Math.abs(r - re[k]), Math.abs(i - im[k]));
    }
    const y = new Float64Array(n);
    fft.realInverse(re, im, y);
    for (let t = 0; t < n; t++) err = Math.max(err, Math.abs(y[t] - x[t]));
    assert(err < 1e-9, `n=${n} err ${err}`);
  }
  let threw = false;
  try {
    new FFT(1000);
  } catch (_) {
    threw = true;
  }
  assert(threw, 'non power of two must throw');
});

test('1. neutral passthrough is bit-exact after latencySamples (48000 and 44100)', () => {
  const info = [];
  for (const sr of [48000, 44100]) {
    for (const algorithm of ['spectral', 'granular']) {
      const core = new VoiceCore(sr, { algorithm });
      const L = core.latencySamples;
      assert(Number.isInteger(L) && L > 0, 'latency must be a positive integer');
      const rnd = makeRng(7);
      const x = new Float32Array(sr).map(() => rnd() * 2 - 1);
      const y = runCore(core, x, 128);
      for (let i = 0; i < L; i++) assert(y[i] === 0, 'pre-roll must be silent');
      for (let i = L; i < x.length; i++) {
        if (y[i] !== x[i - L]) throw new Error(`${sr}/${algorithm}: mismatch at ${i}: ${y[i]} vs ${x[i - L]}`);
      }
      info.push(`${sr}/${algorithm} L=${L}`);
    }
  }
  // In-place processing (input === output) must also work.
  const core = new VoiceCore(48000, {});
  const L = core.latencySamples;
  const x = makeVoice(48000, 0.5, 140);
  const buf = Float32Array.from(x);
  for (let i = 0; i < buf.length; i += 128) core.process(buf.subarray(i, i + 128), buf.subarray(i, i + 128));
  for (let i = L; i < x.length; i++) assert(buf[i] === x[i - L], 'in-place mismatch');
  return info.join(', ');
});

test('1b. neutral passthrough is bit-exact again after a shifted -> neutral switch completes', () => {
  const sr = 48000;
  const core = new VoiceCore(sr, { pitch: 5 });
  const x = makeVoice(sr, 1, 140);
  runCore(core, x.subarray(0, sr / 2), 128);
  core.setParams({ pitch: 0 });
  const tail = runCore(core, x.subarray(sr / 2), 128);
  const L = core.latencySamples;
  const start = Math.round(0.05 * sr);
  for (let i = start; i < tail.length; i++) assert(tail[i] === x[sr / 2 + i - L], `mismatch at ${i}`);
});

test('2. output identical regardless of block size (non-neutral settings)', () => {
  const sr = 48000;
  const x = makeVoice(sr, 1.5, 150);
  const settings = [
    { pitch: 4.5, formant: -2, gate: -60, bitDepth: 12, downsample: 2 },
    { algorithm: 'granular', pitch: -7 },
    { texture: 'robot', robotPitch: 97 },
    { texture: 'whisper', formant: 3 },
  ];
  for (const s of settings) {
    const ref = runCore(new VoiceCore(sr, s), x, 128);
    for (const bs of [1024, 37, 1, 4096]) {
      const y = runCore(new VoiceCore(sr, s), x, bs);
      for (let i = 0; i < x.length; i++) {
        if (y[i] !== ref[i]) throw new Error(`${JSON.stringify(s)} block ${bs}: differs at ${i}`);
      }
    }
  }
  // Also with a mid-stream switch at the same sample position.
  const outs = [];
  for (const bs of [128, 37]) {
    const core = new VoiceCore(sr, { pitch: 3 });
    const a = runCore(core, x.subarray(0, 24000), bs);
    core.setParams({ texture: 'robot' });
    core.setParams({ texture: 'whisper' });
    const b = runCore(core, x.subarray(24000, 40000), bs);
    core.setParams({ algorithm: 'granular', texture: 'normal' });
    const c = runCore(core, x.subarray(40000), bs);
    outs.push(Float32Array.from([...a, ...b, ...c]));
  }
  for (let i = 0; i < outs[0].length; i++) assert(outs[0][i] === outs[1][i], `switch run differs at ${i}`);
});

test('3. spectral pitch shift f0 accuracy (+12, +5, -5, -12) within 3%', () => {
  const info = [];
  for (const sr of [48000, 44100]) {
    const f0 = 140;
    const x = makeVoice(sr, 2, f0);
    for (const st of [12, 5, -5, -12]) {
      const core = new VoiceCore(sr, { pitch: st });
      const y = runCore(core, x, 128);
      const est = estimateF0(y, sr, sr, 2 * sr - 1, 40, 700);
      const expected = f0 * Math.pow(2, st / 12);
      const err = Math.abs(est.f0 / expected - 1);
      assert(err < 0.03, `${sr} ${st} st: expected ${expected.toFixed(1)} got ${est.f0.toFixed(1)}`);
      const gainDb = db(rms(y, sr, 2 * sr)) - db(rms(x, sr, 2 * sr));
      assert(Math.abs(gainDb) < 6, `${sr} ${st} st: level change ${gainDb.toFixed(1)} dB`);
      if (sr === 48000) info.push(`${st > 0 ? '+' : ''}${st}: ${est.f0.toFixed(1)}/${expected.toFixed(1)} Hz ${gainDb.toFixed(1)}dB`);
    }
  }
  return info.join(', ');
});

test('4. formant-only shift moves the envelope up, keeps f0; pitch shift keeps the envelope', () => {
  const sr = 48000;
  const f0 = 140;
  const x = makeVoice(sr, 2, f0);
  const envIn = envelopeStats(x, sr, sr, 2 * sr, f0);

  const yF = runCore(new VoiceCore(sr, { formant: 6 }), x, 128);
  const estF = estimateF0(yF, sr, sr, 2 * sr - 1, 40, 700);
  assert(Math.abs(estF.f0 / f0 - 1) < 0.03, `formant shift changed f0: ${estF.f0}`);
  const envF = envelopeStats(yF, sr, sr, 2 * sr, f0);
  assert(envF.centroid > envIn.centroid * 1.15, `centroid did not move up: ${envIn.centroid.toFixed(0)} -> ${envF.centroid.toFixed(0)}`);
  assert(envF.peak >= envIn.peak, `envelope peak moved down: ${envIn.peak.toFixed(0)} -> ${envF.peak.toFixed(0)}`);
  // The formant region moves up: level at F1 * 2^(6/12) relative to F1 rises strongly.
  const tilt = (y) => db(toneAmp(y, sr, sr, 2 * sr, 980)) - db(toneAmp(y, sr, sr, 2 * sr, 700));
  const tiltGain = tilt(yF) - tilt(x);
  assert(tiltGain > 10, `formant region did not move: 980/700 Hz level ratio changed by ${tiltGain.toFixed(1)} dB`);

  const yD = runCore(new VoiceCore(sr, { formant: -6 }), x, 128);
  const envD = envelopeStats(yD, sr, sr, 2 * sr, f0);
  assert(envD.centroid < envIn.centroid * 0.87, `negative formant did not move centroid down: ${envD.centroid.toFixed(0)}`);

  const parts = [`in peak ${envIn.peak.toFixed(0)} Hz / centroid ${envIn.centroid.toFixed(0)} Hz`, `F+6 ${envF.peak.toFixed(0)}/${envF.centroid.toFixed(0)} (980/700 Hz +${tiltGain.toFixed(0)} dB)`];
  for (const st of [5, -5]) {
    const yP = runCore(new VoiceCore(sr, { pitch: st }), x, 128);
    const envP = envelopeStats(yP, sr, sr, 2 * sr, f0 * Math.pow(2, st / 12));
    assert(Math.abs(envP.peak / envIn.peak - 1) < 0.15, `pitch ${st}: envelope peak moved ${envIn.peak.toFixed(0)} -> ${envP.peak.toFixed(0)}`);
    assert(Math.abs(envP.centroid / envIn.centroid - 1) < 0.15, `pitch ${st}: centroid moved ${envIn.centroid.toFixed(0)} -> ${envP.centroid.toFixed(0)}`);
    parts.push(`P${st > 0 ? '+' : ''}${st} ${envP.peak.toFixed(0)}/${envP.centroid.toFixed(0)}`);
  }
  return parts.join(', ');
});

test('5. granular +7 / -7 f0 accuracy within 4%', () => {
  const sr = 48000;
  const f0 = 140;
  const x = makeVoice(sr, 2, f0);
  const info = [];
  for (const st of [7, -7]) {
    const core = new VoiceCore(sr, { algorithm: 'granular', pitch: st });
    assert(core.latencySamples === new GranularShifter(sr).latencySamples, 'granular latency');
    const y = runCore(core, x, 128);
    const est = estimateF0(y, sr, sr, 2 * sr - 1, 40, 700);
    const expected = f0 * Math.pow(2, st / 12);
    assert(Math.abs(est.f0 / expected - 1) < 0.04, `${st}: expected ${expected.toFixed(1)} got ${est.f0.toFixed(1)}`);
    info.push(`${st > 0 ? '+' : ''}${st}: ${est.f0.toFixed(1)}/${expected.toFixed(1)} Hz`);
  }
  return info.join(', ');
});

test('6. robot follows robotPitch regardless of input; whisper is aperiodic at a similar level', () => {
  const sr = 48000;
  const info = [];
  for (const [inF0, rp] of [
    [140, 110],
    [220, 110],
    [120, 75],
    [180, 300],
  ]) {
    const x = makeVoice(sr, 2, inF0);
    const y = runCore(new VoiceCore(sr, { texture: 'robot', robotPitch: rp }), x, 128);
    const est = estimateF0(y, sr, sr, 2 * sr - 1, 40, 700);
    assert(Math.abs(est.f0 / rp - 1) < 0.03, `robot ${rp} (input ${inF0}): got ${est.f0.toFixed(1)}`);
    const gainDb = db(rms(y, sr, 2 * sr)) - db(rms(x, sr, 2 * sr));
    assert(Math.abs(gainDb) < 6, `robot level change ${gainDb.toFixed(1)} dB`);
    info.push(`robot ${rp}: ${est.f0.toFixed(1)} Hz ${gainDb.toFixed(1)}dB`);
  }
  const x = makeVoice(sr, 2, 140);
  const y = runCore(new VoiceCore(sr, { texture: 'whisper' }), x, 128);
  const est = estimateF0(y, sr, sr, 2 * sr - 1, 60, 500);
  assert(est.peak < 0.4, `whisper periodicity ${est.peak.toFixed(2)}`);
  const gainDb = db(rms(y, sr, 2 * sr)) - db(rms(x, sr, 2 * sr));
  assert(Math.abs(gainDb) < 6, `whisper level change ${gainDb.toFixed(1)} dB`);
  info.push(`whisper periodicity ${est.peak.toFixed(2)} level ${gainDb.toFixed(1)}dB`);
  return info.join(', ');
});

test('7. gate attenuates -70 dBFS noise by > 30 dB and passes loud speech', () => {
  const sr = 48000;
  const rnd = makeRng(3);
  const amp = Math.pow(10, -70 / 20) * Math.sqrt(3); // uniform noise with RMS = -70 dBFS
  const noise = new Float32Array(2 * sr).map(() => (rnd() * 2 - 1) * amp);
  const core = new VoiceCore(sr, { gate: -40 });
  const yN = runCore(core, noise, 128);
  const att = db(rms(noise, sr, 2 * sr)) - db(rms(yN, sr, 2 * sr));
  assert(att > 30, `noise attenuation only ${att.toFixed(1)} dB`);

  const x = makeVoice(sr, 1, 140, null, 0.5);
  const yS = runCore(core, x, 128);
  const L = core.latencySamples;
  const lossDb = db(rms(x, 0.3 * sr, sr - L)) - db(rms(yS, 0.3 * sr + L, sr));
  assert(Math.abs(lossDb) < 0.5, `speech level changed by ${lossDb.toFixed(2)} dB`);
  return `noise attenuated ${att > 200 ? '>200' : att.toFixed(0)} dB, speech change ${lossDb.toFixed(2)} dB`;
});

test('8. bitDepth / downsample alter the signal; 16 bits / factor 1 are transparent', () => {
  const sr = 48000;
  const x = makeVoice(sr, 0.5, 140);
  const ref = runCore(new VoiceCore(sr, {}), x, 128);
  const same = runCore(new VoiceCore(sr, { bitDepth: 16, downsample: 1 }), x, 128);
  for (let i = 0; i < x.length; i++) assert(same[i] === ref[i], 'bitDepth 16 / downsample 1 not transparent');

  const L = new VoiceCore(sr, {}).latencySamples;
  const c4 = runCore(new VoiceCore(sr, { bitDepth: 4 }), x, 128);
  const levels = new Set();
  for (let i = L; i < x.length; i++) {
    levels.add(c4[i]);
    const q = c4[i] * 8;
    assert(Math.abs(q - Math.round(q)) < 1e-6, 'bitDepth 4 must quantise to 1/8 steps');
    assert(Math.abs(c4[i] - x[i - L]) <= 1 / 16 + 1e-6, 'quantisation error too big');
  }
  assert(levels.size > 3 && levels.size <= 17, `unexpected level count ${levels.size}`);

  const d8 = runCore(new VoiceCore(sr, { downsample: 8 }), x, 128);
  let changed = 0;
  for (let i = L; i < x.length; i++) {
    const holdStart = i - (i % 8);
    if (d8[i] !== d8[holdStart]) throw new Error('sample-and-hold not holding');
    if (d8[i] !== ref[i]) changed++;
  }
  assert(changed > x.length / 2, 'downsample made no difference');
  return `4-bit levels used: ${levels.size}`;
});

test('9. never outputs NaN/Infinity (silence, noise, DC, impulses, NaN input, extreme params)', () => {
  const sr = 48000;
  const n = sr;
  const rnd = makeRng(11);
  const signals = {
    silence: new Float32Array(n),
    noise: new Float32Array(n).map(() => rnd() * 2 - 1),
    dc: new Float32Array(n).fill(1),
    negdc: new Float32Array(n).fill(-1),
    impulses: new Float32Array(n).map((_, i) => (i % 4800 === 0 ? 1 : 0)),
    tiny: new Float32Array(n).map(() => (rnd() - 0.5) * 1e-30),
    garbage: new Float32Array(n).map((_, i) => (i % 1000 === 5 ? NaN : i % 1000 === 7 ? Infinity : i % 777 === 0 ? -Infinity : Math.sin(i * 0.01))),
  };
  const combos = [];
  for (const algorithm of ['spectral', 'granular']) {
    for (const texture of ['normal', 'robot', 'whisper']) {
      for (const pitch of [-24, 0, 24]) {
        for (const formant of [-12, 12]) {
          combos.push({ algorithm, texture, pitch, formant, robotPitch: pitch < 0 ? 40 : 400, gate: pitch > 0 ? -20 : -90, bitDepth: pitch === 0 ? 2 : 16, downsample: pitch === 0 ? 32 : 1 });
        }
      }
    }
  }
  combos.push({ pitch: 1e9, formant: -1e9, robotPitch: NaN, gate: 'x', bitDepth: -5, downsample: 1e6, algorithm: 'bogus', texture: 42 });
  let runs = 0;
  for (const p of combos) {
    for (const [name, sig] of Object.entries(signals)) {
      const y = runCore(new VoiceCore(sr, p), sig, 128);
      if (!allFinite(y)) throw new Error(`non-finite output for ${name} with ${JSON.stringify(p)}`);
      if (name === 'noise' || name === 'dc') assert(maxAbs(y) < 50, `runaway output for ${name} ${JSON.stringify(p)}: ${maxAbs(y)}`);
      runs++;
    }
  }
  for (const sr2 of [8000, 22050, 96000, 192000, NaN, -1]) {
    const y = runCore(new VoiceCore(sr2, { pitch: 7, formant: 3 }), signals.noise.subarray(0, 20000), 128);
    assert(allFinite(y), `non-finite at sampleRate ${sr2}`);
  }
  return `${runs} signal/param runs`;
});

test('10. parameter changes mid-stream are click-free', () => {
  const sr = 48000;
  const f0 = 140;
  const x = makeVoice(sr, 3, f0, null, 0.5);
  const refStep = maxStep(x, 0, x.length);
  const scenarios = [
    ['pitch jump +3 -> +12', { pitch: 3 }, { pitch: 12 }],
    ['pitch jump +12 -> -12', { pitch: 12 }, { pitch: -12 }],
    ['granular pitch -7 -> +7', { algorithm: 'granular', pitch: -7 }, { pitch: 7 }],
    ['spectral -> granular', { pitch: 5 }, { algorithm: 'granular' }],
    ['granular -> spectral', { algorithm: 'granular', pitch: 5 }, { algorithm: 'spectral' }],
    ['normal -> robot', { pitch: 2 }, { texture: 'robot' }],
    ['robot -> whisper', { texture: 'robot' }, { texture: 'whisper' }],
    ['whisper -> normal', { texture: 'whisper', pitch: 3 }, { texture: 'normal' }],
    ['neutral -> shifted', {}, { pitch: -5, formant: 2 }],
    ['shifted -> neutral', { pitch: -5 }, { pitch: 0 }],
    ['neutral spectral -> neutral granular', {}, { algorithm: 'granular' }],
    ['rapid toggles', { pitch: 4 }, null],
  ];
  const info = [];
  let worstRatio = 0;
  for (const [name, a, b] of scenarios) {
    const core = new VoiceCore(sr, a);
    const out = new Float32Array(x.length);
    const sw = 1.5 * sr;
    for (let i = 0; i < x.length; i += 128) {
      if (i === sw) {
        if (b) core.setParams(b);
      }
      if (!b && i >= sw && i < sw + 0.2 * sr && (i / 128) % 3 === 0) {
        core.setParams((i / 128) % 2 === 0 ? { pitch: 0 } : { pitch: 4, texture: (i / 128) % 4 === 0 ? 'robot' : 'normal' });
      }
      core.process(x.subarray(i, i + 128), out.subarray(i, i + 128));
    }
    assert(allFinite(out), name + ': non-finite');
    // Steady-state reference steps before the switch, then check the switch region.
    const before = maxStep(out, sr, sw);
    const around = maxStep(out, sw - 256, sw + 0.3 * sr);
    const bound = Math.max(2.5 * before, 1.5 * refStep);
    worstRatio = Math.max(worstRatio, around / bound);
    assert(around <= bound, `${name}: step ${around.toFixed(3)} > bound ${bound.toFixed(3)} (pre-switch ${before.toFixed(3)})`);
    info.push(`${name} ${(around / refStep).toFixed(2)}`);
  }
  return `worst step / bound = ${worstRatio.toFixed(2)}`;
});

test('11. performance: heaviest settings >= 20x real time (10 s @ 48 kHz)', () => {
  const sr = 48000;
  const x = makeVoice(sr, 10, 140);
  const params = { algorithm: 'spectral', pitch: -7, formant: 4, gate: -50, bitDepth: 8, downsample: 2 };
  runCore(new VoiceCore(sr, params), x.subarray(0, sr), 128); // warm-up JIT
  // Best of three timed runs, so scheduler noise on a busy machine does not decide the result.
  let secs = Infinity;
  for (let rep = 0; rep < 3; rep++) {
    const core = new VoiceCore(sr, params);
    const t0 = process.hrtime.bigint();
    runCore(core, x, 128);
    secs = Math.min(secs, Number(process.hrtime.bigint() - t0) / 1e9);
  }
  const factor = 10 / secs;
  console.log(`      realtime factor: ${factor.toFixed(1)}x (${(secs * 1000).toFixed(0)} ms for 10 s, ~${(100 / factor).toFixed(1)}% of one core)`);
  assert(factor >= 20, `only ${factor.toFixed(1)}x real time`);
  // Robot and granular paths for reference.
  const t1 = process.hrtime.bigint();
  runCore(new VoiceCore(sr, { texture: 'robot', robotPitch: 400 }), x, 128);
  const f2 = 10 / (Number(process.hrtime.bigint() - t1) / 1e9);
  assert(f2 >= 20, `robot only ${f2.toFixed(1)}x real time`);
  return `spectral ${factor.toFixed(1)}x, robot ${f2.toFixed(1)}x`;
});

test('12. stringified wvcDefineDSP is self-contained and registers a working worklet processor', () => {
  const src = globalThis.wvcDefineDSP.toString();
  assert(typeof globalThis.wvcDefineDSP === 'function', 'global wvcDefineDSP missing');

  // Plain scope (no worklet globals).
  const plain = {};
  const define = new Function('return (' + src + ');')();
  define(plain);
  assert(plain.WVCDSP && typeof plain.WVCDSP.VoiceCore === 'function', 'WVCDSP not installed');
  assert(plain.WVCDSP.PROCESSOR_NAME === 'wvc-voice-core', 'PROCESSOR_NAME');
  const c = new plain.WVCDSP.VoiceCore(48000, { pitch: 3 });
  const buf = new Float32Array(1024).map((_, i) => Math.sin(i * 0.05));
  c.process(buf, new Float32Array(1024));

  // Mock AudioWorkletGlobalScope.
  const registry = new Map();
  class MockPort {
    constructor() {
      this.sent = [];
      this.onmessage = null;
    }
    postMessage(m) {
      this.sent.push(JSON.parse(JSON.stringify(m)));
    }
    deliver(data) {
      if (this.onmessage) this.onmessage({ data });
    }
  }
  class AudioWorkletProcessor {
    constructor() {
      this.port = new MockPort();
    }
  }
  const scope = {
    sampleRate: 44100,
    AudioWorkletProcessor,
    registerProcessor(name, cls) {
      if (registry.has(name)) throw new Error('NotSupportedError: already registered');
      registry.set(name, cls);
    },
  };
  // Evaluate exactly like voice-engine.js does: '(' + src + ')(globalThis);' with scope as globalThis.
  new Function('globalThis', '(' + src + ')(globalThis);')(scope);
  new Function('globalThis', '(' + src + ')(globalThis);')(scope); // double registration must not throw
  assert(registry.has('wvc-voice-core'), 'processor not registered');
  const Proc = registry.get('wvc-voice-core');
  const node = new Proc({ numberOfInputs: 1, numberOfOutputs: 1, processorOptions: { params: { pitch: 0 } } });
  assert(node.port.sent[0] && node.port.sent[0].type === 'ready', 'no ready message');
  const lat0 = node.port.sent[0].latencySamples;
  assert(lat0 === new SpectralShifter(44100).latencySamples, `ready latency ${lat0}`);

  const inp = new Float32Array(128);
  const out = new Float32Array(128);
  let t = 0;
  const all = [];
  for (let b = 0; b < 100; b++) {
    for (let i = 0; i < 128; i++) inp[i] = Math.sin(t++ * 0.03) * 0.5;
    assert(node.process([[inp]], [[out]], {}) === true, 'process must return true');
    all.push(...out);
  }
  for (let i = lat0; i < all.length; i++) {
    const expected = Math.fround(Math.sin((i - lat0) * 0.03) * 0.5);
    if (all[i] !== expected) throw new Error(`worklet passthrough mismatch at ${i}`);
  }

  node.port.deliver({ type: 'params', params: { algorithm: 'granular', pitch: 5 } });
  const latMsg = node.port.sent.find((m) => m.type === 'latency');
  assert(latMsg && latMsg.latencySamples === new GranularShifter(44100).latencySamples, 'no latency message on algorithm change');
  const nSent = node.port.sent.length;
  node.port.deliver({ type: 'params', params: { pitch: 7 } });
  assert(node.port.sent.length === nSent, 'latency must only be posted when it changes');

  // Missing input -> silence; stereo output gets both channels filled.
  const o1 = new Float32Array(128).fill(9);
  const o2 = new Float32Array(128).fill(9);
  assert(node.process([[]], [[o1, o2]], {}) === true, 'missing input must return true');
  assert(node.process([], [[o1, o2]], {}) === true, 'no inputs must return true');
  assert(o1.every((v) => v === 0) && o2.every((v) => v === 0), 'missing input must output silence');

  // Garbage messages are ignored; reset works.
  node.port.deliver(null);
  node.port.deliver('params');
  node.port.deliver({ type: 'params', params: null });
  node.port.deliver({ type: 'reset' });
  assert(node.process([[inp]], [[out]], {}) === true, 'process after reset');
  assert(allFinite(out), 'non-finite after reset');

  // A throwing core posts one error, then passes input through.
  node._core.process = () => {
    throw new Error('boom');
  };
  node.process([[inp]], [[out]], {});
  node.process([[inp]], [[out]], {});
  const errs = node.port.sent.filter((m) => m.type === 'error');
  assert(errs.length === 1 && /boom/.test(errs[0].message), 'error must be posted exactly once');
  for (let i = 0; i < 128; i++) assert(out[i] === inp[i], 'must pass input through after an error');

  node.port.deliver({ type: 'dispose' });
  assert(node.process([[inp]], [[out]], {}) === false, 'process must return false after dispose');
  return `ready latency ${lat0}, messages ${node.port.sent.map((m) => m.type).join('/')}`;
});

test('13. no allocations / constant state: repeated runs are deterministic, reset restores initial behaviour', () => {
  const sr = 48000;
  const x = makeVoice(sr, 1, 160);
  const p = { pitch: -3, formant: 2, gate: -60 };
  const core = new VoiceCore(sr, p);
  const a = runCore(core, x, 128);
  core.reset();
  const b = runCore(core, x, 128);
  for (let i = 0; i < x.length; i++) assert(a[i] === b[i], `reset not deterministic at ${i}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
