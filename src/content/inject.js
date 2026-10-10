/*
 * getUserMedia hook, runs inside the WhatsApp page (MAIN world).
 *
 * Runs inside the WhatsApp page (document_start, all frames). Every microphone stream the
 * page requests is routed through a WVC.VoiceEngine and a processed MediaStream is returned.
 * Whatever happens, this must not break a call: on any error the original stream is returned.
 */
(function () {
  'use strict';

  try {
    const GUARD = Symbol.for('wvc.inject.installed');
    if (window[GUARD]) return;
    Object.defineProperty(window, GUARD, { value: true, enumerable: false, configurable: false, writable: false });

    const WVC = window.WVC;
    if (!WVC || !WVC.VoiceEngine || typeof WVC.VoiceEngine.create !== 'function' || !WVC.MSG) return;
    if (typeof navigator === 'undefined' || typeof MediaStream !== 'function') return;

    const MSG = WVC.MSG;
    const SETTINGS_WAIT_MS = 1500;
    const RUNNING_WAIT_MS = 1000;
    const MONITOR_GAIN = 0.8;

    // Captured before the page can tamper with them.
    const nativeTrackStop = MediaStreamTrack.prototype.stop;
    const nativeTrackClone = MediaStreamTrack.prototype.clone;
    // processed track (or decorated clone) -> session, so MediaStream.prototype.clone() can
    // decorate the tracks it clones internally (it never calls our per-track clone()).
    const trackSessions = new WeakMap();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;

    const CONFIG = { workletURL: null };
    let settings = null; // null until the first SETTINGS message
    let settingsWaiters = [];
    let audioCtx = null;
    let lastError = null;
    let lastProcessor = null;
    const sessions = new Set();

    /* ---------------------------------------------------------------- *
     * Page messaging
     * ---------------------------------------------------------------- */

    // The message never leaves this window (receivers check event.source === window), so the
    // target origin only matters for opaque-origin frames (sandboxed / some about:blank), where
    // location.origin is "null" and only "*" can deliver it.
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
        window.postMessage({ __wvc: true, source: MSG.PAGE_MAIN, type, payload }, targetOrigin());
      } catch (_) {
        /* ignore: messaging is best effort */
      }
    }

    function errorMessage(err) {
      if (!err) return 'Unknown error';
      if (typeof err === 'string') return err;
      return (err.name && err.name !== 'Error' ? err.name + ': ' : '') + (err.message || String(err));
    }

    let statusTimer = 0;
    function reportStatus() {
      // Coalesce bursts (e.g. several state changes in one tick) into one message.
      if (statusTimer) return;
      statusTimer = setTimeout(() => {
        statusTimer = 0;
        const status = WVC.emptyStatus();
        status.active = sessions.size;
        status.processor = lastProcessor;
        status.contextState = audioCtx ? audioCtx.state : null;
        status.error = lastError;
        status.updatedAt = Date.now();
        post(MSG.STATUS, { status });
      }, 0);
    }

    function setError(err) {
      lastError = errorMessage(err);
      reportStatus();
    }

    function applySettings(next) {
      settings = WVC.normalizeSettings(next);
      const waiters = settingsWaiters;
      settingsWaiters = [];
      for (const w of waiters) {
        try {
          w();
        } catch (_) {
          /* ignore */
        }
      }
      for (const s of sessions) {
        try {
          s.engine.update({ params: settings.params, enabled: settings.enabled });
        } catch (err) {
          setError(err);
        }
        applyMonitor(s);
      }
      reportStatus();
    }

    window.addEventListener(
      'message',
      (event) => {
        try {
          if (event.source !== window) return;
          const data = event.data;
          if (!data || data.__wvc !== true || data.source !== MSG.PAGE_BRIDGE) return;
          const payload = data.payload && typeof data.payload === 'object' ? data.payload : {};
          if (data.type === MSG.CONFIG) {
            if (typeof payload.workletURL === 'string' && payload.workletURL) CONFIG.workletURL = payload.workletURL;
          } else if (data.type === MSG.SETTINGS) {
            applySettings(payload.settings);
          }
        } catch (_) {
          /* ignore malformed messages */
        }
      },
      false
    );

    function waitForSettings() {
      if (settings) return Promise.resolve(settings);
      return new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve(settings || WVC.defaultSettings());
        };
        settingsWaiters.push(finish);
        setTimeout(finish, SETTINGS_WAIT_MS);
      });
    }

    /* ---------------------------------------------------------------- *
     * AudioContext
     * ---------------------------------------------------------------- */

    let gestureListening = false;
    function onGesture() {
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      removeGestureListeners();
    }
    function addGestureListeners() {
      if (gestureListening) return;
      gestureListening = true;
      window.addEventListener('pointerdown', onGesture, { capture: true, passive: true });
      window.addEventListener('keydown', onGesture, { capture: true, passive: true });
    }
    function removeGestureListeners() {
      if (!gestureListening) return;
      gestureListening = false;
      window.removeEventListener('pointerdown', onGesture, { capture: true });
      window.removeEventListener('keydown', onGesture, { capture: true });
    }

    function getContext() {
      if (audioCtx && audioCtx.state !== 'closed') return audioCtx;
      if (typeof AudioCtx !== 'function') throw new Error('Web Audio is not available');
      const ctx = new AudioCtx({ latencyHint: 'interactive' });
      ctx.addEventListener('statechange', () => {
        if (ctx === audioCtx) {
          if (ctx.state === 'running') removeGestureListeners();
          reportStatus();
        }
      });
      audioCtx = ctx;
      reportStatus();
      return ctx;
    }

    function resumeContext(ctx) {
      if (ctx.state === 'running') return;
      try {
        const p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_) {
        /* ignore */
      }
      addGestureListeners();
    }

    function waitRunning(ctx, ms) {
      if (ctx.state === 'running') return Promise.resolve(true);
      return new Promise((resolve) => {
        let done = false;
        const finish = (ok) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          ctx.removeEventListener('statechange', onChange);
          resolve(ok);
        };
        const onChange = () => {
          if (ctx.state === 'running') finish(true);
          else if (ctx.state === 'closed') finish(false);
        };
        const timer = setTimeout(() => finish(ctx.state === 'running'), ms);
        ctx.addEventListener('statechange', onChange);
      });
    }

    /* ---------------------------------------------------------------- *
     * Sessions (one per wrapped microphone track)
     * ---------------------------------------------------------------- */

    function safeDisconnect(node) {
      if (!node) return;
      try {
        node.disconnect();
      } catch (_) {
        /* ignore */
      }
    }

    function applyMonitor(s) {
      if (s.closed) return;
      const want = !!(settings && settings.monitor);
      try {
        if (want && !s.monitor) {
          const g = s.ctx.createGain();
          g.gain.value = MONITOR_GAIN;
          s.engine.output.connect(g);
          if (s.fileBus) s.fileBus.connect(g);
          g.connect(s.ctx.destination);
          s.monitor = g;
        } else if (!want && s.monitor) {
          try {
            s.engine.output.disconnect(s.monitor);
          } catch (_) {
            /* ignore */
          }
          try {
            if (s.fileBus) s.fileBus.disconnect(s.monitor);
          } catch (_) {
            /* ignore */
          }
          safeDisconnect(s.monitor);
          s.monitor = null;
        }
      } catch (err) {
        setError(err);
      }
    }

    function teardown(s, stopOriginal) {
      if (s.closed) return;
      s.closed = true;
      sessions.delete(s);
      try {
        vnSessionClosed(s);
      } catch (_) {
        /* fail open */
      }
      try {
        s.original.removeEventListener('ended', s.onOriginalEnded);
      } catch (_) {
        /* ignore */
      }
      if (stopOriginal) {
        try {
          nativeTrackStop.call(s.original);
        } catch (_) {
          /* ignore */
        }
      }
      safeDisconnect(s.source);
      safeDisconnect(s.micGain);
      safeDisconnect(s.fileBus);
      safeDisconnect(s.monitor);
      s.monitor = null;
      try {
        s.engine && s.engine.destroy();
      } catch (_) {
        /* ignore */
      }
      safeDisconnect(s.destination);
      reportStatus();
    }

    function defineMethod(obj, name, fn) {
      Object.defineProperty(obj, name, { value: fn, writable: true, configurable: true, enumerable: false });
    }

    function decorateTrack(track, s) {
      s.tracks.add(track);
      trackSessions.set(track, s);
      const original = s.original;
      defineMethod(track, 'stop', function stop() {
        if (!s.tracks.has(track)) {
          nativeTrackStop.call(track);
          return;
        }
        s.tracks.delete(track);
        nativeTrackStop.call(track);
        if (s.tracks.size === 0) teardown(s, true);
      });
      defineMethod(track, 'clone', function clone() {
        const c = nativeTrackClone.call(track);
        if (!s.closed && track.readyState === 'live') decorateTrack(c, s);
        return c;
      });
      defineMethod(track, 'getSettings', function getSettings() {
        return original.getSettings();
      });
      defineMethod(track, 'getConstraints', function getConstraints() {
        return original.getConstraints();
      });
      defineMethod(track, 'getCapabilities', function getCapabilities() {
        return typeof original.getCapabilities === 'function' ? original.getCapabilities() : {};
      });
      defineMethod(track, 'applyConstraints', function applyConstraints(constraints) {
        return original.applyConstraints(constraints);
      });
      Object.defineProperty(track, 'label', {
        configurable: true,
        enumerable: true,
        get() {
          return original.label;
        },
      });
      return track;
    }

    async function wrapStream(stream) {
      let s = null;
      try {
        if (!stream || typeof stream.getAudioTracks !== 'function') return stream;
        const audioTracks = stream.getAudioTracks();
        if (!audioTracks.length) return stream;
        const original = audioTracks[0];
        if (original.readyState !== 'live') return stream;

        const current = await waitForSettings();
        const ctx = getContext();
        resumeContext(ctx);
        const running = waitRunning(ctx, RUNNING_WAIT_MS);

        s = {
          ctx,
          original,
          engine: null,
          source: null,
          micGain: null, // mic -> micGain -> engine.input (muted while a file plays without the mic)
          fileBus: null, // audio-file player -> fileBus -> destination (when the effect is not applied)
          player: null, // active voice-note player in this session, if any
          destination: null,
          monitor: null,
          tracks: new Set(),
          closed: false,
          onOriginalEnded: null,
        };

        s.engine = await WVC.VoiceEngine.create(ctx, {
          params: current.params,
          enabled: current.enabled,
          workletURL: CONFIG.workletURL,
        });
        if (!(await running)) {
          throw new Error('AudioContext did not start (state: ' + ctx.state + '); using the unprocessed microphone');
        }
        if (original.readyState !== 'live') throw new Error('Microphone track ended while the voice engine was starting');

        s.source = ctx.createMediaStreamSource(new MediaStream([original]));
        s.destination = ctx.createMediaStreamDestination();
        s.micGain = ctx.createGain();
        s.fileBus = ctx.createGain();
        s.source.connect(s.micGain);
        s.micGain.connect(s.engine.input);
        s.engine.output.connect(s.destination);
        s.fileBus.connect(s.destination);
        // Settings may have changed while the engine was being created.
        if (settings) s.engine.update({ params: settings.params, enabled: settings.enabled });

        const processed = s.destination.stream.getAudioTracks()[0];
        if (!processed) throw new Error('MediaStreamDestination produced no audio track');
        processed.enabled = original.enabled;
        decorateTrack(processed, s);

        s.onOriginalEnded = () => {
          const live = Array.from(s.tracks);
          s.tracks.clear();
          teardown(s, false);
          for (const t of live) {
            try {
              nativeTrackStop.call(t);
              t.dispatchEvent(new Event('ended'));
            } catch (_) {
              /* ignore */
            }
          }
        };
        original.addEventListener('ended', s.onOriginalEnded);

        sessions.add(s);
        lastProcessor = s.engine.processorType || null;
        lastError = null;
        applyMonitor(s);
        reportStatus();
        try {
          vnSessionStarted(s); // may start an armed audio file in this session
        } catch (_) {
          /* fail open: the microphone keeps working */
        }

        return new MediaStream([processed, ...audioTracks.slice(1), ...stream.getVideoTracks()]);
      } catch (err) {
        if (s) {
          // Fail open: release everything we built but keep the user's microphone running.
          s.tracks.clear();
          teardown(s, false);
        }
        setError(err);
        return stream;
      }
    }

    /* ---------------------------------------------------------------- *
     * Audio file -> voice note (see docs/how-it-works.md)
     *
     * One decoded file is held per frame. It is played into a microphone session either when the
     * next session starts (armed, one-shot) or into every live session right away (play now).
     * Everything here fails open: errors become VN_ERROR and the microphone keeps working.
     * ---------------------------------------------------------------- */

    const VN_OK =
      typeof WVC.emptyVoiceNoteState === 'function' &&
      typeof WVC.normalizeVoiceNoteOptions === 'function' &&
      typeof MSG.PAGE_UI === 'string' &&
      typeof MSG.VN_LOAD === 'string';
    const VN_PEAKS = WVC.VN_PEAKS || 160;
    const VN_MAX_BYTES = WVC.VN_MAX_BYTES || 150 * 1024 * 1024;
    const VN_MAX_SECONDS = WVC.VN_MAX_SECONDS || 30 * 60;
    const VN_ARM_TIMEOUT_MS = WVC.VN_ARM_TIMEOUT_MS || 3 * 60 * 1000;
    const VN_TICK_MS = 250;
    const VN_LEAD_S = 0.03; // schedule a little ahead so the start is never clipped
    const VN_FADE_IN_S = 0.015;
    const VN_FADE_OUT_S = 0.04;
    const VN_STOP_FADE_S = 0.02;
    const VN_MIC_RAMP_S = 0.02;

    const VN = {
      name: null,
      buffer: null, // AudioBuffer (48 kHz), usable in any AudioContext
      state: 'empty',
      options: VN_OK ? WVC.normalizeVoiceNoteOptions(null) : null,
      armedUntil: 0,
      armTimer: 0,
      loadToken: 0,
      players: new Set(),
      lastPosition: 0,
      tick: 0,
    };

    function vnPost(type, payload) {
      if (VN_OK) post(type, payload);
    }

    function vnError(message) {
      vnPost(MSG.VN_ERROR, { message: String(message || 'Something went wrong with the audio file.') });
    }

    function vnLength(opts) {
      if (!VN.buffer) return 0;
      const o = opts || VN.options;
      const end = o.end == null ? VN.buffer.duration : Math.min(o.end, VN.buffer.duration);
      return Math.max(0, end - o.start);
    }

    function playerPosition(p) {
      try {
        return Math.max(0, Math.min(p.length, p.s.ctx.currentTime - p.t0));
      } catch (_) {
        return 0;
      }
    }

    function vnPosition() {
      for (const p of VN.players) return playerPosition(p);
      return 0;
    }

    function vnState() {
      const st = WVC.emptyVoiceNoteState();
      st.state = VN.state;
      st.name = VN.name;
      st.duration = VN.buffer ? VN.buffer.duration : 0;
      st.length = vnLength();
      st.position = VN.state === 'playing' ? vnPosition() : VN.state === 'done' ? VN.lastPosition : 0;
      st.armedUntil = VN.state === 'armed' ? VN.armedUntil : 0;
      st.liveMics = sessions.size;
      st.options = Object.assign({}, VN.options);
      return st;
    }

    function postVnState() {
      if (!VN_OK) return;
      try {
        vnPost(MSG.VN_STATE, vnState());
      } catch (_) {
        /* ignore */
      }
    }

    function setVnState(state) {
      VN.state = state;
      if (state === 'playing') startTick();
      else stopTick();
      postVnState();
    }

    function startTick() {
      if (VN.tick) return;
      VN.tick = setInterval(() => {
        try {
          if (VN.state !== 'playing') return stopTick();
          // Watchdog: if 'ended' never fires (closed / stalled context), finish anyway.
          for (const p of Array.from(VN.players)) {
            let dead = false;
            try {
              dead = p.s.closed || p.s.ctx.state === 'closed' || p.s.ctx.currentTime > p.t0 + p.length + 1;
            } catch (_) {
              dead = true;
            }
            if (dead) onPlayerEnded(p);
          }
          if (VN.state === 'playing') postVnState();
        } catch (_) {
          /* ignore */
        }
      }, VN_TICK_MS);
    }

    function stopTick() {
      if (!VN.tick) return;
      clearInterval(VN.tick);
      VN.tick = 0;
    }

    function releasePlayer(p) {
      VN.players.delete(p);
      if (p.s.player === p) p.s.player = null;
      setTimeout(() => {
        safeDisconnect(p.src);
        safeDisconnect(p.gain);
      }, 120);
    }

    function stopPlayer(p, fade) {
      if (p.stopped) return;
      p.stopped = true;
      try {
        const ctx = p.s.ctx;
        const now = ctx.currentTime;
        const g = p.gain.gain;
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        if (fade && ctx.state === 'running') {
          g.linearRampToValueAtTime(0, now + VN_STOP_FADE_S);
          p.src.stop(now + VN_STOP_FADE_S + 0.005);
        } else {
          g.setValueAtTime(0, now);
          p.src.stop();
        }
      } catch (_) {
        /* already stopped */
      }
      releasePlayer(p);
    }

    /** Stop every player. Returns the playback position reached (seconds) or -1 if nothing played. */
    function stopAllPlayers(fade) {
      if (!VN.players.size) return -1;
      const pos = vnPosition();
      for (const p of Array.from(VN.players)) stopPlayer(p, fade);
      return pos;
    }

    function onPlayerEnded(p) {
      if (!VN.players.has(p) || p.stopped) return;
      p.stopped = true;
      releasePlayer(p);
      if (!VN.players.size && VN.state === 'playing') {
        VN.lastPosition = p.length;
        setVnState('done');
      }
    }

    function muteMic(s) {
      if (!s.micGain) return;
      s.micMuted = true; // stays muted for the rest of this session
      const now = s.ctx.currentTime;
      const g = s.micGain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + VN_MIC_RAMP_S);
    }

    function startPlayer(s, opts) {
      if (s.closed || !s.micGain || !s.fileBus) throw new Error('This microphone is no longer active.');
      const ctx = s.ctx;
      const length = vnLength(opts);
      if (!(length > 0.01)) throw new Error('The selected part of the file is empty.');
      const src = ctx.createBufferSource();
      src.buffer = VN.buffer;
      const gain = ctx.createGain();
      const vol = opts.volume;
      const now = ctx.currentTime;
      const t0 = now + VN_LEAD_S;
      const g = gain.gain;
      const fadeIn = Math.min(VN_FADE_IN_S, length / 4);
      const fadeOut = Math.min(VN_FADE_OUT_S, length / 4);
      g.setValueAtTime(0, now);
      g.setValueAtTime(0, t0);
      g.linearRampToValueAtTime(vol, t0 + fadeIn);
      g.setValueAtTime(vol, t0 + length - fadeOut);
      g.linearRampToValueAtTime(0, t0 + length);
      src.connect(gain);
      gain.connect(opts.applyEffect && s.engine && s.engine.input ? s.engine.input : s.fileBus);
      const p = { s, src, gain, t0, length, stopped: false };
      src.onended = () => {
        try {
          onPlayerEnded(p);
        } catch (_) {
          /* ignore */
        }
      };
      src.start(t0, opts.start, length);
      if (s.player) stopPlayer(s.player, true);
      s.player = p;
      VN.players.add(p);
      if (!opts.includeMic) muteMic(s);
      return p;
    }

    /** Start the loaded file in the given sessions. Returns the number of sessions it started in. */
    function startPlayback(targets, opts) {
      stopAllPlayers(true);
      VN.options = opts;
      let started = 0;
      let firstError = null;
      for (const s of targets) {
        try {
          startPlayer(s, opts);
          started++;
        } catch (err) {
          if (!firstError) firstError = err;
        }
      }
      if (started) {
        VN.lastPosition = 0;
        setVnState('playing');
      } else {
        setVnState(VN.buffer ? 'ready' : 'empty');
        vnError('Could not play the file into the microphone' + (firstError ? ': ' + errorMessage(firstError) : '.'));
      }
      return started;
    }

    function disarm() {
      if (VN.armTimer) clearTimeout(VN.armTimer);
      VN.armTimer = 0;
      VN.armedUntil = 0;
    }

    /** Called by wrapStream once a session is fully built (its AudioContext is running). */
    function vnSessionStarted(s) {
      if (!VN_OK) return;
      if (VN.state === 'armed' && VN.buffer) {
        const valid = Date.now() <= VN.armedUntil;
        disarm(); // one-shot
        if (valid) {
          startPlayback([s], VN.options);
          return;
        }
        setVnState('ready');
        return;
      }
      postVnState(); // liveMics changed
    }

    /** Called from teardown() (session already removed from `sessions`). */
    function vnSessionClosed(s) {
      if (!VN_OK) return;
      const p = s.player;
      if (p && VN.players.has(p)) {
        const pos = playerPosition(p);
        stopPlayer(p, false);
        if (!VN.players.size && VN.state === 'playing') {
          VN.lastPosition = pos;
          setVnState(pos > 0.05 ? 'done' : 'ready');
          return;
        }
      }
      postVnState();
    }

    function computePeaks(buf) {
      const peaks = new Array(VN_PEAKS).fill(0);
      const n = buf.length;
      const chans = [];
      for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
      const nc = chans.length || 1;
      for (let b = 0; b < VN_PEAKS; b++) {
        const from = Math.floor((b * n) / VN_PEAKS);
        const to = Math.max(from + 1, Math.floor(((b + 1) * n) / VN_PEAKS));
        let m = 0;
        for (let i = from; i < to && i < n; i++) {
          let v = 0;
          for (let c = 0; c < chans.length; c++) v += chans[c][i];
          v = Math.abs(v / nc);
          if (v > m) m = v;
        }
        peaks[b] = Math.round(Math.min(1, m) * 1000) / 1000;
      }
      return peaks;
    }

    function fmtMB(bytes) {
      return Math.round(bytes / (1024 * 1024)) + ' MB';
    }

    async function vnLoad(name, buffer) {
      const token = ++VN.loadToken;
      const pos = stopAllPlayers(true);
      if (pos >= 0) VN.lastPosition = pos;
      disarm();
      const restore = () => setVnState(VN.buffer ? 'ready' : 'empty');
      if (!buffer.byteLength) {
        restore();
        return vnError('That file is empty.');
      }
      if (buffer.byteLength > VN_MAX_BYTES) {
        restore();
        return vnError('That file is too big (' + fmtMB(buffer.byteLength) + '). The limit is ' + fmtMB(VN_MAX_BYTES) + '.');
      }
      setVnState('loading');
      let decoded = null;
      let failure = null;
      try {
        if (typeof OfflineAudioContext !== 'function') throw new Error('Web Audio is not available');
        const oac = new OfflineAudioContext(2, 1, 48000);
        decoded = await oac.decodeAudioData(buffer);
      } catch (err) {
        failure = err;
      }
      if (token !== VN.loadToken) return; // superseded by a newer load / clear
      if (failure || !decoded || !decoded.length || !(decoded.duration > 0)) {
        restore();
        return vnError("This file couldn't be read as audio. Try an MP3, M4A, WAV, OGG, OPUS or FLAC file.");
      }
      if (decoded.duration > VN_MAX_SECONDS) {
        restore();
        return vnError(
          'That audio is too long (' + Math.round(decoded.duration / 60) + ' min). The limit is ' + Math.round(VN_MAX_SECONDS / 60) + ' minutes.'
        );
      }
      const peaks = computePeaks(decoded);
      VN.buffer = decoded;
      VN.name = name;
      VN.lastPosition = 0;
      // Keep the user's toggles and volume, reset the trim to the whole new file.
      VN.options = WVC.normalizeVoiceNoteOptions(Object.assign({}, VN.options, { start: 0, end: null }), decoded.duration);
      vnPost(MSG.VN_LOADED, {
        name,
        duration: decoded.duration,
        sampleRate: decoded.sampleRate,
        channels: decoded.numberOfChannels,
        peaks,
      });
      setVnState('ready');
    }

    function requireFile() {
      if (VN.state === 'loading') {
        vnError('The file is still loading, please wait a moment.');
        return false;
      }
      if (!VN.buffer) {
        vnError('Choose an audio file first.');
        return false;
      }
      return true;
    }

    function vnArm(options) {
      if (!requireFile()) return;
      const pos = stopAllPlayers(true);
      if (pos >= 0) VN.lastPosition = pos;
      disarm();
      VN.options = WVC.normalizeVoiceNoteOptions(options, VN.buffer.duration);
      VN.armedUntil = Date.now() + VN_ARM_TIMEOUT_MS;
      VN.armTimer = setTimeout(() => {
        VN.armTimer = 0;
        if (VN.state === 'armed') {
          VN.armedUntil = 0;
          setVnState(VN.buffer ? 'ready' : 'empty');
        }
      }, VN_ARM_TIMEOUT_MS);
      setVnState('armed');
    }

    function vnPlayNow(options) {
      if (!requireFile()) return;
      const live = Array.from(sessions).filter((s) => !s.closed);
      if (!live.length) {
        return vnError('No microphone is recording right now. Click 🎤 in a chat first, or use "Arm for next voice note".');
      }
      disarm();
      startPlayback(live, WVC.normalizeVoiceNoteOptions(options, VN.buffer.duration));
    }

    function vnStop() {
      if (VN.state === 'armed') {
        disarm();
        return setVnState(VN.buffer ? 'ready' : 'empty');
      }
      const pos = stopAllPlayers(true);
      if (pos >= 0 || VN.state === 'playing') {
        VN.lastPosition = Math.max(0, pos);
        return setVnState(pos > 0.05 ? 'done' : VN.buffer ? 'ready' : 'empty');
      }
      postVnState();
    }

    function vnClear() {
      VN.loadToken++; // cancels a pending decode
      stopAllPlayers(true);
      disarm();
      VN.buffer = null;
      VN.name = null;
      VN.lastPosition = 0;
      VN.options = WVC.normalizeVoiceNoteOptions(Object.assign({}, VN.options, { start: 0, end: null }));
      setVnState('empty');
    }

    function onUiMessage(event) {
      try {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || typeof data !== 'object' || data.__wvc !== true || data.source !== MSG.PAGE_UI) return;
        if (typeof data.type !== 'string') return;
        const payload = data.payload && typeof data.payload === 'object' ? data.payload : {};
        const options = payload.options && typeof payload.options === 'object' ? payload.options : null;
        switch (data.type) {
          case MSG.VN_LOAD: {
            if (!(payload.buffer instanceof ArrayBuffer)) return vnError("That file couldn't be read.");
            const name = typeof payload.name === 'string' && payload.name ? payload.name.slice(0, 200) : 'Audio file';
            vnLoad(name, payload.buffer).catch((err) => {
              setVnState(VN.buffer ? 'ready' : 'empty');
              vnError('Could not load the file: ' + errorMessage(err));
            });
            return;
          }
          case MSG.VN_ARM:
            return vnArm(options);
          case MSG.VN_PLAY_NOW:
            return vnPlayNow(options);
          case MSG.VN_STOP:
            return vnStop();
          case MSG.VN_CLEAR:
            return vnClear();
          case MSG.VN_QUERY:
            return postVnState();
          default:
            return;
        }
      } catch (err) {
        try {
          vnError('Audio file error: ' + errorMessage(err));
        } catch (_) {
          /* ignore */
        }
      }
    }

    if (VN_OK) window.addEventListener('message', onUiMessage, false);

    /* ---------------------------------------------------------------- *
     * Patching
     * ---------------------------------------------------------------- */

    const patchedToOriginal = new WeakMap();
    const nativeToString = Function.prototype.toString;

    function disguise(patched, original) {
      try {
        Object.defineProperty(patched, 'name', { value: original.name, configurable: true });
        Object.defineProperty(patched, 'length', { value: original.length, configurable: true });
      } catch (_) {
        /* ignore */
      }
      patchedToOriginal.set(patched, original);
      return patched;
    }

    // Method shorthand functions have no prototype and are not constructible, like native methods.
    const toStringPatch = {
      toString() {
        const target = typeof this === 'function' && patchedToOriginal.has(this) ? patchedToOriginal.get(this) : this;
        return nativeToString.call(target);
      },
    }.toString;
    disguise(toStringPatch, nativeToString);
    try {
      Object.defineProperty(Function.prototype, 'toString', {
        value: toStringPatch,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    } catch (_) {
      /* toString disguise is cosmetic */
    }

    function makePromiseGUM(original) {
      const patched = {
        getUserMedia(...args) {
          let result;
          try {
            result = original.apply(this, args);
          } catch (err) {
            return Promise.reject(err);
          }
          if (!result || typeof result.then !== 'function') return result;
          return result.then((stream) => wrapStream(stream));
        },
      }.getUserMedia;
      return disguise(patched, original);
    }

    function makeLegacyGUM(original, name) {
      const holder = {
        [name](constraints, onSuccess, onError) {
          // Native throws a TypeError for a missing success callback: let it.
          if (typeof onSuccess !== 'function') return original.call(this, constraints, onSuccess, onError);
          const success = (stream) => {
            wrapStream(stream).then(
              (out) => {
                if (typeof onSuccess === 'function') onSuccess(out);
              },
              () => {
                if (typeof onSuccess === 'function') onSuccess(stream);
              }
            );
          };
          return original.call(this, constraints, success, onError);
        },
      };
      return disguise(holder[name], original);
    }

    function patchProperty(obj, key, factory) {
      try {
        const desc = Object.getOwnPropertyDescriptor(obj, key);
        if (!desc || typeof desc.value !== 'function' || patchedToOriginal.has(desc.value)) return;
        Object.defineProperty(obj, key, {
          value: factory(desc.value),
          writable: desc.writable !== false,
          configurable: desc.configurable !== false,
          enumerable: !!desc.enumerable,
        });
      } catch (err) {
        setError(err);
      }
    }

    function makeStreamClone(original) {
      const patched = {
        clone() {
          const out = original.apply(this, arguments);
          try {
            const src = this.getTracks();
            const dst = out.getTracks();
            for (let i = 0; i < src.length && i < dst.length; i++) {
              const s = trackSessions.get(src[i]);
              if (s && !s.closed && s.tracks.has(src[i]) && dst[i].readyState === 'live' && dst[i].kind === src[i].kind) {
                decorateTrack(dst[i], s);
              }
            }
          } catch (_) {
            /* decoration is best effort */
          }
          return out;
        },
      }.clone;
      return disguise(patched, original);
    }

    if (typeof MediaStream === 'function' && MediaStream.prototype) {
      patchProperty(MediaStream.prototype, 'clone', makeStreamClone);
    }
    if (typeof MediaDevices === 'function' && MediaDevices.prototype) {
      patchProperty(MediaDevices.prototype, 'getUserMedia', makePromiseGUM);
    }
    try {
      if (navigator.mediaDevices) patchProperty(navigator.mediaDevices, 'getUserMedia', makePromiseGUM);
    } catch (_) {
      /* ignore */
    }
    for (const key of ['getUserMedia', 'webkitGetUserMedia']) {
      const proto = Object.getPrototypeOf(navigator);
      let owner = null;
      if (Object.prototype.hasOwnProperty.call(navigator, key)) owner = navigator;
      else if (proto && Object.prototype.hasOwnProperty.call(proto, key)) owner = proto;
      if (owner) patchProperty(owner, key, (orig) => makeLegacyGUM(orig, key));
    }

    post(MSG.HELLO, {});
    // Announce this frame (active: 0) so the popup/studio can tell "attached and idle" apart
    // from "tab needs a reload".
    reportStatus();
  } catch (err) {
    try {
      if (typeof console !== 'undefined') console.warn('[Voice Changer] disabled:', err);
    } catch (_) {
      /* ignore */
    }
  }
})();
