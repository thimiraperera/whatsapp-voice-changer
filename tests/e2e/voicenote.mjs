// End-to-end test for "send an audio file as a voice note".
// Real Chrome + the unpacked extension + the real web.whatsapp.com page (logged out), fake mic = 140 Hz voice.
// Drives inject.js directly by posting PAGE_UI messages from the MAIN world (same envelope voicenote-ui.js uses),
// and measures what the stream handed to WhatsApp actually carries.
import { launch, openPage, sleep } from './cdp.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const wav = path.join(here, 'voice140.wav');
if (!fs.existsSync(wav)) {
  console.error('Missing tests/e2e/voice140.wav. Run: node tests/e2e/make-voice-wav.mjs');
  process.exit(2);
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  - ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
};
const near = (v, target, tol) => Number.isFinite(v) && Math.abs(v / target - 1) < tol;

// If the UI script is not there yet (it is written separately), load a temp copy without it so the
// MAIN-world side can still be tested.
function extensionDir() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const missing = manifest.content_scripts.flatMap((c) => c.js).filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (!missing.length) return { dir: ROOT, note: 'extension as-is' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wvc-ext-'));
  for (const item of ['manifest.json', 'icons', 'src']) fs.cpSync(path.join(ROOT, item), path.join(tmp, item), { recursive: true });
  for (const c of manifest.content_scripts) c.js = c.js.filter((f) => !missing.includes(f));
  fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { dir: tmp, note: 'temp copy without missing ' + missing.join(', '), tmp };
}

// Pitch (autocorrelation, copied from e2e.mjs with a configurable range) + Goertzel levels at chosen frequencies.
const MEASURE = `async (stream, secs = 1.2, warm = 0.3, maxF = 600, freqs = [140, 440, 785]) => {
  const ctx = new AudioContext();
  await ctx.resume();
  const src = ctx.createMediaStreamSource(stream);
  const sp = ctx.createScriptProcessor(2048, 1, 1);
  const chunks = [];
  let t0 = null;
  sp.onaudioprocess = (e) => { if (t0 === null) t0 = ctx.currentTime; if (ctx.currentTime - t0 > warm) chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
  src.connect(sp); sp.connect(ctx.destination);
  await new Promise((r) => setTimeout(r, (secs + warm) * 1000 + 200));
  sp.disconnect(); src.disconnect();
  const sr = ctx.sampleRate; await ctx.close();
  const n = chunks.reduce((a, c) => a + c.length, 0); const x = new Float32Array(n); let o = 0; for (const c of chunks) { x.set(c, o); o += c.length; }
  let rms = 0; for (const v of x) rms += v * v; rms = Math.sqrt(rms / Math.max(1, n));
  const minLag = Math.floor(sr / maxF), maxLag = Math.floor(sr / 55), W = Math.min(n - maxLag - 1, sr);
  let best = -1, bestLag = 0; const r = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) { let s = 0, e1 = 0, e2 = 0; for (let i = 0; i < W; i++) { s += x[i] * x[i + lag]; e1 += x[i] * x[i]; e2 += x[i + lag] * x[i + lag]; } r[lag] = s / Math.sqrt(e1 * e2 + 1e-12); }
  for (let lag = minLag; lag <= maxLag; lag++) if (r[lag] > best) { best = r[lag]; bestLag = lag; }
  for (let lag = minLag + 1; lag < bestLag; lag++) if (r[lag] > 0.9 * best && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) { bestLag = lag; break; }
  const a = r[bestLag - 1], b = r[bestLag], c = r[bestLag + 1]; const d = (a - c) / (2 * (a - 2 * b + c) || 1);
  const bands = {};
  for (const f of freqs) {
    const w = 2 * Math.PI * f / sr; let re = 0, im = 0;
    for (let i = 0; i < n; i++) { const h = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)); re += x[i] * h * Math.cos(w * i); im -= x[i] * h * Math.sin(w * i); }
    bands[f] = Math.round(20 * Math.log10(4 * Math.hypot(re, im) / Math.max(1, n) + 1e-9) * 10) / 10; // Hann-corrected sine amplitude, dBFS
  }
  return { f0: Math.round(sr / (bestLag + (Number.isFinite(d) ? d : 0)) * 10) / 10, clarity: Math.round(best * 1000) / 1000, rmsDb: Math.round(20 * Math.log10(rms + 1e-9) * 10) / 10, bands, n, sr };
}`;

// In-page helpers: WAV generator, UI-message sender, VN message log.
const HELPERS = `(() => {
  window.__measure = ${MEASURE};
  window.__vn = [];
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source === window && d && d.__wvc === true && d.source === 'wvc-main' && typeof d.type === 'string' && d.type.startsWith('vn-')) {
      window.__vn.push({ type: d.type, payload: d.payload, at: performance.now(), now: Date.now() });
    }
  });
  window.__ui = (type, payload = {}, transfer = []) => window.postMessage({ __wvc: true, source: 'wvc-ui', type, payload }, '*', transfer);
  window.__wav = (secs, freq, channels = 1, amp = 0.5) => {
    const sr = 48000, n = Math.round(secs * sr), bytes = 44 + n * channels * 2;
    const buf = new ArrayBuffer(bytes), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, bytes - 8, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, channels, true); v.setUint32(24, sr, true); v.setUint32(28, sr * channels * 2, true);
    v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * channels * 2, true);
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) { const a = c === 0 ? amp : amp * 0.6; v.setInt16(o, Math.round(a * Math.sin(2 * Math.PI * freq * i / sr) * 32767), true); o += 2; }
    return buf;
  };
  // Resolve with the first VN message at index >= from matching pred.
  window.__waitVn = (from, pred, ms = 5000) => new Promise((res) => {
    const t0 = performance.now();
    const poll = () => {
      for (let i = from; i < __vn.length; i++) { try { if (pred(__vn[i])) return res(__vn[i]); } catch (_) {} }
      if (performance.now() - t0 > ms) return res(null);
      setTimeout(poll, 20);
    };
    poll();
  });
  window.__states = (from = 0) => __vn.slice(from).filter((m) => m.type === 'vn-state').map((m) => m.payload);
  window.__lastState = () => { const s = __states(); return s[s.length - 1] || null; };
  window.__stopAll = () => { for (const s of window.__streams || []) s.getTracks().forEach((t) => t.stop()); window.__streams = []; };
  window.__gum = async () => { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); (window.__streams = window.__streams || []).push(s); window.__s = s; return true; };
  return true;
})()`;

const ext = extensionDir();
const b = await launch({ headless: true, extraArgs: [`--use-file-for-fake-audio-capture=${wav}`] });
try {
  const { id: extId } = await b.send('Extensions.loadUnpacked', { path: ext.dir });
  check('extension loads (' + ext.note + ')', !!extId, extId);

  const ctl = await openPage(b, `chrome-extension://${extId}/src/popup/popup.html`);
  await sleep(1500);
  const setPreset = async (presetId) =>
    ctl.evaluate(`(async () => {
      const s = WVC.normalizeSettings({ enabled: true, presetId: ${JSON.stringify(presetId)}, params: WVC.presetParams(${JSON.stringify(presetId)}), monitor: false });
      await chrome.storage.local.set({ [WVC.STORAGE_KEYS.SETTINGS]: s });
      return s.presetId;
    })()`);
  await setPreset('natural');

  const wa = await openPage(b, 'https://web.whatsapp.com/');
  await sleep(7000);
  await wa.evaluate(HELPERS);
  const E = (expr) => wa.evaluate(expr);
  const mark = () => E('__vn.length');

  // --- load --------------------------------------------------------------------------------
  let i0 = await mark();
  await E(`(() => { const buf = __wav(3.0, 440); __ui('vn-load', { name: 'tone.wav', buffer: buf }, [buf]); return buf.byteLength; })()`);
  const loaded = await E(`__waitVn(${i0}, (m) => m.type === 'vn-loaded' || m.type === 'vn-error', 8000)`);
  const lp = loaded && loaded.payload;
  const peakMax = lp && Array.isArray(lp.peaks) ? Math.max(...lp.peaks) : null;
  check(
    'VN_LOAD -> VN_LOADED (3.0 s, 160 peaks)',
    loaded && loaded.type === 'vn-loaded' && near(lp.duration, 3.0, 0.01) && lp.peaks.length === 160 && lp.peaks.every((p) => p >= 0 && p <= 1) && lp.sampleRate === 48000 && lp.channels === 1,
    lp && { name: lp.name, duration: lp.duration, sampleRate: lp.sampleRate, channels: lp.channels, peaks: lp.peaks.length, peakMax }
  );
  check('peaks reflect the 0.5 amplitude sine', near(peakMax, 0.5, 0.05), peakMax);
  let st = await E(`__lastState()`);
  check('state after load is ready', st && st.state === 'ready' && st.name === 'tone.wav' && near(st.duration, 3, 0.01) && near(st.length, 3, 0.01), st);
  const seq = await E(`__states(${i0}).map((s) => s.state).join('>')`);
  check('load goes loading -> ready', /loading>ready$/.test(seq), seq);

  // --- invalid input -----------------------------------------------------------------------
  i0 = await mark();
  await E(`(() => { const u = new Uint8Array(4096); for (let i = 0; i < u.length; i++) u[i] = (i * 7919) & 255; __ui('vn-load', { name: 'junk.mp3', buffer: u.buffer }, [u.buffer]); return true; })()`);
  const err = await E(`__waitVn(${i0}, (m) => m.type === 'vn-error', 8000)`);
  await sleep(200);
  st = await E(`__lastState()`);
  check('corrupt buffer -> VN_ERROR with a friendly message', err && typeof err.payload.message === 'string' && err.payload.message.length > 10, err && err.payload);
  check('state stays sane after a corrupt file (previous file kept)', st && st.state === 'ready' && st.name === 'tone.wav', st && { state: st.state, name: st.name });
  i0 = await mark();
  await E(`(() => {
    __ui('vn-load', { name: 'x', buffer: 'not a buffer' });
    window.postMessage({ __wvc: true, source: 'someone-else', type: 'vn-clear', payload: {} }, '*');
    window.postMessage({ __wvc: false, source: 'wvc-ui', type: 'vn-clear', payload: {} }, '*');
    __ui('vn-query');
    return true; })()`);
  await sleep(400);
  const inv = await E(`({ errs: __vn.slice(${i0}).filter((m) => m.type === 'vn-error').length, last: __lastState() })`);
  check('invalid payload rejected, foreign envelopes ignored', inv.errs === 1 && inv.last.state === 'ready' && inv.last.name === 'tone.wav', { errs: inv.errs, state: inv.last.state });

  // --- arm -> play (file only) ---------------------------------------------------------------
  i0 = await mark();
  await E(`__ui('vn-arm', { options: { includeMic: false, applyEffect: false, volume: 1 } })`);
  const armed = await E(`__waitVn(${i0}, (m) => m.type === 'vn-state' && m.payload.state === 'armed')`);
  const armLeft = armed ? armed.payload.armedUntil - armed.now : null;
  check('VN_ARM -> armed, armedUntil ~ now + 180000', armed && armLeft > 178000 && armLeft <= 180500, armLeft);
  await E(`__gum()`);
  const m1 = await E(`__measure(__s, 1.2, 0.3)`);
  check('armed file plays into the mic track (~440 Hz, not 140)', near(m1.f0, 440, 0.03) && m1.rmsDb > -20 && m1.bands[140] < -50, m1);
  const done1 = await E(`__waitVn(${i0}, (m) => m.type === 'vn-state' && m.payload.state === 'done', 5000)`);
  const s1 = await E(`__states(${i0})`);
  const seq1 = s1.map((s) => s.state).filter((s, i, a) => s !== a[i - 1]).join('>');
  const pos1 = s1.filter((s) => s.state === 'playing').map((s) => s.position);
  const advancing = pos1.length >= 4 && pos1.every((p, i) => i === 0 || p >= pos1[i - 1]) && pos1[pos1.length - 1] > 2.0;
  check('state goes armed -> playing -> done', seq1 === 'armed>playing>done' && done1 && near(done1.payload.position, 3, 0.01), seq1);
  check('position advances while playing (~every 250 ms)', advancing, { n: pos1.length, first: pos1[0], last: pos1[pos1.length - 1] });
  check('liveMics reported while recording', s1.some((s) => s.state === 'playing' && s.liveMics === 1), s1.map((s) => s.liveMics).join(','));
  const m1b = await E(`__measure(__s, 1.0, 0.2)`);
  check('after the file ends, includeMic=false keeps the mic muted (rms < -60 dBFS)', m1b.rmsDb < -60, m1b);
  i0 = await mark();
  await E(`__stopAll()`);
  const zero = await E(`__waitVn(${i0}, (m) => m.type === 'vn-state' && m.payload.liveMics === 0, 2000)`);
  check('stopping the track reports liveMics = 0 (state stays done)', zero && zero.payload.state === 'done', zero && zero.payload.state);

  // --- includeMic = true ----------------------------------------------------------------------
  i0 = await mark();
  await E(`__ui('vn-arm', { options: { includeMic: true, applyEffect: false, volume: 1 } })`);
  await E(`__gum()`);
  const m2 = await E(`__measure(__s, 1.2, 0.3)`);
  check('includeMic=true: file (440) and mic (140) both present during playback', m2.bands[440] > -20 && m2.bands[140] > -45, m2.bands);
  await E(`__waitVn(${i0}, (m) => m.type === 'vn-state' && m.payload.state === 'done', 5000)`);
  const m2b = await E(`__measure(__s, 1.2, 0.3)`);
  check('includeMic=true: mic audible after the file ends (~140 Hz)', near(m2b.f0, 140, 0.04) && m2b.rmsDb > -45 && m2b.bands[440] < -50, m2b);
  await E(`__stopAll()`);

  // --- trimming ------------------------------------------------------------------------------
  i0 = await mark();
  await E(`__ui('vn-arm', { options: { start: 1.0, end: 2.0, includeMic: false } })`);
  await E(`__gum()`);
  const tp = await E(`__waitVn(${i0}, (m) => m.type === 'vn-state' && m.payload.state === 'playing', 3000)`);
  const td = await E(`__waitVn(${i0}, (m) => m.type === 'vn-state' && m.payload.state === 'done', 4000)`);
  const trimDur = tp && td ? (td.at - tp.at) / 1000 : null;
  check('trim start=1.0 end=2.0 plays ~1 s', tp && td && near(trimDur, 1.0, 0.2) && near(td.payload.length, 1.0, 0.01) && near(td.payload.position, 1.0, 0.01), { seconds: trimDur, length: td && td.payload.length, options: td && td.payload.options });
  await E(`__stopAll()`);

  // --- applyEffect with the chipmunk preset ----------------------------------------------------
  await setPreset('chipmunk');
  await sleep(500);
  i0 = await mark();
  await E(`__ui('vn-arm', { options: { applyEffect: true, includeMic: false } })`);
  await E(`__gum()`);
  const m3 = await E(`__measure(__s, 1.2, 0.4, 1200)`);
  const chip = 440 * Math.pow(2, 10 / 12);
  check(`applyEffect=true + chipmunk shifts 440 Hz up (expect ~${chip.toFixed(0)} Hz)`, near(m3.f0, chip, 0.04) && m3.bands[785] > m3.bands[440] + 10, m3);
  await E(`__waitVn(${i0}, (m) => m.type === 'vn-state' && m.payload.state === 'done', 5000)`);
  await E(`__stopAll()`);
  await setPreset('natural');
  await sleep(500);

  // --- play now into an already-open mic --------------------------------------------------------
  i0 = await mark();
  await E(`__gum()`);
  const live = await E(`__waitVn(${i0}, (m) => m.type === 'vn-state' && m.payload.liveMics === 1, 3000)`);
  check('opening a mic posts VN_STATE with liveMics = 1', !!live, live && live.payload.state);
  const pre = await E(`__measure(__s, 0.8, 0.2)`);
  check('open mic carries the voice before play now (~140 Hz)', near(pre.f0, 140, 0.04), pre);
  i0 = await mark();
  await E(`__ui('vn-play-now', { options: { includeMic: false } })`);
  const m4 = await E(`__measure(__s, 1.0, 0.3)`);
  check('VN_PLAY_NOW into a live mic -> ~440 Hz', near(m4.f0, 440, 0.03) && m4.bands[140] < -50, m4);
  // stop mid playback via VN_STOP
  await E(`__ui('vn-stop')`);
  const stopped = await E(`__waitVn(${i0}, (m) => m.type === 'vn-state' && m.payload.state !== 'playing' && m.payload.state !== 'armed', 2000)`);
  check('VN_STOP mid-playback -> done (something played)', stopped && stopped.payload.state === 'done' && stopped.payload.position > 0.5 && stopped.payload.position < 3, stopped && stopped.payload);
  const m4b = await E(`__measure(__s, 0.8, 0.2)`);
  check('after VN_STOP the file is silent and the mic stays muted', m4b.rmsDb < -60, m4b);
  await E(`__stopAll()`);

  // --- arm expiry / disarm --------------------------------------------------------------------
  i0 = await mark();
  await E(`__ui('vn-arm', { options: {} })`);
  const a2 = await E(`__waitVn(${i0}, (m) => m.type === 'vn-state' && m.payload.state === 'armed')`);
  const left2 = a2 ? a2.payload.armedUntil - a2.now : null;
  await E(`__ui('vn-stop')`);
  const r2 = await E(`__waitVn(${i0}, (m) => m.type === 'vn-state' && m.payload.state === 'ready')`);
  check('arm timeout is 3 min; VN_STOP disarms to ready', near(left2, 180000, 0.01) && r2 && r2.payload.armedUntil === 0, { left: left2, state: r2 && r2.payload.state });
  await E(`__gum()`);
  const m5 = await E(`__measure(__s, 0.8, 0.3)`);
  check('after disarm the next mic is the normal voice (~140 Hz)', near(m5.f0, 140, 0.04) && m5.rmsDb > -45, m5);
  await E(`__stopAll()`);

  // --- stopping the processed track mid-playback ------------------------------------------------
  i0 = await mark();
  await E(`__ui('vn-arm', { options: { includeMic: false } })`);
  await E(`__gum()`);
  await E(`__waitVn(${i0}, (m) => m.type === 'vn-state' && m.payload.state === 'playing' && m.payload.position > 0.5, 3000)`);
  await E(`__stopAll()`);
  const end6 = await E(`__waitVn(${i0}, (m) => m.type === 'vn-state' && m.payload.state !== 'playing' && m.payload.state !== 'armed', 2000)`);
  await sleep(800);
  const last6 = await E(`__lastState()`);
  check('stopping the track mid-playback ends playback cleanly', end6 && last6.state === 'done' && last6.liveMics === 0 && last6.position > 0.4 && last6.position < 2.5, last6 && { state: last6.state, position: last6.position, liveMics: last6.liveMics });

  // --- stereo file + clear ------------------------------------------------------------------------
  i0 = await mark();
  await E(`(() => { const buf = __wav(3.0, 440, 2); __ui('vn-load', { name: 'stereo.wav', buffer: buf }, [buf]); return true; })()`);
  const ls = await E(`__waitVn(${i0}, (m) => m.type === 'vn-loaded' || m.type === 'vn-error', 8000)`);
  check('stereo WAV loads (2 channels, 3.0 s)', ls && ls.type === 'vn-loaded' && ls.payload.channels === 2 && near(ls.payload.duration, 3, 0.01) && ls.payload.peaks.length === 160, ls && { type: ls.type, ch: ls.payload.channels, d: ls.payload.duration, peakMax: ls.payload.peaks && Math.max(...ls.payload.peaks) });
  await E(`__ui('vn-arm', { options: { includeMic: false } })`);
  await E(`__gum()`);
  const m7 = await E(`__measure(__s, 1.0, 0.3)`);
  check('stereo file plays as mono ~440 Hz', near(m7.f0, 440, 0.03) && m7.rmsDb > -25, m7);
  await E(`__stopAll()`);
  i0 = await mark();
  await E(`__ui('vn-clear')`);
  const cl = await E(`__waitVn(${i0}, (m) => m.type === 'vn-state' && m.payload.state === 'empty')`);
  check('VN_CLEAR -> empty', cl && cl.payload.name === null && cl.payload.duration === 0, cl && cl.payload);
  i0 = await mark();
  await E(`__ui('vn-arm', { options: {} })`);
  const noFile = await E(`__waitVn(${i0}, (m) => m.type === 'vn-error', 2000)`);
  check('arming without a file -> VN_ERROR', !!noFile, noFile && noFile.payload);

  // --- regular mic still fine ---------------------------------------------------------------------
  await E(`__gum()`);
  const m8 = await E(`__measure(__s, 0.8, 0.3)`);
  check('microphone still works normally afterwards (~140 Hz)', near(m8.f0, 140, 0.04) && m8.rmsDb > -45, m8);
  await E(`__stopAll()`);

  const errs = wa.logs.filter((l) => /wvc|voice|worklet|\[exception\]/i.test(l));
  check('no console errors on WhatsApp Web', errs.length === 0, errs.slice(0, 8));
} catch (e) {
  check('voice-note e2e run completed', false, e.stack || e.message);
} finally {
  await b.close();
  if (ext.tmp) setTimeout(() => { try { fs.rmSync(ext.tmp, { recursive: true, force: true }); } catch {} }, 1600);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}
