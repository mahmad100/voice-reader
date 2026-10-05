// Voice Reader content script: finds the readable text on the page, drives playback
// sentence by sentence, highlights the current sentence and word, and shows the player bar.
(() => {
  if (window.__voiceReaderLoaded) return;
  window.__voiceReaderLoaded = true;

  // ---------- Constants ----------

  const BLOCK_SEL = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,td,th,dd,dt,figcaption,caption';
  const SKIP_SEL = 'nav,aside,form,button,select,textarea,script,style,noscript,svg,math,template,' +
    '[role="navigation"],[role="complementary"],[role="search"],[role="dialog"],[aria-hidden="true"],[hidden],' +
    // Fact boxes, data tables, tables of contents and citation lists aren't worth hearing.
    'table:has(th),.infobox,.navbox,.sidebar,.metadata,.hatnote,.toc,#toc,.noprint,' +
    '.reflist,.references,.mw-references-wrap,.refbegin,' +
    '#voice-reader-host';
  // Reading stops at the first of these headings once the article has started.
  const END_HEADING = /^(references|notes|citations|sources|bibliography|footnotes|further reading|external links|see also|related (articles|posts|stories))$/i;
  const FOOTER_SEL = 'footer,[role="contentinfo"]';
  const HEADER_SEL = 'header,[role="banner"]';
  // Inside a block, text under these is never spoken (e.g. Wikipedia's "[1]" and "[edit]").
  const TEXT_SKIP_SEL = 'script,style,noscript,svg,math,template,button,select,textarea,' +
    '[aria-hidden="true"],sup.reference,.mw-editsection';

  const ABBREVIATION_END = /(?:^|[\s(])(?:[A-Z]|Dr|Mr|Mrs|Ms|Prof|St|Jr|Sr|vs|etc|e\.g|i\.e|No|Fig|pp?)\.\s*$/;
  const MAX_CHUNK = 220; // long sentences are split so each utterance stays short
  const RATE_MIN = 0.5;
  const RATE_MAX = 4;
  const RATE_STEP = 0.1;
  const DEFAULT_CPS = 15; // characters per second at 1x, used until a voice is measured

  const HAS_HIGHLIGHTS = typeof CSS !== 'undefined' && 'highlights' in CSS;

  // ---------- State ----------

  const settings = { rate: 1, voiceName: null };
  const state = {
    queue: [],        // [{ model, start, end, text }]
    idx: 0,
    playing: false,
    gen: 0,           // bumped on every speak/stop so stale engine events are ignored
    voices: null,
    voiceKey: 'default',
    startedAt: 0,
    sawWord: false,
    errors: 0,
    timers: [],
  };
  const wordSupport = new Map(); // voiceName -> whether the engine reports word positions
  const cpsAt1x = new Map();     // voiceName -> measured characters/second at 1x
  let ui = null;
  let sentenceHL = null;
  let wordHL = null;
  let segmenter = null;

  // ---------- Finding the readable text ----------

  function isVisible(el) {
    if (el.checkVisibility) return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    return el.getClientRects().length > 0;
  }

  function directTextLength(el) {
    let n = 0;
    for (const c of el.childNodes) if (c.nodeType === Node.TEXT_NODE) n += c.data.trim().length;
    return n;
  }

  function linkDensity(el, len) {
    if (!len) return 0;
    let linked = 0;
    for (const a of el.querySelectorAll('a')) linked += a.textContent.trim().length;
    return linked / len;
  }

  // Text-bearing elements under root, keeping only the innermost so nothing is read twice.
  function findCandidates(root) {
    const found = [];
    for (const el of root.querySelectorAll(BLOCK_SEL + ',div')) {
      if (el.tagName === 'DIV' && directTextLength(el) < 40) continue;
      if (el.closest(SKIP_SEL)) continue;
      if (!el.textContent.trim()) continue;
      found.push(el);
    }
    const hasInner = new Set();
    for (const el of found) {
      for (let p = el.parentElement; p && !hasInner.has(p); p = p.parentElement) hasInner.add(p);
    }
    return found.filter((el) => !hasInner.has(el) && isVisible(el));
  }

  // Score parents/grandparents by the non-link text they hold (Readability-style) to find the article.
  function findContentRoot() {
    const body = document.body;
    const scores = new Map();
    for (const el of findCandidates(body)) {
      const len = el.textContent.trim().length;
      if (len < 25) continue;
      const weight = len * (1 - Math.min(linkDensity(el, len), 1));
      let node = el.parentElement;
      for (let d = 0, f = 1; node && node !== body && d < 3; d++, f /= 2, node = node.parentElement) {
        scores.set(node, (scores.get(node) || 0) + weight * f);
      }
    }
    let best = null;
    let bestScore = 0;
    for (const [node, score] of scores) {
      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    }
    if (!best || bestScore < 250) return body;
    return best.closest('article, main, [role="main"]') || best;
  }

  function collectBlocks() {
    const root = findContentRoot();
    const isBody = root === document.body;
    const blocks = findCandidates(root).filter((el) => {
      const footer = el.closest(FOOTER_SEL);
      if (footer && root.contains(footer)) return false;
      if (isBody && el.closest(HEADER_SEL)) return false;
      const len = el.textContent.trim().length;
      if (!/^H\d$/.test(el.tagName) && len < 120 && linkDensity(el, len) > 0.6) return false;
      return true;
    });
    // Article titles often sit just outside the article body.
    if (!isBody) {
      const title = [...document.querySelectorAll('h1')].find((h) =>
        !root.contains(h) && !h.contains(root) &&
        (h.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        !h.closest(SKIP_SEL) && isVisible(h));
      if (title) blocks.unshift(title);
    }
    const end = blocks.findIndex((el, i) => i > 2 && /^H\d$/.test(el.tagName) && END_HEADING.test(el.textContent.trim()));
    return end > 0 ? blocks.slice(0, end) : blocks;
  }

  // ---------- Text model: block text plus a map back to DOM text nodes ----------

  const displayCache = new WeakMap();

  function layoutBlock(el, stop) {
    for (; el && el !== stop; el = el.parentElement) {
      let display = displayCache.get(el);
      if (display === undefined) {
        display = getComputedStyle(el).display;
        displayCache.set(el, display);
      }
      if (display !== 'contents' && !display.startsWith('inline')) return el;
    }
    return stop;
  }

  function buildModel(el) {
    const segs = [];
    let text = '';
    let lastBlock = null;
    let pendingBreak = false;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        if (n.tagName === 'BR') return NodeFilter.FILTER_ACCEPT;
        if (n.matches(TEXT_SKIP_SEL) || !isVisible(n)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType !== Node.TEXT_NODE) {
        pendingBreak = true;
        continue;
      }
      const data = n.data;
      if (!data) continue;
      const block = layoutBlock(n.parentElement, el);
      // Keep words in separate boxes (or across a <br>) from running together.
      if (text && (pendingBreak || block !== lastBlock) && !/\s$/.test(text) && !/^\s/.test(data)) text += ' ';
      segs.push({ node: n, start: text.length, end: text.length + data.length });
      text += data;
      lastBlock = block;
      pendingBreak = false;
    }
    return { el, text, segs };
  }

  function sentenceSegmenter() {
    if (!segmenter) {
      try {
        segmenter = new Intl.Segmenter(document.documentElement.lang || undefined, { granularity: 'sentence' });
      } catch {
        segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
      }
    }
    return segmenter;
  }

  function pushChunks(out, model, start, end) {
    const t = model.text;
    while (start < end && /\s/.test(t[start])) start++;
    while (end > start && /\s/.test(t[end - 1])) end--;
    if (start === end || !/[\p{L}\p{N}]/u.test(t.slice(start, end))) return;
    if (end - start > MAX_CHUNK) {
      const slice = t.slice(start, start + MAX_CHUNK);
      let cut = Math.max(slice.lastIndexOf(', '), slice.lastIndexOf('; '), slice.lastIndexOf(': '),
        slice.lastIndexOf(' – '), slice.lastIndexOf(' — '));
      if (cut < 80) cut = slice.lastIndexOf(' ');
      if (cut > 0) {
        const mid = start + cut + 1;
        pushChunks(out, model, start, mid);
        pushChunks(out, model, mid, end);
        return;
      }
    }
    // Whitespace becomes plain spaces; lengths stay equal so engine offsets map straight back.
    out.push({ model, start, end, text: t.slice(start, end).replace(/\s/g, ' ') });
  }

  function buildQueue(elements) {
    const queue = [];
    for (const el of elements) {
      const model = buildModel(el);
      if (!model.segs.length) continue;
      let from = 0;
      for (const { index, segment } of sentenceSegmenter().segment(model.text)) {
        const end = index + segment.length;
        // "W. Smith", "Dr. Lee", "e.g. this": the segmenter splits these, so keep going.
        if (ABBREVIATION_END.test(segment) && end < model.text.length) continue;
        pushChunks(queue, model, from, end);
        from = end;
      }
      pushChunks(queue, model, from, model.text.length);
    }
    return queue;
  }

  // Index of the sentence containing a DOM position, or -1 if it isn't in the queue.
  function findIndex(node, offset) {
    const q = state.queue;
    for (let i = 0; i < q.length; i++) {
      const model = q[i].model;
      if (!model.el.contains(node)) continue;
      const seg = model.segs.find((s) => s.node === node);
      const off = seg ? seg.start + offset : 0;
      for (let j = i; j < q.length && q[j].model === model; j++) {
        if (q[j].end > off) return j;
      }
      return i;
    }
    return -1;
  }

  // ---------- Highlighting (CSS Custom Highlight API: no changes to the page's DOM) ----------

  function posAt(model, off, atEnd) {
    const segs = model.segs;
    for (const s of segs) {
      if (atEnd ? off > s.start && off <= s.end : off >= s.start && off < s.end) return [s.node, off - s.start];
    }
    if (atEnd) {
      for (let i = segs.length - 1; i >= 0; i--) if (segs[i].end <= off) return [segs[i].node, segs[i].node.length];
    } else {
      for (const s of segs) if (s.start >= off) return [s.node, 0];
    }
    const last = segs[segs.length - 1];
    return [last.node, last.node.length];
  }

  function makeRange(model, start, end) {
    try {
      const r = document.createRange();
      r.setStart(...posAt(model, start, false));
      r.setEnd(...posAt(model, end, true));
      return r;
    } catch {
      return null; // the page changed underneath us
    }
  }

  function installHighlights() {
    if (!HAS_HIGHLIGHTS || sentenceHL) return;
    sentenceHL = new Highlight();
    wordHL = new Highlight();
    wordHL.priority = 1;
    CSS.highlights.set('voice-reader-sentence', sentenceHL);
    CSS.highlights.set('voice-reader-word', wordHL);
    const style = document.createElement('style');
    style.id = 'voice-reader-style';
    style.textContent =
      '::highlight(voice-reader-sentence){background-color:rgba(255,213,79,.35);}' +
      '::highlight(voice-reader-word){background-color:#ffd54f;color:#111;}';
    (document.head || document.documentElement).appendChild(style);
  }

  function removeHighlights() {
    if (!sentenceHL) return;
    CSS.highlights.delete('voice-reader-sentence');
    CSS.highlights.delete('voice-reader-word');
    document.getElementById('voice-reader-style')?.remove();
    sentenceHL = wordHL = null;
  }

  function highlightSentence(item) {
    if (!sentenceHL) return;
    sentenceHL.clear();
    wordHL.clear();
    const r = makeRange(item.model, item.start, item.end);
    if (!r) return;
    sentenceHL.add(r);
    scrollIntoViewIfNeeded(item.model.el, r);
  }

  function highlightWord(item, start, end) {
    if (!wordHL) return;
    wordHL.clear();
    const r = makeRange(item.model, item.start + start, item.start + end);
    if (r) wordHL.add(r);
  }

  function scrollIntoViewIfNeeded(el, range) {
    const rect = range.getBoundingClientRect();
    if (!rect.height) return;
    const barSpace = 110;
    if (rect.top >= 40 && rect.bottom <= innerHeight - barSpace) return;
    if (el.getBoundingClientRect().height < innerHeight * 0.6) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else {
      window.scrollBy({ top: rect.top - innerHeight * 0.3, behavior: 'smooth' });
    }
  }

  // ---------- Speech ----------

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(onExtensionError);
    } catch (err) {
      onExtensionError(err);
      return Promise.resolve();
    }
  }

  function onExtensionError(err) {
    // The extension was reloaded or removed while this page stayed open.
    if (/context invalidated/i.test(String(err?.message || err))) {
      state.gen++;
      clearTimers();
      teardown();
    }
  }

  function usableVoices() {
    return (state.voices || []).filter((v) => !(state.aiUnavailable && v.engine === 'ai'));
  }

  function currentVoice() {
    const voices = usableVoices();
    return voices.find((v) => v.voiceName === settings.voiceName) || pickDefaultVoice(voices);
  }

  function pageLang() {
    return (document.documentElement.lang || navigator.language || 'en').toLowerCase().slice(0, 2);
  }

  function pickDefaultVoice(voices) {
    const lang = pageLang();
    const same = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
    const pool = same.length ? same : voices;
    const score = (v) =>
      (v.engine === 'ai' ? 10 : 0) +
      (/natural|neural|online/i.test(v.voiceName) ? 4 : 0) +
      (/google/i.test(v.voiceName) ? 2 : 0) +
      (v.lang === navigator.language ? 1 : 0);
    return pool.slice().sort((a, b) => score(b) - score(a))[0] || null;
  }

  function clearTimers() {
    for (const t of state.timers) clearTimeout(t);
    state.timers = [];
    clearTimeout(state.watchdog);
    clearTimeout(state.wordTimer);
  }

  // If the engine goes quiet (e.g. the service worker restarted), move on instead of hanging.
  function armWatchdog(id, ms) {
    clearTimeout(state.watchdog);
    state.watchdog = setTimeout(() => { if (id === state.gen) advance(); }, ms);
  }

  function speakCurrent() {
    clearTimers();
    const item = state.queue[state.idx];
    if (!item) return finish();
    const id = ++state.gen;
    state.playing = true;
    state.startedAt = 0;
    state.sawWord = false;
    highlightSentence(item);

    const voice = currentVoice();
    state.voiceKey = voice?.voiceName || 'default';
    if (voice?.eventTypes && !voice.eventTypes.includes('word') && !wordSupport.has(state.voiceKey)) {
      wordSupport.set(state.voiceKey, false);
    }
    const isAI = voice?.engine === 'ai';
    // AI voices prepare the next few sentences while this one plays.
    const upcoming = isAI ? state.queue.slice(state.idx + 1, state.idx + 4).map((q) => q.text) : undefined;
    send({ type: 'speak', id, text: item.text, rate: settings.rate, voiceName: voice?.voiceName, lang: voice?.lang, upcoming });

    armWatchdog(id, isAI ? 60000 : (item.text.length / (5 * settings.rate) + 10) * 1000);
    updateUI();
  }

  function onTtsEvent(id, ev) {
    if (id !== state.gen) return;
    const item = state.queue[state.idx];
    if (!item) return;
    switch (ev.type) {
      case 'progress':
        // AI voice downloading or warming up.
        setStatus(ev.message);
        armWatchdog(id, 60000);
        break;
      case 'start':
        state.startedAt = performance.now();
        state.errors = 0;
        updateUI();
        if (ev.duration) {
          // AI voice: the exact clip length is known, so pace the word highlight to it.
          armWatchdog(id, ev.duration * 1000 + 8000);
          startWordEstimator(item, id, ev.duration);
        } else if (wordSupport.get(state.voiceKey) === false) {
          startWordEstimator(item, id);
        } else if (!wordSupport.has(state.voiceKey)) {
          state.timers.push(setTimeout(() => {
            if (id === state.gen && !state.sawWord) startWordEstimator(item, id);
          }, 700));
        }
        break;
      case 'word': {
        if (!state.sawWord) {
          state.sawWord = true;
          wordSupport.set(state.voiceKey, true);
        }
        const start = ev.charIndex || 0;
        let len = ev.length;
        if (!len) len = (/^\S+/.exec(item.text.slice(start)) || [''])[0].length;
        highlightWord(item, start, start + len);
        break;
      }
      case 'end':
        calibrate(item);
        if (!state.sawWord && !wordSupport.has(state.voiceKey)) wordSupport.set(state.voiceKey, false);
        advance();
        break;
      case 'interrupted':
      case 'cancelled':
        // Speech was taken over from elsewhere (e.g. reading started in another tab).
        pausePlayback(false);
        break;
      case 'error':
        console.warn('[Voice Reader] speech error:', ev.errorMessage);
        if (/webgpu/i.test(ev.errorMessage || '')) {
          // No GPU support for AI voices here: fall back to a built-in voice.
          state.aiUnavailable = true;
          populateVoices();
          speakCurrent();
          setStatus('AI voices unsupported here');
          return;
        }
        if (++state.errors >= 3) {
          pausePlayback(false);
          setStatus('Voice error, try another voice');
        } else {
          advance();
        }
        break;
    }
  }

  // For voices that don't report word positions, move the word highlight along by time.
  // With a known clip duration (AI voices) time is shared out by word length plus pauses at
  // punctuation; otherwise the voice's measured characters-per-second is used.
  function startWordEstimator(item, id, duration) {
    const words = [];
    const re = /\S+/g;
    for (let m; (m = re.exec(item.text));) words.push([m.index, m.index + m[0].length]);
    if (!words.length) return;
    let wordEnds; // position of each word's end, in the same units as `pos` below
    let toPos;    // elapsed seconds -> position
    if (duration) {
      let total = 0;
      wordEnds = words.map(([s, e]) => {
        const last = item.text[e - 1];
        total += e - s + 1 + (/[.!?]/.test(last) ? 5 : /[,;:]/.test(last) ? 3 : 0);
        return total;
      });
      toPos = (secs) => (secs / duration) * total;
    } else {
      const cps = (cpsAt1x.get(state.voiceKey) || DEFAULT_CPS) * settings.rate;
      wordEnds = words.map(([, e]) => e);
      toPos = (secs) => secs * cps;
    }
    let shown = -1;
    const tick = () => {
      if (id !== state.gen || state.sawWord) return;
      const pos = toPos((performance.now() - state.startedAt) / 1000);
      let w = wordEnds.findIndex((end) => end > pos);
      if (w < 0) w = words.length - 1;
      if (w !== shown) {
        shown = w;
        highlightWord(item, words[w][0], words[w][1]);
      }
      state.wordTimer = setTimeout(tick, 50);
    };
    clearTimeout(state.wordTimer);
    tick();
  }

  function calibrate(item) {
    if (!state.startedAt || item.text.length < 25 || currentVoice()?.engine === 'ai') return;
    const secs = (performance.now() - state.startedAt) / 1000;
    if (secs < 0.8) return;
    const cps = item.text.length / secs / settings.rate;
    const prev = cpsAt1x.get(state.voiceKey);
    cpsAt1x.set(state.voiceKey, prev ? prev * 0.7 + cps * 0.3 : cps);
  }

  function advance() {
    clearTimers();
    state.idx++;
    if (state.idx < state.queue.length) speakCurrent();
    else finish();
  }

  function play() {
    if (!state.queue.length) return;
    if (state.idx >= state.queue.length) state.idx = 0;
    speakCurrent();
  }

  function pausePlayback(stopEngine = true) {
    state.gen++;
    clearTimers();
    state.playing = false;
    if (stopEngine) send({ type: 'stop' });
    wordHL?.clear();
    updateUI();
  }

  function finish() {
    state.gen++;
    clearTimers();
    state.playing = false;
    state.idx = state.queue.length;
    sentenceHL?.clear();
    wordHL?.clear();
    updateUI();
    setStatus('Finished');
  }

  function jump(delta) {
    if (!state.queue.length) return;
    state.idx = Math.max(0, Math.min(state.queue.length - 1, state.idx + delta));
    if (state.playing) {
      speakCurrent();
    } else {
      highlightSentence(state.queue[state.idx]);
      updateUI();
    }
  }

  function setRate(rate) {
    settings.rate = Math.round(Math.max(RATE_MIN, Math.min(RATE_MAX, rate)) * 10) / 10;
    chrome.storage.sync.set({ rate: settings.rate }).catch(() => {});
    if (state.playing) speakCurrent(); // restart the sentence at the new speed
    updateUI();
  }

  function setVoice(voiceName) {
    settings.voiceName = voiceName;
    chrome.storage.sync.set({ voiceName }).catch(() => {});
    if (state.playing) speakCurrent();
  }

  // ---------- Starting points ----------

  function startAt(node, offset) {
    let idx = findIndex(node, offset);
    if (idx < 0) {
      // Not part of the detected article (e.g. a sidebar): read just that block.
      const el = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest(BLOCK_SEL + ',div');
      if (!el) return;
      state.queue = buildQueue([el]);
      idx = Math.max(0, findIndex(node, offset));
    }
    if (!state.queue.length) return;
    state.idx = idx;
    speakCurrent();
  }

  async function startReading({ fromSelection }) {
    await ensureReady();
    let node = null;
    let offset = 0;
    const sel = getSelection();
    if (fromSelection && sel && sel.rangeCount && !sel.isCollapsed) {
      const r = sel.getRangeAt(0);
      node = r.startContainer;
      offset = r.startOffset;
      sel.removeAllRanges();
    }
    state.queue = buildQueue(collectBlocks());
    if (node) return startAt(node, offset);
    if (!state.queue.length) {
      updateUI();
      setStatus('No readable text found');
      return;
    }
    state.idx = 0;
    speakCurrent();
  }

  function hasSelection() {
    const sel = getSelection();
    return !!(sel && sel.rangeCount && !sel.isCollapsed && sel.toString().trim());
  }

  // ---------- Player bar ----------

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    play: 'M8 5v14l11-7z',
    pause: 'M6 5h4v14H6zm8 0h4v14h-4z',
    prev: 'M6 6h2v12H6zm3.5 6 8.5 6V6z',
    next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  };

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }

  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    Object.assign(el, props);
    el.append(...children);
    return el;
  }

  function button(cls, title, iconName, onClick) {
    const b = h('button', { className: cls, title, type: 'button' }, icon(iconName));
    b.setAttribute('aria-label', title);
    b.addEventListener('click', onClick);
    return b;
  }

  const BAR_CSS = `
    :host { all: initial; }
    .bar { display: flex; align-items: center; gap: 4px; padding: 6px 10px; background: #1f2330; color: #f2f4f8;
      border-radius: 999px; box-shadow: 0 8px 28px rgba(0,0,0,.35); font: 13px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
      user-select: none; }
    button { all: unset; cursor: pointer; display: grid; place-items: center; width: 32px; height: 32px;
      border-radius: 50%; color: inherit; font-weight: 700; font-size: 16px; }
    button:hover { background: rgba(255,255,255,.12); }
    button:focus-visible { outline: 2px solid #8ab4ff; outline-offset: 1px; }
    button.play { width: 40px; height: 40px; background: #4f8cff; color: #fff; }
    button.play:hover { background: #3f7cf0; }
    button.small { width: 26px; height: 26px; }
    svg { width: 20px; height: 20px; fill: currentColor; }
    .rate { min-width: 40px; text-align: center; font-variant-numeric: tabular-nums; font-weight: 600; }
    select { font: inherit; background: #2b3142; color: inherit; border: 1px solid #3a4258; border-radius: 8px;
      padding: 5px 6px; max-width: 190px; cursor: pointer; }
    option, optgroup { background: #2b3142; color: #f2f4f8; }
    .status { min-width: 64px; opacity: .75; font-variant-numeric: tabular-nums; padding: 0 6px; white-space: nowrap; text-align: center; }
    .sep { width: 1px; height: 22px; background: rgba(255,255,255,.15); margin: 0 4px; }
  `;

  function buildUI() {
    const host = h('div', { id: 'voice-reader-host' });
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;left:50%;bottom:20px;transform:translateX(-50%);';
    const shadow = host.attachShadow({ mode: 'open' });

    const playBtn = button('play', 'Play / pause (Alt+Shift+R)', 'play', () => (state.playing ? pausePlayback() : play()));
    const rateLabel = h('span', { className: 'rate', title: 'Reading speed' });
    const status = h('span', { className: 'status' });
    const voiceSelect = h('select', { title: 'Voice' });
    voiceSelect.addEventListener('change', () => setVoice(voiceSelect.value));

    const slower = h('button', { className: 'small', title: 'Slower (Alt+Shift+Down)', type: 'button' }, '−');
    slower.addEventListener('click', () => setRate(settings.rate - RATE_STEP));
    const faster = h('button', { className: 'small', title: 'Faster (Alt+Shift+Up)', type: 'button' }, '+');
    faster.addEventListener('click', () => setRate(settings.rate + RATE_STEP));

    const bar = h('div', { className: 'bar' },
      button('', 'Previous sentence (Alt+Shift+Left)', 'prev', () => jump(-1)),
      playBtn,
      button('', 'Next sentence (Alt+Shift+Right)', 'next', () => jump(1)),
      h('span', { className: 'sep' }),
      slower, rateLabel, faster,
      h('span', { className: 'sep' }),
      voiceSelect,
      status,
      button('', 'Close (Alt+Shift+X)', 'close', teardown),
    );
    shadow.append(h('style', { textContent: BAR_CSS }), bar);
    document.documentElement.appendChild(host);

    ui = { host, playBtn, rateLabel, status, voiceSelect, statusText: '' };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('click', onAltClick, true);
    installHighlights();
  }

  function populateVoices() {
    if (!ui) return;
    const sel = ui.voiceSelect;
    sel.replaceChildren();
    const lang = pageLang();
    const all = usableVoices();
    const ai = all.filter((v) => v.engine === 'ai');
    const voices = all.filter((v) => v.engine !== 'ai').sort((a, b) => a.voiceName.localeCompare(b.voiceName));
    const mine = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
    const other = voices.filter((v) => !mine.includes(v));
    const addGroup = (label, list, strip = '') => {
      if (!list.length) return;
      const group = h('optgroup', { label });
      for (const v of list) group.append(h('option', { value: v.voiceName, textContent: v.voiceName.replace(strip, '') }));
      sel.append(group);
    };
    addGroup('Natural AI voices (English)', ai, 'AI: ');
    addGroup('Built-in voices: page language', mine);
    addGroup('Built-in voices: other languages', other);
    const current = currentVoice();
    if (current) sel.value = current.voiceName;
  }

  function setStatus(text) {
    if (!ui) return;
    ui.statusText = text;
    ui.status.textContent = text;
  }

  function updateUI() {
    if (!ui) return;
    ui.playBtn.replaceChildren(icon(state.playing ? 'pause' : 'play'));
    ui.rateLabel.textContent = settings.rate.toFixed(1) + '×';
    const total = state.queue.length;
    if (total && state.idx < total) setStatus(`${state.idx + 1} / ${total}`);
  }

  async function ensureReady() {
    if (!ui) buildUI();
    if (!state.voices) {
      try {
        Object.assign(settings, await chrome.storage.sync.get({ rate: 1, voiceName: null }));
      } catch {
        // Fall back to defaults.
      }
      const voices = await send({ type: 'getVoices' });
      state.voices = Array.isArray(voices) ? voices : [];
      populateVoices();
    }
    updateUI();
  }

  function teardown() {
    if (state.playing) send({ type: 'stop' });
    state.gen++;
    clearTimers();
    state.playing = false;
    state.queue = [];
    state.idx = 0;
    removeHighlights();
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('click', onAltClick, true);
    ui?.host.remove();
    ui = null;
  }

  // ---------- Input ----------

  function onKeyDown(e) {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    const actions = {
      ArrowRight: () => jump(1),
      ArrowLeft: () => jump(-1),
      ArrowUp: () => setRate(settings.rate + RATE_STEP),
      ArrowDown: () => setRate(settings.rate - RATE_STEP),
      KeyX: teardown,
    };
    const action = actions[e.code];
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    action();
  }

  // Alt+click anywhere on the page to start reading from that spot.
  function onAltClick(e) {
    if (!e.altKey || e.shiftKey || e.ctrlKey || e.metaKey || !ui) return;
    if (e.composedPath().includes(ui.host)) return;
    const pos = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (!pos) return;
    e.preventDefault(); // also stops Chrome's Alt+click "download link"
    e.stopPropagation();
    if (!state.queue.length || findIndex(pos.startContainer, pos.startOffset) < 0) {
      state.queue = buildQueue(collectBlocks());
    }
    startAt(pos.startContainer, pos.startOffset);
  }

  window.addEventListener('pagehide', () => {
    if (state.playing) send({ type: 'stop' });
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    sendResponse({ ok: true });
    switch (msg.type) {
      case 'toggle':
        if (!ui || hasSelection()) startReading({ fromSelection: true });
        else if (state.playing) pausePlayback();
        else play();
        break;
      case 'readPage':
        startReading({ fromSelection: false });
        break;
      case 'readSelection':
        startReading({ fromSelection: true });
        break;
      case 'ttsEvent':
        onTtsEvent(msg.id, msg.ev);
        break;
      case 'externalStop':
        // Reading started in another tab.
        if (state.playing) pausePlayback(false);
        break;
    }
  });
})();
