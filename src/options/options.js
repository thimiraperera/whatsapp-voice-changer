/*
 * Voice Studio (the options page).
 * Requires (in order): params.js, dsp-core.js, voice-engine.js.
 */
(function () {
  'use strict';

  const WVC = globalThis.WVC;
  const KEYS = WVC.STORAGE_KEYS;
  const WRITE_DEBOUNCE_MS = 60;
  const STATUS_POLL_MS = 2000;
  const EMOJIS = ['⭐', '🎤', '🎧', '🔥', '💎', '🚀', '🦊', '🐉', '🦄', '🐸', '🐺', '🦁', '🤡', '🧙', '🥷', '🧛', '🎃', '💀', '👑', '🌙', '⚡', '🌈', '🎸', '🎹', '🍄', '🛸'];

  const $ = (id) => document.getElementById(id);
  const hasChrome = typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
  const hasStorage = hasChrome && !!(chrome.storage && chrome.storage.local);

  /* ================================================================ state */

  const state = {
    settings: WVC.defaultSettings(),
    custom: [],
    category: 'all',
    query: '',
    dragging: null, // param id of slider currently being dragged (pointer down)
    pendingRemote: null, // settings that arrived during a drag; applied on release
  };

  /* ================================================================ utilities */

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (children) for (const c of [].concat(children)) if (c != null) node.append(c);
    return node;
  }

  function debounce(fn, ms) {
    let t = null;
    const wrapped = (...args) => {
      clearTimeout(t);
      t = setTimeout(() => {
        t = null;
        fn(...args);
      }, ms);
    };
    wrapped.pending = () => t !== null;
    wrapped.flush = (...args) => {
      if (t !== null) {
        clearTimeout(t);
        t = null;
        fn(...args);
      }
    };
    return wrapped;
  }

  let toastTimer = null;
  function toast(msg, kind) {
    const t = $('toast');
    t.textContent = msg;
    t.dataset.kind = kind || 'info';
    t.hidden = false;
    requestAnimationFrame(() => t.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => {
        t.hidden = true;
      }, 250);
    }, 2600);
  }

  function lastErrorMessage() {
    try {
      return chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
    } catch (_) {
      return null;
    }
  }

  /* ================================================================ storage */

  async function loadStored() {
    if (!hasStorage) return;
    try {
      const data = await chrome.storage.local.get([KEYS.SETTINGS, KEYS.CUSTOM_PRESETS]);
      state.settings = WVC.normalizeSettings(data[KEYS.SETTINGS]);
      state.custom = WVC.normalizeCustomPresets(data[KEYS.CUSTOM_PRESETS]);
    } catch (err) {
      console.warn('[Voice Studio] could not read settings', err);
    }
  }

  // JSON of settings we wrote whose storage.onChanged echo has not arrived yet. An echo of an
  // older write must not overwrite newer local edits made while that write was in flight.
  const inflightWrites = [];
  function writeSettingsNow() {
    if (!hasStorage) return;
    const s = WVC.normalizeSettings(state.settings);
    const json = JSON.stringify(s);
    inflightWrites.push(json);
    // A write that changes nothing produces no onChanged event; forget it after a while.
    setTimeout(() => {
      const i = inflightWrites.indexOf(json);
      if (i >= 0) inflightWrites.splice(i, 1);
    }, 2000);
    chrome.storage.local.set({ [KEYS.SETTINGS]: s }).catch((err) => {
      console.warn('[Voice Studio] could not save settings', err);
      toast('Could not save settings', 'error');
    });
  }
  const writeSettings = debounce(writeSettingsNow, WRITE_DEBOUNCE_MS);

  function writeCustom() {
    if (!hasStorage) return Promise.resolve();
    return chrome.storage.local.set({ [KEYS.CUSTOM_PRESETS]: WVC.normalizeCustomPresets(state.custom) }).catch((err) => {
      console.warn('[Voice Studio] could not save presets', err);
      toast('Could not save presets', 'error');
    });
  }

  /** Central mutation point for settings: updates UI + test engine + storage. */
  function commitSettings(next, opts) {
    state.settings = WVC.normalizeSettings(next);
    renderAll(opts);
    lab.applySettings();
    writeSettings();
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    let touched = false;
    if (changes[KEYS.CUSTOM_PRESETS]) {
      state.custom = WVC.normalizeCustomPresets(changes[KEYS.CUSTOM_PRESETS].newValue);
      touched = true;
    }
    if (changes[KEYS.SETTINGS]) {
      const incoming = WVC.normalizeSettings(changes[KEYS.SETTINGS].newValue);
      const json = JSON.stringify(incoming);
      const echo = inflightWrites.indexOf(json);
      if (echo >= 0) {
        // Our own write coming back (possibly an older one): our state is already newer or equal.
        inflightWrites.splice(0, echo + 1);
      } else if (writeSettings.pending()) {
        // Unsaved local edits are about to be written; they win (last writer wins).
      } else if (state.dragging) {
        // Don't yank the slider out from under the user's pointer; reconcile on release.
        state.pendingRemote = incoming;
      } else if (json !== JSON.stringify(state.settings)) {
        state.settings = incoming;
        touched = true;
      }
    }
    if (touched) {
      renderAll();
      lab.applySettings();
    }
  }

  function endDrag() {
    if (!state.dragging) return;
    const id = state.dragging;
    state.dragging = null;
    writeSettings.flush();
    if (state.pendingRemote) {
      const remote = state.pendingRemote;
      state.pendingRemote = null;
      // Our own latest write wins for the dragged value; take everything else from the remote.
      if (JSON.stringify(remote) !== JSON.stringify(state.settings)) {
        const mine = lastDraggedEntry && lastDraggedEntry.id === id ? lastDragged() : {};
        state.settings = WVC.normalizeSettings({ ...remote, params: { ...remote.params, ...mine } });
        renderAll();
        lab.applySettings();
        writeSettings();
      }
    }
  }
  let lastDraggedEntry = null;
  function lastDragged() {
    return lastDraggedEntry ? { [lastDraggedEntry.id]: lastDraggedEntry.value } : {};
  }

  /* ================================================================ header */

  function initHeader() {
    let version = WVC.VERSION;
    try {
      if (hasChrome && chrome.runtime.getManifest) version = chrome.runtime.getManifest().version || version;
    } catch (_) {
      /* keep WVC.VERSION */
    }
    $('version').textContent = 'v' + version;
    $('masterSwitch').addEventListener('change', (e) => {
      commitSettings({ ...state.settings, enabled: e.target.checked });
    });
    pollStatus();
    setInterval(pollStatus, STATUS_POLL_MS);
  }

  function renderHeader() {
    const on = state.settings.enabled;
    $('masterSwitch').checked = on;
    $('masterLabel').textContent = on ? 'Voice changer on' : 'Voice changer off';
    document.body.classList.toggle('is-off', !on);
  }

  function getTabStatus(tabId) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: WVC.MSG.RT_GET_STATUS, tabId }, (res) => {
          if (lastErrorMessage()) return resolve(null);
          resolve(res && res.status ? res.status : null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  let polling = false;
  async function pollStatus() {
    const pill = $('statusPill');
    const set = (cls, text, title) => {
      pill.className = 'pill' + (cls ? ' ' + cls : '');
      if (pill.textContent !== text) pill.textContent = text;
      pill.title = title || '';
    };
    if (!hasChrome || !chrome.tabs || !chrome.tabs.query) {
      set('', 'Preview mode', 'Extension APIs are unavailable (page opened outside the extension).');
      return;
    }
    if (polling || document.hidden) return;
    polling = true;
    try {
      const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
      if (!tabs.length) {
        set('', 'WhatsApp Web not open', 'Open web.whatsapp.com in a tab to use the voice changer.');
        return;
      }
      const statuses = (await Promise.all(tabs.map((t) => getTabStatus(t.id)))).filter(Boolean);
      const active = statuses.reduce((n, s) => n + (Number(s.active) || 0), 0);
      const error = statuses.map((s) => s.error).find(Boolean);
      if (error) set('pill-warn', 'Problem in WhatsApp tab', String(error));
      else if (active > 0) set('pill-live', state.settings.enabled ? 'LIVE - voice changed' : 'LIVE - original voice', `${active} active microphone stream(s)`);
      else if (statuses.length) set('pill-ok', 'WhatsApp ready', 'The voice changer is attached to WhatsApp Web. Start a call or voice note.');
      else set('pill-warn', 'Reload WhatsApp tab', 'WhatsApp Web is open but the extension is not attached yet. Reload the tab.');
    } catch (err) {
      set('pill-warn', 'Status unavailable', String((err && err.message) || err));
    } finally {
      polling = false;
    }
  }

  /* ================================================================ presets */

  function allPresets() {
    return WVC.PRESETS.concat(state.custom);
  }

  function currentPreset() {
    return WVC.getPreset(state.settings.presetId, state.custom);
  }

  function applyPreset(preset) {
    commitSettings({ ...state.settings, presetId: preset.id, params: WVC.presetParams(preset, state.custom) });
  }

  function initPresets() {
    const chips = $('categoryChips');
    const cats = [{ id: 'all', label: 'All' }].concat(WVC.PRESET_CATEGORIES);
    for (const c of cats) {
      const chip = el('button', { type: 'button', class: 'chip', role: 'tab', 'aria-selected': c.id === state.category ? 'true' : 'false', dataset: { cat: c.id }, text: c.label });
      chips.append(chip);
    }
    chips.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      state.category = chip.dataset.cat;
      for (const c of chips.children) c.setAttribute('aria-selected', String(c === chip));
      renderPresets();
    });
    chips.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const list = [...chips.children];
      const i = list.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const next = list[(i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length];
      next.focus();
      next.click();
    });

    $('presetSearch').addEventListener('input', (e) => {
      state.query = e.target.value.trim().toLowerCase();
      renderPresets();
    });

    const grid = $('presetGrid');
    grid.addEventListener('click', (e) => {
      const more = e.target.closest('.preset-more');
      if (more) {
        openPresetMenu(more.dataset.id, more);
        return;
      }
      const tile = e.target.closest('.preset');
      if (!tile) return;
      const p = WVC.getPreset(tile.dataset.id, state.custom);
      if (p) applyPreset(p);
    });
    grid.addEventListener('contextmenu', (e) => {
      const tile = e.target.closest('.preset');
      if (!tile || !tile.dataset.id.startsWith('custom-')) return;
      e.preventDefault();
      openPresetMenu(tile.dataset.id, tile, e.clientX, e.clientY);
    });

    $('resetPreset').addEventListener('click', () => {
      const p = currentPreset();
      if (p) applyPreset(p);
      else commitSettings({ ...state.settings, presetId: WVC.DEFAULT_PRESET_ID, params: WVC.presetParams(WVC.DEFAULT_PRESET_ID) });
    });
    $('saveAsBtn').addEventListener('click', () => openPresetDialog('create'));
    $('updatePresetBtn').addEventListener('click', () => {
      const p = currentPreset();
      if (p && !p.builtIn) updateCustomPreset(p.id);
    });
    $('exportBtn').addEventListener('click', exportPresets);
    $('importBtn').addEventListener('click', () => $('importFile').click());
    $('importFile').addEventListener('change', importPresets);

    initPresetMenu();
    initPresetDialog();
  }

  function presetMatches(p) {
    if (state.category !== 'all' && p.category !== state.category) return false;
    if (!state.query) return true;
    return (p.name + ' ' + (p.description || '') + ' ' + p.category).toLowerCase().includes(state.query);
  }

  function renderPresets() {
    const grid = $('presetGrid');
    const activeId = state.settings.presetId;
    const hadFocus = grid.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    const frag = document.createDocumentFragment();
    let count = 0;
    for (const p of allPresets()) {
      if (!presetMatches(p)) continue;
      count++;
      const custom = !p.builtIn;
      const tile = el('button', {
        type: 'button',
        class: 'preset',
        'aria-pressed': p.id === activeId ? 'true' : 'false',
        title: p.description || p.name,
        dataset: { id: p.id },
      }, [el('span', { class: 'preset-emoji', 'aria-hidden': 'true', text: p.emoji }), el('span', { class: 'preset-name', text: p.name })]);
      const cell = el('div', { class: 'preset-cell' + (custom ? ' is-custom' : '') }, tile);
      if (custom) {
        cell.append(el('button', { type: 'button', class: 'preset-more', 'aria-label': `More actions for ${p.name}`, 'aria-haspopup': 'menu', title: 'Rename, update or delete', dataset: { id: p.id }, text: '⋯' }));
      }
      frag.append(cell);
    }
    grid.replaceChildren(frag);
    $('presetEmpty').hidden = count > 0;
    $('presetEmpty').textContent = state.category === 'mine' && !state.custom.length && !state.query ? 'No custom presets yet. Tweak a voice and press "Save as new preset".' : 'No presets match.';
    if (hadFocus) {
      const again = grid.querySelector(`.preset[data-id="${CSS.escape(hadFocus)}"]`);
      if (again) again.focus();
    }
  }

  function renderCurrent() {
    const p = currentPreset();
    const modified = WVC.isModified(state.settings, state.custom);
    $('currentEmoji').textContent = p ? p.emoji : '🎛️';
    $('currentName').textContent = p ? p.name : 'Custom settings';
    $('currentModified').hidden = !modified;
    $('resetPreset').disabled = !modified;
    const isCustom = !!p && !p.builtIn;
    $('updatePresetBtn').hidden = !isCustom;
    $('updatePresetBtn').disabled = !modified;
    $('exportBtn').disabled = !state.custom.length;
  }

  /* ---------------- custom preset menu ---------------- */

  let menuTarget = null;
  let menuReturnFocus = null;

  function initPresetMenu() {
    const menu = $('presetMenu');
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.menu-item');
      if (!item || !menuTarget) return;
      const id = menuTarget;
      closePresetMenu(false);
      if (item.dataset.action === 'rename') openPresetDialog('rename', id);
      else if (item.dataset.action === 'update') updateCustomPreset(id);
      else if (item.dataset.action === 'delete') confirmDelete(id);
    });
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('.menu-item')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        closePresetMenu(true);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        items[e.key === 'Home' ? 0 : items.length - 1].focus();
      }
    });
    document.addEventListener('pointerdown', (e) => {
      if (!menu.hidden && !menu.contains(e.target)) closePresetMenu(false);
    });
    window.addEventListener('resize', () => closePresetMenu(false));
    window.addEventListener('scroll', () => closePresetMenu(false), true);
  }

  function openPresetMenu(id, anchor, x, y) {
    const menu = $('presetMenu');
    menuTarget = id;
    menuReturnFocus = anchor;
    menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let left = x != null ? x : r.right - mw;
    let top = y != null ? y : r.bottom + 4;
    left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
    if (top + mh > window.innerHeight - 8) top = (y != null ? y : r.top) - mh - 4;
    top = Math.max(8, Math.min(top, window.innerHeight - mh - 8));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.querySelector('.menu-item').focus();
  }

  function closePresetMenu(restoreFocus) {
    const menu = $('presetMenu');
    if (menu.hidden) return;
    menu.hidden = true;
    menuTarget = null;
    if (restoreFocus && menuReturnFocus && menuReturnFocus.isConnected) menuReturnFocus.focus();
    menuReturnFocus = null;
  }

  /* ---------------- save / rename dialog ---------------- */

  let dialogMode = 'create';
  let dialogId = null;
  let dialogEmoji = EMOJIS[0];

  function initPresetDialog() {
    const grid = $('emojiGrid');
    for (const e of EMOJIS) {
      grid.append(el('button', { type: 'button', class: 'emoji-opt', role: 'radio', 'aria-checked': 'false', 'aria-label': e, dataset: { emoji: e }, text: e }));
    }
    grid.addEventListener('click', (e) => {
      const b = e.target.closest('.emoji-opt');
      if (b) selectEmoji(b.dataset.emoji, true);
    });
    grid.addEventListener('keydown', (e) => {
      const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      if (!(e.key in keys)) return;
      e.preventDefault();
      const i = EMOJIS.indexOf(dialogEmoji);
      selectEmoji(EMOJIS[(i + keys[e.key] + EMOJIS.length) % EMOJIS.length], true);
    });
    $('presetCancel').addEventListener('click', () => $('presetDialog').close('cancel'));
    $('presetForm').addEventListener('submit', (e) => {
      const name = $('presetName').value.trim();
      if (!name) {
        e.preventDefault();
        $('presetName').focus();
        return;
      }
      submitPresetDialog(name);
    });
    $('confirmCancel').addEventListener('click', () => $('confirmDialog').close('cancel'));
  }

  function selectEmoji(emoji, focus) {
    dialogEmoji = emoji;
    for (const b of $('emojiGrid').children) {
      const on = b.dataset.emoji === emoji;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
  }

  function openPresetDialog(mode, id) {
    dialogMode = mode;
    dialogId = id || null;
    const p = id ? WVC.getPreset(id, state.custom) : null;
    if (mode === 'rename' && !p) return;
    $('presetDialogTitle').textContent = mode === 'rename' ? 'Rename preset' : 'Save as new preset';
    $('presetSubmit').textContent = mode === 'rename' ? 'Rename' : 'Save';
    const base = currentPreset();
    $('presetName').value = mode === 'rename' ? p.name : base ? `${base.name} (my mix)`.slice(0, 40) : 'My voice';
    selectEmoji(mode === 'rename' && EMOJIS.includes(p.emoji) ? p.emoji : mode === 'rename' ? p.emoji : EMOJIS[0], false);
    if (!EMOJIS.includes(dialogEmoji)) dialogEmoji = p.emoji; // keep an imported emoji that isn't in the list
    try {
      $('presetDialog').showModal();
    } catch (_) {
      $('presetDialog').setAttribute('open', '');
    }
    $('presetName').select();
  }

  function submitPresetDialog(name) {
    if (dialogMode === 'rename') {
      const idx = state.custom.findIndex((p) => p.id === dialogId);
      if (idx < 0) return;
      state.custom[idx] = { ...state.custom[idx], name: name.slice(0, 40), emoji: dialogEmoji };
      writeCustom();
      renderAll();
      toast('Preset renamed');
    } else {
      const preset = WVC.makeCustomPreset(name, state.settings.params, dialogEmoji);
      state.custom = state.custom.concat(preset);
      writeCustom();
      commitSettings({ ...state.settings, presetId: preset.id, params: WVC.presetParams(preset, state.custom) });
      toast(`Saved "${preset.name}"`);
    }
  }

  function updateCustomPreset(id) {
    const idx = state.custom.findIndex((p) => p.id === id);
    if (idx < 0) return;
    state.custom[idx] = { ...state.custom[idx], params: WVC.normalizeParams(state.settings.params) };
    state.custom = state.custom.slice();
    writeCustom();
    if (state.settings.presetId !== id) commitSettings({ ...state.settings, presetId: id });
    else renderAll();
    toast(`Updated "${state.custom[idx].name}"`);
  }

  function confirmDelete(id) {
    const p = WVC.getPreset(id, state.custom);
    if (!p || p.builtIn) return;
    const dlg = $('confirmDialog');
    $('confirmText').textContent = `"${p.name}" will be removed permanently. This can't be undone (unless you exported it).`;
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      if (dlg.returnValue !== 'ok') return;
      state.custom = state.custom.filter((c) => c.id !== id);
      writeCustom();
      if (state.settings.presetId === id) {
        // Keep the sound; the preset reference just becomes a modified "Natural".
        commitSettings({ ...state.settings, presetId: WVC.DEFAULT_PRESET_ID });
      } else renderAll();
      toast(`Deleted "${p.name}"`);
    };
    dlg.returnValue = '';
    dlg.addEventListener('close', onClose);
    try {
      dlg.showModal();
    } catch (_) {
      dlg.setAttribute('open', '');
    }
    $('confirmCancel').focus();
  }

  /* ---------------- export / import ---------------- */

  function exportPresets() {
    if (!state.custom.length) {
      toast('No custom presets to export');
      return;
    }
    const data = { app: 'voice-changer-whatsapp-web', version: WVC.VERSION, exportedAt: new Date().toISOString(), presets: WVC.normalizeCustomPresets(state.custom) };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `voice-presets-${new Date().toISOString().slice(0, 10)}.json` });
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Exported ${state.custom.length} preset(s)`);
  }

  async function importPresets(e) {
    const input = e.target;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('File is too large');
      let json;
      try {
        json = JSON.parse(await file.text());
      } catch (_) {
        throw new Error('this is not a valid preset (JSON) file');
      }
      const list = Array.isArray(json) ? json : json && Array.isArray(json.presets) ? json.presets : null;
      if (!list) throw new Error('No presets found in this file');
      // Only objects that actually carry a params object count as presets (not {} / numbers / strings).
      const valid = list.filter((p) => p && typeof p === 'object' && !Array.isArray(p) && p.params && typeof p.params === 'object' && !Array.isArray(p.params));
      const incoming = WVC.normalizeCustomPresets(valid);
      if (!incoming.length) throw new Error('No valid presets found in this file');
      // Skip presets that are already in the library (same name, icon and sound), e.g. re-importing a backup.
      const sig = (p) => JSON.stringify([p.name.trim().toLowerCase(), p.emoji, WVC.normalizeParams(p.params)]);
      const have = new Set(state.custom.map(sig));
      const unique = incoming.filter((p) => {
        const k = sig(p);
        if (have.has(k)) return false;
        have.add(k);
        return true;
      });
      const skipped = incoming.length - unique.length;
      if (!unique.length) {
        toast(`All ${incoming.length} preset(s) in this file are already in your library`);
        return;
      }
      const ids = new Set(state.custom.map((p) => p.id));
      const fresh = unique.map((p) => {
        if (!ids.has(p.id)) {
          ids.add(p.id);
          return p;
        }
        let id;
        do id = WVC.makeCustomPreset(p.name, {}).id; while (ids.has(id));
        ids.add(id);
        return { ...p, id };
      });
      state.custom = WVC.normalizeCustomPresets(state.custom.concat(fresh));
      await writeCustom();
      renderAll();
      toast(`Imported ${fresh.length} preset(s)` + (skipped ? ` · skipped ${skipped} duplicate(s)` : ''));
    } catch (err) {
      toast('Import failed: ' + ((err && err.message) || 'invalid file'), 'error');
    }
  }

  /* ================================================================ parameters */

  const SLIDER_RES = 1000;
  const controls = new Map(); // id -> { param, input, value, row, note }

  function presetValue(id) {
    const p = currentPreset();
    return (p ? WVC.presetParams(p, state.custom) : WVC.defaultParams())[id];
  }

  function stepDecimals(p) {
    return (String(p.step || 1).split('.')[1] || '').length;
  }

  function setParam(id, value, fromDrag) {
    const p = WVC.PARAM_MAP[id];
    const v = WVC.normalizeValue(p, p.type === 'range' ? Number(Number(value).toFixed(stepDecimals(p))) : value);
    if (state.settings.params[id] === v) return;
    if (fromDrag) lastDraggedEntry = { id, value: v };
    commitSettings({ ...state.settings, params: { ...state.settings.params, [id]: v } });
  }

  function initParams() {
    const root = $('groups');
    let collapsed = {};
    try {
      collapsed = JSON.parse(localStorage.getItem('wvc.studio.collapsed') || '{}') || {};
    } catch (_) {
      collapsed = {};
    }
    const saveCollapsed = () => {
      try {
        localStorage.setItem('wvc.studio.collapsed', JSON.stringify(collapsed));
      } catch (_) {
        /* per-viewer convenience only */
      }
    };

    WVC.GROUPS.forEach((g, gi) => {
      const params = WVC.PARAMS.filter((p) => p.group === g.id);
      if (!params.length) return;
      const bodyId = 'group-body-' + g.id;
      const open = !collapsed[g.id];
      const toggle = el('button', { type: 'button', class: 'group-toggle', 'aria-expanded': String(open), 'aria-controls': bodyId }, [
        el('span', { class: 'group-icon', 'aria-hidden': 'true', text: g.icon }),
        el('span', { class: 'group-label', text: g.label }),
        el('span', { class: 'group-count faint', text: `${params.length}` }),
        el('span', { class: 'group-chevron', 'aria-hidden': 'true' }),
      ]);
      const body = el('div', { class: 'group-body', id: bodyId });
      body.hidden = !open;
      const card = el('section', { class: 'card group' + (open ? ' is-open' : ''), 'aria-label': g.label, style: `--i:${gi}` }, [el('h3', { class: 'group-head' }, toggle), body]);
      toggle.addEventListener('click', () => {
        const nowOpen = toggle.getAttribute('aria-expanded') !== 'true';
        toggle.setAttribute('aria-expanded', String(nowOpen));
        body.hidden = !nowOpen;
        card.classList.toggle('is-open', nowOpen);
        collapsed[g.id] = !nowOpen;
        saveCollapsed();
      });
      for (const p of params) body.append(p.type === 'select' ? buildSelect(p) : buildRange(p));
      root.append(card);
    });
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    window.addEventListener('blur', endDrag);
  }

  function buildRange(p) {
    const inputId = 'param-' + p.id;
    const hintId = inputId + '-hint';
    const noteId = inputId + '-note';
    const bipolar = p.min < 0 && p.max > 0;
    const input = el('input', {
      type: 'range',
      id: inputId,
      class: 'slider' + (bipolar ? ' slider-bipolar' : ''),
      min: 0,
      max: SLIDER_RES,
      step: 1,
      'aria-describedby': [p.hint ? hintId : null, noteId].filter(Boolean).join(' '),
    });
    if (bipolar) input.style.setProperty('--zero', WVC.toSlider(p, 0) * 100 + '%');
    const value = el('output', { class: 'param-value mono', for: inputId });
    const label = el('label', { class: 'param-label', for: inputId, text: p.label });
    const note = el('p', { class: 'param-note small', id: noteId, hidden: true });
    const row = el('div', { class: 'param', title: (p.hint ? p.hint + '\n' : '') + 'Double-click the slider to reset it.' }, [
      el('div', { class: 'param-top' }, [label, value]),
      input,
      p.hint ? el('p', { class: 'param-hint faint small', id: hintId, text: p.hint }) : null,
      note,
    ]);

    input.addEventListener('pointerdown', () => {
      state.dragging = p.id;
      lastDraggedEntry = null; // never carry a value over from an earlier drag
    });
    input.addEventListener('input', () => {
      setParam(p.id, WVC.fromSlider(p, Number(input.value) / SLIDER_RES), true);
    });
    input.addEventListener('change', () => {
      if (!state.dragging) writeSettings.flush();
    });
    input.addEventListener('dblclick', () => {
      const v = presetValue(p.id);
      setParam(p.id, v);
      toast(`${p.label} reset to ${WVC.formatValue(p, v)}`);
    });
    input.addEventListener('keydown', (e) => {
      const cur = state.settings.params[p.id];
      const step = p.step || (p.max - p.min) / 100;
      const big = Math.max(step, (p.max - p.min) / 10);
      let next;
      switch (e.key) {
        case 'ArrowUp':
        case 'ArrowRight':
          next = cur + (e.shiftKey ? big : step);
          break;
        case 'ArrowDown':
        case 'ArrowLeft':
          next = cur - (e.shiftKey ? big : step);
          break;
        case 'PageUp':
          next = cur + big;
          break;
        case 'PageDown':
          next = cur - big;
          break;
        case 'Home':
          next = p.min;
          break;
        case 'End':
          next = p.max;
          break;
        case 'Delete':
        case 'Backspace':
          next = presetValue(p.id);
          break;
        default:
          return;
      }
      e.preventDefault();
      setParam(p.id, Math.min(p.max, Math.max(p.min, next)));
    });
    controls.set(p.id, { param: p, input, value, row, note });
    return row;
  }

  function buildSelect(p) {
    const inputId = 'param-' + p.id;
    const hintId = inputId + '-hint';
    const select = el('select', { id: inputId, class: 'select', 'aria-describedby': p.hint ? hintId : null });
    for (const o of p.options) select.append(el('option', { value: o.value, text: o.label }));
    select.addEventListener('change', () => setParam(p.id, select.value));
    const row = el('div', { class: 'param param-select', title: p.hint || '' }, [
      el('div', { class: 'param-top' }, [el('label', { class: 'param-label', for: inputId, text: p.label })]),
      select,
      p.hint ? el('p', { class: 'param-hint faint small', id: hintId, text: p.hint }) : null,
    ]);
    controls.set(p.id, { param: p, input: select, value: null, row, note: null });
    return row;
  }

  function renderParams() {
    const params = state.settings.params;
    const ref = WVC.presetParams(currentPreset() || WVC.DEFAULT_PRESET_ID, state.custom);
    for (const [id, c] of controls) {
      const v = params[id];
      const p = c.param;
      if (p.type === 'select') {
        if (c.input.value !== v) c.input.value = v;
        c.row.classList.toggle('is-changed', v !== ref[id]);
        continue;
      }
      const t = WVC.toSlider(p, v);
      // While dragging, leave the thumb where the pointer put it; only update the readout.
      if (state.dragging !== id) {
        const pos = String(Math.round(t * SLIDER_RES));
        if (c.input.value !== pos) c.input.value = pos;
      }
      c.input.style.setProperty('--fill', t * 100 + '%');
      const text = WVC.formatValue(p, v);
      if (c.value.textContent !== text) c.value.textContent = text;
      c.input.setAttribute('aria-valuetext', text);
      c.row.classList.toggle('is-changed', Math.abs(v - ref[id]) > 1e-6);
    }

    const pitch = controls.get('pitch');
    if (pitch) {
      // Robot and whisper textures replace the voice's own pitch (robot: fixed monotone; whisper: no pitch at all).
      const msg = params.texture === 'robot' ? `No effect with "Monotone robot". The robot's note is set by ${(WVC.PARAM_MAP.robotPitch || { label: 'Robot tone' }).label} below.` : 'No effect with a whispered texture, whispers have no pitch.';
      setDim(pitch, params.texture !== 'normal', msg);
    }
    const formant = controls.get('formant');
    if (formant) {
      const inactive = params.algorithm === 'granular' && params.texture === 'normal';
      setDim(formant, inactive, 'No effect with the Classic engine. Switch Engine to Natural to shape the timbre.');
    }
    const robot = controls.get('robotPitch');
    if (robot) setDim(robot, params.texture !== 'robot', 'Only used when Voice texture is "Monotone robot".');
  }

  function setDim(c, dim, msg) {
    c.row.classList.toggle('is-dim', dim);
    if (c.note) {
      c.note.hidden = !dim;
      c.note.textContent = dim ? msg : '';
    }
  }

  /* ================================================================ call settings + shortcuts */

  function initCallSettings() {
    $('monitorCall').addEventListener('change', (e) => {
      commitSettings({ ...state.settings, monitor: e.target.checked });
      if (e.target.checked) toast('Hear myself is on, use headphones');
    });
    $('fileButton').addEventListener('change', (e) => {
      commitSettings({ ...state.settings, fileButton: e.target.checked });
    });
  }

  function renderCallSettings() {
    $('monitorCall').checked = state.settings.monitor;
    $('monitorCallWarn').classList.toggle('is-emph', state.settings.monitor);
    $('fileButton').checked = state.settings.fileButton !== false;
  }

  const SHORTCUTS_URL = 'chrome://extensions/shortcuts';

  function openShortcutsPage() {
    try {
      chrome.tabs.create({ url: SHORTCUTS_URL }, () => {
        if (lastErrorMessage()) toast(`Open ${SHORTCUTS_URL} manually`, 'error');
      });
    } catch (_) {
      toast(`Open ${SHORTCUTS_URL} manually`, 'error');
    }
  }

  async function renderShortcuts() {
    const list = $('shortcutList');
    let cmds = null;
    try {
      if (hasChrome && chrome.commands && chrome.commands.getAll) cmds = await chrome.commands.getAll();
    } catch (_) {
      cmds = null;
    }
    const live = Array.isArray(cmds);
    if (!live) {
      // Preview mode (no extension APIs): show the manifest's suggested keys.
      cmds = [
        { name: 'toggle-voice', description: 'Turn the voice changer on / off', shortcut: 'Alt+Shift+V' },
        { name: 'next-preset', description: 'Switch to the next preset', shortcut: 'Alt+Shift+M' },
      ];
    }
    // "Open the popup" is only worth listing once the user has given it a key.
    cmds = cmds.filter((c) => c.name !== '_execute_action' || c.shortcut);
    let unset = 0;
    const items = cmds.map((c) => {
      const desc = c.name === '_execute_action' ? 'Open the popup' : c.description || c.name;
      const keys = [];
      if (c.shortcut) {
        c.shortcut.split('+').forEach((k, i) => {
          if (i) keys.push(el('span', { class: 'faint', 'aria-hidden': 'true', text: '+' }));
          keys.push(el('kbd', { class: 'kbd', text: k }));
        });
      } else {
        unset++;
        const link = el('button', { type: 'button', class: 'shortcut-unset', title: `Chrome did not assign a key to this command. Assign one in ${SHORTCUTS_URL}.`, text: 'Not set - assign' });
        link.addEventListener('click', openShortcutsPage);
        keys.push(link);
      }
      return el('li', { class: 'shortcut' }, [el('span', { text: desc }), el('span', { class: 'shortcut-keys' }, keys)]);
    });
    list.replaceChildren(...items);
    const note = $('shortcutNote');
    note.hidden = !unset;
    note.textContent = unset
      ? `"Not set" means Chrome didn't assign the suggested key (Chrome or another extension already uses it). Assign your own in ${SHORTCUTS_URL}.`
      : '';
  }

  function initShortcuts() {
    const btn = $('shortcutBtn');
    if (!hasChrome || !chrome.tabs || !chrome.tabs.create) {
      btn.disabled = true;
      btn.title = 'Available when opened from the extension';
    }
    btn.addEventListener('click', openShortcutsPage);
    // Pick up keys the user just changed in chrome://extensions/shortcuts.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) renderShortcuts();
    });
    window.addEventListener('focus', () => renderShortcuts());
    return renderShortcuts();
  }

  /* ================================================================ mic test lab */

  const METER_FLOOR_DB = -60;
  const RECORD_MS = 5000;

  const lab = {
    running: false,
    starting: false,
    ctx: null,
    stream: null,
    source: null,
    engine: null,
    monitorGain: null,
    recDest: null,
    recorder: null,
    recTimer: null,
    recURL: null,
    raf: 0,
    bypass: false,
    deviceId: '',
    buf: null,
    freq: null,
    meters: {},

    workletURL() {
      try {
        return hasChrome ? chrome.runtime.getURL('src/engine/dsp-core.js') : null;
      } catch (_) {
        return null;
      }
    },

    engineEnabled() {
      return state.settings.enabled && !this.bypass;
    },

    /** Called after every settings change (local or remote). */
    applySettings() {
      if (this.engine) this.engine.update({ params: state.settings.params, enabled: this.engineEnabled() });
      this.renderInfo();
    },

    message(text) {
      const m = $('labMessage');
      m.textContent = text || '';
      m.hidden = !text;
    },

    async start() {
      if (this.running || this.starting) return;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        this.message('Microphone access is not available on this page.');
        return;
      }
      if (!WVC.VoiceEngine || typeof WVC.VoiceEngine.create !== 'function') {
        this.message('The voice engine failed to load. Try reloading this page.');
        return;
      }
      this.starting = true;
      this.message('');
      this.renderButtons();
      try {
        const audio = { echoCancellation: false, noiseSuppression: true, autoGainControl: false, channelCount: 1 };
        if (this.deviceId) audio.deviceId = { exact: this.deviceId };
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({ audio });
        } catch (err) {
          // the saved device may have been unplugged, fall back to the default one
          if (this.deviceId && err && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
            this.deviceId = '';
            delete audio.deviceId;
            this.stream = await navigator.mediaDevices.getUserMedia({ audio });
          } else throw err;
        }
        const Ctx = window.AudioContext || window.webkitAudioContext;
        this.ctx = new Ctx({ latencyHint: 'interactive' });
        if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
        this.engine = await WVC.VoiceEngine.create(this.ctx, {
          params: state.settings.params,
          enabled: this.engineEnabled(),
          workletURL: this.workletURL(),
        });
        this.source = this.ctx.createMediaStreamSource(this.stream);
        this.source.connect(this.engine.input);
        this.monitorGain = this.ctx.createGain();
        this.monitorGain.gain.value = $('monitorTest').checked ? 1 : 0;
        this.engine.output.connect(this.monitorGain);
        this.monitorGain.connect(this.ctx.destination);
        this.recDest = this.ctx.createMediaStreamDestination();
        this.engine.output.connect(this.recDest);
        const track = this.stream.getAudioTracks()[0];
        if (track) {
          track.addEventListener('ended', () => {
            this.stop();
            this.message('The microphone was disconnected.');
          });
          const s = track.getSettings ? track.getSettings() : {};
          if (s.deviceId && !this.restartQueued) this.deviceId = s.deviceId;
        }
        this.buf = new Float32Array(this.engine.inputAnalyser.fftSize);
        this.freq = new Float32Array(this.engine.outputAnalyser.frequencyBinCount);
        this.running = true;
        if (!this.restartQueued) await this.refreshDevices();
        this.loop();
      } catch (err) {
        this.teardown();
        const name = err && err.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          this.message('Microphone permission was denied. Click the camera/microphone icon in the address bar, allow the microphone for this page, then try again.');
        } else if (name === 'NotFoundError') {
          this.message('No microphone was found. Plug one in and try again.');
        } else if (name === 'NotReadableError') {
          this.message('The microphone is busy or blocked by another app. Close other apps using it and try again.');
        } else {
          this.message('Could not start the mic test: ' + ((err && err.message) || err));
        }
      } finally {
        this.starting = false;
        this.renderButtons();
        this.renderInfo();
      }
      if (this.restartQueued) {
        this.restartQueued = false;
        if (this.running) await this.restart();
      }
    },

    stop() {
      this.teardown();
      this.renderButtons();
      this.renderInfo();
      this.resetMeters();
    },

    teardown() {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.stopRecording(true);
      this.setBypass(false);
      try {
        if (this.source) this.source.disconnect();
      } catch (_) {
        /* already disconnected */
      }
      if (this.engine) {
        try {
          this.engine.destroy();
        } catch (_) {
          /* idempotent */
        }
      }
      if (this.stream) for (const t of this.stream.getTracks()) t.stop();
      if (this.ctx && this.ctx.state !== 'closed') this.ctx.close().catch(() => {});
      this.running = false;
      this.ctx = this.stream = this.source = this.engine = this.monitorGain = this.recDest = null;
    },

    async restart() {
      if (this.starting) {
        // e.g. a second device picked while the first switch is still opening the mic
        this.restartQueued = true;
        return;
      }
      if (!this.running) return;
      this.teardown();
      await this.start();
    },

    async refreshDevices() {
      const sel = $('deviceSelect');
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
      try {
        const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
        const labelled = devices.some((d) => d.label);
        const frag = document.createDocumentFragment();
        if (!labelled) frag.append(el('option', { value: '', text: 'Default microphone' }));
        devices.forEach((d, i) => {
          if (!labelled && !d.deviceId) return;
          if (labelled) frag.append(el('option', { value: d.deviceId === 'default' ? '' : d.deviceId, text: d.label || `Microphone ${i + 1}` }));
        });
        sel.replaceChildren(frag);
        sel.value = [...sel.options].some((o) => o.value === this.deviceId) ? this.deviceId : '';
        sel.disabled = !labelled;
      } catch (_) {
        sel.disabled = true;
      }
    },

    setMonitor(on) {
      if (this.monitorGain && this.ctx) this.monitorGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
      $('monitorTestWarn').classList.toggle('is-emph', on);
    },

    setBypass(on) {
      if (this.bypass === on) return;
      this.bypass = on;
      $('bypassBtn').classList.toggle('is-held', on);
      $('bypassBtn').setAttribute('aria-pressed', String(on));
      if (this.engine) this.engine.update({ enabled: this.engineEnabled() });
      this.renderInfo();
    },

    toggleRecording() {
      if (this.recorder) this.stopRecording(false);
      else this.startRecording();
    },

    startRecording() {
      if (!this.recDest || typeof MediaRecorder === 'undefined') {
        toast('Recording is not supported here', 'error');
        return;
      }
      const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
      let rec;
      try {
        rec = new MediaRecorder(this.recDest.stream, mimeType ? { mimeType } : undefined);
      } catch (err) {
        toast('Could not start recording', 'error');
        return;
      }
      const chunks = [];
      rec.addEventListener('dataavailable', (e) => {
        if (e.data && e.data.size) chunks.push(e.data);
      });
      rec.addEventListener('stop', () => {
        clearTimeout(this.recTimer);
        const discard = rec._discard;
        if (this.recorder === rec) this.recorder = null;
        this.renderButtons();
        if (discard || !chunks.length) return;
        const type = rec.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(chunks, { type });
        if (this.recURL) URL.revokeObjectURL(this.recURL);
        this.recURL = URL.createObjectURL(blob);
        const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
        const audio = $('recordAudio');
        // MediaRecorder WebM files carry no duration, so the player would show 0:00 and could not seek.
        // Seeking far past the end once makes Chrome scan the file and learn the real duration.
        audio.addEventListener('loadedmetadata', function fixDuration() {
          if (audio.duration !== Infinity) return;
          const onDur = () => {
            if (!Number.isFinite(audio.duration)) return;
            audio.removeEventListener('durationchange', onDur);
            audio.currentTime = 0;
          };
          audio.addEventListener('durationchange', onDur);
          audio.currentTime = 1e7;
        }, { once: true });
        audio.src = this.recURL;
        $('recordDownload').href = this.recURL;
        $('recordDownload').download = `voice-sample-${Date.now()}.${ext}`;
        $('recording').hidden = false;
      });
      this.recorder = rec;
      this.recStart = performance.now();
      rec.start(250);
      this.recTimer = setTimeout(() => this.stopRecording(false), RECORD_MS);
      this.renderButtons();
    },

    stopRecording(discard) {
      clearTimeout(this.recTimer);
      const rec = this.recorder;
      if (!rec) return;
      rec._discard = !!discard;
      this.recorder = null;
      try {
        if (rec.state !== 'inactive') rec.stop();
      } catch (_) {
        /* already stopped */
      }
      this.renderButtons();
    },

    renderButtons() {
      const b = $('testBtn');
      b.setAttribute('aria-pressed', String(this.running));
      b.classList.toggle('is-running', this.running);
      b.classList.toggle('btn-primary', !this.running);
      b.disabled = this.starting;
      $('testBtnLabel').textContent = this.starting ? 'Starting…' : this.running ? 'Stop mic test' : 'Start mic test';
      $('bypassBtn').disabled = !this.running;
      const rb = $('recordBtn');
      rb.disabled = !this.running;
      rb.classList.toggle('is-recording', !!this.recorder);
      if (!this.recorder) rb.textContent = 'Record 5 s';
      document.body.classList.toggle('lab-running', this.running);
    },

    renderInfo() {
      const info = $('engineInfo');
      if (!this.engine) {
        info.textContent = this.starting ? 'Loading engine…' : 'Engine idle';
        return;
      }
      const type = this.engine.processorType === 'worklet' ? 'AudioWorklet' : this.engine.processorType === 'script-processor' ? 'ScriptProcessor (fallback)' : 'bypassed';
      const lat = Number(this.engine.latency) * 1000;
      const mode = !state.settings.enabled ? ' · master off' : this.bypass ? ' · original voice' : '';
      info.textContent = `${type} · ${Number.isFinite(lat) ? lat.toFixed(1) : '–'} ms latency${mode}`;
    },

    resetMeters() {
      for (const id of ['meterIn', 'meterOut']) this.drawMeter(id, -Infinity, -Infinity, true);
      this.meters = {};
      scope.clear();
    },

    measure(analyser, key) {
      analyser.getFloatTimeDomainData(this.buf);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < this.buf.length; i++) {
        const s = this.buf[i];
        sum += s * s;
        const a = s < 0 ? -s : s;
        if (a > peak) peak = a;
      }
      const rms = 20 * Math.log10(Math.sqrt(sum / this.buf.length) || 1e-9);
      const pk = 20 * Math.log10(peak || 1e-9);
      const now = performance.now();
      const m = (this.meters[key] = this.meters[key] || { rms: -Infinity, hold: -Infinity, holdAt: 0 });
      // Fast attack, ~300 ms release for the bar; peak hold for 1.2 s then falls at 20 dB/s.
      m.rms = rms > m.rms ? rms : m.rms + (rms - m.rms) * 0.12;
      if (pk >= m.hold || now - m.holdAt > 1200) {
        if (pk >= m.hold) {
          m.hold = pk;
          m.holdAt = now;
        } else m.hold = Math.max(pk, m.hold - 20 * ((now - (m.lastAt || now)) / 1000));
      }
      m.lastAt = now;
      return m;
    },

    drawMeter(id, rms, hold, force) {
      const root = $(id);
      const bar = root.querySelector('.meter-bar');
      const pos = (db) => Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
      bar.style.setProperty('--level', pos(rms) * 100 + '%');
      bar.style.setProperty('--peak', pos(hold) * 100 + '%');
      bar.classList.toggle('is-hot', hold > -3);
      const now = performance.now();
      if (force || !root._t || now - root._t > 120) {
        root._t = now;
        const txt = hold > METER_FLOOR_DB ? `${hold > -0.05 ? '0.0' : '−' + Math.abs(hold).toFixed(1)} dB` : '−∞ dB';
        root.querySelector('.meter-value').textContent = txt;
        bar.setAttribute('aria-valuenow', String(Math.round(Math.max(METER_FLOOR_DB, Math.min(0, rms)))));
      }
    },

    loop() {
      const tick = () => {
        if (!this.running || !this.engine) return;
        const mi = this.measure(this.engine.inputAnalyser, 'in');
        this.drawMeter('meterIn', mi.rms, mi.hold);
        const mo = this.measure(this.engine.outputAnalyser, 'out');
        this.drawMeter('meterOut', mo.rms, mo.hold);
        scope.draw(this.engine.outputAnalyser, this.freq, this.buf, this.ctx.sampleRate);
        if (this.recorder) {
          const left = Math.max(0, RECORD_MS - (performance.now() - this.recStart));
          $('recordBtn').textContent = `Stop (${(left / 1000).toFixed(1)} s)`;
        }
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    },
  };

  /* ---------------- spectrum / waveform canvas ---------------- */

  const scope = {
    canvas: null,
    g: null,
    w: 0,
    h: 0,
    dpr: 1,
    colors: {},
    smooth: null,

    init() {
      this.canvas = $('scope');
      this.g = this.canvas.getContext('2d');
      const ro = new ResizeObserver(() => this.resize());
      ro.observe(this.canvas);
      matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => this.readColors());
      this.readColors();
      this.resize();
    },

    readColors() {
      const cs = getComputedStyle(document.documentElement);
      const v = (n) => cs.getPropertyValue(n).trim();
      this.colors = { accent: v('--accent'), violet: v('--violet'), grid: v('--border'), text: v('--text-faint'), live: v('--live') };
      this.clear();
    },

    resize() {
      const r = this.canvas.getBoundingClientRect();
      this.dpr = Math.min(3, window.devicePixelRatio || 1);
      this.w = Math.max(1, Math.round(r.width));
      this.h = Math.max(1, Math.round(r.height));
      this.canvas.width = Math.round(this.w * this.dpr);
      this.canvas.height = Math.round(this.h * this.dpr);
      this.g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      if (!lab.running) this.clear();
    },

    grid() {
      const { g, w, h } = this;
      g.clearRect(0, 0, w, h);
      g.strokeStyle = this.colors.grid;
      g.fillStyle = this.colors.text;
      g.lineWidth = 1;
      g.font = '10px ' + getComputedStyle(document.body).getPropertyValue('--mono');
      g.globalAlpha = 0.6;
      for (const f of [100, 1000, 10000]) {
        const x = Math.round(this.xOf(f)) + 0.5;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, h);
        g.stroke();
        g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), x + 4, h - 6);
      }
      for (const db of [-30, -60]) {
        const y = Math.round(this.yOf(db)) + 0.5;
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(w, y);
        g.stroke();
      }
      g.globalAlpha = 1;
    },

    xOf(f) {
      const lo = Math.log(40);
      const hi = Math.log(20000);
      return ((Math.log(f) - lo) / (hi - lo)) * this.w;
    },

    yOf(db) {
      return (Math.max(-100, Math.min(0, db)) / -100) * this.h;
    },

    clear() {
      if (!this.g) return;
      this.grid();
      this.smooth = null;
      const { g, w, h } = this;
      g.fillStyle = this.colors.text;
      g.textAlign = 'center';
      g.font = '13px ' + getComputedStyle(document.body).getPropertyValue('--font');
      g.fillText(lab.running ? '' : 'Start the mic test to see your voice', w / 2, h / 2);
      g.textAlign = 'start';
    },

    draw(analyser, freq, wave, sampleRate) {
      if (!this.g || this.w < 2) return;
      const { g, w, h } = this;
      this.grid();

      analyser.getFloatFrequencyData(freq);
      const n = freq.length;
      if (!this.smooth || this.smooth.length !== n) this.smooth = new Float32Array(n).fill(-100);
      const binHz = sampleRate / 2 / n;
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, this.colors.accent);
      grad.addColorStop(1, 'transparent');
      g.beginPath();
      g.moveTo(0, h);
      let lastX = -1;
      for (let i = 1; i < n; i++) {
        const f = i * binHz;
        if (f < 40) continue;
        const v = Number.isFinite(freq[i]) ? freq[i] : -100;
        this.smooth[i] = v > this.smooth[i] ? v : this.smooth[i] * 0.85 + v * 0.15;
        const x = this.xOf(f);
        if (x - lastX < 1 && i < n - 1) continue; // one point per pixel column is plenty
        lastX = x;
        g.lineTo(x, this.yOf(this.smooth[i]));
      }
      g.lineTo(w, h);
      g.closePath();
      g.globalAlpha = 0.35;
      g.fillStyle = grad;
      g.fill();
      g.globalAlpha = 1;
      g.strokeStyle = this.colors.accent;
      g.lineWidth = 1.5;
      g.stroke();

      analyser.getFloatTimeDomainData(wave);
      g.beginPath();
      const mid = h / 2;
      const len = Math.min(wave.length, 1024);
      for (let i = 0; i < len; i++) {
        const x = (i / (len - 1)) * w;
        const y = mid - Math.max(-1, Math.min(1, wave[i])) * mid * 0.9;
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      g.strokeStyle = this.colors.violet;
      g.lineWidth = 1.25;
      g.stroke();
    },
  };

  function initLab() {
    scope.init();
    $('testBtn').addEventListener('click', () => (lab.running ? lab.stop() : lab.start()));
    $('deviceSelect').addEventListener('change', (e) => {
      lab.deviceId = e.target.value;
      lab.restart();
    });
    $('monitorTest').addEventListener('change', (e) => lab.setMonitor(e.target.checked));
    $('recordBtn').addEventListener('click', () => lab.toggleRecording());

    const bp = $('bypassBtn');
    bp.setAttribute('aria-pressed', 'false');
    bp.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      bp.setPointerCapture(e.pointerId);
      lab.setBypass(true);
    });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) bp.addEventListener(ev, () => lab.setBypass(false));
    bp.addEventListener('keydown', (e) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
      if (!e.repeat) lab.setBypass(true);
    });
    bp.addEventListener('keyup', (e) => {
      if (e.key === ' ' || e.key === 'Enter') lab.setBypass(false);
    });
    bp.addEventListener('blur', () => lab.setBypass(false));
    bp.addEventListener('contextmenu', (e) => e.preventDefault());

    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => {
        if (lab.running) lab.refreshDevices();
      });
    }
    window.addEventListener('pagehide', () => {
      lab.teardown();
      if (lab.recURL) URL.revokeObjectURL(lab.recURL);
    });
    lab.renderButtons();
  }

  /* ================================================================ render + boot */

  function renderAll() {
    renderHeader();
    renderCurrent();
    renderPresets();
    renderParams();
    renderCallSettings();
  }

  async function init() {
    await loadStored();
    initHeader();
    initPresets();
    initParams();
    initCallSettings();
    initLab();
    initShortcuts();
    renderAll();
    if (hasStorage && chrome.storage.onChanged) chrome.storage.onChanged.addListener(onStorageChanged);
    else toast('Preview mode, settings are not saved');
    window.addEventListener('pagehide', () => writeSettings.flush());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) pollStatus();
    });
    requestAnimationFrame(() => document.body.classList.add('is-ready'));
  }

  init().catch((err) => {
    console.error('[Voice Studio] failed to start', err);
    toast('Voice Studio failed to start: ' + ((err && err.message) || err), 'error');
  });
})();
