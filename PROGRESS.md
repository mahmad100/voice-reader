# Wren: Progress

My own Speechify replacement: a Chrome extension that reads pages aloud with sentence and word highlighting.

## Status (2026-10-07)

| Version | Feature | Status |
| --- | --- | --- |
| v0.1 | Reads pages with built-in voices, word highlighting, player bar, shortcuts | ✅ Confirmed working in Chrome |
| v0.2 | Natural AI voices (Kokoro, runs on the laptop's GPU) | ✅ Confirmed working in Chrome (Heart, 1× and 2×) |
| v0.3 | Page map: list of sections to tick, untick, and jump to | ✅ Tested in Chrome |
| v0.4 | Math read aloud (equations, Greek letters, symbols), with a box over equations | ✅ Tested in Chrome on "Mass–energy equivalence" |
| v0.5 | Click to read, read just a selection, paragraph play buttons, Options panel (line focus, wider spacing, highlight colors, follow along) | ✅ Tested in Chrome. ⚠️ 4 last fixes not yet tried, see below |
| v0.6 | Renamed Wren. Animated logo. Apple-style glass player you can drag and dock (vertical on the sides). Appearance panel: logo, color, position lock, glass | ✅ Used in Chrome by the user (appearance panel, glass, panels). ⚠️ Last 3 fixes not yet tried, see below |
| v0.7 | True pause and resume (carries on mid-word), shrink when not in use (with an on/off button on the bar), position picker fix | ✅ Shrink and picker used in Chrome by the user. ⚠️ Pause/resume not yet tried with real voices |
| v0.7+ | AI voice starts faster after a click (short first piece, clips prepared before the click), × to close panels | ✅ The user tried it in Chrome: "it works". ⚠️ Not measured with the prepare-ahead, see Session 5 |

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

**Put the project on GitHub:** https://github.com/mahmad100/wren (public, branch `main`).

**Built v0.3: page map** (button on the bar, or Alt+Shift+M)
- Sections come from the article's headings. "References" onwards starts unticked, so the default reading is unchanged (still 225 sentences on "Dyslexia").
- Tested on "Dyslexia": jump to a section, untick the section being read (moves on), jump into an unticked section, Alt+click into an unticked section.

**Built v0.4: math and Greek letters**
- `math-speech.js` turns MathML into English, and names Greek letters and symbols in ordinary text.
- Checked how Kokoro pronounces things (with `phonemizer` in the build folder): "xi" came out as "Roman eleven" and "mu" as "moo", so they're respelled "zye" and "mew". A lone "a" is sent as "A", or it's read as "uh".
- Tested the converter on 8 representative real equations from Wikipedia "Mass–energy equivalence" (of its 34), and read the page in Chrome. Covers Wikipedia's quirks: the power on the closing bracket in `(pc)^2`, aligned equations split into table cells, and subscripts spelled out letter by letter (`E_rel`).
- Equations get a yellow box over them, since they're images. The word box follows the voice: "E equals m c squared" lights up the equation for its ~2 s.
- Fixed: the box first hid the equation, because the blend only worked inside the overlay. Now the overlay layer itself blends with the page.

**Fixed:** the page map popped up on every page, because "map open" was remembered from testing. It now always starts closed.

**Researched Speechify and NaturalReader:**
- Speechify: click to listen, a play button on selected text, "Read Selection", skip-content switches.
- NaturalReader: Click to Read with a hover highlight, Highlight to Read with a minimum length, a separate switch for each.
- Nielsen Norman Group timing for anything shown on hover: show after 0.3–0.5 s at rest, hide 0.5 s after leaving.
- For dyslexia: wider letter spacing has the best evidence (Zorzi et al., PNAS 2012: ~20% faster, half the errors). Line focus comes from Immersive Reader. OpenDyslexic showed no benefit (Wery & Diliberto 2017), so no special font.

**Built v0.5: starting where you point, and reading options**
- Click to read from the exact word, with a dotted underline preview. Text outside the article gets a temporary "Clicked text" section instead of replacing the map.
- Selection play button, in the highlight color: reads just the selection, then "Finished selection".
- Paragraph play buttons (off by default), using the NN/g timings.
- ⚙ Options panel on the bar: a switch for each of these, plus follow along with "Back to reading", line focus, wider spacing (WCAG values), and highlight color and style.
- Right-click menu: added *Read selected text* next to *Read aloud from here*.
- The user asked for no extra shortcuts. Alt+Shift+M/O/X were removed: they clash with Wikipedia's own Alt+Shift shortcuts (O opened "Log in", X opens a random article).
- Tested in Chrome on "Mass–energy equivalence": the click preview and click-to-read, clicking text outside the article, selection reading, the paragraph button appearing after 0.45 s, line focus, spacing, green highlight, and "Back to reading".

## Session 2 (2026-10-07)

**Renamed to Wren** (was "Voice Reader"): extension name, page titles, log tags and docs. The folder and GitHub repo were still `voice-reader` then; see Session 4.

**Logo:** picked "Soundtail" (in orange) from three ideas: a wren whose cocked tail is a fan of three sound-level bars. `wren-mark.js` draws it. It's on the player bar, and while reading its tail sways slowly. It eases in and out instead of starting or stopping suddenly. The toolbar icon sways too. The PNG icons are made from the same drawing (`node icons/build.mjs`). The tail went through a few shapes: side-by-side bars looked like a hand, and a fan from one point reads as a tail.

**Redesigned the player** (Apple style): frosted glass in light and dark mode, Wren orange, and a progress ring around the play button.
- Drag it anywhere. Near the top or bottom edge it docks there; once either end of the bar reaches the left or right side it turns vertical there, wherever it's held; anywhere else it floats. It glides into place, and its position is remembered (`dock` setting). 
- Click the logo (now in a circle, like the buttons) for **Appearance**: three logos (Soundtail, Songbird, Wave), five colors (Ember, Rose, Dusk, Moss, Ink), a position picker (tap an edge of a small screen) with **Lock position** (lock badge on the logo, a shake if dragged), and glass settings (clear to frosted, pill or rounded, tint). The color themes the whole player, the play buttons on the page, and the toolbar icon. The glass settings apply to the bar, panels and message bubbles alike. Saved as the `logo`, `color`, `lockDock`, `glassClarity`, `glassTint` and `barShape` settings.
- The voice menu is now a panel with a list of voices, opened from a button that shows the voice's name. Options use on/off switches, and the highlight style is a segmented control.
- Panels open on the side facing the page and stay inside the window. Esc closes them.
- Checked with screenshots of a test page (Chrome's extension features stubbed): bottom, top, left and right docks, floating, dark mode, each panel, dragging, and a locked drag. The user then used it in Chrome.

**Fixed after the user tried it in Chrome:**
- Clicking the logo did nothing: the bar holds the pointer during a possible drag, so the click went to the bar. A press and release on the logo without moving now opens Appearance.
- The bar only turned vertical when the pointer itself reached the side. It now turns vertical when either end of the bar does, wherever it's held.
- Scrolling a panel sometimes scrolled the page behind it (and turned off follow along). Panels now keep the scroll.
- The highlight style switch wrapped "Sentence and word" onto two lines and looked heavy in dark mode. Now "Both · Sentence · Word" on one line, iPhone-style.
- **Reading a selected paragraph stopped after the first word.** A triple-click selection ends on Wikipedia's citation "[1]", which isn't spoken, so its position fell back to the start of the paragraph. Text that isn't spoken now maps to the nearest spoken text. Checked on the test page: all three sentences read, then it stopped.
- The version is now 0.6.0 (Chrome still said 0.5).

## Session 3 (2026-10-07): v0.7

**True pause and resume** (was: resuming restarted the sentence).
- Pause holds the voice mid-word: `chrome.tts.pause()`/`resume()` for built-in voices, and pausing the `<audio>` clip in `offscreen.js` for AI voices. The word highlight stays on the paused word, and its timing skips the pause.
- Fallback: if the voice doesn't confirm the pause within 0.3 s, or can't resume (e.g. the AI voice unloaded after 10 minutes), it's stopped, and resume starts from the paused word. Speed and voice changes also carry on from the current word now, instead of restarting the sentence.
- Skipping to another sentence while paused lets go of the held one. A speed or voice change while paused lets go too (the held audio is at the old setting); play then carries on from the word.
- Tested on a test page with a fake voice that speaks a word every 100 ms: a voice that can pause (pause, resume, next sentence, nothing repeated), one that can't (stopped, resumed from "their loud songs"), skip while paused, and faster while paused (resumed from "small"). Not yet tried with real voices.

**Shrink when not in use** (Appearance → Position, off by default): the player slims down to the logo and play button, like the iPhone's Dynamic Island, and opens into the full bar when pointed at (after 80 ms, so passing over it doesn't). It shrinks 0.5 s after the pointer leaves, and stays open while a panel is open or it has keyboard focus (a mouse click doesn't count). The hidden controls slide out along the bar, which is placed by the size it's heading to, so it stays anchored to its edge. Works vertical too. Checked on the test page: shrunk at the bottom (stays centered), expanded on hover (same spot as the normal bar), and shrunk on the left. Reduced-motion users get it without the slide. A button on the bar (inward arrows, next to ×) turns it on or off too.

**Fixed:** with shrinking on, tapping an edge in the position picker (or dragging) from a side to the top or bottom left the bar parked high above the edge: the hidden controls kept their vertical-bar heights while the bar was measured. Also, opening a panel while shrunk now always expands the bar.

## Session 4 (2026-10-07): renamed everything to Wren

- **GitHub repo** renamed `voice-reader` → `wren` (https://github.com/mahmad100/wren). Old links redirect.
- **Commit history cleaned:** the `Co-Authored-By: Claude` line was removed from every commit and the history force-pushed. All commits are by Mohammad Ahmadi only, and the contributor list shows only mahmad100. From now on, commits carry no Claude attribution.
- **AI voice build folder** renamed `voice-reader-build` → `wren-build`. `build.mjs` now writes into `Projects/wren`, and the package is named `wren-build`.
- **Project folder:** not renamed yet. Windows said it was "in use" (Claude Code was running inside it, and VS Code and Chrome may hold it too). The user is renaming it by hand.
- **License:** GPL-3.0-or-later (`LICENSE`), chosen by the user because the AI voice bundle includes eSpeak NG (GPL-3.0, via `phonemizer`). Credits and licenses for the bundled code (kokoro-js, Transformers.js, phonemizer, eSpeak NG: Apache-2.0/GPL-3.0; onnxruntime-web: MIT) are in `THIRD_PARTY_NOTICES.md`, with the Apache text in `licenses/Apache-2.0.txt`. Update the versions there when the bundle is rebuilt.
- Left alone on purpose: the internal `voice-reader-…` IDs in `content.js` (page element and highlight names nobody sees).

## Session 5 (2026-10-07): faster start after a click, × on panels

**× on panels:** Page map, Voice, Options and Appearance each have a × in the top-right corner that closes them (`panelHead` in `content.js`).

**AI voice starting somewhere new (click, paragraph button, jump) took a few seconds.** The v0.5 fix (what you're waiting for goes to the front of the line) was still in place; the rest was the time to make the clip.
- Measured in Chrome with temporary timing code (Bella/Fable, Dyslexia article): a clip costs about **0.75–0.9 s however short, plus ~14 ms per character**. 16 chars: 0.96 s, 30: 0.98 s, 51: 1.3 s, 115: 2.3 s, 126: 2.5 s. Kokoro already keeps the voice data in memory, so the fixed cost is the model run on the GPU. A click landed 1.9 s before sound: 0.3 s double-click wait (stretched by a hidden tab), ~1 s making the clip, plus the trip there and back.
- **Short first piece:** a sentence that wasn't prepared ahead has its first words, up to a comma, semicolon, colon or dash leaving at least 4 words on each side (`firstPieceEnd`), spoken as their own clip. The rest is made while they play, and the whole sentence stays highlighted. Sentences with equations aren't split.
- **Prepared before the click:** the word under a pointer resting 0.2 s, a paragraph whose play button appears, and the spot of a mouse press are sent as `prepare` (content → background → offscreen). The offscreen page makes that clip first and keeps only the latest guess waiting. The clip is exactly the one `speakCurrent` asks for on the click, so the click finds it ready.
- The user tried it and said it works. Not measured after the prepare-ahead, because the test tab was covered by another window: Chrome then stops animation frames (the hover preview runs on them) and stretches a 0.3 s timer to 1 s.

**Testing notes:** content-script `console.log` doesn't reach my console reader; write to `document.documentElement.dataset` instead and read it from the page. The Chrome window must be uncovered (side by side with the terminal), or `document.visibilityState` is `hidden` and timings are wrong. The test tab is opened in the Claude tab group; the user has to reload Wren and click the icon *in that tab*.

## Next session: start here

0. **Measure the faster start** (window side by side, tab visible): click with and without resting first, while reading and while stopped. Listen for a gap where a sentence is split. If a resting pointer still waits, the guess may be waiting behind a clip already being made.

1. **If the folder is still `Projects/voice-reader`, rename it to `wren`** (close Claude Code, VS Code's folder and maybe Chrome first). Then in `chrome://extensions` remove Wren and *Load unpacked* the `wren` folder, since Chrome remembers the old path. Saved Wren settings may reset. `node build.mjs` fails until the folder is renamed.
2. **Try pause and resume with real voices:** a Windows voice (Microsoft …), Google US English, and an AI voice (Heart). Pause mid-sentence, wait, resume: it should carry on mid-word. Also pause for over 10 minutes with an AI voice (should resume from the word).
3. **Check the last v0.6 fixes in Chrome:** scrolling inside a panel (shouldn't move the page), the Both/Sentence/Word switch, and triple-clicking a paragraph then pressing its play button (should read the whole paragraph). Also try the glass slider and a locked drag by hand.
4. **Check the four v0.5 fixes**, still never tried in Chrome:
   - Starting mid-sentence (click or selection) with an AI voice took 25+ s, because the voice prepared sentences strictly in order. `offscreen.js` now puts what you're waiting for first. Expected: a 1–3 s wait at most.
   - The paragraph play button never went away if the pointer kept moving after leaving the paragraph. It now goes 0.5 s after leaving.
   - Line focus dimmed the whole page while scrolled away from the sentence being read. It now steps aside.
   - A reader left open during an extension reload got stuck in an endless loop of errors (an old bug).
5. My tests switched on line focus, wider spacing and a green highlight in the user's settings. Switch them back in Options if not wanted.
6. **Listen to math on a few more pages** and tune the wording: Wikipedia "Normal distribution", "Schrödinger equation", "Quadratic formula". Open questions: say "capital" for Δ vs δ? Absolute value bars |x| are silent.
7. Other ideas: skip-content switches (citations, brackets, URLs), a size setting for the player, tables read row by row, PDF support (PDF.js), Google Docs.

**Testing note:** my Chrome tool can't press browser-level shortcuts or the toolbar icon, and Alt+Shift+letter keys hit the page's own shortcuts. The user has to reload the extension and click the icon; after that I can drive the player bar.

## Where things live

- Extension (load this folder in Chrome): `Projects/wren/`
- GitHub (public): https://github.com/mahmad100/wren. The GitHub CLI is at `%LOCALAPPDATA%\Microsoft\WinGet\Packages\GitHub.cli_*\bin\gh.exe`, logged in as mahmad100.
- AI voice build tooling (kept outside OneDrive): `C:\Users\mahmad10\wren-build` → `node build.mjs`
- Details on using it and how it works: `README.md`
