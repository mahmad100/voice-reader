# Third-party notices

Wren is licensed under the GNU General Public License v3.0 or later (see [LICENSE](LICENSE)). It includes the open-source software below. Each part keeps its own license; all of them can be used in a GPL-3.0 project.

All of it is in the AI voice engine in `offscreen/`. `kokoro.bundle.js` is built from the npm packages below with `build.mjs` (see README, *Rebuilding the AI voice bundle*), and `ort/` holds files copied unchanged from onnxruntime-web.

| Component | Version | License | Source |
| --- | --- | --- | --- |
| kokoro-js | 1.2.1 | Apache-2.0 | https://github.com/hexgrad/kokoro |
| Transformers.js (@huggingface/transformers) | 3.8.1 | Apache-2.0 | https://github.com/huggingface/transformers.js |
| phonemizer | 1.2.1 | Apache-2.0 | https://github.com/xenova/phonemizer |
| eSpeak NG (compiled into phonemizer) | | GPL-3.0-or-later | https://github.com/espeak-ng/espeak-ng |
| ONNX Runtime Web (onnxruntime-web) | 1.22.0-dev.20250409 | MIT | https://github.com/microsoft/onnxruntime |

Not included in this repository, but used: the **Kokoro-82M** speech model (Apache-2.0, https://huggingface.co/hexgrad/Kokoro-82M), which is downloaded from Hugging Face the first time an AI voice is used.

## kokoro-js

Copyright hexgrad. Licensed under the Apache License, Version 2.0 ([licenses/Apache-2.0.txt](licenses/Apache-2.0.txt)).

## Transformers.js

Copyright Hugging Face. Licensed under the Apache License, Version 2.0 ([licenses/Apache-2.0.txt](licenses/Apache-2.0.txt)).

## phonemizer

Copyright Xenova. Licensed under the Apache License, Version 2.0 ([licenses/Apache-2.0.txt](licenses/Apache-2.0.txt)).

## eSpeak NG

Copyright Jonathan Duddington, Reece H. Dunn, and the eSpeak NG contributors. Licensed under the GNU General Public License v3.0 or later ([LICENSE](LICENSE)). It is included in phonemizer as a WebAssembly build; its source code is at https://github.com/espeak-ng/espeak-ng.

## ONNX Runtime Web

```
MIT License

Copyright (c) Microsoft Corporation. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
