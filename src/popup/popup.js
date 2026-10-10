/* Toolbar popup. */
(function () {
  'use strict';

  const WVC = globalThis.WVC;
  const KEYS = WVC.STORAGE_KEYS;
  const WA_ORIGIN = 'https://web.whatsapp.com/';
  const SLIDER_RES = 1000;
  const WRITE_DEBOUNCE_MS = 60;
  const STATUS_POLL_MS = 1000;
  const CHIP_STORAGE_KEY = 'wvc.popup.category';
  const ALL = 'all';

  const hasChrome = typeof chrome !== 'undefined' && chrome && chrome.runtime && chrome.runtime.id;
  const hasStorage = !!(hasChrome && chrome.storage && chrome.storage.local);

  const $ = (id) => document.getElementById(id);
  const el = {
    app: $('app'),
    enabled: $('enabled'),
    status: $('status'),
    openWa: $('openWa'),
    reloadWa: $('reloadWa'),
    curEmoji: $('curEmoji'),
    curName: $('curName'),
    curMod: $('curMod'),
    reset: $('reset'),
    chips: $('chips'),
    grid: $('grid'),
    sliders: $('sliders'),
    studio: $('studio'),
    shortcuts: $('shortcuts'),
    voiceNote: $('voiceNote'),
    voiceNoteHint: $('voiceNoteHint'),
  };

  const state = {
    settings: WVC.defaultSettings(),
    custom: [],
    category: readChip(),
    activeSlider: null, // param id the user is dragging right now
    tabId: null,
    isWhatsApp: false,
    status: null,
    statusKnown: false, // got at least one RT_GET_STATUS reply
    statusFailed: false, // the first request(s) failed
  };

  const sliderRows = new Map(); // param id -> { row, input, value, param }
  let writeTimer = 0;
  let pendingWrite = false;
  // Fields edited locally since the last write. An external change (studio, keyboard command)
  // that lands while a write is pending is merged: our dirty fields win, everything else comes
  // from storage, so neither surface silently reverts the other's edits.
  const dirty = { enabled: false, preset: false, params: new Set() };
  // Snapshots of what we wrote recently, used to recognise (and skip) our own onChanged echoes,
  // including stale ones that arrive after a newer local edit.
  const ECHO_TTL_MS = 3000;
  let recentWrites = []; // [{ json, at }]

  /* ------------------------------------------------------------ storage */

  function readChip() {
    try {
      return localStorage.getItem(CHIP_STORAGE_KEY) || ALL;
    } catch {
      return ALL;
    }
  }
  function saveChip(id) {
    try {
      localStorage.setItem(CHIP_STORAGE_KEY, id);
    } catch {
      /* storage blocked: selection simply isn't remembered */
    }
  }

  async function loadFromStorage() {
    if (!hasStorage) return;
    try {
      const data = await chrome.storage.local.get([KEYS.SETTINGS, KEYS.CUSTOM_PRESETS]);
      state.custom = WVC.normalizeCustomPresets(data[KEYS.CUSTOM_PRESETS]);
      const stored = WVC.normalizeSettings(data[KEYS.SETTINGS]);
      // Don't clobber edits the user made before the initial read resolved.
      state.settings = pendingWrite ? mergeDirty(stored) : stored;
    } catch (err) {
      console.warn('[WVC popup] could not read settings', err);
    }
  }

  function mergeDirty(incoming) {
    const local = state.settings;
    if (dirty.enabled) incoming.enabled = local.enabled;
    if (dirty.preset) {
      incoming.presetId = local.presetId;
      incoming.params = { ...local.params };
    }
    for (const id of dirty.params) incoming.params[id] = local.params[id];
    return incoming;
  }

  function scheduleWrite(immediate) {
    pendingWrite = true;
    clearTimeout(writeTimer);
    if (immediate) flushWrite();
    else writeTimer = setTimeout(flushWrite, WRITE_DEBOUNCE_MS);
  }

  function flushWrite() {
    clearTimeout(writeTimer);
    if (!pendingWrite) return;
    pendingWrite = false;
    dirty.enabled = false;
    dirty.preset = false;
    dirty.params.clear();
    if (!hasStorage) return;
    const settings = WVC.normalizeSettings(state.settings);
    const now = Date.now();
    recentWrites = recentWrites.filter((w) => now - w.at < ECHO_TTL_MS);
    recentWrites.push({ json: JSON.stringify(settings), at: now });
    try {
      chrome.storage.local.set({ [KEYS.SETTINGS]: settings }).catch((err) => console.warn('[WVC popup] write failed', err));
    } catch (err) {
      console.warn('[WVC popup] write failed', err);
    }
  }

  // True when `settings` is one of our own recent writes (it and everything older is then dropped).
  function isOwnEcho(settings) {
    const json = JSON.stringify(settings);
    const now = Date.now();
    const i = recentWrites.findIndex((w) => w.json === json && now - w.at < ECHO_TTL_MS);
    if (i < 0) return false;
    recentWrites = recentWrites.slice(i + 1);
    return true;
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    let touched = false;
    const customChanged = !!changes[KEYS.CUSTOM_PRESETS];
    if (customChanged) {
      state.custom = WVC.normalizeCustomPresets(changes[KEYS.CUSTOM_PRESETS].newValue);
      renderChips();
    }
    if (changes[KEYS.SETTINGS]) {
      let incoming = WVC.normalizeSettings(changes[KEYS.SETTINGS].newValue);
      if (!isOwnEcho(incoming)) {
        // External change (studio, keyboard command): merge so our unsaved edits survive.
        if (pendingWrite) incoming = mergeDirty(incoming);
        if (state.activeSlider) {
          // Keep the value under the user's finger; accept everything else.
          incoming.params[state.activeSlider] = state.settings.params[state.activeSlider];
        }
        state.settings = incoming;
        touched = true;
      }
    }
    if (touched) {
      renderEnabled();
      renderCurrent(true);
      renderGridSelection();
      renderSliders();
      renderStatus();
    } else if (customChanged) {
      // The current preset may have been renamed, edited or deleted in the studio.
      renderCurrent(false);
      renderSliders();
    }
  }

  /* ------------------------------------------------------------ settings actions */

  function setEnabled(on) {
    state.settings.enabled = !!on;
    dirty.enabled = true;
    renderEnabled();
    renderStatus();
    scheduleWrite(true);
  }

  function applyPreset(id) {
    const preset = WVC.getPreset(id, state.custom);
    if (!preset) return;
    state.settings.presetId = preset.id;
    state.settings.params = WVC.presetParams(preset, state.custom);
    dirty.preset = true;
    dirty.params.clear();
    scheduleWrite(true);
    renderCurrent(true);
    renderGridSelection();
    renderSliders();
  }

  function setParam(id, value, { flash = false } = {}) {
    const v = WVC.normalizeValue(id, value);
    if (v === undefined || v === state.settings.params[id]) return;
    state.settings.params[id] = v;
    dirty.params.add(id);
    scheduleWrite();
    renderSlider(id, flash);
    renderCurrent(false);
  }

  function presetValue(id) {
    return WVC.presetParams(state.settings.presetId, state.custom)[id];
  }

  /* ------------------------------------------------------------ rendering */

  function renderAll() {
    renderEnabled();
    renderCurrent(false);
    renderChips();
    renderSliders();
    renderStatus();
  }

  function renderEnabled() {
    el.enabled.checked = state.settings.enabled;
    el.enabled.setAttribute('aria-checked', String(state.settings.enabled));
    el.app.classList.toggle('is-off', !state.settings.enabled);
  }

  let lastPresetShown = null;
  function renderCurrent(animate) {
    const preset = WVC.getPreset(state.settings.presetId, state.custom);
    const modified = WVC.isModified(state.settings, state.custom);
    el.curEmoji.textContent = preset ? preset.emoji : '🎛️';
    el.curName.textContent = preset ? preset.name : 'Custom voice';
    el.curName.parentElement.title = el.curName.textContent + (modified ? ' (modified)' : '');
    el.curMod.hidden = !modified;
    el.reset.disabled = !modified || !preset;
    if (animate && lastPresetShown !== state.settings.presetId) {
      el.curEmoji.classList.remove('bump');
      void el.curEmoji.offsetWidth; // restart animation
      el.curEmoji.classList.add('bump');
    }
    lastPresetShown = state.settings.presetId;
  }

  function visibleCategories() {
    const cats = [{ id: ALL, label: 'All' }];
    for (const c of WVC.PRESET_CATEGORIES) {
      if (c.id === 'mine' && state.custom.length === 0) continue;
      cats.push(c);
    }
    return cats;
  }

  function renderChips() {
    // Re-rendering replaces the buttons; remember what had focus so it can be restored.
    const ae = document.activeElement;
    const focusedCat = ae && el.chips.contains(ae) ? ae.dataset.cat : null;
    const focusedPreset = ae && el.grid.contains(ae) ? ae.dataset.preset : null;
    rebuildChips();
    let target = null;
    if (focusedCat) target = el.chips.querySelector('.chip[aria-selected="true"]');
    else if (focusedPreset) target = [...el.grid.querySelectorAll('.preset')].find((b) => b.dataset.preset === focusedPreset) || el.grid.querySelector('.preset');
    if (target) target.focus({ preventScroll: true });
  }

  function rebuildChips() {
    const cats = visibleCategories();
    if (!cats.some((c) => c.id === state.category)) state.category = ALL;
    el.chips.textContent = '';
    for (const c of cats) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.id = 'chip-' + c.id;
      b.setAttribute('role', 'tab');
      b.dataset.cat = c.id;
      b.textContent = c.label;
      const selected = c.id === state.category;
      b.setAttribute('aria-selected', String(selected));
      b.tabIndex = selected ? 0 : -1;
      el.chips.appendChild(b);
    }
    el.grid.setAttribute('aria-labelledby', 'chip-' + state.category);
    renderGrid();
  }

  function allPresets() {
    return [...WVC.PRESETS, ...state.custom];
  }

  function renderGrid() {
    const list = allPresets().filter((p) => state.category === ALL || p.category === state.category);
    el.grid.textContent = '';
    if (!list.length) {
      const empty = document.createElement('p');
      empty.className = 'grid-empty faint';
      empty.textContent = 'No presets here yet.';
      el.grid.appendChild(empty);
      return;
    }
    list.forEach((p, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'preset';
      b.dataset.preset = p.id;
      b.title = p.description || p.name;
      b.style.animationDelay = Math.min(i * 12, 240) + 'ms';
      const emoji = document.createElement('span');
      emoji.className = 'preset-emoji';
      emoji.setAttribute('aria-hidden', 'true');
      emoji.textContent = p.emoji || '⭐';
      const name = document.createElement('span');
      name.className = 'preset-name';
      name.textContent = p.name;
      b.append(emoji, name);
      el.grid.appendChild(b);
    });
    renderGridSelection();
  }

  function renderGridSelection() {
    // Roving tabindex: one Tab stop for the whole grid (the selected tile), arrows move inside.
    const tiles = [...el.grid.querySelectorAll('.preset')];
    const focused = tiles.find((b) => b === document.activeElement);
    let stop = null;
    for (const b of tiles) {
      const on = b.dataset.preset === state.settings.presetId;
      b.setAttribute('aria-pressed', String(on));
      if (on) stop = b;
    }
    stop = focused || stop || tiles[0];
    for (const b of tiles) b.tabIndex = b === stop ? 0 : -1;
  }

  function buildSliders() {
    el.sliders.textContent = '';
    sliderRows.clear();
    for (const id of WVC.QUICK_PARAMS) {
      const param = WVC.PARAM_MAP[id];
      if (!param || param.type !== 'range') continue;
      const row = document.createElement('div');
      row.className = 'qs';
      const head = document.createElement('div');
      head.className = 'qs-head';
      head.title = (param.hint ? param.hint + ' ' : '') + 'Double-click to reset.';
      const label = document.createElement('label');
      label.className = 'qs-label';
      label.htmlFor = 'qs-' + id;
      label.textContent = param.label;
      const value = document.createElement('output');
      value.className = 'qs-value';
      value.htmlFor = 'qs-' + id;
      head.append(label, value);

      const input = document.createElement('input');
      input.type = 'range';
      input.id = 'qs-' + id;
      input.className = 'slider';
      input.min = '0';
      input.max = String(SLIDER_RES);
      input.step = '1';
      input.dataset.param = id;
      if (param.min < 0 && param.max > 0) {
        input.classList.add('slider-bipolar');
        input.style.setProperty('--zero', (WVC.toSlider(param, 0) * 100).toFixed(2) + '%');
      }
      row.append(head, input);
      el.sliders.appendChild(row);
      sliderRows.set(id, { row, input, value, param });

      head.addEventListener('dblclick', () => resetParam(id));
      input.addEventListener('input', () => {
        state.activeSlider = id;
        setParam(id, WVC.fromSlider(param, Number(input.value) / SLIDER_RES));
      });
      input.addEventListener('change', () => {
        if (state.activeSlider === id) state.activeSlider = null;
      });
      input.addEventListener('pointerdown', () => (state.activeSlider = id));
      input.addEventListener('pointerup', () => {
        if (state.activeSlider === id) state.activeSlider = null;
      });
      input.addEventListener('blur', () => {
        if (state.activeSlider === id) state.activeSlider = null;
      });
      input.addEventListener('keydown', (e) => onSliderKey(e, id));
      input.addEventListener('dblclick', (e) => {
        if (e.altKey) resetParam(id);
      });
    }
  }

  function resetParam(id) {
    setParam(id, presetValue(id), { flash: true });
  }

  // Step in value space so log-scaled params move by their real step, not by 1/1000 of the track.
  function onSliderKey(e, id) {
    const p = WVC.PARAM_MAP[id];
    const cur = state.settings.params[id];
    const big = (p.max - p.min) / 10;
    let next;
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        next = cur + (e.shiftKey ? big : p.step);
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        next = cur - (e.shiftKey ? big : p.step);
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
        next = presetValue(id);
        break;
      default:
        return;
    }
    e.preventDefault();
    if (p.step) next = Math.round((next - p.min) / p.step) * p.step + p.min;
    const decimals = (String(p.step).split('.')[1] || '').length;
    setParam(id, Number(WVC.clamp(next, p.min, p.max).toFixed(decimals)));
  }

  function renderSliders() {
    for (const id of sliderRows.keys()) renderSlider(id, false);
  }

  function renderSlider(id, flash) {
    const r = sliderRows.get(id);
    if (!r) return;
    const v = state.settings.params[id];
    const t = WVC.toSlider(r.param, v);
    if (state.activeSlider !== id || document.activeElement !== r.input) {
      r.input.value = String(Math.round(t * SLIDER_RES));
    }
    r.input.style.setProperty('--fill', (t * 100).toFixed(2) + '%');
    const text = WVC.formatValue(r.param, v);
    r.value.textContent = text;
    r.input.setAttribute('aria-valuetext', text);
    const base = presetValue(id);
    r.row.classList.toggle('is-changed', Math.abs(v - base) > 1e-6);
    if (flash) {
      r.value.classList.remove('flash');
      void r.value.offsetWidth;
      r.value.classList.add('flash');
      setTimeout(() => r.value.classList.remove('flash'), 400);
    }
  }

  /* ------------------------------------------------------------ status */

  function pill(kind, text, sub) {
    const p = document.createElement('span');
    p.className = 'pill' + (kind ? ' pill-' + kind : '');
    const t = document.createElement('span');
    t.className = 'pill-text';
    t.textContent = text;
    if (sub) {
      const s = document.createElement('span');
      s.className = 'pill-sub';
      s.textContent = ' · ' + sub;
      t.append(s);
    }
    p.append(t);
    p.title = text + (sub ? ' · ' + sub : '');
    return p;
  }

  let lastStatusKey = '';
  function renderStatus() {
    let node;
    let key;
    const s = state.status;
    if (!hasChrome) {
      key = 'preview';
      node = pill('', 'Preview (extension APIs unavailable)');
    } else if (!state.isWhatsApp) {
      key = 'nowa|' + state.settings.enabled;
      node = state.settings.enabled ? pill('', 'Not on WhatsApp Web') : pill('', 'Off: your normal voice is used');
    } else if (!state.statusKnown) {
      // No reply from the service worker yet (or it is unreachable).
      key = 'unknown|' + state.statusFailed;
      node = state.statusFailed ? pill('warn', 'Status unavailable, try reopening this popup') : pill('', 'Checking…');
    } else if (!s) {
      // { status: null }: the content scripts never reported from this tab (opened before the
      // extension was installed / reloaded), so calls in it are not processed yet.
      key = 'detached';
      node = pill('warn', 'Reload WhatsApp Web to activate');
    } else if (!state.settings.enabled) {
      key = 'off|' + (s.active > 0);
      node = pill('', s.active > 0 ? 'Off: the call uses your normal voice' : 'Off: your normal voice is used');
    } else if (s.active > 0) {
      const proc = s.processor === 'worklet' ? 'AudioWorklet' : s.processor === 'script-processor' ? 'fallback DSP' : '';
      key = 'live|' + proc;
      node = pill('live', 'Voice changer live on call', proc);
    } else if (s.error) {
      key = 'err|' + s.error;
      node = pill('warn', 'Problem: ' + String(s.error));
    } else {
      key = 'ok';
      node = pill('ok', 'Ready for your next call or voice note');
    }
    el.openWa.hidden = !hasChrome || state.isWhatsApp;
    renderVoiceNote();
    el.reloadWa.hidden = key !== 'detached';
    if (key === lastStatusKey) return;
    lastStatusKey = key;
    el.status.textContent = '';
    el.status.appendChild(node);
  }

  function renderVoiceNote() {
    const usable = hasChrome && state.isWhatsApp && state.tabId != null;
    el.voiceNote.disabled = !usable || vnBusy;
    el.voiceNoteHint.hidden = usable && !vnError;
    if (vnError) el.voiceNoteHint.textContent = vnError;
    else if (!hasChrome || !state.isWhatsApp) el.voiceNoteHint.textContent = 'Open a WhatsApp Web tab first to use this.';
  }

  let vnBusy = false;
  let vnError = '';
  async function openVoiceNote() {
    if (!hasChrome || !state.isWhatsApp || state.tabId == null || vnBusy) return;
    vnBusy = true;
    vnError = '';
    renderVoiceNote();
    try {
      const res = await chrome.tabs.sendMessage(state.tabId, { type: WVC.MSG.RT_OPEN_VOICENOTE }, { frameId: 0 });
      if (res && res.ok) {
        window.close();
        return;
      }
      vnError = 'The 🎵 panel did not answer. Reload the WhatsApp Web tab and try again.';
    } catch {
      // No receiver: the tab was opened before the extension was installed/updated.
      vnError = 'Reload the WhatsApp Web tab, then try again.';
      el.reloadWa.hidden = false;
    }
    vnBusy = false;
    renderVoiceNote();
  }

  async function detectTab() {
    if (!hasChrome || !chrome.tabs) return;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      state.tabId = tab && typeof tab.id === 'number' ? tab.id : null;
      state.isWhatsApp = !!(tab && typeof tab.url === 'string' && tab.url.startsWith(WA_ORIGIN));
    } catch (err) {
      state.isWhatsApp = false;
      console.warn('[WVC popup] tabs.query failed', err);
    }
  }

  async function pollStatus() {
    if (!hasChrome || !state.isWhatsApp || state.tabId == null) {
      renderStatus();
      return;
    }
    try {
      const res = await chrome.runtime.sendMessage({ type: WVC.MSG.RT_GET_STATUS, tabId: state.tabId });
      const st = res && res.status && typeof res.status === 'object' ? res.status : null;
      state.status = st ? { ...st, active: Math.max(0, Number(st.active) || 0) } : null;
      state.statusKnown = true;
      state.statusFailed = false;
    } catch {
      // Service worker not reachable (e.g. just restarting): keep the last known status.
      if (!state.statusKnown) state.statusFailed = true;
    }
    renderStatus();
  }

  /* ------------------------------------------------------------ shortcuts */

  async function renderShortcuts() {
    const map = { 'toggle-voice': 'Alt+Shift+V', 'next-preset': 'Alt+Shift+M' };
    if (hasChrome && chrome.commands && chrome.commands.getAll) {
      try {
        const cmds = await chrome.commands.getAll();
        for (const c of cmds) {
          if (c.name in map) map[c.name] = c.shortcut || '';
        }
      } catch {
        /* keep defaults */
      }
    }
    el.shortcuts.textContent = '';
    const add = (combo, label) => {
      if (!combo) return;
      const line = document.createElement('span');
      line.style.display = 'block';
      for (const [i, k] of combo.split('+').entries()) {
        if (i) line.append('+');
        const kbd = document.createElement('span');
        kbd.className = 'kbd';
        kbd.textContent = k;
        line.append(kbd);
      }
      line.append(' ' + label);
      el.shortcuts.appendChild(line);
    };
    add(map['toggle-voice'], 'on/off');
    add(map['next-preset'], 'next voice');
  }

  /* ------------------------------------------------------------ events */

  function bindEvents() {
    el.enabled.addEventListener('change', () => setEnabled(el.enabled.checked));

    el.reset.addEventListener('click', () => {
      applyPreset(state.settings.presetId);
      renderSliders();
    });

    el.chips.addEventListener('click', (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      selectChip(b.dataset.cat, false);
    });
    el.chips.addEventListener('keydown', (e) => {
      const chips = [...el.chips.querySelectorAll('.chip')];
      const i = chips.findIndex((c) => c.dataset.cat === state.category);
      let j = -1;
      if (e.key === 'ArrowRight') j = (i + 1) % chips.length;
      else if (e.key === 'ArrowLeft') j = (i - 1 + chips.length) % chips.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = chips.length - 1;
      if (j < 0) return;
      e.preventDefault();
      selectChip(chips[j].dataset.cat, true);
    });

    el.grid.addEventListener('click', (e) => {
      const b = e.target.closest('.preset');
      if (b) applyPreset(b.dataset.preset);
    });
    el.grid.addEventListener('keydown', onGridKey);

    el.openWa.addEventListener('click', () => {
      if (!hasChrome) return;
      chrome.tabs.create({ url: WA_ORIGIN }).catch(() => {});
      window.close();
    });

    el.reloadWa.addEventListener('click', () => {
      if (!hasChrome || state.tabId == null) return;
      try {
        const p = chrome.tabs.reload(state.tabId);
        if (p && p.catch) p.catch(() => {});
      } catch {
        /* ignore */
      }
      window.close();
    });

    el.voiceNote.addEventListener('click', openVoiceNote);

    el.studio.addEventListener('click', () => {
      if (!hasChrome) return;
      try {
        const p = chrome.runtime.openOptionsPage();
        if (p && p.catch) p.catch(() => {});
      } catch {
        /* ignore */
      }
      window.close();
    });

    window.addEventListener('pagehide', flushWrite);
    window.addEventListener('blur', flushWrite);
    if (hasStorage) chrome.storage.onChanged.addListener(onStorageChanged);
  }

  function selectChip(id, focus) {
    // renderChips() replaces the buttons, so keep keyboard focus on the chip row (Enter/Space).
    const hadFocus = el.chips.contains(document.activeElement);
    state.category = id;
    saveChip(id);
    renderChips();
    if (focus || hadFocus) {
      const c = el.chips.querySelector('.chip[aria-selected="true"]');
      if (c) {
        c.focus();
        c.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
  }

  // Arrow-key navigation inside the 4-column preset grid.
  function onGridKey(e) {
    const tiles = [...el.grid.querySelectorAll('.preset')];
    const i = tiles.indexOf(document.activeElement);
    if (i < 0) return;
    const cols = 4;
    let j = -1;
    if (e.key === 'ArrowRight') j = i + 1;
    else if (e.key === 'ArrowLeft') j = i - 1;
    else if (e.key === 'ArrowDown') j = i + cols;
    else if (e.key === 'ArrowUp') j = i - cols;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tiles.length - 1;
    if (j < 0 || j >= tiles.length) return;
    e.preventDefault();
    tiles[i].tabIndex = -1;
    tiles[j].tabIndex = 0;
    tiles[j].focus();
  }

  /* ------------------------------------------------------------ init */

  async function init() {
    buildSliders();
    bindEvents();
    renderAll();
    await Promise.all([loadFromStorage(), detectTab()]);
    renderAll();
    renderShortcuts();
    await pollStatus();
    if (hasChrome) setInterval(pollStatus, STATUS_POLL_MS);
  }

  init().catch((err) => console.error('[WVC popup] init failed', err));
})();
