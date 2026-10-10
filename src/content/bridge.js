/*
 * Bridge between the extension and the page, runs in the ISOLATED world.
 *
 * chrome.storage.local  -> SETTINGS / CONFIG -> MAIN world (inject.js)
 * MAIN world STATUS     -> chrome.runtime    -> service worker
 *
 * This file can't use params.js. Chrome injects a file only once per frame, even when two
 * content_scripts entries list it, and params.js already went to the MAIN world. So the few
 * constants needed here are copied below (keep them in sync with WVC.STORAGE_KEYS / WVC.MSG).
 * Settings are passed on as they are, inject.js normalizes them.
 */
(function () {
  'use strict';

  try {
    const GUARD = Symbol.for('wvc.bridge.installed');
    if (globalThis[GUARD]) return;
    Object.defineProperty(globalThis, GUARD, { value: true, enumerable: false });

    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.storage) return;

    // Mirror of WVC.STORAGE_KEYS.SETTINGS and WVC.MSG (src/shared/params.js).
    const KEY = 'wvc.settings';
    const MSG = {
      PAGE_MAIN: 'wvc-main',
      PAGE_BRIDGE: 'wvc-bridge',
      HELLO: 'hello',
      SETTINGS: 'settings',
      CONFIG: 'config',
      STATUS: 'status',
      RT_STATUS: 'wvc:status',
    };

    let alive = true;
    let settings = null; // raw settings object from storage (normalized by inject.js)
    let loaded = false;

    function contextValid() {
      try {
        return alive && !!(chrome.runtime && chrome.runtime.id);
      } catch (_) {
        return false;
      }
    }

    function shutdown() {
      if (!alive) return;
      alive = false;
      try {
        window.removeEventListener('message', onMessage, false);
      } catch (_) {
        /* ignore */
      }
      try {
        chrome.storage.onChanged.removeListener(onStorageChanged);
      } catch (_) {
        /* ignore */
      }
    }

    function isBenignError(err) {
      const m = String((err && err.message) || err || '');
      return /Receiving end does not exist|Extension context invalidated|message port closed|No SW/i.test(m);
    }

    // Messages never leave this window (receivers check event.source === window); "*" is only
    // needed for opaque-origin frames where location.origin is "null".
    function targetOrigin() {
      try {
        const o = window.location.origin;
        return o && o !== 'null' ? o : '*';
      } catch (_) {
        return '*';
      }
    }

    function post(type, payload) {
      try {
        window.postMessage({ __wvc: true, source: MSG.PAGE_BRIDGE, type, payload }, targetOrigin());
      } catch (_) {
        /* ignore */
      }
    }

    function postConfig() {
      if (!contextValid()) return shutdown();
      let workletURL = null;
      try {
        workletURL = chrome.runtime.getURL('src/engine/dsp-core.js');
      } catch (_) {
        return shutdown();
      }
      post(MSG.CONFIG, { workletURL });
    }

    function postSettings() {
      // Always send once loaded, even if storage is empty: inject.js turns null into defaults
      // instead of waiting out its timeout.
      if (loaded) post(MSG.SETTINGS, { settings });
    }

    async function loadSettings() {
      if (!contextValid()) return shutdown();
      try {
        const got = await chrome.storage.local.get(KEY);
        const raw = got ? got[KEY] : undefined;
        settings = raw && typeof raw === 'object' ? raw : null;
      } catch (_) {
        if (!contextValid()) return shutdown();
        settings = null;
      }
      loaded = true;
      postSettings();
    }

    function sanitizeStatus(status) {
      const n = Number(status.active);
      return {
        active: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0,
        processor: typeof status.processor === 'string' ? status.processor.slice(0, 40) : null,
        contextState: typeof status.contextState === 'string' ? status.contextState.slice(0, 20) : null,
        error: typeof status.error === 'string' ? status.error.slice(0, 300) : null,
        updatedAt: Number.isFinite(Number(status.updatedAt)) ? Number(status.updatedAt) : Date.now(),
      };
    }

    function relayStatus(status) {
      if (!contextValid()) return shutdown();
      try {
        const p = chrome.runtime.sendMessage({ type: MSG.RT_STATUS, status });
        if (p && typeof p.catch === 'function') {
          p.catch((err) => {
            if (!contextValid()) shutdown();
            else if (!isBenignError(err)) console.debug('[Voice Changer] status relay failed:', err);
          });
        }
      } catch (err) {
        if (!contextValid() || isBenignError(err)) shutdown();
      }
    }

    // A removed iframe / closed document would otherwise leave its last status (possibly
    // active > 0 => "LIVE") in the service worker until the whole tab navigates or closes.
    let lastStatus = null;
    function onPageHide() {
      if (!contextValid()) return;
      try {
        const p = chrome.runtime.sendMessage({ type: MSG.RT_STATUS, gone: true, status: {} });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_) {
        /* ignore */
      }
    }
    function onPageShow(event) {
      // Restored from the back/forward cache: announce this document again.
      if (event && event.persisted && lastStatus) relayStatus(lastStatus);
    }

    function onMessage(event) {
      try {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.__wvc !== true || data.source !== MSG.PAGE_MAIN) return;
        if (!contextValid()) return shutdown();
        if (data.type === MSG.HELLO) {
          postConfig();
          postSettings(); // no-op until loaded; loadSettings() posts when it completes
        } else if (data.type === MSG.STATUS) {
          const status = data.payload && data.payload.status;
          if (status && typeof status === 'object') relayStatus((lastStatus = sanitizeStatus(status)));
        }
      } catch (_) {
        /* ignore */
      }
    }

    function onStorageChanged(changes, area) {
      try {
        if (!contextValid()) return shutdown();
        if (area !== 'local' || !changes || !changes[KEY]) return;
        const next = changes[KEY].newValue;
        settings = next && typeof next === 'object' ? next : null;
        loaded = true;
        postSettings();
      } catch (_) {
        /* ignore */
      }
    }

    window.addEventListener('message', onMessage, false);
    window.addEventListener('pagehide', onPageHide, false);
    window.addEventListener('pageshow', onPageShow, false);
    chrome.storage.onChanged.addListener(onStorageChanged);

    postConfig();
    loadSettings();
  } catch (_) {
    /* never surface errors into the page */
  }
})();
