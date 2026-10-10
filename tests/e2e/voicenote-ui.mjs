// E2E test for the in-page 🎵 "send an audio file as a voice note" widget (src/content/voicenote-ui.js).
// Real Chrome + the unpacked extension + the real web.whatsapp.com page (logged out).
// Fake microphone = tests/e2e/voice140.wav (140 Hz); the test file is a 330 Hz tone, so the pitch of the
// stream WhatsApp would record tells us whether the file (not the mic) is being sent.
//
//   node tests/e2e/voicenote-ui.mjs            (set EXT_PATH to test another copy of the extension)
import { launch, openPage, sleep } from './cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = process.env.EXT_PATH ? path.resolve(process.env.EXT_PATH) : path.resolve(here, '..', '..');
const OUT = path.join(here, 'out');
fs.mkdirSync(OUT, { recursive: true });
const micWav = path.join(here, 'voice140.wav');
if (!fs.existsSync(micWav)) {
  console.error('Missing tests/e2e/voice140.wav. Run: node tests/e2e/make-voice-wav.mjs');
  process.exit(2);
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  - ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
};

/* ---------------------------------------------------------------- test files */

function writeWav(file, { seconds, rate = 44100, channels = 2, freq = 330 }) {
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * channels * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    // 330 Hz "note" with a couple of harmonics and a gentle 2 Hz swell so the waveform has shape.
    const env = 0.55 + 0.35 * Math.sin(2 * Math.PI * 0.5 * t);
    const v = env * (0.6 * Math.sin(2 * Math.PI * freq * t) + 0.25 * Math.sin(2 * Math.PI * 2 * freq * t) + 0.1 * Math.sin(2 * Math.PI * 3 * freq * t));
    const s = Math.max(-1, Math.min(1, v * 0.8));
    for (let c = 0; c < channels; c++) data.writeInt16LE(Math.round(s * 32767), (i * channels + c) * 2);
  }
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(36 + data.length, 4);
  hdr.write('WAVE', 8);
  hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(channels, 22);
  hdr.writeUInt32LE(rate, 24);
  hdr.writeUInt32LE(rate * channels * 2, 28);
  hdr.writeUInt16LE(channels * 2, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36);
  hdr.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([hdr, data]));
}
const songPath = path.join(OUT, 'vn-test-song-330hz.wav');
writeWav(songPath, { seconds: 7, freq: 330 });
const junkPath = path.join(OUT, 'vn-not-audio.txt');
fs.writeFileSync(junkPath, 'this is not audio\n');

const MEASURE = `async (stream, secs = 1.6, warm = 0.5) => {
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
  const minLag = Math.floor(sr / 600), maxLag = Math.floor(sr / 55), W = Math.min(n - maxLag - 1, sr);
  let best = -1, bestLag = 0; const r = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) { let s = 0, e1 = 0, e2 = 0; for (let i = 0; i < W; i++) { s += x[i] * x[i + lag]; e1 += x[i] * x[i]; e2 += x[i + lag] * x[i + lag]; } r[lag] = s / Math.sqrt(e1 * e2 + 1e-12); }
  for (let lag = minLag; lag <= maxLag; lag++) if (r[lag] > best) { best = r[lag]; bestLag = lag; }
  for (let lag = minLag + 1; lag < bestLag; lag++) if (r[lag] > 0.9 * best && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) { bestLag = lag; break; }
  const a = r[bestLag - 1], b = r[bestLag], c = r[bestLag + 1]; const d = (a - c) / (2 * (a - 2 * b + c) || 1);
  return { f0: sr / (bestLag + (Number.isFinite(d) ? d : 0)), clarity: best, rmsDb: 20 * Math.log10(rms + 1e-9), n, sr };
}`;

/* ---------------------------------------------------------------- run */

const b = await launch({ headless: true, extraArgs: [`--use-file-for-fake-audio-capture=${micWav}`] });
let wa;
try {
  const { id: extId } = await b.send('Extensions.loadUnpacked', { path: EXT });
  check('extension loads', !!extId, extId);
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  const iso = manifest.content_scripts.find((c) => c.world !== 'MAIN');
  check('manifest lists voicenote-ui.js in the ISOLATED entry after bridge.js', iso && iso.js.indexOf('src/content/voicenote-ui.js') > iso.js.indexOf('src/content/bridge.js'), iso && iso.js);

  const ctl = await openPage(b, `chrome-extension://${extId}/src/popup/popup.html`);
  await sleep(1200);
  const setSettings = (patch) =>
    ctl.evaluate(`(async () => { const got = await chrome.storage.local.get(WVC.STORAGE_KEYS.SETTINGS); const s = WVC.normalizeSettings(Object.assign({}, got[WVC.STORAGE_KEYS.SETTINGS], ${JSON.stringify(patch)})); await chrome.storage.local.set({ [WVC.STORAGE_KEYS.SETTINGS]: s }); return s; })()`);
  await setSettings({ enabled: true, presetId: 'natural', params: {}, fileButton: true });

  // --- WhatsApp Web, collecting execution contexts so we can find the extension's ISOLATED world.
  wa = await openPage(b, null);
  const contexts = [];
  b.on((msg) => {
    if (msg.sessionId === wa.sessionId && msg.method === 'Runtime.executionContextCreated') contexts.push(msg.params.context);
    if (msg.sessionId === wa.sessionId && msg.method === 'Runtime.executionContextDestroyed') {
      const i = contexts.findIndex((c) => c.id === msg.params.executionContextId);
      if (i >= 0) contexts.splice(i, 1);
    }
  });
  await wa.s('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await wa.s('DOM.enable');
  await wa.s('Page.navigate', { url: 'https://web.whatsapp.com/' });
  await sleep(7000);
  const { frameTree } = await wa.s('Page.getFrameTree');
  const topFrame = frameTree.frame.id;
  const isoCtx = contexts.find((c) => c.auxData && c.auxData.frameId === topFrame && c.auxData.type === 'isolated' && /Voice Changer/i.test(c.name));
  check('found the extension ISOLATED world in the top frame', !!isoCtx, isoCtx && { id: isoCtx.id, name: isoCtx.name });

  // Resolve the closed shadow root into the isolated world (CDP pierces closed roots).
  async function shadow() {
    const { root } = await wa.s('DOM.getDocument', { depth: -1, pierce: true });
    let hostNode = null;
    const walk = (n) => {
      if (hostNode) return;
      if (n.nodeName === 'WVC-VOICENOTE') hostNode = n;
      for (const c of n.children || []) walk(c);
    };
    walk(root);
    if (!hostNode || !hostNode.shadowRoots || !hostNode.shadowRoots.length) return null;
    const { object } = await wa.s('DOM.resolveNode', { backendNodeId: hostNode.shadowRoots[0].backendNodeId, executionContextId: isoCtx.id });
    return { hostNode, objectId: object.objectId, mode: hostNode.shadowRoots[0].shadowRootType, parent: hostNode.parentId === root.children.find((c) => c.nodeName === 'HTML')?.nodeId };
  }
  let sh = await shadow();
  check('widget host is attached to <html> with a closed shadow root', sh && sh.mode === 'closed' && sh.parent, sh && { mode: sh.mode, onHtml: sh.parent });
  const q = async (fn, byValue = true) => {
    const r = await wa.s('Runtime.callFunctionOn', { objectId: sh.objectId, functionDeclaration: fn, returnByValue: byValue, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return byValue ? r.result.value : r.result.objectId;
  };
  const ui = () =>
    q(`function () {
      const $ = (s) => this.querySelector(s);
      const vis = (n) => { if (!n) return false; for (let x = n; x && x !== this; x = x.parentNode) if (x.hidden) return false; return true; };
      const r = $('.fab').getBoundingClientRect();
      return {
        fab: !$('.fab').hidden, fabRect: { x: r.x, y: r.y, w: r.width, h: r.height }, fabExpanded: $('.fab').getAttribute('aria-expanded'),
        panel: !$('.panel').hidden,
        empty: vis($('.drop')), loading: vis($('.loading')), editor: vis($('.file')), actions: vis($('.acts')),
        armed: vis($('.stage.armed')), playing: vis($('.stage.playing')), done: vis($('.stage.done')),
        err: vis($('.err')) ? $('.err').textContent : '',
        fname: $('.fname').textContent, fdur: $('.fdur').textContent, startOut: $('output[for="wvc-vn-start"]').textContent, endOut: $('output[for="wvc-vn-end"]').textContent,
        seln: $('.seln').textContent, countdown: $('.stage.armed span span') ? $('.stage.armed span span').textContent : '',
        bar: $('.bar i').style.width, ptime: $('.stage.playing .srow span').textContent,
        playNowDisabled: $('.acts .btn:not(.pri):not(.danger)').disabled, curStep: [...this.querySelectorAll('.step')].findIndex((s) => s.classList.contains('cur')),
        focus: this.activeElement ? (this.activeElement.className || this.activeElement.tagName) + ':' + (this.activeElement.textContent || '').slice(0, 30) : null,
      };
    }`);
  const click = (sel) => q(`function () { this.querySelector(${JSON.stringify(sel)}).click(); return true; }`);
  const waitFor = async (pred, ms = 8000) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < ms) {
      last = await ui();
      if (pred(last)) return last;
      await sleep(150);
    }
    return last;
  };
  const shot = async (name) => {
    const r = await wa.s('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `vn-${name}.png`), Buffer.from(r.data, 'base64'));
  };

  let u = await ui();
  check('FAB exists and panel starts closed', u.fab && !u.panel && u.fabRect.w > 30 && u.fabRect.x > 1280 - 80, u.fabRect);
  await shot('0-fab');

  // --- dragging the FAB moves it and persists fabY; a drag is not a click
  const cx = u.fabRect.x + u.fabRect.w / 2, cy = u.fabRect.y + u.fabRect.h / 2;
  await wa.s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
  await wa.s('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 6; i++) await wa.s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy - i * 25, button: 'left', buttons: 1 });
  await wa.s('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy - 150, button: 'left', clickCount: 1 });
  await sleep(400);
  const afterDrag = await ui();
  const storedUI = await ctl.evaluate(`chrome.storage.local.get('wvc.ui').then((v) => v['wvc.ui'] || null)`);
  check('dragging the FAB moves it up and stores fabY', Math.abs(afterDrag.fabRect.y - (u.fabRect.y - 150)) < 3 && !afterDrag.panel && storedUI && typeof storedUI.fabY === 'number', { y0: u.fabRect.y, y1: afterDrag.fabRect.y, stored: storedUI, panelOpened: afterDrag.panel });

  // --- a real click (no drag) opens the panel
  const c2x = afterDrag.fabRect.x + afterDrag.fabRect.w / 2, c2y = afterDrag.fabRect.y + afterDrag.fabRect.h / 2;
  await wa.s('Input.dispatchMouseEvent', { type: 'mousePressed', x: c2x, y: c2y, button: 'left', clickCount: 1 });
  await wa.s('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c2x, y: c2y, button: 'left', clickCount: 1 });
  u = await waitFor((x) => x.panel, 2000);
  check('clicking the FAB opens the panel in the empty state', u.panel && u.empty && !u.editor && u.fabExpanded === 'true' && u.curStep === 0, { panel: u.panel, empty: u.empty, step: u.curStep });
  await sleep(300);
  await shot('1-empty');

  // --- a non-audio file is refused client-side
  const inputId = await q(`function () { return this.querySelector('input[type=file]'); }`, false);
  await wa.s('DOM.setFileInputFiles', { files: [junkPath], objectId: inputId });
  u = await waitFor((x) => !!x.err, 2000);
  check('non-audio file is rejected with a readable error', /doesn.t look like an audio file/.test(u.err) && u.empty, u.err);

  // --- load the song
  await wa.s('DOM.setFileInputFiles', { files: [songPath], objectId: inputId });
  u = await waitFor((x) => x.editor && x.actions, 15000);
  check('file loads -> ready state with name and duration', u.editor && u.actions && !u.err && u.fname === path.basename(songPath) && /^0:07 total$/.test(u.fdur), { fname: u.fname, fdur: u.fdur, err: u.err });
  const wave = await q(`function () {
    const c = this.querySelector('canvas'); const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data;
    let green = 0, grey = 0; for (let i = 0; i < d.length; i += 4) { if (d[i + 1] > 150 && d[i] < 120 && d[i + 3] > 200) green++; else if (d[i + 3] > 40 && Math.abs(d[i] - d[i + 1]) < 20) grey++; }
    return { w: c.width, h: c.height, green, grey };
  }`);
  check('waveform is drawn', wave.w > 200 && wave.green > 1500, wave);
  check('Play now is disabled while no mic is live', u.playNowDisabled === true);
  await shot('2-ready');

  // --- move the trim start to 1.0 s
  await q(`function () { const s = this.querySelector('#wvc-vn-start'); s.value = '1'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; }`);
  u = await ui();
  const wave2 = await q(`function () { const c = this.querySelector('canvas'); const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; let grey = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 40 && d[i + 3] < 160 && d[i] > 150 && d[i + 1] > 150 && d[i + 2] > 150) grey++; return grey; }`);
  check('trim start moves to 0:01.0 and the waveform shows the cut', u.startOut === '0:01.0' && u.endOut === '0:07.0' && /6\.0/.test(u.seln) && wave2 > 100, { startOut: u.startOut, endOut: u.endOut, seln: u.seln, greyPixels: wave2 });
  await shot('3-trimmed');

  // --- preview plays the selected part from the blob: URL (WhatsApp's CSP must allow it)
  await click('.play');
  await sleep(900);
  const pv = await q(`function () { const a = this.querySelector('audio'); return { t: a.currentTime, paused: a.paused, err: a.error && a.error.code, label: this.querySelector('.play').getAttribute('aria-label') }; }`);
  await click('.play');
  const pv2 = await q(`function () { const a = this.querySelector('audio'); return { paused: a.paused, label: this.querySelector('.play').getAttribute('aria-label') }; }`);
  check('preview plays from the trim start and stops again', !pv.err && !pv.paused && pv.t > 1.3 && pv.t < 2.6 && pv.label === 'Stop preview' && pv2.paused, { pv, pv2 });

  // --- Arm
  await click('.btn.pri.wide');
  u = await waitFor((x) => x.armed, 3000);
  check('Arm -> armed UI with countdown', u.armed && !u.actions && /^[23]:\d\d$/.test(u.countdown) && u.curStep === 1 && /Cancel/.test(u.focus || ''), { armed: u.armed, countdown: u.countdown, step: u.curStep, focus: u.focus });
  await shot('4-armed');

  // --- WhatsApp's 🎤 = getUserMedia in the MAIN world; the file should now be what is "recorded"
  await wa.evaluate(`window.__measure = ${MEASURE}; true`);
  await wa.evaluate(`(async () => { window.__s = await navigator.mediaDevices.getUserMedia({ audio: true }); return true; })()`);
  u = await waitFor((x) => x.playing, 4000);
  check('mic request starts playback -> playing UI', u.playing && !u.armed && u.curStep === 1, { playing: u.playing, ptime: u.ptime });
  const m = await wa.evaluate(`__measure(__s, 1.5, 0.3)`);
  check('recorded stream carries the file (~330 Hz), not the 140 Hz mic', Math.abs(m.f0 / 330 - 1) < 0.04 && m.rmsDb > -40, m);
  u = await ui();
  check('progress bar and time advance while playing', u.playing && parseFloat(u.bar) > 10 && /^0:0[1-6] \/ 0:06$/.test(u.ptime), { bar: u.bar, ptime: u.ptime });
  await shot('5-playing');
  u = await waitFor((x) => x.done, 8000);
  check('natural end -> done UI ("press Send")', u.done && u.actions && u.curStep === 2, { done: u.done });
  await sleep(300);
  await shot('6-done');
  const after = await wa.evaluate(`__measure(__s, 1.0, 0.2)`);
  check('mic stays muted for the rest of that recording (includeMic off)', after.rmsDb < -60, after);
  u = await ui();
  check('Play now is enabled while a mic is live', u.playNowDisabled === false);
  await wa.evaluate(`__s.getTracks().forEach((t) => t.stop()); true`);

  // --- Escape closes the panel and returns focus to the FAB
  await q(`function () { this.querySelector('.x').focus(); return true; }`);
  await wa.s('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await wa.s('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  u = await waitFor((x) => !x.panel, 1500);
  check('Escape closes the panel and focuses the FAB', !u.panel && /fab/.test(u.focus || ''), { panel: u.panel, focus: u.focus });

  // --- settings.fileButton = false hides the FAB live
  await setSettings({ fileButton: false });
  u = await waitFor((x) => !x.fab, 2000);
  check('fileButton=false hides the FAB', !u.fab, { fab: u.fab });
  await shot('7-hidden');

  // --- the popup's RT_OPEN_VOICENOTE still opens the panel
  const rt = await ctl.evaluate(`(async () => { const [tab] = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' }); return chrome.tabs.sendMessage(tab.id, { type: WVC.MSG.RT_OPEN_VOICENOTE }, { frameId: 0 }); })()`);
  u = await waitFor((x) => x.panel, 2000);
  check('RT_OPEN_VOICENOTE opens the panel even with the FAB hidden', rt && rt.ok === true && u.panel && !u.fab, { rt, panel: u.panel });
  await sleep(300);
  await shot('8-open-from-popup');

  // --- Remove file -> empty
  await click('.btn.danger');
  u = await waitFor((x) => x.empty, 2000);
  check('Remove file -> empty state', u.empty && !u.editor, { empty: u.empty });
  await setSettings({ fileButton: true });
  u = await waitFor((x) => x.fab, 2000);
  check('fileButton=true shows the FAB again', u.fab);

  // --- persistence of the UI options + fabY
  const stored2 = await ctl.evaluate(`chrome.storage.local.get(null).then((v) => ({ ui: v['wvc.ui'], fileButton: v['wvc.settings'].fileButton }))`);
  check('wvc.ui keeps fabY, settings keep fileButton', stored2.ui && typeof stored2.ui.fabY === 'number' && stored2.fileButton === true, stored2);

  // --- Studio toggle is bound to settings.fileButton
  const studio = await openPage(b, `chrome-extension://${extId}/src/options/options.html`);
  await sleep(1500);
  const st1 = await studio.evaluate(`document.getElementById('fileButton').checked`);
  await studio.evaluate(`(() => { const c = document.getElementById('fileButton'); c.click(); return c.checked; })()`);
  await sleep(500);
  const fb = await ctl.evaluate(`chrome.storage.local.get('wvc.settings').then((v) => v['wvc.settings'].fileButton)`);
  u = await waitFor((x) => !x.fab, 2000);
  check('Studio toggle writes fileButton and the FAB reacts', st1 === true && fb === false && !u.fab, { before: st1, stored: fb, fab: u.fab });
  // popup write must keep fileButton=false
  await ctl.evaluate(`(() => { document.getElementById('enabled').click(); return true; })()`);
  await sleep(400);
  const fb2 = await ctl.evaluate(`chrome.storage.local.get('wvc.settings').then((v) => v['wvc.settings'])`);
  check('a popup write keeps fileButton=false', fb2.fileButton === false && fb2.enabled === false, { fileButton: fb2.fileButton, enabled: fb2.enabled });
  const st2 = await studio.evaluate(`document.getElementById('fileButton').checked`);
  check('Studio stays in sync after the popup write', st2 === false);
  await studio.evaluate(`(() => { document.getElementById('fileButton').click(); return true; })()`);
  await sleep(400);
  await ctl.evaluate(`(() => { document.getElementById('enabled').click(); return true; })()`);
  await sleep(500);

  // --- console hygiene
  const errs = wa.logs.filter((l) => /\[exception\]|voicenote|wvc/i.test(l) && !/\[debug\]/.test(l));
  check('no extension errors in the WhatsApp console', errs.length === 0, errs.slice(0, 6));

  // --- popup screenshot (active tab is not WhatsApp here -> button disabled with hint)
  const pp = await openPage(b, null);
  await pp.s('Emulation.setDeviceMetricsOverride', { width: 380, height: 600, deviceScaleFactor: 1, mobile: false });
  await pp.s('Page.navigate', { url: `chrome-extension://${extId}/src/popup/popup.html` });
  await sleep(1500);
  const pinfo = await pp.evaluate(`(() => { const b = document.getElementById('voiceNote'); const r = b.getBoundingClientRect(); return { disabled: b.disabled, hint: !document.getElementById('voiceNoteHint').hidden, bottom: document.querySelector('.ftr').getBoundingClientRect().bottom, sh: document.documentElement.scrollHeight, top: r.top }; })()`);
  check('popup: 🎵 button present, disabled with a hint off WhatsApp, fits 600 px', pinfo.disabled && pinfo.hint && pinfo.bottom <= 600 && pinfo.sh <= 600, pinfo);
  const ps = await pp.s('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'vn-popup.png'), Buffer.from(ps.data, 'base64'));
  const sp = await openPage(b, null);
  await sp.s('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1400, deviceScaleFactor: 1, mobile: false });
  await sp.s('Page.navigate', { url: `chrome-extension://${extId}/src/options/options.html` });
  await sleep(1500);
  await sp.evaluate(`(() => { const d = [...document.querySelectorAll('.help details')].find((x) => /audio file/.test(x.textContent)); if (d) d.open = true; document.getElementById('callTitle').scrollIntoView(); return !!d; })()`);
  await sleep(300);
  const clip = await sp.evaluate(`(() => { const a = document.getElementById('callTitle').closest('.two-col').getBoundingClientRect(); const d = [...document.querySelectorAll('.help details')].find((x) => /audio file/.test(x.textContent)).getBoundingClientRect(); return { x: a.left + scrollX - 8, y: a.top + scrollY - 8, width: a.width + 16, height: d.bottom - a.top + 16, scale: 1 }; })()`);
  const ss = await sp.s('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
  fs.writeFileSync(path.join(OUT, 'vn-studio.png'), Buffer.from(ss.data, 'base64'));
  const studioErrs = [...studio.logs, ...sp.logs, ...pp.logs].filter((l) => /error|exception/i.test(l));
  check('popup/studio have no console errors', studioErrs.length === 0, studioErrs.slice(0, 6));
} catch (e) {
  check('voice-note UI e2e run completed', false, e.stack || e.message);
} finally {
  await b.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  fs.writeFileSync(path.join(OUT, 'voicenote-ui-results.json'), JSON.stringify(results, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}
