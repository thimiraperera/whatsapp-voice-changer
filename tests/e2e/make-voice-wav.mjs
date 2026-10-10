// Synthetic "voice": 140 Hz glottal-like pulse train through 3 formant resonators, 48 kHz mono 16-bit.
import fs from 'node:fs';
const sr = 48000, secs = 8, f0 = 140;
const n = sr * secs;
const x = new Float64Array(n);
// Rosenberg-ish glottal pulse train
let phase = 0;
for (let i = 0; i < n; i++) {
  phase += f0 / sr;
  if (phase >= 1) phase -= 1;
  const t = phase;
  x[i] = t < 0.4 ? 0.5 * (1 - Math.cos(Math.PI * t / 0.4)) : t < 0.56 ? Math.cos((Math.PI / 2) * (t - 0.4) / 0.16) : 0;
}
// differentiate (lip radiation)
for (let i = n - 1; i > 0; i--) x[i] = x[i] - x[i - 1];
// formant resonators (two-pole)
function reson(sig, fc, bw) {
  const r = Math.exp(-Math.PI * bw / sr), th = 2 * Math.PI * fc / sr;
  const a1 = 2 * r * Math.cos(th), a2 = -r * r, g = 1 - r;
  const y = new Float64Array(sig.length);
  for (let i = 0; i < sig.length; i++) y[i] = g * sig[i] + a1 * (y[i - 1] || 0) + a2 * (y[i - 2] || 0);
  return y;
}
const y1 = reson(x, 700, 110), y2 = reson(x, 1220, 120), y3 = reson(x, 2600, 160);
const y = new Float64Array(n);
for (let i = 0; i < n; i++) y[i] = y1[i] + 0.6 * y2[i] + 0.3 * y3[i];
let peak = 0; for (const v of y) peak = Math.max(peak, Math.abs(v));
const buf = Buffer.alloc(44 + n * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round((y[i] / peak) * 0.5 * 32767), 44 + i * 2);
fs.writeFileSync(new URL('./voice140.wav', import.meta.url), buf);
console.log('wrote voice140.wav', buf.length, 'bytes');
