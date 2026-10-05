# Voice Reader: Progress

My own Speechify replacement: a Chrome extension that reads pages aloud with sentence and word highlighting.

## Status (2026-10-05)

| Version | Feature | Status |
| --- | --- | --- |
| v0.1 | Reads pages with built-in voices, word highlighting, player bar, shortcuts | ✅ Confirmed working in Chrome |
| v0.2 | Natural AI voices (Kokoro, runs on the laptop's GPU) | ✅ Confirmed working in Chrome (Heart, 1× and 2×) |
| v0.3 | Page map: list of sections to tick, untick, and jump to | ✅ Tested in Chrome |

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

**Tested v0.2 AI voices:** reads on its own with Heart at 1× and 2×, no stalls. Sounded good to the user.

**Put the project on GitHub:** https://github.com/mahmad100/voice-reader (public, branch `main`).

**Built v0.3: page map** (button on the bar, or Alt+Shift+M)
- Sections come from the article's headings. "References" onwards starts unticked, so the default reading is unchanged (still 225 sentences on "Dyslexia").
- Tested on "Dyslexia": jump to a section, untick the section being read (moves on), jump into an unticked section, Alt+click into an unticked section.

## Next session: start here

1. **Math reading, starting with Greek letters and symbols in math** (the user's choice). Plan:
   - Keep two versions of each sentence: the text highlighted on the page and the text spoken. Right now they're the same string.
   - Read `<math>` elements instead of skipping them: Wikipedia includes the LaTeX source. Turn it into speech ("E equals m c squared"), possibly with the Speech Rule Engine that MathJax uses.
   - Greek letters and symbols: α → "alpha", ≤ → "less than or equal to", ° → "degrees".
   - The word highlight has to map spoken words back to page text, so an equation is highlighted as one unit.
   - Test pages: Wikipedia "Mass–energy equivalence", "Normal distribution".
2. Other ideas: tables read row by row, PDF support (PDF.js), Google Docs, true pause/resume, auto-scroll switch, highlight colors.

## Where things live

- Extension (load this folder in Chrome): `Projects/voice-reader/`
- AI voice build tooling (kept outside OneDrive): `C:\Users\mahmad10\voice-reader-build` → `node build.mjs`
- Details on using it and how it works: `README.md`
