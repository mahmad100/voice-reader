# Voice Reader: Progress

My own Speechify replacement: a Chrome extension that reads pages aloud with sentence and word highlighting.

## Status (2026-10-05)

| Version | Feature | Status |
| --- | --- | --- |
| v0.1 | Reads pages with built-in voices, word highlighting, player bar, shortcuts | ✅ Confirmed working in Chrome |
| v0.2 | Natural AI voices (Kokoro, runs on the laptop's GPU) | ⚠️ Built, **not yet tried in the real extension** |

## Session 1 (2026-10-05)

**Built v0.1**
- Finds the article text and skips menus, sidebars, Wikipedia fact boxes, data tables, and reference lists. Stops at "References", "External links", etc.
- Splits text into sentences without breaking at initials ("W. Pringle Morgan") or "Dr.", "e.g.".
- Highlights the current sentence and word without changing the page (CSS Custom Highlight API).
- Speech goes through `chrome.tts` in the background script, so it needs no click on the page first.
- Tested on the Wikipedia "Dyslexia" article: 225 sentences of article text. Before the fixes it was 1,065, mostly citations.

**Built v0.2: AI voices**
- Kokoro-82M runs in a hidden extension page (`offscreen/`), using WebGPU.
- Speed measured on this laptop (Intel Arc / Xe2 graphics):
  - Processor only (CPU, smaller q8 model): **0.2× real time**, too slow to use.
  - Graphics chip (WebGPU, full-precision fp32 model): **~3.5× real time**. This is what the extension uses.
- Prepares the next 3 sentences while the current one plays. The gap between sentences was ~20 ms in testing.
- One-time ~330 MB model download, cached afterwards. About 5 s from first press to speech, including warm-up.
- 10 AI voices (US and UK English). Heart is the default.
- Falls back to a built-in voice on computers without WebGPU.

## Next session: start here

1. **Test the AI voices in the real extension.** Reload it in `chrome://extensions`, choose "Heart" from the *Natural AI voices* group, and read a page.
   - If it's stuck on "Loading" or silent: Developer mode → **Inspect views: offscreen.html** → Console. Copy the red errors.
   - Check that the highlighted word keeps up with the voice, at 1× and at 2×.
2. Then pick the next feature:
   - PDF support (PDF.js)
   - Google Docs support
   - True pause/resume (right now resume restarts the sentence)
   - Auto-scroll on/off switch, highlight colors

## Where things live

- Extension (load this folder in Chrome): `Projects/voice-reader/`
- AI voice build tooling (kept outside OneDrive): `C:\Users\mahmad10\voice-reader-build` → `node build.mjs`
- Details on using it and how it works: `README.md`
