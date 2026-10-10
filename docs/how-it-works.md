# How it works

Notes on how the extension is put together, mostly for future me. If you just want to use it, the README is enough.

The short version: the extension patches `getUserMedia` on web.whatsapp.com, runs the microphone through a Web Audio graph, and gives WhatsApp the processed stream. That covers both calls and voice notes. There's no build step, every file is a plain script (no modules, no bundler).

## Files

```
manifest.json
icons/
src/shared/params.js         parameters, presets, settings helpers (global WVC)
src/shared/theme.css         colors and base components for the popup and the studio
src/engine/dsp-core.js       pitch/formant shifter and the AudioWorklet processor (global WVCDSP)
src/engine/voice-engine.js   builds the Web Audio graph (WVC.VoiceEngine)
src/content/inject.js        MAIN world: the getUserMedia hook
src/content/bridge.js        ISOLATED world: settings from chrome.storage to the page, status back
src/content/voicenote-ui.js  ISOLATED world, top frame: the 🎵 voice note button and panel
src/background/service-worker.js   defaults, shortcuts, badge, per-tab status
src/popup/                   toolbar popup
src/options/                 Voice Studio (opens as a tab)
tests/                       Node tests, the engine harness and the Chrome e2e tests
```

## The microphone hook

`inject.js` runs in the page itself (MAIN world) at `document_start`, in every frame. It replaces `MediaDevices.prototype.getUserMedia` plus the old callback versions (`navigator.getUserMedia`, `webkitGetUserMedia`). The patched functions keep their `name`, `length` and `toString()` so they look like the originals.

For every stream that has audio, it connects the mic track to a `VoiceEngine` and returns a new MediaStream with the processed audio track and the original video tracks. The audio gets wrapped even while the voice changer is switched off, so it can be turned on in the middle of a call.

WhatsApp has to be able to treat the processed track like a normal one:
- `stop()` also stops the real mic track and tears the engine down once no clones are left
- `getSettings`, `getConstraints`, `getCapabilities` and `applyConstraints` are passed through to the real track
- `label` is the real track's label, and when the real track ends the processed one ends too
- muting with `track.enabled = false` still works

The rule for this file is that it can't break a call. If building the graph throws, or the AudioContext still isn't running about a second after it was created, it returns the original stream and reports the error in the status.

Settings come in through page messages (below). If WhatsApp asks for the mic before the first settings message arrives, the hook waits up to 1.5 s and then uses the defaults.

## Page messages

There are three scripts on the page: `inject.js` in the MAIN world, `bridge.js` and `voicenote-ui.js` in the ISOLATED world. They talk with `window.postMessage` using this envelope:

```js
{ __wvc: true, source, type, payload }
```

Receivers check `event.source === window` and the `source` tag before doing anything.

| From | To | type | payload |
|---|---|---|---|
| inject.js | bridge | `hello` | `{}`, sent once at startup |
| bridge | inject.js | `config` | `{ workletURL }` |
| bridge | inject.js | `settings` | `{ settings }`, also sent on every storage change |
| inject.js | bridge | `status` | `{ status }` whenever it changes |

Both sides start at `document_start` and either one can load first. That's why there's the hello: the bridge sends config and settings straight away and again whenever it gets a hello.

One thing that cost me some time: Chrome injects a given file only once per frame, even if two `content_scripts` entries list it. `params.js` is already in the MAIN world bundle, so it never runs in the ISOLATED world. That's why `bridge.js` and `voicenote-ui.js` keep their own copies of the few constants they need (storage keys and message types). If you change those in `params.js`, change the copies too. The bridge passes settings on raw and `inject.js` normalizes them.

The bridge also relays status to the service worker with `chrome.runtime.sendMessage({ type: 'wvc:status', status })`. The popup and the studio ask for it with `wvc:get-status`.

## Settings

Stored in `chrome.storage.local` under `wvc.settings`:

```js
{ enabled, presetId, params: { /* every parameter */ }, monitor, fileButton }
```

Custom presets are in `wvc.customPresets`, and the voice note widget keeps its button position and options in `wvc.ui`. Anything read from storage goes through `WVC.normalizeSettings()` / `WVC.normalizeCustomPresets()` first.

Choosing a preset sets `presetId` and copies the preset's params. Moving a slider keeps `presetId` and changes that one param, and the UI shows "modified" when they differ. The popup and the studio both write with a ~60 ms debounce, so dragging a slider during a call feels live, and both listen to `chrome.storage.onChanged` to stay in sync.

## The audio engine

`dsp-core.js` does the pitch side of things: a phase vocoder with a cepstral envelope (the Natural engine, which can also move formants on their own) and a two-grain delay line shifter (Classic). The robot and whisper textures, the noise gate and the bit/sample crushers live there too.

The whole file is one function, `wvcDefineDSP(scope)`, that doesn't reference anything outside itself. That way `voice-engine.js` can turn it into an AudioWorklet module with `'(' + wvcDefineDSP.toString() + ')(globalThis);'`.

Loading the worklet, per AudioContext:
1. a blob URL of that source (WhatsApp's CSP allows `blob:` scripts)
2. if that fails, the extension URL of `dsp-core.js`
3. then a `data:` URL
4. and if nothing works, a ScriptProcessorNode running the same code on the main thread

On the Voice Studio page it's the other way around. Extension pages don't allow `blob:` or `data:` scripts, so the extension URL goes first there.

Latency is constant per engine: 1023 samples for Natural and 1200 for Classic at 48 kHz, so about 21 and 25 ms. With pitch 0, formant 0 and a normal texture, the core passes the input through untouched (just delayed), and it crossfades for ~20 ms whenever it switches modes so you don't hear clicks.

`voice-engine.js` builds the rest of the graph around the core:

| Parameter | What it does |
|---|---|
| pitch, formant | semitones, done in the core (formant only works with the Natural engine) |
| texture, robotPitch | normal, robot (monotone at robotPitch Hz) or whisper |
| gate | noise gate threshold in dBFS, the lowest value turns it off |
| bitDepth, downsample | crushers, 16 bits and factor 1 are off |
| ringMix, ringFreq | ring modulator, the metallic robot sound |
| vibratoDepth, vibratoRate | delay line modulated by an LFO |
| tremoloDepth, tremoloRate | volume LFO |
| chorusMix, chorusRate | a few detuned, modulated short delays |
| echoMix, echoTime, echoFeedback | feedback delay |
| reverbMix, reverbSize | convolver with a generated impulse response, size is the decay in seconds |
| highpass, lowpass | filters, the end values mean off |
| bass, mid, treble | low shelf 180 Hz, peak 1.2 kHz, high shelf 4.5 kHz |
| drive | waveshaper distortion with makeup gain |
| staticNoise | band-passed noise that follows your voice, so it only hisses while you talk |
| compress | compressor, from off to a -40 dB threshold at 12:1 |
| mix | dry/wet, the dry path is delayed to line up with the wet one |
| volume | output gain in dB |

All changes use `setTargetAtTime`, so nothing clicks when you move a slider mid-call. At the very end there's a limiter (threshold -1 dB, ratio 20).

## Sending an audio file as a voice note

WhatsApp records a voice note by calling `getUserMedia({ audio })` when you press the mic button and encoding whatever comes out of that track. Since the track is already ours, `inject.js` can play a decoded file into it instead of (or on top of) the microphone. WhatsApp sends the result as a real voice note.

`voicenote-ui.js` is only the interface. It sits in a closed shadow root with its CSS inline, never touches WhatsApp's DOM and never clicks anything. Its messages use `source: 'wvc-ui'`, and `inject.js` answers with `source: 'wvc-main'`:

| From | type | payload |
|---|---|---|
| UI | `vn-load` | `{ name, buffer }`, the ArrayBuffer is transferred |
| UI | `vn-arm` | `{ options }`, play on the next mic request (expires after 3 minutes) |
| UI | `vn-play-now` | `{ options }`, play into every mic stream that's live right now |
| UI | `vn-stop` / `vn-clear` | stop playback, or stop and forget the file |
| UI | `vn-query` | ask for the current state |
| page | `vn-loaded` | `{ name, duration, sampleRate, channels, peaks }` |
| page | `vn-state` | the current state, also every ~250 ms while playing |
| page | `vn-error` | `{ message }`, readable enough to show as is |

Files are decoded with an OfflineAudioContext at 48 kHz (no user gesture needed), with limits of 150 MB and 30 minutes. Only one file is kept at a time.

During playback the file goes through a gain node (short fade in and out) and then either into the engine, if "apply my voice effect" is on, or straight to the output. When "include my microphone" is off, the mic is faded to zero and stays there for the rest of that recording, so the note has the file and then silence until you press Send.

The panel goes through these states: empty, loading, ready (trim, preview, options, arm), armed (waiting for you to press the mic), playing and done. If anything fails it posts an error and the microphone keeps working normally.

The popup's "Send audio file as voice note" button sends `wvc:open-voicenote` to the tab, which opens the panel even when the 🎵 button is hidden.

## Service worker

- On install it writes default settings (without overwriting existing ones) and opens the Voice Studio the first time.
- `Alt+Shift+V` flips `enabled`, `Alt+Shift+M` moves to the next built-in preset.
- Badge: nothing when disabled, a green ON when enabled, a red LIVE when a processed stream is running in that tab.
- Tab status lives in memory and is mirrored to `chrome.storage.session`, because the service worker can be stopped at any time. It's cleared when the tab closes or navigates.
