# End-to-end tests (real Chrome)

These drive a real Chrome (no Puppeteer, no dependencies) over the DevTools protocol pipe.
They load this unpacked extension with `Extensions.loadUnpacked` (flag `--enable-unsafe-extension-debugging`),
so they work with branded Chrome 137+, where `--load-extension` no longer does.

```bash
node tests/e2e/make-voice-wav.mjs
```

That writes `voice140.wav`, a synthetic 140 Hz vowel used as the fake microphone. You only need to run it once.

```bash
node tests/e2e/e2e.mjs
```

This opens the real `https://web.whatsapp.com/` (logged out; only the page load and `getUserMedia` are
needed), then checks that:
- the hook installs and looks native
- the stream WhatsApp receives is pitch-shifted as expected while presets are switched live mid-"call"
- the master switch restores the original voice
- video and legacy APIs pass through
- live status reaches the service worker
- stopping the track cleans up
- no console errors appear
- the keyboard shortcuts get assigned

It also saves screenshots of the popup and the Voice Studio to `tests/e2e/out/`.

```bash
node tests/e2e/harness.mjs
```

This runs `tests/engine-harness.html` headless: every preset, live updates, dry/wet alignment and the
ScriptProcessor fallback, all rendered through the full Web Audio graph in an OfflineAudioContext.

Set `CHROME_PATH` to use a different Chrome or Edge binary.
