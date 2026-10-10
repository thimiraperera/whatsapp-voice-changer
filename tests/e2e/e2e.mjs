// End-to-end test: real Chrome + the unpacked extension + the real web.whatsapp.com page (logged out),
// synthetic 140 Hz "voice" as the fake microphone. Measures the pitch of the stream WhatsApp would receive.
import { launch, openPage, sleep } from './cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '..', '..');
const wav = path.join(here, 'voice140.wav');
if (!fs.existsSync(wav)) {
  console.error('Missing tests/e2e/voice140.wav. Run: node tests/e2e/make-voice-wav.mjs');
  process.exit(2);
}
if (!fs.existsSync(wav)) { console.error('Run: node tests/e2e/make-voice-wav.mjs first'); process.exit(2); }
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  - ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); };

const MEASURE = `async (stream, secs = 1.6, warm = 0.8) => {
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
  // normalized autocorrelation pitch
  const minLag = Math.floor(sr / 600), maxLag = Math.floor(sr / 55), W = Math.min(n - maxLag - 1, sr);
  let best = -1, bestLag = 0; const r = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) { let s = 0, e1 = 0, e2 = 0; for (let i = 0; i < W; i++) { s += x[i] * x[i + lag]; e1 += x[i] * x[i]; e2 += x[i + lag] * x[i + lag]; } r[lag] = s / Math.sqrt(e1 * e2 + 1e-12); }
  for (let lag = minLag; lag <= maxLag; lag++) if (r[lag] > best) { best = r[lag]; bestLag = lag; }
  // prefer the smallest lag whose peak is within 90% of the best (avoid octave errors)
  for (let lag = minLag + 1; lag < bestLag; lag++) if (r[lag] > 0.9 * best && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) { bestLag = lag; break; }
  const a = r[bestLag - 1], b = r[bestLag], c = r[bestLag + 1]; const d = (a - c) / (2 * (a - 2 * b + c) || 1);
  return { f0: sr / (bestLag + (Number.isFinite(d) ? d : 0)), clarity: best, rmsDb: 20 * Math.log10(rms + 1e-9), n, sr };
}`;

const b = await launch({ headless: true, extraArgs: [`--use-file-for-fake-audio-capture=${wav}`] });
try {
  const { id: extId } = await b.send('Extensions.loadUnpacked', { path: EXT });
  check('extension loads', !!extId, extId);

  // Extension page used as a settings controller
  const ctl = await openPage(b, `chrome-extension://${extId}/src/popup/popup.html`);
  await sleep(1500);
  const setPreset = async (presetId, extra = {}) => ctl.evaluate(`(async () => {
    const custom = [];
    const s = WVC.normalizeSettings(Object.assign({ enabled: true, presetId: ${JSON.stringify(presetId)}, params: WVC.presetParams(${JSON.stringify(presetId)}), monitor: false }, ${JSON.stringify(extra)}));
    await chrome.storage.local.set({ [WVC.STORAGE_KEYS.SETTINGS]: s });
    return s.presetId + ' enabled=' + s.enabled;
  })()`);
  const cmds = await ctl.evaluate(`chrome.commands.getAll().then(c => c.filter(x => x.name !== '_execute_action').map(x => x.name + '=' + x.shortcut))`);
  check('keyboard shortcuts get assigned', cmds.length === 2 && cmds.every((c) => /=.+/.test(c)), cmds);
  const stored = await ctl.evaluate(`chrome.storage.local.get(null).then(v => v)`);
  check('defaults written on install', stored && stored['wvc.settings'] && typeof stored['wvc.settings'].enabled === 'boolean', Object.keys(stored || {}));

  // WhatsApp Web
  await setPreset('deep');
  const wa = await openPage(b, 'https://web.whatsapp.com/');
  await sleep(7000);
  const env = await wa.evaluate(`({
    hasWVC: typeof WVC === 'object', hasEngine: !!(window.WVC && WVC.VoiceEngine), hasDSP: typeof WVCDSP === 'object',
    gumToString: MediaDevices.prototype.getUserMedia.toString(), gumName: MediaDevices.prototype.getUserMedia.name, gumLen: MediaDevices.prototype.getUserMedia.length,
  })`);
  check('MAIN-world scripts present on WhatsApp Web', env.hasWVC && env.hasEngine && env.hasDSP, env);
  check('patched getUserMedia looks native', /\[native code\]/.test(env.gumToString) && env.gumName === 'getUserMedia', env.gumToString);

  await wa.evaluate(`window.__measure = ${MEASURE}; true`);
  await wa.evaluate(`(async () => { window.__s = await navigator.mediaDevices.getUserMedia({ audio: true }); return true; })()`);
  const trk = await wa.evaluate(`(() => { const t = __s.getAudioTracks()[0]; return { label: t.label, kind: t.kind, state: t.readyState, settings: t.getSettings(), n: __s.getAudioTracks().length }; })()`);
  check('processed track looks like the mic', trk.kind === 'audio' && trk.state === 'live' && /Fake/i.test(trk.label), trk);

  const expect = { deep: 140 * Math.pow(2, -5 / 12), natural: 140, higher: 140 * Math.pow(2, 5 / 12), robot: 110, chipmunk: 140 * Math.pow(2, 10 / 12), giant: 140 * Math.pow(2, -10 / 12) };
  const m1 = await wa.evaluate(`__measure(__s)`);
  check('deep preset lowers pitch (expect ~' + expect.deep.toFixed(0) + ' Hz)', Math.abs(m1.f0 / expect.deep - 1) < 0.05, m1);

  for (const id of ['natural', 'higher', 'chipmunk', 'giant']) {
    await setPreset(id);
    await sleep(400);
    const m = await wa.evaluate(`__measure(__s)`);
    check(`live switch to "${id}" (expect ~${expect[id].toFixed(0)} Hz)`, Math.abs(m.f0 / expect[id] - 1) < 0.06 && m.rmsDb > -45, m);
  }

  // Robot texture on its own (the Robot preset also adds ring-mod + echo, which confuses a plain pitch detector)
  await ctl.evaluate(`(async () => { const s = WVC.normalizeSettings({ enabled: true, presetId: 'robot', params: Object.assign(WVC.defaultParams(), { texture: 'robot', robotPitch: 110 }) }); await chrome.storage.local.set({ [WVC.STORAGE_KEYS.SETTINGS]: s }); return true; })()`);
  await sleep(400);
  const rb = await wa.evaluate(`__measure(__s)`);
  check('robot texture is monotone at robotPitch (expect ~110 Hz)', Math.abs(rb.f0 / 110 - 1) < 0.04, rb);
  await setPreset('robot'); await sleep(400);
  const rp = await wa.evaluate(`__measure(__s)`);
  check('robot preset produces a loud, strongly periodic voice', rp.clarity > 0.8 && rp.rmsDb > -45, rp);

  await setPreset('giant', { enabled: false });
  await sleep(400);
  const off = await wa.evaluate(`__measure(__s)`);
  check('master switch off mid-call -> original voice (~140 Hz)', Math.abs(off.f0 / 140 - 1) < 0.04 && off.rmsDb > -45, off);

  // Status plumbing to the service worker
  await setPreset('deep');
  await sleep(600);
  const st = await ctl.evaluate(`(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
    if (!tabs.length) return { error: 'no tab' };
    return chrome.runtime.sendMessage({ type: WVC.MSG.RT_GET_STATUS, tabId: tabs[0].id });
  })()`);
  check('service worker reports a live stream for the WhatsApp tab', st && st.status && st.status.active >= 1, st);

  // Video + audio request keeps the video track
  const av = await wa.evaluate(`(async () => { const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }); const r = { a: s.getAudioTracks().length, v: s.getVideoTracks().length }; s.getTracks().forEach(t => t.stop()); return r; })()`);
  check('audio+video call stream keeps its video track', av.a === 1 && av.v === 1, av);

  // Legacy callback API
  const legacy = await wa.evaluate(`new Promise((res) => { const f = navigator.webkitGetUserMedia || navigator.getUserMedia; if (!f) return res('absent'); f.call(navigator, { audio: true }, (s) => { const l = s.getAudioTracks()[0].label; s.getTracks().forEach(t => t.stop()); res('ok ' + l); }, (e) => res('err ' + e)); })`);
  check('legacy webkitGetUserMedia works', /^ok|absent/.test(legacy), legacy);

  // Stop -> status goes back to 0
  await wa.evaluate(`__s.getTracks().forEach(t => t.stop()); true`);
  await sleep(800);
  const st2 = await ctl.evaluate(`(async () => { const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' }); return chrome.runtime.sendMessage({ type: WVC.MSG.RT_GET_STATUS, tabId: tabs[0].id }); })()`);
  check('stopping the track ends processing (active = 0)', st2 && st2.status && st2.status.active === 0, st2);

  // Audio-only permissionless path: a video-only request must be untouched
  const vid = await wa.evaluate(`(async () => { const s = await navigator.mediaDevices.getUserMedia({ video: true }); const r = { a: s.getAudioTracks().length, v: s.getVideoTracks().length }; s.getTracks().forEach(t => t.stop()); return r; })()`);
  check('video-only request passes through', vid.a === 0 && vid.v === 1, vid);

  const waErrors = wa.logs.filter((l) => /wvc|voice|worklet|\[exception\]/i.test(l));
  check('no extension errors in WhatsApp console', waErrors.length === 0, waErrors.slice(0, 8));

  // Screenshots of the UI surfaces
  for (const [name, url, w, h] of [
    ['popup', `chrome-extension://${extId}/src/popup/popup.html`, 380, 600],
    ['studio', `chrome-extension://${extId}/src/options/options.html`, 1360, 1800],
    ['studio-narrow', `chrome-extension://${extId}/src/options/options.html`, 720, 1800],
  ]) {
    const p = await openPage(b, null);
    await p.s('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await p.s('Page.navigate', { url });
    await sleep(1800);
    const shot = await p.s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.mkdirSync(path.join(here, 'out'), { recursive: true }); fs.writeFileSync(path.join(here, 'out', `shot-${name}.png`), Buffer.from(shot.data, 'base64'));
    const errs = p.logs.filter((l) => /error|exception/i.test(l));
    check(`${name} page renders without console errors`, errs.length === 0, errs.slice(0, 6));
  }
} catch (e) {
  check('e2e run completed', false, e.stack || e.message);
} finally {
  await b.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  fs.mkdirSync(path.join(here, 'out'), { recursive: true }); fs.writeFileSync(path.join(here, 'out', 'e2e-results.json'), JSON.stringify(results, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}
