# Wren

A Chrome extension that reads web pages aloud and highlights each sentence and word as it is spoken. It can use built-in voices or natural AI voices that run on your own computer.

Current status and next steps are in [PROGRESS.md](PROGRESS.md).

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this `voice-reader` folder.
4. Pin the extension (puzzle-piece icon → pin) so the Wren icon is always visible.

After changing any file, click the reload arrow on the extension's card in `chrome://extensions`, then refresh the page you're reading.

## Use

| Action | How |
| --- | --- |
| Read the page | Click the toolbar icon, or press **Alt+Shift+R** |
| Pause / resume | Same again, or the big button on the player bar |
| Read from a word | With the player open, **click** any text (see *Starting where you point*) |
| Read just some text | Select it, then press the play button that appears next to it, or right-click → *Read selected text* |
| Read on from a selection | Right-click selected text → *Read aloud from here* |
| Read from a paragraph | **Alt+click** it, or turn on paragraph play buttons in Options |
| Previous / next sentence | **Alt+Shift+←** / **Alt+Shift+→** |
| Slower / faster | **Alt+Shift+↓** / **Alt+Shift+↑**, or **−** / **+** on the bar |
| Choose a voice | The voice button on the bar (it shows the voice's name) |
| Page map / Options | The list and ⚙ buttons on the bar |
| Move the player | Drag it by the logo or any empty part of the bar |
| Change the logo, color, glass or position | Click the logo on the bar |
| Close the player | **×** on the bar |

Your speed, voice, Options choices and where you put the player are remembered. The page map, voice and Options panels start closed, and Esc closes them. To change the start/pause shortcut, go to `chrome://extensions/shortcuts`.

## The player

A frosted-glass bar that follows your system's light or dark mode. The ring around the play button fills as you get through the article, and the logo moves gently while it reads.

- **Appearance:** click the round logo to choose it (Soundtail, Songbird or Wave) and a color (Ember, Rose, Dusk, Moss or Ink). The color runs through the whole player, the play buttons on the page, and the toolbar icon. The same panel has:
  - **Position:** a small picture of the screen. Tap an edge to send the player there. **Lock position** stops it being dragged (like an iPhone's rotation lock); a lock badge shows on the logo, and a drag makes the bar shake.
  - **Glass:** a slider from clear to frosted, pill or rounded corners, and a tint in your color. These apply to the bar, the panels and the message bubbles alike; panels stay a little more solid than the bar so their text stays readable.

- **Docking:** push either end of the bar up to the left or right side and it turns into a vertical strip there, wherever you're holding it. Pull it a little way back out and it turns horizontal again. Near the top or bottom edge it docks there horizontally. Anywhere else it floats where you drop it.
- **Panels:** Appearance, the page map, voices and Options open on the side facing the page. Only one is open at a time. Scrolling a panel never scrolls the page behind it.
- **Messages:** on a vertical bar there's no room for "Finished" or "Loading AI voice", so they show in a bubble beside it for a few seconds.

## Starting where you point

Modeled on Speechify and NaturalReader. Each one can be switched on or off in **Options** (⚙ on the bar).

- **Click to read** (on by default): with the player open, click any text and reading starts from that word. A dotted underline shows where a click would start. Links, buttons and text boxes keep working as usual. A double-click still just selects a word. Text outside the article (a caption, a sidebar) works too: it's added to the page map as "Clicked text" instead of replacing the map.
- **Play button on selected text** (on by default): select at least a few characters and, once you let go of the mouse, a play button appears next to the selection in your highlight color. It reads just the selection, then stops at "Finished selection". Selecting a whole paragraph (a triple-click) reads all of it, even when it ends on a citation like "[1]". Pressing play again carries on from just after it.
- **Play buttons beside paragraphs** (off by default): rest the pointer on a paragraph and a play button in your Wren color appears in its margin. It doesn't appear for the paragraph already being read.

Buttons that appear on hover follow the Nielsen Norman Group's timing guidance, so they don't flicker as the pointer passes over the page: they show after the pointer has rested for 0.4 s, and go 0.5 s after it leaves.

## Options for easier reading

Choices aimed at dyslexic readers, all in **Options**:

- **Follow along:** the page scrolls with the reading. If you scroll away by hand, it stops following and a **Back to reading** button appears. It also picks up again by itself once the sentence being read is back on screen.
- **Line focus:** dims the page except the sentence being read (like Microsoft Immersive Reader). It steps aside while you've scrolled away.
- **Wider text spacing:** more space between letters, words and lines in the article, using the WCAG text-spacing values. Extra letter spacing is the change with the best evidence for dyslexic readers ([Zorzi et al., PNAS 2012](https://pubmed.ncbi.nlm.nih.gov/22665803/)). Special "dyslexia fonts" like OpenDyslexic showed no benefit in studies, so there isn't one.
- **Highlight:** yellow, green, blue or pink, for the sentence and word, the sentence only, or the word only.

## Page map

The page map lists the article's sections, one per heading, nested by level, with the number of sentences in each. The section being read is marked in orange.

- **Tick or untick** a section to include or skip it. Unticking the section being read moves on to the next ticked one.
- **Click a title** to jump there and start reading. This also ticks it if it was unticked.
- Sections from "References", "See also", "External links" and similar onwards start unticked, so by default reading stops where the article ends.
- Alt+clicking text in an unticked section ticks it and reads from there.

## Math and Greek letters

Equations are read aloud instead of skipped, for example *E = mc²* becomes "E equals m c squared", and *γ = 1/√(1 − v²/c²)* becomes "gamma equals 1 over the square root of 1 minus v squared over c squared". While an equation is being read, a yellow box is drawn over it, since many sites show equations as images that the normal highlight can't color.

- Works with Wikipedia, MathJax, KaTeX, and plain MathML. Equations are read from the machine-readable copy these sites keep behind each equation. If there's only TeX source, a simpler reading of it is used.
- Covers powers ("squared", "to the power of"), subscripts ("v sub 0"), fractions, roots, sums and integrals with limits, limits, brackets ("the quantity a plus b, squared"), accents ("x hat", "vector F") and common operators.
- Greek letters are named, in equations and in ordinary text ("the α-helix" → "the alpha-helix"). Greek words are left alone, and "μm" is read as "micro m".
- Some names are respelled so the voices say them right: Kokoro reads "xi" as "Roman eleven" and "mu" as "moo", so they're sent as "zye" and "mew".

## Natural AI voices

The voice menu's first group, **Natural AI voices**, uses [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), an open-source speech model that runs on your own computer. It's free, private (text never leaves your machine), and works offline after setup.

- **First use:** downloads the model once (~330 MB). The player bar shows "Loading AI voice …%".
- **After that:** it loads from Chrome's cache, and speech starts a few seconds after you press play.
- **Read-ahead:** the next few sentences are prepared while the current one plays, so there are no pauses between sentences.
- **Requirements:** a graphics chip with WebGPU (most laptops from the last few years). Without it, the reader switches to a built-in voice and says "AI voices unsupported here".
- **Language:** English only (US and UK accents).
- **Memory:** about 300 MB while in use. It's freed after 10 minutes without AI-voice reading.

## How it works

- `background.js` speaks through Chrome's `chrome.tts` engine and passes its progress events back to the page.
- `content.js` finds the article text (skipping menus, sidebars, fact boxes, and reference lists), groups it into sections at each heading for the page map, splits it into sentences, highlights them with the CSS Custom Highlight API, and draws the player bar, the Options panel and the play buttons. The page itself isn't modified, except for one attribute on the article while wider spacing is on.
- Reading can start or stop partway through a sentence (a clicked word, the end of a selection). That part is spoken as its own piece, and highlighted from the right place.
- Voices that report word positions (for example the Windows "Microsoft …" voices) get exact word highlighting. For voices that don't (for example "Google US English"), the highlight follows an estimate based on that voice's measured speaking speed. For AI voices, the estimate is timed against the exact length of each audio clip.
- `math-speech.js` turns equations (MathML) and math symbols into spoken English. It is injected just before `content.js`, which keeps two versions of the text: what's spoken, and where each part sits on the page, so an equation spoken as several words is highlighted as one unit.
- `wren-mark.js` draws the three logos and holds the five color palettes. The logo moves slowly while reading, on the player bar (in a circle) and in the toolbar icon (a rounded square). `background.js` sets the toolbar icon to the chosen logo. The PNG icons in `icons/` are Soundtail in Ember; after changing the drawing, run `node icons/build.mjs` to remake them with Chrome.
- `offscreen/` holds the AI voice engine: a hidden extension page (`offscreen.js`) that runs Kokoro on the GPU and plays the audio. It makes one clip at a time: what the reader is waiting to hear goes first, and read-ahead comes after. `kokoro.bundle.js` and `ort/` are generated files; don't edit them by hand.

### Rebuilding the AI voice bundle

The bundle is built in `C:\Users\mahmad10\voice-reader-build`. That folder is kept outside OneDrive so OneDrive doesn't sync `node_modules`. To update Kokoro:

```
cd C:\Users\mahmad10\voice-reader-build
npm update kokoro-js
node build.mjs
```

## Known limits (v0.6)

- **Can't run on:** Chrome's built-in PDF viewer, `chrome://` pages, or the Chrome Web Store. Google Docs draws its text in a way the extension can't read yet.
- **Speed limits:** Google voices top out around 2× speed. Windows voices go faster.
- **Pause:** resuming starts the current sentence again.
- **Math:** matrices and multi-line derivations are read row by row, and very long equations can be hard to follow by ear. Equation boxes don't follow equations inside separately scrolling areas.
- **AI voice after a jump:** if a sentence is already being generated, it finishes first (about 1–3 s).
- **Keyboard shortcuts:** only Alt+Shift+R and Alt+Shift+arrows. Alt+Shift+letter keys belong to many sites (on Wikipedia, Alt+Shift+O opens "Log in").

## Ideas for next versions

- Reading tables row by row, and image descriptions
- PDF support with PDF.js
- Google Docs support
- Skip-content switches (citations, brackets, URLs), like Speechify's
- True pause and resume, from the exact word
- Auto-hide (the player shrinks to its logo while reading) and a size setting for the player
