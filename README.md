# Voice Reader

A Chrome extension that reads web pages aloud and highlights each sentence and word as it is spoken. It can use built-in voices or natural AI voices that run on your own computer.

Current status and next steps are in [PROGRESS.md](PROGRESS.md).

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this `voice-reader` folder.
4. Pin the extension (puzzle-piece icon → pin) so the speaker icon is always visible.

After changing any file, click the reload arrow on the extension's card in `chrome://extensions`, then refresh the page you're reading.

## Use

| Action | How |
| --- | --- |
| Read the page | Click the toolbar icon, or press **Alt+Shift+R** |
| Pause / resume | Same again, or the big button on the player bar |
| Read from a spot | Select some text first, or **Alt+click** any paragraph |
| Read from a selection | Right-click selected text → *Read aloud from here* |
| Page map | **Alt+Shift+M**, or the list button on the bar |
| Previous / next sentence | **Alt+Shift+←** / **Alt+Shift+→** |
| Slower / faster | **Alt+Shift+↓** / **Alt+Shift+↑**, or **−** / **+** on the bar |
| Close the player | **Alt+Shift+X**, or **×** on the bar |

Your speed, voice, and whether the page map is open are remembered. To change the start/pause shortcut, go to `chrome://extensions/shortcuts`.

## Page map

The page map lists the article's sections, one per heading, nested by level, with the number of sentences in each. The section being read is marked in yellow.

- **Tick or untick** a section to include or skip it. Unticking the section being read moves on to the next ticked one.
- **Click a title** to jump there and start reading. This also ticks it if it was unticked.
- Sections from "References", "See also", "External links" and similar onwards start unticked, so by default reading stops where the article ends.
- Alt+clicking text in an unticked section ticks it and reads from there.

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
- `content.js` finds the article text (skipping menus, sidebars, fact boxes, and reference lists), groups it into sections at each heading for the page map, splits it into sentences, highlights them with the CSS Custom Highlight API (the page itself isn't modified), and draws the player bar.
- Voices that report word positions (for example the Windows "Microsoft …" voices) get exact word highlighting. For voices that don't (for example "Google US English"), the highlight follows an estimate based on that voice's measured speaking speed. For AI voices, the estimate is timed against the exact length of each audio clip.
- `offscreen/` holds the AI voice engine: a hidden extension page (`offscreen.js`) that runs Kokoro on the GPU and plays the audio. `kokoro.bundle.js` and `ort/` are generated files; don't edit them by hand.

### Rebuilding the AI voice bundle

The bundle is built in `C:\Users\mahmad10\voice-reader-build`. That folder is kept outside OneDrive so OneDrive doesn't sync `node_modules`. To update Kokoro:

```
cd C:\Users\mahmad10\voice-reader-build
npm update kokoro-js
node build.mjs
```

## Known limits (v0.3)

- **Can't run on:** Chrome's built-in PDF viewer, `chrome://` pages, or the Chrome Web Store. Google Docs draws its text in a way the extension can't read yet.
- **Speed limits:** Google voices top out around 2× speed. Windows voices go faster.
- **Pause:** resuming starts the current sentence again.
- **Math:** equations are skipped, and Greek letters and symbols are left to the voice to pronounce.

## Ideas for next versions

- Reading math aloud (equations, Greek letters, symbols)
- Reading tables row by row, and image descriptions
- PDF support with PDF.js
- Google Docs support
- Turning auto-scroll on/off, and changing highlight colors
