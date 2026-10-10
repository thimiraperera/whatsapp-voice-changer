/*
 * The 🎵 "send an audio file as a voice note" widget on WhatsApp Web.
 *
 * ISOLATED world, top frame only. Draws a draggable round button (the FAB) on the right edge and a
 * panel, both inside a closed shadow root on <html> with the CSS inline. It doesn't touch WhatsApp's
 * DOM or CSS, doesn't click anything for the user and only listens for keys inside its own panel.
 *
 * Decoding, arming and playing into the microphone track happen in inject.js (MAIN world).
 * This file talks to it with window.postMessage, see docs/how-it-works.md.
 *
 * Like bridge.js it can't use params.js (it isn't injected into the ISOLATED world), so the
 * constants below are copies of WVC.MSG / WVC.STORAGE_KEYS / WVC.VN_*. Keep them in sync.
 */
(function () {
  'use strict';

  try {
    if (window.top !== window) return;
    const GUARD = Symbol.for('wvc.voicenote-ui.installed');
    if (globalThis[GUARD]) return;
    Object.defineProperty(globalThis, GUARD, { value: true, enumerable: false });
  } catch (_) {
    return;
  }

  /* ------------------------------------------------------------ mirrored constants */

  const SRC_UI = 'wvc-ui';
  const SRC_MAIN = 'wvc-main';
  const T = {
    LOAD: 'vn-load',
    ARM: 'vn-arm',
    PLAY_NOW: 'vn-play-now',
    STOP: 'vn-stop',
    CLEAR: 'vn-clear',
    QUERY: 'vn-query',
    LOADED: 'vn-loaded',
    STATE: 'vn-state',
    ERROR: 'vn-error',
  };
  const RT_OPEN_VOICENOTE = 'wvc:open-voicenote';
  const KEY_SETTINGS = 'wvc.settings';
  const KEY_UI = 'wvc.ui';
  const VN_PEAKS = 160;
  const VN_MAX_BYTES = 150 * 1024 * 1024;
  const VN_MAX_SECONDS = 30 * 60;
  const LOAD_TIMEOUT_MS = 45000;
  const DEFAULT_FAB_Y = 0.68;
  const FAB_SIZE = 46;
  const EDGE = 12;
  const ACCEPT = 'audio/*,video/*,.mp3,.m4a,.aac,.wav,.ogg,.oga,.opus,.flac,.webm,.mp4';

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function defaultOptions() {
    return { start: 0, end: null, applyEffect: false, includeMic: false, volume: 1 };
  }
  function normalizeOptions(o, duration) {
    const src = o && typeof o === 'object' ? o : {};
    const dur = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
    let start = Number(src.start);
    start = Number.isFinite(start) ? clamp(start, 0, dur) : 0;
    let end = src.end == null ? null : Number(src.end);
    if (end != null && (!Number.isFinite(end) || end <= start + 0.05)) end = null;
    if (end != null && end > dur) end = null;
    const vol = Number(src.volume);
    return {
      start,
      end,
      applyEffect: typeof src.applyEffect === 'boolean' ? src.applyEffect : false,
      includeMic: typeof src.includeMic === 'boolean' ? src.includeMic : false,
      volume: Number.isFinite(vol) ? clamp(vol, 0, 1.5) : 1,
    };
  }
  function emptyState() {
    return { state: 'empty', name: null, duration: 0, position: 0, length: 0, armedUntil: 0, liveMics: 0, options: defaultOptions() };
  }

  /* ------------------------------------------------------------ extension context */

  let ctxAlive = true;
  function extOK() {
    try {
      return ctxAlive && typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }
  function extDead() {
    ctxAlive = false;
  }
  async function storageGet(key) {
    if (!extOK()) return undefined;
    try {
      const got = await chrome.storage.local.get(key);
      return got ? got[key] : undefined;
    } catch (_) {
      if (!extOK()) extDead();
      return undefined;
    }
  }
  let uiWriteChain = Promise.resolve();
  function saveUI(patch) {
    if (!extOK()) return;
    // Read-modify-write so several WhatsApp tabs never drop each other's keys.
    uiWriteChain = uiWriteChain
      .then(async () => {
        if (!extOK()) return;
        const cur = await storageGet(KEY_UI);
        const next = Object.assign({}, cur && typeof cur === 'object' ? cur : {}, patch);
        await chrome.storage.local.set({ [KEY_UI]: next });
      })
      .catch(() => {
        if (!extOK()) extDead();
      });
  }

  /* ------------------------------------------------------------ page messaging */

  function targetOrigin() {
    try {
      const o = window.location.origin;
      return o && o !== 'null' ? o : '*';
    } catch (_) {
      return '*';
    }
  }
  function post(type, payload, transfer) {
    try {
      window.postMessage({ __wvc: true, source: SRC_UI, type, payload: payload || {} }, targetOrigin(), transfer || []);
      return true;
    } catch (err) {
      return false;
    }
  }

  /* ------------------------------------------------------------ state */

  const S = {
    vn: emptyState(), // last VN_STATE from MAIN
    peaks: null, // Float32Array-like 0..1
    fileURL: null, // blob URL of the chosen file, for preview
    fileName: '',
    localLoading: false, // reading / waiting for MAIN to confirm
    loadTimer: 0,
    error: '',
    opts: defaultOptions(), // current panel options (start/end are per file)
    fabY: DEFAULT_FAB_Y,
    fabVisible: true, // settings.fileButton
    open: false,
    mounted: false,
    previewing: false,
  };

  /* ------------------------------------------------------------ CSS */

  const CSS = `
:host {
  all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important;
  z-index: 2147483000 !important; pointer-events: none !important; display: block !important; overflow: visible !important;
  contain: none !important; transform: none !important; filter: none !important; opacity: 1 !important; visibility: visible !important;
}
*, *::before, *::after { box-sizing: border-box; }
.root {
  --bg: #111b21; --bg2: #18252c; --bg3: #20303a; --line: rgba(233,237,239,.10); --line2: rgba(233,237,239,.18);
  --text: #e9edef; --dim: #aebac1; --faint: #8696a0; --accent: #25d366; --accent2: #1fb85a; --ink: #06250f;
  --soft: rgba(37,211,102,.14); --live: #ff5c6c; --warn: #ffb547;
  font: 13.5px/1.4 'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif;
  color: var(--text); -webkit-font-smoothing: antialiased; letter-spacing: normal; text-align: left;
}
button, input { font: inherit; color: inherit; margin: 0; }
button { cursor: pointer; }
[hidden] { display: none !important; }
:focus { outline: none; }
:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(37,211,102,.55); }
.sr { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; padding: 0; margin: -1px; }

/* ---------- FAB */
.fab {
  position: fixed; right: ${EDGE}px; top: 60%; width: ${FAB_SIZE}px; height: ${FAB_SIZE}px; border-radius: 50%;
  border: 2px solid rgba(255,255,255,.9); background: var(--accent); color: var(--ink); padding: 0;
  display: grid; place-items: center; pointer-events: auto; touch-action: none; user-select: none;
  box-shadow: 0 6px 18px rgba(0,0,0,.35), 0 1px 3px rgba(0,0,0,.3);
  transition: transform .15s ease, box-shadow .15s ease, background .15s ease;
}
.fab:hover { transform: scale(1.06); box-shadow: 0 8px 22px rgba(0,0,0,.42); }
.fab.dragging { transform: scale(1.1); cursor: grabbing; transition: none; }
.fab.open { background: #0e1a1f; color: var(--accent); border-color: var(--accent); }
.fab svg { width: 22px; height: 22px; display: block; pointer-events: none; }
.fab .badge { position: absolute; top: -2px; right: -2px; width: 13px; height: 13px; border-radius: 50%; border: 2px solid #fff; background: var(--warn); display: none; }
.fab.armed .badge { display: block; background: var(--warn); animation: pulse 1.2s ease-in-out infinite; }
.fab.playing .badge { display: block; background: var(--live); animation: pulse .8s ease-in-out infinite; }
.fab.done .badge { display: block; background: #fff; border-color: var(--accent); }
.fab.drop { transform: scale(1.18); box-shadow: 0 0 0 6px rgba(37,211,102,.35), 0 8px 22px rgba(0,0,0,.4); }

/* ---------- Panel */
.panel {
  position: fixed; right: ${EDGE + FAB_SIZE + 12}px; top: 80px; width: 348px; max-width: calc(100vw - 24px);
  max-height: calc(100vh - 24px); overflow: auto; overscroll-behavior: contain; pointer-events: auto;
  background: var(--bg); border: 1px solid var(--line2); border-radius: 16px;
  box-shadow: 0 18px 50px rgba(0,0,0,.45), 0 2px 8px rgba(0,0,0,.35);
  animation: pop .18s cubic-bezier(.2,.7,.2,1);
  scrollbar-width: thin; scrollbar-color: var(--bg3) transparent;
}
.panel.nofab { right: ${EDGE}px; }
.panel.dragover { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37,211,102,.35), 0 18px 50px rgba(0,0,0,.45); }
.hdr { display: flex; align-items: center; gap: 10px; padding: 12px 10px 10px 14px; border-bottom: 1px solid var(--line);
  background: radial-gradient(120% 140% at 0% 0%, rgba(37,211,102,.16), transparent 60%); border-radius: 16px 16px 0 0; }
.hdr-ico { width: 30px; height: 30px; border-radius: 9px; background: var(--accent); color: var(--ink); display: grid; place-items: center; flex: none; }
.hdr-ico svg { width: 17px; height: 17px; }
.hdr-t { flex: 1; min-width: 0; }
.title { margin: 0; font-size: 14.5px; font-weight: 700; line-height: 1.2; font-family: 'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif; }
.sub { margin: 1px 0 0; font-size: 11.5px; color: var(--faint); }
.x { width: 30px; height: 30px; border-radius: 8px; border: 0; background: transparent; color: var(--dim); display: grid; place-items: center; font-size: 18px; line-height: 1; flex: none; }
.x:hover { background: var(--bg3); color: var(--text); }

.body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 12px; }

.steps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.step { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; padding: 7px 8px; border-radius: 10px; background: var(--bg2); border: 1px solid var(--line);
  font-size: 11.5px; line-height: 1.25; color: var(--dim); transition: border-color .2s, background .2s, color .2s; }
.step b { display: grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: var(--bg3); color: var(--dim); font-size: 11px; font-weight: 700; }
.step.cur { border-color: rgba(37,211,102,.55); background: var(--soft); color: var(--text); }
.step.cur b { background: var(--accent); color: var(--ink); }
.step.ok b { background: rgba(37,211,102,.25); color: var(--accent); }

.err { margin: 0; padding: 8px 10px; border-radius: 10px; background: rgba(255,92,108,.12); border: 1px solid rgba(255,92,108,.4); color: #ffb3bb; font-size: 12.5px; }

/* drop zone */
.drop { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 18px 12px 16px; border: 1.5px dashed var(--line2); border-radius: 14px;
  background: var(--bg2); text-align: center; transition: border-color .15s, background .15s; }
.drop.over, .panel.dragover .drop { border-color: var(--accent); background: var(--soft); }
.drop-ico { font-size: 28px; line-height: 1; }
.drop-t { margin: 0; font-weight: 600; }
.drop-s { margin: 0; font-size: 11.5px; color: var(--faint); }

.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 34px; padding: 0 14px; border-radius: 9px;
  border: 1px solid var(--line2); background: var(--bg3); color: var(--text); font-weight: 600; font-size: 13px; white-space: nowrap;
  transition: background .15s, border-color .15s, transform .08s; }
.btn:hover:not(:disabled) { background: #293d48; }
.btn:active:not(:disabled) { transform: translateY(1px); }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.btn.pri { background: var(--accent); border-color: var(--accent); color: var(--ink); }
.btn.pri:hover:not(:disabled) { background: var(--accent2); }
.btn.ghost { background: transparent; border-color: transparent; color: var(--dim); }
.btn.ghost:hover:not(:disabled) { background: var(--bg3); color: var(--text); }
.btn.danger { color: #ff8b97; }
.btn.sm { height: 28px; padding: 0 10px; font-size: 12px; }
.btn.wide { width: 100%; height: 38px; font-size: 13.5px; }

/* loading */
.loading { display: flex; align-items: center; gap: 12px; padding: 16px 12px; border-radius: 14px; background: var(--bg2); }
.spin { width: 22px; height: 22px; border-radius: 50%; border: 3px solid var(--bg3); border-top-color: var(--accent); animation: spin .8s linear infinite; flex: none; }
.loading p { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* file */
.file { display: flex; flex-direction: column; gap: 10px; }
.frow { display: flex; align-items: center; gap: 10px; }
.play { width: 36px; height: 36px; border-radius: 50%; border: 0; background: var(--accent); color: var(--ink); display: grid; place-items: center; flex: none; }
.play:hover:not(:disabled) { background: var(--accent2); }
.play:disabled { opacity: .45; cursor: not-allowed; }
.play svg { width: 14px; height: 14px; }
.fmeta { flex: 1; min-width: 0; }
.fname { margin: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fdur { margin: 0; font-size: 11.5px; color: var(--faint); font-variant-numeric: tabular-nums; }
.wave { position: relative; height: 58px; border-radius: 10px; background: var(--bg2); border: 1px solid var(--line); overflow: hidden; }
.wave canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.trim { display: grid; grid-template-columns: 38px 1fr 52px; align-items: center; gap: 8px; font-size: 12px; color: var(--dim); }
.trim label { font-weight: 600; }
.trim output { text-align: right; font-family: 'Cascadia Mono', Consolas, ui-monospace, monospace; font-size: 11.5px; color: var(--text); font-variant-numeric: tabular-nums; }
.trims { display: flex; flex-direction: column; gap: 2px; }
.seln { margin: 0; font-size: 11.5px; color: var(--faint); text-align: right; font-variant-numeric: tabular-nums; }

input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; height: 22px; background: transparent; cursor: pointer; --fill: 0%; }
input[type=range]::-webkit-slider-runnable-track { height: 4px; border-radius: 4px; background: linear-gradient(to right, var(--accent) 0 var(--fill), var(--bg3) var(--fill) 100%); }
input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; margin-top: -6px; border-radius: 50%; background: #fff; border: 3px solid var(--accent); box-shadow: 0 1px 3px rgba(0,0,0,.4); }
input[type=range]:focus-visible { box-shadow: none; }
input[type=range]:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 4px rgba(37,211,102,.45); }
input[type=range]:disabled { opacity: .5; cursor: not-allowed; }
input[type=range].end::-webkit-slider-runnable-track { background: linear-gradient(to right, var(--bg3) 0 var(--fill), var(--accent) var(--fill) 100%); }

.opts { display: flex; flex-direction: column; gap: 2px; padding: 6px 10px; border-radius: 12px; background: var(--bg2); border: 1px solid var(--line); }
.tog { display: flex; align-items: center; gap: 10px; min-height: 32px; cursor: pointer; font-size: 13px; }
.tog span.l { flex: 1; min-width: 0; }
.tog small { display: block; color: var(--faint); font-size: 11px; line-height: 1.25; }
.sw { position: relative; width: 36px; height: 20px; flex: none; }
.sw input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; margin: 0; cursor: pointer; z-index: 1; }
.sw i { position: absolute; inset: 0; border-radius: 999px; background: var(--bg3); border: 1px solid var(--line2); transition: background .15s; }
.sw i::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #cfd8dc; transition: transform .15s, background .15s; }
.sw input:checked + i { background: var(--accent); border-color: var(--accent); }
.sw input:checked + i::after { transform: translateX(16px); background: #fff; }
.sw input:focus-visible + i { box-shadow: 0 0 0 3px rgba(37,211,102,.5); }
.sw input:disabled { cursor: not-allowed; }
.sw input:disabled + i { opacity: .5; }
.vol { display: grid; grid-template-columns: 1fr 44px; align-items: center; gap: 8px; }
.vol-h { display: flex; justify-content: space-between; font-size: 13px; margin-top: 4px; }
.vol output { text-align: right; font-family: 'Cascadia Mono', Consolas, ui-monospace, monospace; font-size: 11.5px; font-variant-numeric: tabular-nums; }

.acts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.acts .wide { grid-column: 1 / -1; }
.note { margin: 0; font-size: 11.5px; color: var(--faint); }
.note.live { color: var(--accent); }

/* armed / playing / done */
.stage { display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 14px; border: 1px solid var(--line2); background: var(--bg2); }
.stage.armed { border-color: rgba(255,181,71,.55); background: linear-gradient(180deg, rgba(255,181,71,.12), rgba(255,181,71,.04)); }
.stage.playing { border-color: rgba(255,92,108,.5); background: linear-gradient(180deg, rgba(255,92,108,.12), rgba(255,92,108,.03)); }
.stage.done { border-color: rgba(37,211,102,.55); background: linear-gradient(180deg, rgba(37,211,102,.16), rgba(37,211,102,.04)); }
.big { display: flex; align-items: center; gap: 10px; margin: 0; font-weight: 700; font-size: 14px; line-height: 1.3; }
.dot { width: 12px; height: 12px; border-radius: 50%; flex: none; }
.armed .dot { background: var(--warn); animation: pulse 1.2s ease-in-out infinite; }
.playing .dot { background: var(--live); animation: pulse .8s ease-in-out infinite; }
.done .dot { background: var(--accent); }
.srow { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--dim); font-variant-numeric: tabular-nums; }
.bar { height: 6px; border-radius: 6px; background: var(--bg3); overflow: hidden; }
.bar i { display: block; height: 100%; width: 0; background: var(--live); border-radius: 6px; transition: width .25s linear; }

@keyframes pop { from { opacity: 0; transform: translateY(6px) scale(.98); } to { opacity: 1; transform: none; } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .45; transform: scale(.82); } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`;

  const NOTE_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M19 3.2v11.3a3.3 3.3 0 1 1-2-3V7.3l-8 1.9v7.3a3.3 3.3 0 1 1-2-3V5.6c0-.5.3-.9.8-1l10-2.4c.6-.1 1.2.3 1.2 1Z"/></svg>';
  const PLAY_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M4 2.4v11.2c0 .6.7 1 1.2.6l8.4-5.6c.4-.3.4-.9 0-1.2L5.2 1.8C4.7 1.4 4 1.8 4 2.4Z"/></svg>';
  const PAUSE_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="3" y="2" width="3.6" height="12" rx="1" fill="currentColor"/><rect x="9.4" y="2" width="3.6" height="12" rx="1" fill="currentColor"/></svg>';

  /* ------------------------------------------------------------ DOM */

  let host = null;
  let root = null; // closed shadow root
  const E = {}; // element refs

  function h(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'html') n.innerHTML = v; // only used with the constant SVG strings above
        else n.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (children) for (const c of children) if (c) n.append(c);
    return n;
  }

  function build() {
    host = document.createElement('wvc-voicenote');
    // Inline styles are a fallback only; the shadow's :host rule (important, inner context) wins.
    host.setAttribute('style', 'position:fixed !important;top:0 !important;left:0 !important;width:0 !important;height:0 !important;' +
      'z-index:2147483000 !important;pointer-events:none !important;display:block !important;overflow:visible !important;');
    root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const wrap = h('div', { class: 'root' });

    // FAB
    E.fab = h('button', { type: 'button', class: 'fab', 'aria-label': 'Send an audio file as a voice note', 'aria-expanded': 'false', 'aria-controls': 'wvc-vn-panel', title: 'Send a song / audio file as a voice note (drag to move)', html: NOTE_SVG });
    E.fab.append(h('span', { class: 'badge', 'aria-hidden': 'true' }));

    // Panel
    E.panel = h('section', { class: 'panel', id: 'wvc-vn-panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'wvc-vn-title', 'aria-describedby': 'wvc-vn-steps', hidden: true });
    E.close = h('button', { type: 'button', class: 'x', 'aria-label': 'Close', title: 'Close (Esc)', text: '✕' });
    const hdr = h('div', { class: 'hdr' }, [
      h('span', { class: 'hdr-ico', 'aria-hidden': 'true', html: NOTE_SVG }),
      h('div', { class: 'hdr-t' }, [h('h2', { class: 'title', id: 'wvc-vn-title', text: 'Send audio as a voice note' }), h('p', { class: 'sub', text: 'A song or any audio file, sent like a recording' })]),
      E.close,
    ]);

    E.steps = h('ol', { class: 'steps', id: 'wvc-vn-steps', 'aria-label': 'How it works' }, [
      h('li', { class: 'step' }, [h('b', { text: '1' }), document.createTextNode('Choose a file & Arm')]),
      h('li', { class: 'step' }, [h('b', { text: '2' }), document.createTextNode('Click 🎤 in a chat')]),
      h('li', { class: 'step' }, [h('b', { text: '3' }), document.createTextNode('Press Send ➤ when it ends')]),
    ]);

    E.err = h('p', { class: 'err', role: 'alert', hidden: true });
    E.live = h('p', { class: 'sr', role: 'status', 'aria-live': 'polite' });

    // empty
    E.input = h('input', { type: 'file', accept: ACCEPT, class: 'sr', tabindex: '-1', 'aria-hidden': 'true' });
    E.choose = h('button', { type: 'button', class: 'btn pri', text: 'Choose audio file…' });
    E.empty = h('div', { class: 'drop' }, [
      h('span', { class: 'drop-ico', 'aria-hidden': 'true', text: '🎵' }),
      h('p', { class: 'drop-t', text: 'Drop a song or audio file here' }),
      E.choose,
      h('p', { class: 'drop-s', text: 'MP3, M4A, WAV, OGG, Opus, FLAC, or the sound of a video · up to 30 min' }),
      E.input,
    ]);

    // loading
    E.loadingText = h('p', { text: 'Loading…' });
    E.loading = h('div', { class: 'loading', role: 'status' }, [h('span', { class: 'spin', 'aria-hidden': 'true' }), E.loadingText]);

    // file section
    E.play = h('button', { type: 'button', class: 'play', 'aria-label': 'Preview the selected part', title: 'Preview', html: PLAY_SVG });
    E.fname = h('p', { class: 'fname' });
    E.fdur = h('p', { class: 'fdur' });
    E.canvas = h('canvas', { role: 'img', 'aria-label': 'Waveform of the audio file' });
    E.audio = h('audio', { preload: 'auto' });
    E.start = h('input', { type: 'range', id: 'wvc-vn-start', min: '0', max: '1', step: '0.1', value: '0', class: 'start', 'aria-label': 'Start of the part to send' });
    E.end = h('input', { type: 'range', id: 'wvc-vn-end', min: '0', max: '1', step: '0.1', value: '1', class: 'end', 'aria-label': 'End of the part to send' });
    E.startOut = h('output', { for: 'wvc-vn-start' });
    E.endOut = h('output', { for: 'wvc-vn-end' });
    E.seln = h('p', { class: 'seln' });
    E.applyEffect = h('input', { type: 'checkbox', role: 'switch', id: 'wvc-vn-fx' });
    E.includeMic = h('input', { type: 'checkbox', role: 'switch', id: 'wvc-vn-mic' });
    E.volume = h('input', { type: 'range', id: 'wvc-vn-vol', min: '0', max: '150', step: '5', value: '100', 'aria-label': 'File volume' });
    E.volOut = h('output', { for: 'wvc-vn-vol' });

    const tog = (input, label, small) =>
      h('label', { class: 'tog', for: input.id }, [h('span', { class: 'l' }, [document.createTextNode(label), h('small', { text: small })]), h('span', { class: 'sw' }, [input, h('i', { 'aria-hidden': 'true' })])]);

    E.editor = h('div', { class: 'file' }, [
      h('div', { class: 'frow' }, [E.play, h('div', { class: 'fmeta' }, [E.fname, E.fdur])]),
      h('div', { class: 'wave' }, [E.canvas]),
      h('div', { class: 'trims' }, [
        h('div', { class: 'trim' }, [h('label', { for: 'wvc-vn-start', text: 'Start' }), E.start, E.startOut]),
        h('div', { class: 'trim' }, [h('label', { for: 'wvc-vn-end', text: 'End' }), E.end, E.endOut]),
        E.seln,
      ]),
      h('div', { class: 'opts' }, [
        tog(E.applyEffect, 'Apply my voice effect', 'Run the file through your current voice preset'),
        tog(E.includeMic, 'Include my microphone', 'Off: only the file is recorded. On: sing or talk along'),
        h('div', { class: 'vol-h' }, [h('label', { for: 'wvc-vn-vol', text: 'Volume' })]),
        h('div', { class: 'vol' }, [E.volume, E.volOut]),
      ]),
      E.audio,
    ]);

    // ready actions
    E.arm = h('button', { type: 'button', class: 'btn pri wide', text: 'Arm for next voice note' });
    E.playNow = h('button', { type: 'button', class: 'btn', title: 'Play into the recording or call that is live right now', text: '▶ Play now' });
    E.remove = h('button', { type: 'button', class: 'btn danger', text: 'Remove file' });
    E.liveNote = h('p', { class: 'note' });
    E.actions = h('div', { class: 'acts' }, [E.arm, E.playNow, E.remove]);

    // armed
    E.countdown = h('span', { text: '3:00' });
    E.cancel = h('button', { type: 'button', class: 'btn sm', text: 'Cancel' });
    E.armed = h('div', { class: 'stage armed', role: 'status' }, [
      h('p', { class: 'big' }, [h('span', { class: 'dot', 'aria-hidden': 'true' }), document.createTextNode('Armed. Now click 🎤 in any chat to start recording')]),
      h('div', { class: 'srow' }, [h('span', {}, [document.createTextNode('The file starts by itself · expires in '), E.countdown]), E.cancel]),
    ]);

    // playing
    E.bar = h('i');
    E.ptime = h('span', { text: '0:00 / 0:00' });
    E.stop = h('button', { type: 'button', class: 'btn sm', text: '■ Stop' });
    E.playing = h('div', { class: 'stage playing' }, [
      h('p', { class: 'big' }, [h('span', { class: 'dot', 'aria-hidden': 'true' }), document.createTextNode('Playing into your voice note…')]),
      h('div', { class: 'bar', role: 'progressbar', 'aria-label': 'Playback progress', 'aria-valuemin': '0', 'aria-valuemax': '100' }, [E.bar]),
      h('div', { class: 'srow' }, [E.ptime, E.stop]),
      h('p', { class: 'note', text: "Don't press Send yet, wait until it finishes." }),
    ]);

    // done
    E.done = h('div', { class: 'stage done', role: 'status' }, [
      h('p', { class: 'big' }, [h('span', { class: 'dot', 'aria-hidden': 'true' }), document.createTextNode('✓ Finished. Now press Send ➤ in WhatsApp')]),
      h('p', { class: 'note', text: 'Want to redo it? Delete the recording in WhatsApp, then arm again below.' }),
    ]);

    E.body = h('div', { class: 'body' }, [E.steps, E.err, E.empty, E.loading, E.armed, E.playing, E.done, E.editor, E.liveNote, E.actions, E.live]);
    E.panel.append(hdr, E.body);
    wrap.append(E.fab, E.panel);
    root.append(style, wrap);
    bindEvents();
  }

  /* ------------------------------------------------------------ mounting */

  let observer = null;
  function mount() {
    try {
      if (!host) build();
      const de = document.documentElement;
      if (!de) return;
      if (host.parentNode !== de) de.appendChild(host);
      if (!S.mounted) {
        S.mounted = true;
        observer = new MutationObserver(() => {
          const d = document.documentElement;
          if (host && d && host.parentNode !== d) d.appendChild(host);
        });
        observer.observe(de, { childList: true });
        placeFab();
        render();
      }
    } catch (_) {
      /* never break the page */
    }
  }

  /* ------------------------------------------------------------ helpers */

  function fmt(sec, tenths) {
    sec = Math.max(0, Number(sec) || 0);
    if (tenths) {
      const t = Math.round(sec * 10) / 10;
      const m = Math.floor(t / 60);
      const s = t - m * 60;
      return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
    }
    const r = Math.floor(sec + 1e-6);
    const m = Math.floor(r / 60);
    const s = r % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function fileDuration() {
    return Number(S.vn.duration) || 0;
  }
  function selStart() {
    return S.opts.start || 0;
  }
  function selEnd() {
    const d = fileDuration();
    return S.opts.end == null ? d : Math.min(S.opts.end, d);
  }
  function showError(msg) {
    S.error = msg ? String(msg).slice(0, 300) : '';
    render();
  }
  function announce(text) {
    if (E.live) E.live.textContent = text;
  }

  /* ------------------------------------------------------------ FAB position + drag */

  function fabTop() {
    const avail = Math.max(0, window.innerHeight - FAB_SIZE - EDGE * 2);
    return EDGE + clamp(S.fabY, 0, 1) * avail;
  }
  function placeFab() {
    if (!E.fab) return;
    E.fab.style.top = Math.round(fabTop()) + 'px';
    if (S.open) placePanel();
  }
  function placePanel() {
    if (!E.panel || E.panel.hidden) return;
    const vh = window.innerHeight;
    const ph = Math.min(E.panel.offsetHeight || 480, vh - 24);
    const useFab = S.fabVisible && window.innerWidth >= 480;
    E.panel.classList.toggle('nofab', !useFab);
    const center = useFab ? fabTop() + FAB_SIZE / 2 : vh / 2;
    E.panel.style.top = Math.round(clamp(center - ph / 2, 12, Math.max(12, vh - ph - 12))) + 'px';
  }

  let drag = null;
  let suppressClick = false;
  function onFabPointerDown(e) {
    if (e.button !== 0) return;
    drag = { id: e.pointerId, y0: e.clientY, top0: fabTop(), moved: false };
    try {
      E.fab.setPointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
  }
  function onFabPointerMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    if (!drag.moved && Math.abs(dy) < 5) return;
    drag.moved = true;
    E.fab.classList.add('dragging');
    const avail = Math.max(1, window.innerHeight - FAB_SIZE - EDGE * 2);
    S.fabY = clamp((drag.top0 + dy - EDGE) / avail, 0, 1);
    placeFab();
    e.preventDefault();
  }
  function onFabPointerUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    E.fab.classList.remove('dragging');
    if (moved) {
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 0);
      saveUI({ fabY: Math.round(S.fabY * 1000) / 1000 });
    }
  }
  function onFabKey(e) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    e.stopPropagation();
    S.fabY = clamp(S.fabY + (e.key === 'ArrowUp' ? -0.05 : 0.05), 0, 1);
    placeFab();
    saveUI({ fabY: Math.round(S.fabY * 1000) / 1000 });
  }

  /* ------------------------------------------------------------ open / close */

  let returnFocus = null;
  function openPanel(focus) {
    mount();
    if (!E.panel) return;
    if (!S.open) {
      const ae = document.activeElement;
      returnFocus = ae && ae !== document.body ? ae : null;
      S.open = true;
      E.panel.hidden = false;
      post(T.QUERY, {});
    }
    render();
    placePanel();
    requestAnimationFrame(() => {
      placePanel();
      drawWave();
      if (focus !== false) focusFirst();
    });
  }
  function closePanel() {
    if (!S.open) return;
    S.open = false;
    stopPreview();
    E.panel.hidden = true;
    render();
    const fabShown = !E.fab.hidden;
    try {
      if (fabShown) E.fab.focus({ preventScroll: true });
      else if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
    } catch (_) {
      /* ignore */
    }
    returnFocus = null;
  }
  function focusFirst() {
    const cand = [E.choose, E.cancel, E.stop, E.arm, E.close];
    for (const c of cand) {
      if (c && !c.disabled && isShown(c)) {
        c.focus({ preventScroll: true });
        return;
      }
    }
  }
  function isShown(n) {
    for (let x = n; x && x !== E.panel; x = x.parentNode) if (x.hidden) return false;
    return true;
  }

  /* ------------------------------------------------------------ file loading */

  function isAudioLike(file) {
    if (!file) return false;
    if (/^(audio|video)\//.test(file.type || '')) return true;
    return /\.(mp3|m4a|aac|wav|wave|ogg|oga|opus|flac|webm|mp4|m4v|mov|3gp|amr|wma|aif|aiff|caf)$/i.test(file.name || '');
  }

  async function loadFile(file) {
    if (!file) return;
    S.error = '';
    if (!isAudioLike(file)) return showError(`"${file.name}" doesn't look like an audio file. Try MP3, M4A, WAV, OGG or FLAC.`);
    if (file.size > VN_MAX_BYTES) return showError('That file is too big (' + Math.round(file.size / 1048576) + ' MB). The limit is 150 MB.');
    if (file.size === 0) return showError('That file is empty.');
    stopPreview();
    if (S.fileURL) {
      try {
        URL.revokeObjectURL(S.fileURL);
      } catch (_) {
        /* ignore */
      }
    }
    S.fileURL = null;
    S.peaks = null;
    S.fileName = file.name || 'audio';
    S.localLoading = true;
    render();
    let buffer;
    try {
      buffer = await file.arrayBuffer();
    } catch (_) {
      S.localLoading = false;
      return showError('Could not read that file.');
    }
    try {
      S.fileURL = URL.createObjectURL(file);
    } catch (_) {
      S.fileURL = null;
    }
    clearTimeout(S.loadTimer);
    S.loadTimer = setTimeout(() => {
      if (!S.localLoading) return;
      S.localLoading = false;
      showError('The voice-note engine did not respond. Reload WhatsApp Web and try again.');
    }, LOAD_TIMEOUT_MS);
    if (!post(T.LOAD, { name: S.fileName, buffer }, [buffer])) {
      S.localLoading = false;
      clearTimeout(S.loadTimer);
      showError('Could not hand the file to the page. Reload WhatsApp Web and try again.');
    }
  }

  /* ------------------------------------------------------------ messages from MAIN */

  function onMessage(event) {
    try {
      if (event.source !== window) return;
      const d = event.data;
      if (!d || d.__wvc !== true || d.source !== SRC_MAIN) return;
      const p = d.payload && typeof d.payload === 'object' ? d.payload : {};
      if (d.type === T.LOADED) onLoaded(p);
      else if (d.type === T.STATE) onState(p);
      else if (d.type === T.ERROR) onError(p);
    } catch (_) {
      /* ignore */
    }
  }

  function onLoaded(p) {
    const peaks = Array.isArray(p.peaks) ? p.peaks.slice(0, VN_PEAKS).map((v) => clamp(Number(v) || 0, 0, 1)) : null;
    S.peaks = peaks && peaks.length ? peaks : null;
    if (typeof p.name === 'string') S.fileName = p.name;
    S.localLoading = false;
    clearTimeout(S.loadTimer);
    // New file: fresh trim, keep the user's toggles and volume.
    S.opts = normalizeOptions(Object.assign({}, S.opts, { start: 0, end: null }), Number(p.duration) || 0);
    S.vn = Object.assign({}, S.vn, { name: S.fileName, duration: Number(p.duration) || 0 });
    announce('Loaded ' + S.fileName + ', ' + fmt(p.duration) + '.');
    render();
  }

  function onState(p) {
    const prev = S.vn.state;
    const next = Object.assign(emptyState(), p);
    next.options = normalizeOptions(p.options, next.duration);
    if (!['empty', 'loading', 'ready', 'armed', 'playing', 'done'].includes(next.state)) next.state = 'empty';
    S.vn = next;
    if (next.state !== 'loading') {
      if (S.localLoading && next.state !== 'empty') {
        S.localLoading = false;
        clearTimeout(S.loadTimer);
      }
    }
    if (next.state === 'empty' && !S.localLoading) {
      S.peaks = null;
      if (S.fileURL) {
        try {
          URL.revokeObjectURL(S.fileURL);
        } catch (_) {
          /* ignore */
        }
        S.fileURL = null;
      }
    }
    if ((next.state === 'armed' || next.state === 'playing') && next.options) {
      // Show what MAIN is actually using.
      S.opts = Object.assign({}, next.options);
    }
    if (prev !== next.state) {
      if (next.state === 'playing') {
        stopPreview();
        announce('Playing into your voice note.');
      } else if (next.state === 'done') announce('Finished. Now press Send in WhatsApp.');
      else if (next.state === 'armed') announce('Armed. Click the microphone in a chat.');
      if (next.state === 'done' && !S.open && S.mounted) openPanel(false);
    }
    render();
  }

  function onError(p) {
    S.localLoading = false;
    clearTimeout(S.loadTimer);
    showError((p && p.message) || 'Something went wrong with that file.');
    if (!S.open) openPanel(false);
  }

  /* ------------------------------------------------------------ actions */

  function currentOptions() {
    return normalizeOptions(S.opts, fileDuration());
  }
  function persistOptions() {
    const o = currentOptions();
    saveUI({ voiceNote: { applyEffect: o.applyEffect, includeMic: o.includeMic, volume: o.volume } });
  }
  function arm() {
    stopPreview();
    S.error = '';
    post(T.ARM, { options: currentOptions() });
    // Optimistic UI until MAIN confirms with VN_STATE.
    S.vn = Object.assign({}, S.vn, { state: 'armed', armedUntil: Date.now() + 3 * 60 * 1000 });
    render();
    requestAnimationFrame(() => E.cancel && E.cancel.focus({ preventScroll: true }));
  }
  function playNow() {
    stopPreview();
    S.error = '';
    post(T.PLAY_NOW, { options: currentOptions() });
  }
  function stop() {
    post(T.STOP, {});
  }
  function removeFile() {
    stopPreview();
    post(T.CLEAR, {});
    S.vn = emptyState();
    S.peaks = null;
    S.error = '';
    if (S.fileURL) {
      try {
        URL.revokeObjectURL(S.fileURL);
      } catch (_) {
        /* ignore */
      }
      S.fileURL = null;
    }
    render();
    requestAnimationFrame(() => E.choose && E.choose.focus({ preventScroll: true }));
  }

  /* ------------------------------------------------------------ preview */

  let previewRAF = 0;
  function togglePreview() {
    if (S.previewing) return stopPreview();
    if (!S.fileURL) return;
    try {
      if (E.audio.getAttribute('src') !== S.fileURL) E.audio.src = S.fileURL;
      E.audio.currentTime = selStart();
      E.audio.volume = clamp(currentOptions().volume, 0, 1);
      const p = E.audio.play();
      S.previewing = true;
      if (p && p.catch)
        p.catch(() => {
          S.previewing = false;
          renderPlayButton();
          showError("This browser can't preview that file here, but it can still be sent.");
        });
    } catch (_) {
      S.previewing = false;
    }
    renderPlayButton();
    const tick = () => {
      if (!S.previewing) return;
      if (E.audio.currentTime >= selEnd() - 0.02 || E.audio.ended) return stopPreview();
      drawWave();
      previewRAF = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(previewRAF);
    previewRAF = requestAnimationFrame(tick);
  }
  function stopPreview() {
    cancelAnimationFrame(previewRAF);
    if (E.audio) {
      try {
        E.audio.pause();
      } catch (_) {
        /* ignore */
      }
    }
    if (S.previewing) {
      S.previewing = false;
      renderPlayButton();
      drawWave();
    }
  }
  function renderPlayButton() {
    if (!E.play) return;
    E.play.innerHTML = S.previewing ? PAUSE_SVG : PLAY_SVG;
    E.play.setAttribute('aria-label', S.previewing ? 'Stop preview' : 'Preview the selected part');
    E.play.title = S.previewing ? 'Stop preview' : S.fileURL ? 'Preview' : 'Preview unavailable (choose the file again to preview)';
  }

  /* ------------------------------------------------------------ waveform */

  function drawWave() {
    const c = E.canvas;
    if (!c || !S.open || !isShown(c)) return;
    const w = c.clientWidth;
    const hgt = c.clientHeight;
    if (!w || !hgt) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hgt * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hgt * dpr);
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    const dur = fileDuration();
    const s0 = dur ? selStart() / dur : 0;
    const s1 = dur ? selEnd() / dur : 1;
    // selection background
    g.fillStyle = 'rgba(37,211,102,0.10)';
    g.fillRect(s0 * w, 0, (s1 - s0) * w, hgt);
    const peaks = S.peaks || null;
    const n = peaks ? peaks.length : 80;
    const gap = 1;
    const bw = Math.max(1, w / n - gap);
    const mid = hgt / 2;
    for (let i = 0; i < n; i++) {
      const v = peaks ? peaks[i] : 0.06;
      const bh = Math.max(2, Math.pow(v, 0.8) * (hgt - 10));
      const x = (i / n) * w;
      const t = (i + 0.5) / n;
      g.fillStyle = t >= s0 && t <= s1 ? '#25d366' : 'rgba(174,186,193,0.35)';
      g.fillRect(x + gap / 2, mid - bh / 2, bw, bh);
    }
    // trim edges
    g.fillStyle = '#ffffff';
    g.fillRect(Math.round(s0 * w), 0, 2, hgt);
    g.fillRect(Math.round(s1 * w) - 2, 0, 2, hgt);
    // playhead
    let ph = null;
    if (S.previewing && dur) ph = E.audio.currentTime / dur;
    else if (S.vn.state === 'playing' && dur) ph = (selStart() + (Number(S.vn.position) || 0)) / dur;
    if (ph != null && ph >= 0 && ph <= 1) {
      g.fillStyle = S.previewing ? '#ffffff' : '#ff5c6c';
      g.fillRect(Math.round(ph * w) - 1, 0, 2, hgt);
    }
  }

  /* ------------------------------------------------------------ render */

  let countdownTimer = 0;
  function render() {
    if (!E.panel) return;
    const st = S.localLoading ? 'loading' : S.vn.state;
    const hasFile = ['ready', 'armed', 'playing', 'done'].includes(st);
    const busy = st === 'armed' || st === 'playing';

    // FAB
    E.fab.hidden = !S.fabVisible;
    E.fab.classList.toggle('open', S.open);
    E.fab.classList.toggle('armed', st === 'armed');
    E.fab.classList.toggle('playing', st === 'playing');
    E.fab.classList.toggle('done', st === 'done');
    E.fab.setAttribute('aria-expanded', String(S.open));
    E.fab.title =
      st === 'armed' ? 'Armed: click 🎤 in a chat' : st === 'playing' ? 'Playing into your voice note…' : st === 'done' ? 'Finished: press Send in WhatsApp' : 'Send a song / audio file as a voice note (drag to move)';

    if (!S.open) {
      clearInterval(countdownTimer);
      countdownTimer = 0;
      return;
    }

    // steps
    const cur = st === 'armed' || st === 'playing' ? 1 : st === 'done' ? 2 : 0;
    [...E.steps.children].forEach((li, i) => {
      li.classList.toggle('cur', i === cur);
      li.classList.toggle('ok', i < cur);
      if (i === cur) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    });

    E.err.hidden = !S.error;
    E.err.textContent = S.error;

    E.empty.hidden = st !== 'empty';
    E.loading.hidden = st !== 'loading';
    E.loadingText.textContent = 'Decoding "' + (S.fileName || S.vn.name || 'file') + '"…';
    E.editor.hidden = !hasFile;
    E.actions.hidden = !(st === 'ready' || st === 'done');
    E.armed.hidden = st !== 'armed';
    E.playing.hidden = st !== 'playing';
    E.done.hidden = st !== 'done';

    if (hasFile) {
      const dur = fileDuration();
      E.fname.textContent = S.vn.name || S.fileName || 'Audio file';
      E.fname.title = E.fname.textContent;
      E.fdur.textContent = fmt(dur) + ' total';
      const maxV = String(Math.round(dur * 10) / 10);
      for (const r of [E.start, E.end]) {
        r.max = maxV;
        r.disabled = busy;
      }
      const a = selStart();
      const b = selEnd();
      if (root.activeElement !== E.start) E.start.value = String(Math.round(a * 10) / 10);
      if (root.activeElement !== E.end) E.end.value = String(Math.round(b * 10) / 10);
      E.start.style.setProperty('--fill', (dur ? (a / dur) * 100 : 0).toFixed(2) + '%');
      E.end.style.setProperty('--fill', (dur ? (b / dur) * 100 : 100).toFixed(2) + '%');
      E.startOut.textContent = fmt(a, true);
      E.endOut.textContent = fmt(b, true);
      E.start.setAttribute('aria-valuetext', fmt(a, true));
      E.end.setAttribute('aria-valuetext', fmt(b, true));
      E.seln.textContent = 'Sends ' + fmt(b - a, true) + (a > 0 || b < dur - 0.05 ? ' (trimmed)' : '');
      E.applyEffect.checked = !!S.opts.applyEffect;
      E.includeMic.checked = !!S.opts.includeMic;
      E.applyEffect.disabled = E.includeMic.disabled = E.volume.disabled = busy;
      const vol = Math.round((S.opts.volume == null ? 1 : S.opts.volume) * 100);
      if (root.activeElement !== E.volume) E.volume.value = String(vol);
      E.volume.style.setProperty('--fill', ((vol / 150) * 100).toFixed(2) + '%');
      E.volOut.textContent = vol + '%';
      E.volume.setAttribute('aria-valuetext', vol + '%');
      E.play.disabled = !S.fileURL || busy;
      renderPlayButton();
    }

    E.arm.textContent = st === 'done' ? 'Arm for another voice note' : 'Arm for next voice note';
    const live = Number(S.vn.liveMics) || 0;
    E.playNow.disabled = !(live > 0);
    E.liveNote.hidden = !(st === 'ready' || st === 'done');
    E.liveNote.classList.toggle('live', live > 0);
    E.liveNote.textContent =
      live > 0
        ? '● A recording or call is live right now. "Play now" starts the file in it right away.'
        : 'Tip: "Arm", then click 🎤 in a chat. The file plays into the recording, then you press Send.';

    // armed countdown
    if (st === 'armed') {
      const tick = () => {
        const left = Math.max(0, (Number(S.vn.armedUntil) || 0) - Date.now());
        E.countdown.textContent = fmt(left / 1000);
      };
      tick();
      if (!countdownTimer) countdownTimer = setInterval(tick, 1000);
    } else if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = 0;
    }

    // playing progress
    if (st === 'playing') {
      const len = Number(S.vn.length) || Math.max(0, selEnd() - selStart());
      const pos = clamp(Number(S.vn.position) || 0, 0, len || 0);
      const pct = len ? (pos / len) * 100 : 0;
      E.bar.style.width = pct.toFixed(1) + '%';
      E.bar.parentNode.setAttribute('aria-valuenow', String(Math.round(pct)));
      E.ptime.textContent = fmt(pos) + ' / ' + fmt(len);
    }

    drawWave();
    requestAnimationFrame(placePanel);
  }

  /* ------------------------------------------------------------ events */

  function bindEvents() {
    E.fab.addEventListener('pointerdown', onFabPointerDown);
    E.fab.addEventListener('pointermove', onFabPointerMove);
    E.fab.addEventListener('pointerup', onFabPointerUp);
    E.fab.addEventListener('pointercancel', onFabPointerUp);
    E.fab.addEventListener('keydown', onFabKey);
    E.fab.addEventListener('click', (e) => {
      e.stopPropagation();
      if (suppressClick) return;
      if (S.open) closePanel();
      else openPanel(e.detail === 0); // keyboard activation -> move focus into the panel
    });
    // Drop a file straight onto the FAB.
    for (const t of ['dragenter', 'dragover']) {
      E.fab.addEventListener(t, (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        E.fab.classList.add('drop');
      });
    }
    E.fab.addEventListener('dragleave', () => E.fab.classList.remove('drop'));
    E.fab.addEventListener('drop', (e) => {
      E.fab.classList.remove('drop');
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      openPanel(false);
      if (f && canLoad()) loadFile(f);
    });

    E.close.addEventListener('click', closePanel);
    E.choose.addEventListener('click', () => {
      try {
        E.input.value = '';
        E.input.click();
      } catch (_) {
        /* ignore */
      }
    });
    E.input.addEventListener('change', () => {
      const f = E.input.files && E.input.files[0];
      if (f) loadFile(f);
    });

    // Drag & drop onto the whole panel.
    let depth = 0;
    E.panel.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth++;
      if (canLoad()) E.panel.classList.add('dragover');
    });
    E.panel.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = canLoad() ? 'copy' : 'none';
    });
    E.panel.addEventListener('dragleave', (e) => {
      e.stopPropagation();
      depth = Math.max(0, depth - 1);
      if (!depth) E.panel.classList.remove('dragover');
    });
    E.panel.addEventListener('drop', (e) => {
      depth = 0;
      E.panel.classList.remove('dragover');
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      if (!canLoad()) return showError('Stop or cancel the current file first.');
      loadFile(f);
    });

    E.start.addEventListener('input', () => {
      const d = fileDuration();
      let v = clamp(Number(E.start.value) || 0, 0, d);
      const b = selEnd();
      if (v > b - 0.1) {
        v = Math.max(0, b - 0.1);
        E.start.value = String(v);
      }
      S.opts.start = Math.round(v * 10) / 10;
      stopPreview();
      render();
    });
    E.end.addEventListener('input', () => {
      const d = fileDuration();
      let v = clamp(Number(E.end.value) || 0, 0, d);
      const a = selStart();
      if (v < a + 0.1) {
        v = Math.min(d, a + 0.1);
        E.end.value = String(v);
      }
      S.opts.end = v >= d - 0.05 ? null : Math.round(v * 10) / 10;
      stopPreview();
      render();
    });
    E.applyEffect.addEventListener('change', () => {
      S.opts.applyEffect = E.applyEffect.checked;
      persistOptions();
      render();
    });
    E.includeMic.addEventListener('change', () => {
      S.opts.includeMic = E.includeMic.checked;
      persistOptions();
      render();
    });
    E.volume.addEventListener('input', () => {
      S.opts.volume = clamp(Number(E.volume.value) / 100, 0, 1.5);
      if (S.previewing) E.audio.volume = clamp(S.opts.volume, 0, 1);
      render();
    });
    E.volume.addEventListener('change', persistOptions);
    E.play.addEventListener('click', togglePreview);
    E.audio.addEventListener('ended', stopPreview);
    E.arm.addEventListener('click', arm);
    E.playNow.addEventListener('click', playNow);
    E.remove.addEventListener('click', removeFile);
    E.cancel.addEventListener('click', () => {
      stop();
      requestAnimationFrame(() => E.arm && E.arm.focus({ preventScroll: true }));
    });
    E.stop.addEventListener('click', stop);

    // Keys typed inside the panel belong to the panel: Escape closes it, and nothing leaks to
    // WhatsApp's global shortcuts (arrow keys on a slider, Space on a button, …).
    E.panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closePanel();
      }
      e.stopPropagation();
    });
    for (const t of ['keyup', 'keypress']) E.panel.addEventListener(t, (e) => e.stopPropagation());
    // Clicks inside our UI shouldn't reach WhatsApp's "click outside" handlers either.
    for (const t of ['click', 'mousedown', 'pointerdown']) E.panel.addEventListener(t, (e) => e.stopPropagation());

    window.addEventListener('resize', () => {
      placeFab();
      if (S.open) drawWave();
    });
  }

  function hasFiles(e) {
    try {
      const types = e.dataTransfer && e.dataTransfer.types;
      return !!types && Array.prototype.indexOf.call(types, 'Files') >= 0;
    } catch (_) {
      return false;
    }
  }
  function canLoad() {
    const st = S.localLoading ? 'loading' : S.vn.state;
    return st === 'empty' || st === 'ready' || st === 'done';
  }

  /* ------------------------------------------------------------ settings + ui state */

  function applyFileButton(settings) {
    S.fabVisible = !(settings && typeof settings === 'object' && settings.fileButton === false);
    render();
    if (S.open) placePanel();
  }

  async function loadStored() {
    const [settings, ui] = await Promise.all([storageGet(KEY_SETTINGS), storageGet(KEY_UI)]);
    applyFileButton(settings);
    if (ui && typeof ui === 'object') {
      const y = Number(ui.fabY);
      if (Number.isFinite(y)) S.fabY = clamp(y, 0, 1);
      if (ui.voiceNote && typeof ui.voiceNote === 'object') {
        const o = normalizeOptions(ui.voiceNote);
        // Trim is per file; only toggles and volume carry over.
        if (S.vn.state === 'empty' || S.vn.state === 'ready') {
          S.opts.applyEffect = o.applyEffect;
          S.opts.includeMic = o.includeMic;
          S.opts.volume = o.volume;
        }
      }
    }
    placeFab();
    render();
  }

  function onStorageChanged(changes, area) {
    try {
      if (!extOK()) return extDead();
      if (area !== 'local' || !changes) return;
      if (changes[KEY_SETTINGS]) applyFileButton(changes[KEY_SETTINGS].newValue);
      if (changes[KEY_UI] && !drag) {
        const ui = changes[KEY_UI].newValue;
        const y = ui && Number(ui.fabY);
        if (Number.isFinite(y) && Math.abs(y - S.fabY) > 1e-3) {
          S.fabY = clamp(y, 0, 1);
          placeFab();
        }
      }
    } catch (_) {
      /* ignore */
    }
  }

  function onRuntimeMessage(msg, sender, sendResponse) {
    try {
      if (!msg || msg.type !== RT_OPEN_VOICENOTE) return false;
      openPanel(true);
      sendResponse({ ok: true });
    } catch (_) {
      try {
        sendResponse({ ok: false });
      } catch (__) {
        /* ignore */
      }
    }
    return false;
  }

  /* ------------------------------------------------------------ boot */

  try {
    window.addEventListener('message', onMessage, false);
    if (extOK()) {
      try {
        chrome.storage.onChanged.addListener(onStorageChanged);
        chrome.runtime.onMessage.addListener(onRuntimeMessage);
      } catch (_) {
        extDead();
      }
    }
    const start = () => {
      mount();
      loadStored();
      post(T.QUERY, {});
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  } catch (_) {
    /* fail open: WhatsApp and the microphone keep working without the widget */
  }
})();
