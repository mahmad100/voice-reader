# Voice Reader: Progress

My own Speechify replacement: a Chrome extension that reads pages aloud with sentence and word highlighting.

## Status (2026-10-05)

| Version | Feature | Status |
| --- | --- | --- |
| v0.1 | Reads pages with built-in voices, word highlighting, player bar, shortcuts | ✅ Confirmed working in Chrome |
| v0.2 | Natural AI voices (Kokoro, runs on the laptop's GPU) | ✅ Confirmed working in Chrome (Heart, 1× and 2×) |
| v0.3 | Page map: list of sections to tick, untick, and jump to | ✅ Tested in Chrome |
| v0.4 | Math read aloud (equations, Greek letters, symbols), with a box over equations | ✅ Tested in Chrome on "Mass–energy equivalence" |

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

**Built v0.4: math and Greek letters**
- `math-speech.js` turns MathML into English, and names Greek letters and symbols in ordinary text.
- Checked how Kokoro pronounces things (with `phonemizer` in the build folder): "xi" came out as "Roman eleven" and "mu" as "moo", so they're respelled "zye" and "mew". A lone "a" is sent as "A", or it's read as "uh".
- Tested the converter on 8 representative real equations from Wikipedia "Mass–energy equivalence" (of its 34), and read the page in Chrome. Covers Wikipedia's quirks: the power on the closing bracket in `(pc)^2`, aligned equations split into table cells, and subscripts spelled out letter by letter (`E_rel`).
- Equations get a yellow box over them, since they're images. The word box follows the voice: "E equals m c squared" lights up the equation for its ~2 s.
- Fixed: the box first hid the equation, because the blend only worked inside the overlay. Now the overlay layer itself blends with the page.

## Next session: start here

1. **Listen to math on a few more pages** and tune the wording: Wikipedia "Normal distribution", "Schrödinger equation", "Quadratic formula". Things to consider:
   - Saying "capital" for capital Greek letters (Δ vs δ)? Right now both are just "delta".
   - Absolute value bars |x| are silent.
2. AI voice jump latency: after a jump, sentences already being read ahead finish generating first (up to ~3 s). Could cancel in-progress read-ahead.
3. Other ideas: tables read row by row, PDF support (PDF.js), Google Docs, true pause/resume, auto-scroll switch, highlight colors.

## Where things live

- Extension (load this folder in Chrome): `Projects/voice-reader/`
- GitHub (public): https://github.com/mahmad100/voice-reader. The GitHub CLI is at `%LOCALAPPDATA%\Microsoft\WinGet\Packages\GitHub.cli_*\bin\gh.exe`, logged in as mahmad100.
- AI voice build tooling (kept outside OneDrive): `C:\Users\mahmad10\voice-reader-build` → `node build.mjs`
- Details on using it and how it works: `README.md`
