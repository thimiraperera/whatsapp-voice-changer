/*
 * Parameters, presets and settings, shared by every part of the extension.
 *
 * Classic (non-module) script. It is loaded by:
 *   - the MAIN-world content script bundle on web.whatsapp.com
 *   - the popup and the Voice Studio (options) page via <script src>
 *   - the background service worker via importScripts()
 *   - Node tests via require()
 *
 * Everything hangs off a single global: globalThis.WVC
 */
(function (root) {
  'use strict';

  const WVC = (root.WVC = root.WVC || {});

  WVC.VERSION = '1.0.0';

  /* ------------------------------------------------------------------ *
   * Storage keys and message types
   * ------------------------------------------------------------------ */

  WVC.STORAGE_KEYS = Object.freeze({
    SETTINGS: 'wvc.settings', // chrome.storage.local -> Settings object (see defaultSettings)
    CUSTOM_PRESETS: 'wvc.customPresets', // chrome.storage.local -> Array<Preset>
    UI_STATE: 'wvc.ui', // chrome.storage.local -> { fabY: number (0..1), voiceNote: VoiceNoteOptions } (in-page 🎵 widget)
  });

  WVC.MSG = Object.freeze({
    // window.postMessage envelope: { __wvc: true, source, type, payload }
    PAGE_MAIN: 'wvc-main', // source tag: MAIN world (inject.js) -> ISOLATED world (bridge.js)
    PAGE_BRIDGE: 'wvc-bridge', // source tag: ISOLATED world (bridge.js) -> MAIN world (inject.js)

    HELLO: 'hello', // MAIN -> bridge   payload: {}                      "please send settings + config"
    SETTINGS: 'settings', // bridge -> MAIN payload: { settings }
    CONFIG: 'config', // bridge -> MAIN   payload: { workletURL }         chrome.runtime.getURL('src/engine/dsp-core.js')
    STATUS: 'status', // MAIN -> bridge   payload: { status }              see WVC.emptyStatus()

    // --- "Send an audio file as a voice note" (see docs/how-it-works.md) ---
    PAGE_UI: 'wvc-ui', // source tag: ISOLATED world voicenote-ui.js -> MAIN world (inject.js)
    VN_LOAD: 'vn-load', // UI -> MAIN   payload: { name, buffer: ArrayBuffer (transferred) }
    VN_ARM: 'vn-arm', // UI -> MAIN     payload: { options: VoiceNoteOptions }  play on the NEXT microphone request
    VN_PLAY_NOW: 'vn-play-now', // UI -> MAIN payload: { options }  play into every microphone stream that is live right now
    VN_STOP: 'vn-stop', // UI -> MAIN    payload: {}  stop playback / disarm
    VN_CLEAR: 'vn-clear', // UI -> MAIN   payload: {}  forget the loaded file
    VN_QUERY: 'vn-query', // UI -> MAIN   payload: {}  ask for a VN_STATE (e.g. after the UI (re)loads)
    VN_LOADED: 'vn-loaded', // MAIN -> UI payload: { name, duration, sampleRate, channels, peaks: number[] (VN_PEAKS values 0..1) }
    VN_STATE: 'vn-state', // MAIN -> UI   payload: VoiceNoteState (see WVC.emptyVoiceNoteState)
    VN_ERROR: 'vn-error', // MAIN -> UI   payload: { message }

    // chrome.runtime.sendMessage types
    RT_STATUS: 'wvc:status', // bridge -> service worker   { type, status }
    RT_GET_STATUS: 'wvc:get-status', // popup/studio -> service worker { type, tabId } -> { status | null }
    RT_OPEN_VOICENOTE: 'wvc:open-voicenote', // popup -> WhatsApp tab (chrome.tabs.sendMessage, top frame) { type } -> { ok: true }
  });

  /* ------------------------------------------------------------------ *
   * Audio file -> voice note
   * ------------------------------------------------------------------ */

  WVC.VN_PEAKS = 160; // number of waveform buckets in VN_LOADED.peaks
  WVC.VN_MAX_BYTES = 150 * 1024 * 1024; // refuse bigger files before decoding
  WVC.VN_MAX_SECONDS = 30 * 60; // refuse longer audio after decoding
  WVC.VN_ARM_TIMEOUT_MS = 3 * 60 * 1000; // an armed file disarms itself after 3 minutes

  /** Options chosen in the 🎵 panel. start/end are seconds within the file (end <= duration). */
  WVC.defaultVoiceNoteOptions = function defaultVoiceNoteOptions() {
    return {
      start: 0,
      end: null, // null = to the end of the file
      applyEffect: false, // route the file through the current voice effect
      includeMic: false, // false: mute the real microphone for the rest of that recording; true: mix mic + file
      volume: 1, // 0..1.5 linear gain for the file
    };
  };

  WVC.normalizeVoiceNoteOptions = function normalizeVoiceNoteOptions(o, duration) {
    const d = WVC.defaultVoiceNoteOptions();
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
      applyEffect: typeof src.applyEffect === 'boolean' ? src.applyEffect : d.applyEffect,
      includeMic: typeof src.includeMic === 'boolean' ? src.includeMic : d.includeMic,
      volume: Number.isFinite(vol) ? clamp(vol, 0, 1.5) : d.volume,
    };
  };

  /**
   * VN_STATE payload.
   * state: 'empty'   no file loaded
   *        'loading' decoding a file
   *        'ready'   file loaded, not armed
   *        'armed'   will start on the next getUserMedia audio request (until armedUntil)
   *        'playing' currently feeding one or more live microphone streams
   *        'done'    playback finished (file still loaded; the user should now press WhatsApp's Send)
   */
  WVC.emptyVoiceNoteState = function emptyVoiceNoteState() {
    return {
      state: 'empty',
      name: null,
      duration: 0, // seconds (whole file)
      position: 0, // seconds played within [start, end] while playing / at done
      length: 0, // seconds that will be / were played (end - start)
      armedUntil: 0, // ms timestamp while armed
      liveMics: 0, // number of live processed microphone streams in this frame right now
      options: WVC.defaultVoiceNoteOptions(),
    };
  };

  /** Shape of the live status reported from a WhatsApp tab. */
  WVC.emptyStatus = function emptyStatus() {
    return {
      active: 0, // number of live, processed microphone streams (i.e. an ongoing call / voice-note recording)
      processor: null, // 'worklet' | 'script-processor' | null  (how the DSP core is running)
      contextState: null, // AudioContext.state or null
      error: null, // last error message (string) or null
      updatedAt: 0, // ms timestamp
    };
  };

  /* ------------------------------------------------------------------ *
   * Parameter definitions
   * ------------------------------------------------------------------ */

  WVC.GROUPS = Object.freeze([
    { id: 'voice', label: 'Voice & Pitch', icon: '🎙️' },
    { id: 'modulation', label: 'Robot & Modulation', icon: '🤖' },
    { id: 'space', label: 'Echo & Space', icon: '🏔️' },
    { id: 'tone', label: 'Tone & EQ', icon: '🎚️' },
    { id: 'character', label: 'Distortion & Lo-Fi', icon: '📻' },
    { id: 'output', label: 'Clean-up & Output', icon: '🔊' },
  ]);

  /*
   * type:  'range' | 'select'
   * unit:  'st' semitones, 'hz', 'db', 'pct' (0..1 shown as %), 's', 'ms',
   *        'bits' (max => Off), 'x' (1 => Off), 'gate' (min => Off)
   * scale: 'log' => sliders should map logarithmically (all such params have min > 0)
   */
  const P = [
    // --- Voice & Pitch --------------------------------------------------
    { id: 'pitch', group: 'voice', type: 'range', label: 'Pitch', min: -24, max: 24, step: 0.5, default: 0, unit: 'st',
      hint: 'Raise or lower your voice, in semitones (12 = one octave).' },
    { id: 'formant', group: 'voice', type: 'range', label: 'Formant / Timbre', min: -12, max: 12, step: 0.5, default: 0, unit: 'st',
      hint: 'Changes the apparent size of the speaker. Negative = bigger, darker body; positive = smaller, brighter. Natural engine only.' },
    { id: 'algorithm', group: 'voice', type: 'select', label: 'Engine', default: 'spectral',
      options: [
        { value: 'spectral', label: 'Natural (HQ, formant control)' },
        { value: 'granular', label: 'Classic (lowest latency)' },
      ],
      hint: 'Natural keeps voices realistic and allows formant control. Classic has less delay and a more "cartoon" character.' },
    { id: 'texture', group: 'voice', type: 'select', label: 'Voice texture', default: 'normal',
      options: [
        { value: 'normal', label: 'Normal' },
        { value: 'robot', label: 'Monotone robot' },
        { value: 'whisper', label: 'Whisper' },
      ],
      hint: 'Robot flattens your voice to a single tone; Whisper removes the pitch entirely. Always uses the Natural engine.' },
    { id: 'robotPitch', group: 'voice', type: 'range', label: 'Robot tone', min: 40, max: 400, step: 1, default: 110, unit: 'hz', scale: 'log',
      hint: 'The fixed note used by the Monotone robot texture.' },

    // --- Robot & Modulation ---------------------------------------------
    { id: 'ringMix', group: 'modulation', type: 'range', label: 'Metallic (ring mod)', min: 0, max: 1, step: 0.01, default: 0, unit: 'pct',
      hint: 'Ring modulation, the classic sci-fi metallic robot sound.' },
    { id: 'ringFreq', group: 'modulation', type: 'range', label: 'Metal tone', min: 10, max: 1200, step: 1, default: 80, unit: 'hz', scale: 'log',
      hint: 'Carrier frequency of the ring modulator. Low = growly, high = bell-like.' },
    { id: 'vibratoDepth', group: 'modulation', type: 'range', label: 'Vibrato depth', min: 0, max: 5, step: 0.1, default: 0, unit: 'ms',
      hint: 'Wobbles the pitch up and down.' },
    { id: 'vibratoRate', group: 'modulation', type: 'range', label: 'Vibrato speed', min: 0.5, max: 15, step: 0.1, default: 5, unit: 'hz' },
    { id: 'tremoloDepth', group: 'modulation', type: 'range', label: 'Tremolo depth', min: 0, max: 1, step: 0.01, default: 0, unit: 'pct',
      hint: 'Pulses the volume up and down.' },
    { id: 'tremoloRate', group: 'modulation', type: 'range', label: 'Tremolo speed', min: 0.5, max: 20, step: 0.1, default: 6, unit: 'hz' },
    { id: 'chorusMix', group: 'modulation', type: 'range', label: 'Chorus / crowd', min: 0, max: 1, step: 0.01, default: 0, unit: 'pct',
      hint: 'Layers detuned copies of your voice for a thicker, many-voices sound.' },
    { id: 'chorusRate', group: 'modulation', type: 'range', label: 'Chorus speed', min: 0.1, max: 6, step: 0.05, default: 0.8, unit: 'hz' },

    // --- Echo & Space ---------------------------------------------------
    { id: 'echoMix', group: 'space', type: 'range', label: 'Echo', min: 0, max: 1, step: 0.01, default: 0, unit: 'pct' },
    { id: 'echoTime', group: 'space', type: 'range', label: 'Echo delay', min: 0.02, max: 1.5, step: 0.01, default: 0.25, unit: 's' },
    { id: 'echoFeedback', group: 'space', type: 'range', label: 'Echo repeats', min: 0, max: 0.9, step: 0.01, default: 0.35, unit: 'pct' },
    { id: 'reverbMix', group: 'space', type: 'range', label: 'Reverb', min: 0, max: 1, step: 0.01, default: 0, unit: 'pct' },
    { id: 'reverbSize', group: 'space', type: 'range', label: 'Room size', min: 0.2, max: 8, step: 0.1, default: 2, unit: 's',
      hint: 'Reverb decay time, from a small room to a huge hall.' },

    // --- Tone & EQ ------------------------------------------------------
    { id: 'highpass', group: 'tone', type: 'range', label: 'Low cut', min: 20, max: 2000, step: 1, default: 20, unit: 'hz', scale: 'log',
      hint: 'Removes bass below this frequency. 20 Hz = off.' },
    { id: 'lowpass', group: 'tone', type: 'range', label: 'High cut', min: 500, max: 20000, step: 10, default: 20000, unit: 'hz', scale: 'log',
      hint: 'Removes treble above this frequency. 20 kHz = off.' },
    { id: 'bass', group: 'tone', type: 'range', label: 'Bass', min: -15, max: 15, step: 0.5, default: 0, unit: 'db' },
    { id: 'mid', group: 'tone', type: 'range', label: 'Mid', min: -15, max: 15, step: 0.5, default: 0, unit: 'db' },
    { id: 'treble', group: 'tone', type: 'range', label: 'Treble', min: -15, max: 15, step: 0.5, default: 0, unit: 'db' },

    // --- Distortion & Lo-Fi ---------------------------------------------
    { id: 'drive', group: 'character', type: 'range', label: 'Distortion', min: 0, max: 1, step: 0.01, default: 0, unit: 'pct' },
    { id: 'bitDepth', group: 'character', type: 'range', label: 'Bit crush', min: 2, max: 16, step: 1, default: 16, unit: 'bits',
      hint: 'Fewer bits = grittier, retro digital sound. 16 = off.' },
    { id: 'downsample', group: 'character', type: 'range', label: 'Sample crush', min: 1, max: 32, step: 1, default: 1, unit: 'x',
      hint: 'Reduces the sample rate for an 8-bit / aliasing effect. 1 = off.' },
    { id: 'staticNoise', group: 'character', type: 'range', label: 'Radio static', min: 0, max: 1, step: 0.01, default: 0, unit: 'pct',
      hint: 'Adds walkie-talkie style hiss while you speak.' },

    // --- Clean-up & Output ----------------------------------------------
    { id: 'gate', group: 'output', type: 'range', label: 'Noise gate', min: -90, max: -20, step: 1, default: -90, unit: 'gate',
      hint: 'Silences background noise below this level. -90 dB = off.' },
    { id: 'compress', group: 'output', type: 'range', label: 'Compressor', min: 0, max: 1, step: 0.01, default: 0, unit: 'pct',
      hint: 'Evens out loud and quiet parts so effects stay consistent.' },
    { id: 'mix', group: 'output', type: 'range', label: 'Effect mix', min: 0, max: 1, step: 0.01, default: 1, unit: 'pct',
      hint: 'Blend between your original voice (0%) and the changed voice (100%).' },
    { id: 'volume', group: 'output', type: 'range', label: 'Output volume', min: -24, max: 12, step: 0.5, default: 0, unit: 'db' },
  ];

  WVC.PARAMS = Object.freeze(P.map((p) => Object.freeze(p)));
  WVC.PARAM_MAP = Object.freeze(Object.fromEntries(WVC.PARAMS.map((p) => [p.id, p])));
  WVC.PARAM_IDS = Object.freeze(WVC.PARAMS.map((p) => p.id));

  /** Sliders shown in the compact popup, in order. */
  WVC.QUICK_PARAMS = Object.freeze(['pitch', 'formant', 'ringMix', 'echoMix', 'reverbMix', 'volume']);

  /* ------------------------------------------------------------------ *
   * Presets
   * ------------------------------------------------------------------ */

  WVC.PRESET_CATEGORIES = Object.freeze([
    { id: 'human', label: 'Human' },
    { id: 'creature', label: 'Creatures' },
    { id: 'machine', label: 'Machines' },
    { id: 'place', label: 'Places' },
    { id: 'fun', label: 'Fun' },
    { id: 'mine', label: 'My presets' }, // user-saved presets
  ]);

  // Each preset lists only the params it changes; everything else uses defaults.
  const PRESETS = [
    // Human
    { id: 'natural', name: 'Natural', emoji: '🙂', category: 'human', description: 'Your own voice, untouched.', params: {} },
    { id: 'deep', name: 'Deep Voice', emoji: '🧔', category: 'human', description: 'Lower, fuller, more masculine voice.',
      params: { pitch: -5, formant: -2.5, bass: 3, compress: 0.3 } },
    { id: 'higher', name: 'Higher Voice', emoji: '👩', category: 'human', description: 'Higher, lighter, more feminine voice.',
      params: { pitch: 5, formant: 2.5, bass: -2, treble: 2, compress: 0.3 } },
    { id: 'child', name: 'Child', emoji: '🧒', category: 'human', description: "A small kid's voice.",
      params: { pitch: 7, formant: 5, bass: -4, treble: 2, highpass: 120 } },
    { id: 'elder', name: 'Old Timer', emoji: '👴', category: 'human', description: 'Shaky, aged voice.',
      params: { pitch: -1, formant: 0.5, vibratoDepth: 1.2, vibratoRate: 6.5, tremoloDepth: 0.25, tremoloRate: 6.5, highpass: 150, lowpass: 7000 } },
    { id: 'whisper', name: 'Whisper', emoji: '🤫', category: 'human', description: 'Breathy, secretive whisper.',
      params: { texture: 'whisper', highpass: 250, treble: 4, compress: 0.5, volume: 3 } },
    { id: 'announcer', name: 'Stadium Announcer', emoji: '🏟️', category: 'human', description: 'Booming voice filling a stadium.',
      params: { pitch: -1, formant: -1, bass: 3, compress: 0.8, echoMix: 0.3, echoTime: 0.28, echoFeedback: 0.3, reverbMix: 0.3, reverbSize: 3 } },

    // Creatures
    { id: 'chipmunk', name: 'Chipmunk', emoji: '🐿️', category: 'creature', description: 'Sped-up squeaky cartoon voice.',
      params: { algorithm: 'granular', pitch: 10 } },
    { id: 'helium', name: 'Helium', emoji: '🎈', category: 'creature', description: 'Just inhaled a balloon.',
      params: { pitch: 3, formant: 9, bass: -4 } },
    { id: 'giant', name: 'Giant', emoji: '🗿', category: 'creature', description: 'Enormous, slow-sounding giant.',
      params: { pitch: -10, formant: -7, bass: 4, reverbMix: 0.2, reverbSize: 3 } },
    { id: 'monster', name: 'Monster', emoji: '👹', category: 'creature', description: 'Growling beast under the bed.',
      params: { pitch: -12, formant: -6, drive: 0.3, chorusMix: 0.3, chorusRate: 0.6, reverbMix: 0.15, reverbSize: 2 } },
    { id: 'demon', name: 'Demon', emoji: '😈', category: 'creature', description: 'Layered voice from the underworld.',
      params: { pitch: -8, formant: -4, chorusMix: 0.5, chorusRate: 0.4, drive: 0.4, reverbMix: 0.3, reverbSize: 4, lowpass: 6000 } },
    { id: 'villain', name: 'Dark Villain', emoji: '🦹', category: 'creature', description: 'Menacing masked villain.',
      params: { pitch: -4, formant: -3, drive: 0.25, ringMix: 0.1, ringFreq: 30, highpass: 120, lowpass: 5000, mid: 4, compress: 0.7, reverbMix: 0.1, reverbSize: 1.2 } },
    { id: 'alien', name: 'Alien', emoji: '👽', category: 'creature', description: 'Transmission from another galaxy.',
      params: { pitch: 4, formant: -3, vibratoDepth: 2, vibratoRate: 8, ringMix: 0.25, ringFreq: 350, chorusMix: 0.4, echoMix: 0.2, echoTime: 0.12, echoFeedback: 0.3 } },
    { id: 'ghost', name: 'Ghost', emoji: '👻', category: 'creature', description: 'Haunting, airy spirit.',
      params: { texture: 'whisper', pitch: 2, vibratoDepth: 1, vibratoRate: 4, tremoloDepth: 0.3, tremoloRate: 3, echoMix: 0.3, echoTime: 0.3, echoFeedback: 0.5, reverbMix: 0.5, reverbSize: 5 } },

    // Machines
    { id: 'robot', name: 'Robot', emoji: '🤖', category: 'machine', description: 'Monotone mechanical robot.',
      params: { texture: 'robot', robotPitch: 110, ringMix: 0.3, ringFreq: 60, echoMix: 0.2, echoTime: 0.03, echoFeedback: 0.3 } },
    { id: 'cyborg', name: 'Cyborg', emoji: '🦾', category: 'machine', description: 'Half human, half machine.',
      params: { pitch: -2, ringMix: 0.5, ringFreq: 30, chorusMix: 0.4, bitDepth: 10, echoMix: 0.3, echoTime: 0.02, echoFeedback: 0.6 } },
    { id: 'radio', name: 'Walkie-Talkie', emoji: '📻', category: 'machine', description: 'Crackly two-way radio.',
      params: { highpass: 400, lowpass: 3200, drive: 0.35, staticNoise: 0.15, compress: 0.8, bitDepth: 12 } },
    { id: 'telephone', name: 'Old Telephone', emoji: '☎️', category: 'machine', description: 'Tinny vintage phone line.',
      params: { highpass: 300, lowpass: 3400, mid: 6, drive: 0.15, downsample: 4, compress: 0.6 } },
    { id: 'megaphone', name: 'Megaphone', emoji: '📢', category: 'machine', description: 'Loud, harsh bullhorn.',
      params: { highpass: 600, lowpass: 5000, mid: 9, drive: 0.6, compress: 0.8, echoMix: 0.12, echoTime: 0.08, echoFeedback: 0.2, volume: -3 } },
    { id: 'astronaut', name: 'Astronaut', emoji: '🧑‍🚀', category: 'machine', description: 'Ground control, do you copy?',
      params: { highpass: 350, lowpass: 3500, staticNoise: 0.08, drive: 0.2, compress: 0.7, reverbMix: 0.1, reverbSize: 0.8 } },
    { id: 'retro', name: '8-Bit Arcade', emoji: '👾', category: 'machine', description: 'Crunchy retro video-game voice.',
      params: { pitch: 3, bitDepth: 4, downsample: 8, lowpass: 8000, volume: -3 } },

    // Places
    { id: 'cave', name: 'Cave', emoji: '🕳️', category: 'place', description: 'Deep cave with bouncing echoes.',
      params: { echoMix: 0.4, echoTime: 0.35, echoFeedback: 0.45, reverbMix: 0.35, reverbSize: 3.5 } },
    { id: 'cathedral', name: 'Cathedral', emoji: '⛪', category: 'place', description: 'Huge stone hall.',
      params: { reverbMix: 0.55, reverbSize: 7, highpass: 100 } },
    { id: 'underwater', name: 'Underwater', emoji: '🌊', category: 'place', description: 'Muffled, bubbly and wobbly.',
      params: { pitch: -1, lowpass: 700, vibratoDepth: 1.5, vibratoRate: 1.5, chorusMix: 0.5, chorusRate: 0.5, reverbMix: 0.3, reverbSize: 2 } },
    { id: 'bathroom', name: 'Bathroom', emoji: '🚿', category: 'place', description: 'Small tiled room, lots of reflections.',
      params: { reverbMix: 0.35, reverbSize: 1.1, treble: 2, echoMix: 0.1, echoTime: 0.05, echoFeedback: 0.3 } },

    // Fun
    { id: 'choir', name: 'Choir', emoji: '🎶', category: 'fun', description: 'Sounds like a whole group is talking.',
      params: { chorusMix: 0.8, chorusRate: 1.2, reverbMix: 0.3, reverbSize: 2.5 } },
    { id: 'dizzy', name: 'Dizzy', emoji: '🥴', category: 'fun', description: 'Wobbly, seasick voice.',
      params: { vibratoDepth: 4, vibratoRate: 1.2, chorusMix: 0.4, chorusRate: 0.3 } },
    { id: 'mouse', name: 'Tiny Mouse', emoji: '🐭', category: 'fun', description: 'Teeny squeaky critter.',
      params: { pitch: 14, formant: 10, bass: -6 } },
    { id: 'bear', name: 'Big Bear', emoji: '🐻', category: 'fun', description: 'Low, gruff and fuzzy.',
      params: { pitch: -7, formant: -5, drive: 0.2, bass: 5, lowpass: 5000 } },
  ];

  WVC.PRESETS = Object.freeze(PRESETS.map((p) => Object.freeze({ ...p, builtIn: true, params: Object.freeze({ ...p.params }) })));
  WVC.DEFAULT_PRESET_ID = 'natural';

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  WVC.clamp = clamp;

  /** Full params object with every param at its default. */
  WVC.defaultParams = function defaultParams() {
    const out = {};
    for (const p of WVC.PARAMS) out[p.id] = p.default;
    return out;
  };

  /** Coerce/validate a single value for a param definition. Invalid -> default. */
  WVC.normalizeValue = function normalizeValue(paramOrId, value) {
    const p = typeof paramOrId === 'string' ? WVC.PARAM_MAP[paramOrId] : paramOrId;
    if (!p) return undefined;
    if (p.type === 'select') {
      return p.options.some((o) => o.value === value) ? value : p.default;
    }
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return p.default;
    return clamp(n, p.min, p.max);
  };

  /** Returns a complete, validated params object (unknown keys dropped, missing keys = defaults). */
  WVC.normalizeParams = function normalizeParams(params) {
    const src = params && typeof params === 'object' ? params : {};
    const out = {};
    for (const p of WVC.PARAMS) out[p.id] = p.id in src ? WVC.normalizeValue(p, src[p.id]) : p.default;
    return out;
  };

  /** Find a preset by id among built-ins and (optionally) custom presets. */
  WVC.getPreset = function getPreset(id, customPresets) {
    if (!id) return null;
    const custom = Array.isArray(customPresets) ? customPresets : [];
    return WVC.PRESETS.find((p) => p.id === id) || custom.find((p) => p && p.id === id) || null;
  };

  /** Full params for a preset (object or id). Unknown preset -> defaults. */
  WVC.presetParams = function presetParams(presetOrId, customPresets) {
    const preset = typeof presetOrId === 'string' ? WVC.getPreset(presetOrId, customPresets) : presetOrId;
    return WVC.normalizeParams(Object.assign(WVC.defaultParams(), preset ? preset.params : {}));
  };

  /** Default Settings object stored under STORAGE_KEYS.SETTINGS. */
  WVC.defaultSettings = function defaultSettings() {
    return {
      enabled: true, // master switch: false = calls pass through untouched (still switchable mid-call)
      presetId: WVC.DEFAULT_PRESET_ID, // preset last applied ('natural', 'deep', ..., or a custom preset id)
      params: WVC.presetParams(WVC.DEFAULT_PRESET_ID),
      monitor: false, // play my changed voice back to me during calls (use headphones!)
      fileButton: true, // show the in-page 🎵 'send an audio file as a voice note' button on WhatsApp Web
    };
  };

  /** Validate a (possibly partial / stale) Settings object read from storage. */
  WVC.normalizeSettings = function normalizeSettings(settings) {
    const d = WVC.defaultSettings();
    const s = settings && typeof settings === 'object' ? settings : {};
    return {
      enabled: typeof s.enabled === 'boolean' ? s.enabled : d.enabled,
      presetId: typeof s.presetId === 'string' && s.presetId ? s.presetId : d.presetId,
      params: WVC.normalizeParams(s.params || d.params),
      monitor: typeof s.monitor === 'boolean' ? s.monitor : d.monitor,
      fileButton: typeof s.fileButton === 'boolean' ? s.fileButton : d.fileButton,
    };
  };

  /** True when settings.params differ from the params of settings.presetId. */
  WVC.isModified = function isModified(settings, customPresets) {
    if (!settings) return false;
    const preset = WVC.getPreset(settings.presetId, customPresets);
    if (!preset) return true;
    const a = WVC.normalizeParams(settings.params);
    const b = WVC.presetParams(preset);
    return WVC.PARAMS.some((p) => (p.type === 'select' ? a[p.id] !== b[p.id] : Math.abs(a[p.id] - b[p.id]) > 1e-6));
  };

  /** Create a new custom preset object from the current params. */
  WVC.makeCustomPreset = function makeCustomPreset(name, params, emoji) {
    const id = 'custom-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
    return {
      id,
      name: String(name || 'My voice').slice(0, 40),
      emoji: emoji || '⭐',
      category: 'mine',
      description: 'Custom preset',
      builtIn: false,
      params: WVC.normalizeParams(params),
    };
  };

  /** Validate an array of custom presets (e.g. from storage or an imported JSON file). */
  WVC.normalizeCustomPresets = function normalizeCustomPresets(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      let id = typeof item.id === 'string' && item.id.startsWith('custom-') ? item.id : null;
      if (!id || seen.has(id)) id = WVC.makeCustomPreset('x', {}).id + '-' + out.length;
      seen.add(id);
      out.push({
        id,
        name: String(item.name || 'My voice').slice(0, 40),
        emoji: typeof item.emoji === 'string' && item.emoji ? item.emoji.slice(0, 8) : '⭐',
        category: 'mine',
        description: typeof item.description === 'string' ? item.description.slice(0, 120) : 'Custom preset',
        builtIn: false,
        params: WVC.normalizeParams(item.params),
      });
    }
    return out;
  };

  /* ------------------------------------------------------------------ *
   * Slider mapping & display formatting (shared by popup + studio)
   * ------------------------------------------------------------------ */

  function snap(p, v) {
    const s = p.step || 0;
    if (s > 0) {
      v = Math.round((v - p.min) / s) * s + p.min;
      const decimals = (String(s).split('.')[1] || '').length;
      v = Number(v.toFixed(decimals));
    }
    return clamp(v, p.min, p.max);
  }

  /** Param value -> slider position in [0, 1] (log-aware). */
  WVC.toSlider = function toSlider(paramOrId, value) {
    const p = typeof paramOrId === 'string' ? WVC.PARAM_MAP[paramOrId] : paramOrId;
    const v = clamp(Number(value), p.min, p.max);
    if (p.scale === 'log') return Math.log(v / p.min) / Math.log(p.max / p.min);
    return (v - p.min) / (p.max - p.min);
  };

  /** Slider position in [0, 1] -> param value snapped to step (log-aware). */
  WVC.fromSlider = function fromSlider(paramOrId, t) {
    const p = typeof paramOrId === 'string' ? WVC.PARAM_MAP[paramOrId] : paramOrId;
    t = clamp(Number(t) || 0, 0, 1);
    const v = p.scale === 'log' ? p.min * Math.pow(p.max / p.min, t) : p.min + t * (p.max - p.min);
    return snap(p, v);
  };

  function trimNum(n, maxDecimals) {
    return Number(n.toFixed(maxDecimals)).toString();
  }

  /** Human-readable value, e.g. "+3 st", "1.2 kHz", "35%", "Off". */
  WVC.formatValue = function formatValue(paramOrId, value) {
    const p = typeof paramOrId === 'string' ? WVC.PARAM_MAP[paramOrId] : paramOrId;
    if (!p) return String(value);
    if (p.type === 'select') {
      const o = p.options.find((x) => x.value === value);
      return o ? o.label : String(value);
    }
    const v = Number(value);
    switch (p.unit) {
      case 'st':
        return (v > 0 ? '+' : v < 0 ? '−' : '') + trimNum(Math.abs(v), 1) + ' st';
      case 'hz':
        if (p.id === 'lowpass' && v >= p.max) return 'Off';
        if (p.id === 'highpass' && v <= p.min) return 'Off';
        return v >= 1000 ? trimNum(v / 1000, v >= 10000 ? 1 : 2) + ' kHz' : trimNum(v, v < 10 ? 1 : 0) + ' Hz';
      case 'db':
        return (v > 0 ? '+' : v < 0 ? '−' : '') + trimNum(Math.abs(v), 1) + ' dB';
      case 'pct':
        return Math.round(v * 100) + '%';
      case 's':
        return v < 1 ? Math.round(v * 1000) + ' ms' : trimNum(v, 2) + ' s';
      case 'ms':
        return v <= 0 ? 'Off' : trimNum(v, 1) + ' ms';
      case 'bits':
        return v >= p.max ? 'Off' : trimNum(v, 0) + ' bit';
      case 'x':
        return v <= 1 ? 'Off' : '÷' + trimNum(v, 0);
      case 'gate':
        return v <= p.min ? 'Off' : trimNum(v, 0) + ' dB';
      default:
        return trimNum(v, 2);
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = WVC;
})(typeof globalThis !== 'undefined' ? globalThis : this);
