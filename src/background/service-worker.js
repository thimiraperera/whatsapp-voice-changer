/*
 * Background service worker: default settings, keyboard shortcuts, the toolbar badge
 * and the live status of each tab.
 */
'use strict';

importScripts('/src/shared/params.js');

(function () {
  const WVC = globalThis.WVC;
  const MSG = WVC.MSG;
  const KEY = WVC.STORAGE_KEYS.SETTINGS;
  const CUSTOM_KEY = WVC.STORAGE_KEYS.CUSTOM_PRESETS;
  const SESSION_KEY = 'wvc.tabStatus';
  const WHATSAPP_PREFIX = 'https://web.whatsapp.com/';
  const COLOR_ON = '#1fb85a';
  const COLOR_LIVE = '#e0263a';

  // tabId (string) -> { frameKey (string) -> status }
  let tabStatus = {};
  let enabled = true;

  const restored = (async () => {
    try {
      const got = await chrome.storage.session.get(SESSION_KEY);
      const saved = got && got[SESSION_KEY];
      if (saved && typeof saved === 'object') {
        // Merge: messages that arrived before the restore finished win.
        for (const [tabId, frames] of Object.entries(saved)) {
          if (frames && typeof frames === 'object') tabStatus[tabId] = Object.assign({}, frames, tabStatus[tabId]);
        }
      }
    } catch (_) {
      /* session storage unavailable: start empty */
    }
    try {
      const got = await chrome.storage.local.get(KEY);
      enabled = WVC.normalizeSettings(got && got[KEY]).enabled;
    } catch (_) {
      /* keep default */
    }
  })();

  let persistTimer = 0;
  function persist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = 0;
      chrome.storage.session.set({ [SESSION_KEY]: tabStatus }).catch(() => {});
    }, 50);
  }

  function aggregate(tabId) {
    const frames = tabStatus[String(tabId)];
    if (!frames) return null;
    const list = Object.values(frames).filter((s) => s && typeof s === 'object');
    if (!list.length) return null;
    const out = WVC.emptyStatus();
    let newest = null;
    let newestError = null;
    for (const s of list) {
      out.active += Math.max(0, Number(s.active) || 0);
      if (!newest || (s.updatedAt || 0) >= (newest.updatedAt || 0)) newest = s;
      if (s.error && (!newestError || (s.updatedAt || 0) >= (newestError.updatedAt || 0))) newestError = s;
      out.updatedAt = Math.max(out.updatedAt, Number(s.updatedAt) || 0);
    }
    // Prefer the frame that actually has a live stream for processor/context info.
    const liveNewest = list
      .filter((s) => s.active > 0)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    const src = liveNewest || newest;
    out.processor = (src && src.processor) || list.map((s) => s.processor).find(Boolean) || null;
    out.contextState = (src && src.contextState) || list.map((s) => s.contextState).find(Boolean) || null;
    out.error = newestError ? String(newestError.error) : null;
    return out;
  }

  async function setBadge(tabId) {
    const status = aggregate(tabId);
    const live = !!(status && status.active > 0);
    const text = !enabled ? '' : live ? 'LIVE' : 'ON';
    try {
      await chrome.action.setBadgeText({ tabId, text });
      if (text) {
        await chrome.action.setBadgeBackgroundColor({ tabId, color: live ? COLOR_LIVE : COLOR_ON });
        if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' });
      }
    } catch (_) {
      /* tab closed meanwhile */
    }
  }

  async function refreshAllBadges() {
    try {
      const tabs = await chrome.tabs.query({ url: WHATSAPP_PREFIX + '*' });
      await Promise.all(tabs.map((t) => (t.id >= 0 ? setBadge(t.id) : null)));
    } catch (_) {
      /* ignore */
    }
    // Tabs we hold status for (e.g. restored) but that the query did not return.
    for (const id of Object.keys(tabStatus)) setBadge(Number(id));
  }

  function clearTab(tabId) {
    const key = String(tabId);
    if (tabStatus[key]) {
      delete tabStatus[key];
      persist();
    }
  }

  async function readSettings() {
    const got = await chrome.storage.local.get([KEY, CUSTOM_KEY]);
    return {
      settings: WVC.normalizeSettings(got[KEY]),
      custom: WVC.normalizeCustomPresets(got[CUSTOM_KEY]),
    };
  }

  /* ---------------------------------------------------------------- *
   * Events
   * ---------------------------------------------------------------- */

  chrome.runtime.onInstalled.addListener(async (details) => {
    try {
      const got = await chrome.storage.local.get([KEY, CUSTOM_KEY]);
      const writes = {};
      if (got[KEY] === undefined) writes[KEY] = WVC.defaultSettings();
      if (got[CUSTOM_KEY] === undefined) writes[CUSTOM_KEY] = [];
      if (Object.keys(writes).length) await chrome.storage.local.set(writes);
    } catch (err) {
      console.warn('[Voice Changer] could not write defaults:', err);
    }
    if (details && details.reason === 'install') {
      try {
        await chrome.runtime.openOptionsPage();
      } catch (_) {
        /* ignore */
      }
    }
    await restored;
    refreshAllBadges();
  });

  chrome.runtime.onStartup.addListener(async () => {
    await restored;
    refreshAllBadges();
  });

  chrome.commands.onCommand.addListener(async (command) => {
    try {
      const { settings, custom } = await readSettings();
      if (command === 'toggle-voice') {
        settings.enabled = !settings.enabled;
      } else if (command === 'next-preset') {
        const presets = WVC.PRESETS;
        const idx = presets.findIndex((p) => p.id === settings.presetId);
        const next = presets[(idx + 1) % presets.length];
        settings.presetId = next.id;
        settings.params = WVC.presetParams(next, custom);
        settings.enabled = true;
      } else {
        return;
      }
      await chrome.storage.local.set({ [KEY]: WVC.normalizeSettings(settings) });
    } catch (err) {
      console.warn('[Voice Changer] command failed:', err);
    }
  });

  // Every handler below waits for `restored`: after a SW restart the event that woke it may run
  // before the session/local reads finish, and the restore would then resurrect a cleared tab's
  // stale status or overwrite a fresh `enabled` value with the stale one it read.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    await restored;
    const next = WVC.normalizeSettings(changes[KEY].newValue).enabled;
    if (next !== enabled) {
      enabled = next;
      refreshAllBadges();
    }
  });

  chrome.tabs.onRemoved.addListener(async (tabId) => {
    await restored;
    clearTab(tabId);
  });

  chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
    if (info.status !== 'loading') return;
    await restored;
    clearTab(tabId);
    const url = (tab && tab.url) || info.url || '';
    if (url.startsWith(WHATSAPP_PREFIX)) setBadge(tabId);
    else chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;

    if (message.type === MSG.RT_STATUS) {
      const tabId = sender && sender.tab && sender.tab.id;
      if (typeof tabId !== 'number' || tabId < 0) return false;
      const frameKey = String(sender.documentId || sender.frameId || 0);
      const status = Object.assign(WVC.emptyStatus(), message.status || {});
      status.active = Math.max(0, Number(status.active) || 0);
      status.updatedAt = Number(status.updatedAt) || Date.now();
      restored.then(() => {
        const key = String(tabId);
        if (message.gone) {
          // The document unloaded (bridge pagehide): drop only its own entry.
          if (tabStatus[key] && tabStatus[key][frameKey]) {
            delete tabStatus[key][frameKey];
            persist();
            // Last document gone = the tab is navigating/closing; the next document (if it is
            // WhatsApp) reports itself, so do not paint a badge onto whatever loads next.
            if (Object.keys(tabStatus[key]).length) setBadge(tabId);
            else delete tabStatus[key];
          }
          return;
        }
        // A new document in the same frame replaces the old one's entry.
        const frames = (tabStatus[key] = tabStatus[key] || {});
        if (sender.documentId) {
          for (const k of Object.keys(frames)) {
            if (frames[k] && frames[k].frameId === (sender.frameId || 0) && k !== frameKey) delete frames[k];
          }
        }
        status.frameId = sender.frameId || 0;
        frames[frameKey] = status;
        persist();
        setBadge(tabId);
      });
      return false;
    }

    if (message.type === MSG.RT_GET_STATUS) {
      const tabId = Number(message.tabId);
      restored.then(() => {
        let status = null;
        if (Number.isInteger(tabId)) {
          status = aggregate(tabId);
          if (status) delete status.frameId;
        }
        try {
          sendResponse({ status });
        } catch (_) {
          /* popup closed */
        }
      });
      return true;
    }

    return false;
  });

  restored.then(refreshAllBadges);
})();
