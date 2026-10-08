// Wren content script: finds the readable text on the page, drives playback
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
  // Equations, spoken as words by math-speech.js (Wikipedia, MathJax, KaTeX, plain MathML).
  const MATH_SEL = '.mwe-math-element,mjx-container,.katex,.MathJax,math';
  const MATH = typeof VoiceReaderMath !== 'undefined' ? VoiceReaderMath : null;

  const ABBREVIATION_END = /(?:^|[\s(])(?:[A-Z]|Dr|Mr|Mrs|Ms|Prof|St|Jr|Sr|vs|etc|e\.g|i\.e|No|Fig|pp?)\.\s*$/;
  const MAX_CHUNK = 220; // long sentences are split so each utterance stays short
  const RATE_MIN = 0.5;
  const RATE_MAX = 4;
  const RATE_STEP = 0.1;
  const DEFAULT_CPS = 15; // characters per second at 1x, used until a voice is measured

  const HAS_HIGHLIGHTS = typeof CSS !== 'undefined' && 'highlights' in CSS;

  // ---------- State ----------

  // Remembered between pages (chrome.storage.sync). Changed in the Options panel.
  const DEFAULT_SETTINGS = {
    rate: 1, voiceName: null,
    clickToRead: true,        // click any text to read from that word
    selectionButton: true,    // a play button next to selected text, which reads just that text
    paragraphButtons: false,  // a play button beside the paragraph under the pointer
    follow: true,             // scroll along with the reading
    lineFocus: false,         // dim everything except the sentence being read
    wideSpacing: false,       // wider letter, word and line spacing in the article
    hlColor: 'yellow',
    hlStyle: 'both',          // 'both', 'sentence' or 'word'
    logo: 'soundtail',        // the logo on the bar and toolbar (see wren-mark.js)
    color: 'ember',           // its color, which is also the player's accent color
    autoShrink: false,        // shrink to the logo and play button until pointed at
    lockDock: false,          // the bar can't be dragged (it can still be sent to an edge from Appearance)
    glassClarity: 70,         // 0 = clear glass, 100 = frosted
    glassTint: false,         // shade the bar's glass with the chosen color
    barShape: 'pill',         // 'pill' or 'rounded'
    dock: { edge: 'bottom', x: 0.5, y: 0.5 }, // where the bar sits: an edge, or 'free' (x, y are fractions of the window)
  };
  const settings = { ...DEFAULT_SETTINGS };
  const HL_COLORS = {
    yellow: { name: 'Yellow', word: '#ffd54f', sentence: 'rgba(255,213,79,.35)' },
    green: { name: 'Green', word: '#a8e6a1', sentence: 'rgba(129,212,120,.32)' },
    blue: { name: 'Blue', word: '#a7d4ff', sentence: 'rgba(120,180,255,.32)' },
    pink: { name: 'Pink', word: '#ffb8d9', sentence: 'rgba(255,150,200,.32)' },
  };
  const state = {
    sections: [],     // [{ title, level, blocks, enabled, items }] for the page map
    queue: [],        // [{ model, start, end, text, sec }] from the ticked sections
    current: null,    // what's being spoken: a queue item, or the part of one from a word on
    limit: null,      // { item, end }: reading only a selection stops here
    detached: false,  // the reader scrolled away by hand, so stop following until "Back to reading"
    sentenceRange: null,
    idx: 0,
    playing: false,
    paused: null,     // { id, at, held }: paused mid-sentence. held: the voice is holding its place
    resuming: null,   // the sentence id while waiting for the voice to confirm it resumed
    wordAt: null,     // where the word being read starts (model offset), to resume from
    clipDuration: 0,  // AI voices: the clip's length in seconds
    gen: 0,           // bumped on every speak/stop so stale engine events are ignored
    voices: null,
    voiceKey: 'default',
    startedAt: 0,
    sawWord: false,
    readAhead: [],    // AI voices: the sentences being prepared ahead of the one playing
    errors: 0,
    timers: [],
  };
  const wordSupport = new Map(); // voiceName -> whether the engine reports word positions
  const cpsAt1x = new Map();     // voiceName -> measured characters/second at 1x
  let ui = null;
  let sentenceHL = null;
  let wordHL = null;
  let hoverHL = null;    // click to read: underlines where a click would start reading
  let contentRoot = null; // the article element, for wider spacing
  const marked = { sentence: [], word: [] }; // equations to draw boxes over (see drawMarks)
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

  // All readable blocks in page order, plus the index of the heading where the article proper
  // ends ("References", "External links", ...), or -1 if there isn't one.
  function collectBlocks() {
    const root = findContentRoot();
    contentRoot = root;
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
    return { blocks, end };
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

  // A block's spoken text, with segments mapping each stretch of it back to the page:
  //   { node, start, end, nodeStart }               text spoken as written
  //   { node, start, end, nodeStart, nodeEnd, atom } a symbol spoken as words (α -> "alpha")
  //   { el, start, end, atom }                       an equation spoken as words
  // Atoms are highlighted as a whole while any of their words is spoken.
  function buildModel(el) {
    const segs = [];
    let text = '';
    let lastBlock = null;
    let pendingBreak = false;
    let inEquation = null;
    const nameSymbols = MATH && !/^el\b/i.test(document.documentElement.lang || '');
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        if (n.tagName === 'BR') return NodeFilter.FILTER_ACCEPT;
        if (MATH && n.matches(MATH_SEL)) return isVisible(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        if (n.matches(TEXT_SKIP_SEL) || !isVisible(n)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      },
    });
    const space = (data) => {
      if (text && !/\s$/.test(text) && !/^\s/.test(data)) text += ' ';
    };
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (inEquation?.contains(n)) continue;
      if (n.nodeType !== Node.TEXT_NODE && n.tagName !== 'BR') {
        // An equation: speak it as words.
        inEquation = n;
        const spoken = MATH.equationToSpeech(n);
        if (!spoken) continue;
        space(spoken);
        segs.push({ el: n, start: text.length, end: text.length + spoken.length, atom: true });
        text += spoken;
        lastBlock = null;
        pendingBreak = true;
        continue;
      }
      if (n.nodeType !== Node.TEXT_NODE) {
        pendingBreak = true;
        continue;
      }
      const data = n.data;
      if (!data) continue;
      const block = layoutBlock(n.parentElement, el);
      // Keep words in separate boxes (or across a <br>) from running together.
      if (pendingBreak || block !== lastBlock) space(data);
      let from = 0;
      for (const sym of nameSymbols ? MATH.textSymbols(data) : []) {
        if (sym.index > from) {
          segs.push({ node: n, start: text.length, end: text.length + sym.index - from, nodeStart: from });
          text += data.slice(from, sym.index);
        }
        segs.push({ node: n, start: text.length, end: text.length + sym.spoken.length,
          nodeStart: sym.index, nodeEnd: sym.index + sym.length, atom: true });
        text += sym.spoken;
        from = sym.index + sym.length;
      }
      if (from < data.length) {
        segs.push({ node: n, start: text.length, end: text.length + data.length - from, nodeStart: from });
        text += data.slice(from);
      }
      lastBlock = block;
      pendingBreak = false;
    }
    return { el, text, segs };
  }

  // Where a DOM position falls in a model's spoken text.
  function modelOffset(model, node, offset, atEnd = false) {
    for (const s of model.segs) {
      if (s.el) {
        if (s.el.contains(node)) return atEnd ? s.end : s.start;
        continue;
      }
      if (s.node !== node) continue;
      if (s.atom ? offset < s.nodeEnd : offset < s.nodeStart + (s.end - s.start)) {
        return s.atom ? (atEnd ? s.end : s.start) : s.start + Math.max(0, offset - s.nodeStart);
      }
    }
    const last = [...model.segs].reverse().find((s) => s.node === node);
    if (last) return last.end;
    // Text that isn't spoken (a citation like "[1]", say): the nearest spoken text before it for
    // an end, or after it for a start. A selection often ends on one, at the end of a paragraph.
    const precedes = (s) => (s.el || s.node).compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING;
    if (atEnd) return [...model.segs].reverse().find(precedes)?.end ?? 0;
    return model.segs.find((s) => !precedes(s))?.start ?? model.text.length;
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
    return findIn(state.queue, node, offset);
  }

  function findIn(q, node, offset) {
    for (let i = 0; i < q.length; i++) {
      const model = q[i].model;
      if (!model.el.contains(node)) continue;
      const off = modelOffset(model, node, offset);
      let j = i;
      for (; j < q.length && q[j].model === model; j++) {
        if (q[j].end > off) return j;
      }
      return j - 1; // past the last sentence of this block: that sentence
    }
    return -1;
  }

  // ---------- Page map: the article split into sections at its headings ----------

  function makeSection(title, level, blocks, enabled) {
    return { title, level, blocks, enabled, items: null };
  }

  function buildSections() {
    const { blocks, end } = collectBlocks();
    const sections = [];
    let sec = null;
    blocks.forEach((el, i) => {
      const heading = /^H(\d)$/.exec(el.tagName);
      if (heading || !sec) {
        const title = heading ? buildModel(el).text.replace(/\s+/g, ' ').trim() : '';
        // Everything from "References" on starts unticked, as reading used to stop there.
        sec = makeSection(title || (heading ? 'Untitled section' : 'Introduction'),
          heading ? +heading[1] : 1, [], end < 0 || i < end);
        sections.push(sec);
      }
      sec.blocks.push(el);
    });
    return sections;
  }

  // A section's sentences, split on first use and then kept, so the same objects stay in the
  // queue when sections are ticked or unticked.
  function sectionItems(sec) {
    if (!sec.items) {
      sec.items = buildQueue(sec.blocks);
      for (const item of sec.items) item.sec = sec;
    }
    return sec.items;
  }

  function loadSections() {
    state.limit = null;
    state.sections = buildSections();
    state.queue = [];
    state.idx = 0;
    rebuildQueue();
    renderMap();
    if (settings.wideSpacing) applyDisplaySettings(); // the article has just been found
  }

  // Rebuild the queue from the ticked sections, staying on the current sentence if it's still
  // in. Returns true if the current sentence was dropped and reading moved on.
  function rebuildQueue() {
    const current = state.queue[state.idx];
    state.queue = state.sections.filter((s) => s.enabled).flatMap(sectionItems);
    if (!current) {
      state.idx = Math.min(state.idx, state.queue.length);
      return false;
    }
    const i = state.queue.indexOf(current);
    if (i >= 0) {
      state.idx = i;
      return false;
    }
    // Carry on from the next ticked sentence after it.
    const all = state.sections.flatMap(sectionItems);
    const next = all.slice(all.indexOf(current) + 1).find((it) => it.sec.enabled);
    state.idx = next ? state.queue.indexOf(next) : state.queue.length;
    return true;
  }

  function setSectionEnabled(sec, enabled) {
    sec.enabled = enabled;
    if (rebuildQueue()) {
      if (state.playing) speakCurrent();
      else if (state.queue[state.idx]) highlightSentence(state.queue[state.idx]);
      else clearHighlights();
    }
    renderMap();
    updateUI();
  }

  function jumpToSection(sec) {
    const first = sectionItems(sec)[0];
    if (!first) return;
    state.limit = null;
    state.detached = false;
    sec.enabled = true;
    rebuildQueue();
    state.idx = state.queue.indexOf(first);
    renderMap();
    speakCurrent(first.start);
  }

  // Text outside the detected article (a caption, a fact box, a sidebar): add it to the map as
  // its own section, in page order, so reading it doesn't throw the map away. Reading carries
  // on into the article after it. Only one is kept at a time.
  function addTempSection(blocks, title) {
    if (!blocks.length) return null;
    const sections = state.sections.filter((x) => !x.temp);
    const sec = makeSection(title, Math.min(2, ...sections.map((x) => x.level)), blocks, true);
    sec.temp = true;
    let at = sections.findIndex((x) => x.blocks[0] && (blocks[0].compareDocumentPosition(x.blocks[0]) & Node.DOCUMENT_POSITION_FOLLOWING));
    if (at < 0) at = sections.length;
    sections.splice(at, 0, sec);
    state.sections = sections;
    rebuildQueue();
    renderMap();
    return sec;
  }

  // The nearest block (paragraph, cell, caption...) around a text node, if it's a sensible size.
  function blockAround(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const block = el && layoutBlock(el, document.body);
    if (!block || block === document.body || block === document.documentElement) return null;
    return block;
  }

  // A sentence and the offset in it for a DOM position, searching every section.
  function locate(node, offset, atEnd = false) {
    const all = state.sections.flatMap(sectionItems);
    const i = findIn(all, node, offset);
    if (i < 0) return null;
    const item = all[i];
    const off = modelOffset(item.model, node, offset, atEnd);
    return { item, off: Math.max(item.start, Math.min(item.end, off)) };
  }

  // ---------- Highlighting (CSS Custom Highlight API: no changes to the page's DOM) ----------

  // DOM position for an offset inside a segment. Atoms only have a start and an end.
  function boundary(s, off, atEnd) {
    if (s.el) {
      const parent = s.el.parentNode;
      const i = Array.prototype.indexOf.call(parent.childNodes, s.el);
      return [parent, atEnd ? i + 1 : i];
    }
    if (s.atom) return [s.node, atEnd ? s.nodeEnd : s.nodeStart];
    return [s.node, s.nodeStart + off - s.start];
  }

  function posAt(model, off, atEnd) {
    const segs = model.segs;
    for (const s of segs) {
      if (atEnd ? off > s.start && off <= s.end : off >= s.start && off < s.end) return boundary(s, off, atEnd);
    }
    if (atEnd) {
      for (let i = segs.length - 1; i >= 0; i--) if (segs[i].end <= off) return boundary(segs[i], segs[i].end, true);
    } else {
      for (const s of segs) if (s.start >= off) return boundary(s, s.start, false);
    }
    const last = segs[segs.length - 1];
    return boundary(last, last.end, true);
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
    hoverHL = new Highlight();
    hoverHL.priority = 2;
    CSS.highlights.set('voice-reader-sentence', sentenceHL);
    CSS.highlights.set('voice-reader-word', wordHL);
    CSS.highlights.set('voice-reader-hover', hoverHL);
    const style = document.createElement('style');
    style.id = 'voice-reader-style';
    (document.head || document.documentElement).appendChild(style);
    applyDisplaySettings();
    window.addEventListener('resize', onResize);
  }

  function removeHighlights() {
    clearHighlights();
    window.removeEventListener('resize', onResize);
    document.querySelector('[data-voice-reader-root]')?.removeAttribute('data-voice-reader-root');
    document.getElementById('voice-reader-focus')?.remove();
    if (!sentenceHL) return;
    CSS.highlights.delete('voice-reader-sentence');
    CSS.highlights.delete('voice-reader-word');
    CSS.highlights.delete('voice-reader-hover');
    document.getElementById('voice-reader-style')?.remove();
    sentenceHL = wordHL = hoverHL = null;
  }

  // Wider spacing uses WCAG's text spacing values (1.4.12); extra letter spacing is the change
  // with the best evidence of helping dyslexic readers (Zorzi et al., PNAS 2012).
  const SPACING_CSS =
    '[data-voice-reader-root] :is(p,li,dd,dt,blockquote,td,th,figcaption,caption){letter-spacing:.12em!important;' +
    'word-spacing:.16em!important;line-height:1.8!important;}' +
    '[data-voice-reader-root] :is(h1,h2,h3,h4,h5,h6){letter-spacing:.06em!important;}';

  // Highlight colors and style, wider spacing and line focus, from the settings.
  function applyDisplaySettings() {
    const style = document.getElementById('voice-reader-style');
    if (style) {
      const c = HL_COLORS[settings.hlColor] || HL_COLORS.yellow;
      style.textContent =
        (settings.hlStyle !== 'word' ? `::highlight(voice-reader-sentence){background-color:${c.sentence};}` : '') +
        (settings.hlStyle !== 'sentence' ? `::highlight(voice-reader-word){background-color:${c.word};color:#111;}` : '') +
        `::highlight(voice-reader-hover){text-decoration:underline 2px dotted ${lookPalette().accent[0]};text-underline-offset:4px;}` +
        (settings.wideSpacing ? SPACING_CSS : '');
    }
    const spaced = document.querySelector('[data-voice-reader-root]');
    const root = settings.wideSpacing && ui ? contentRoot : null;
    if (spaced !== root) {
      spaced?.removeAttribute('data-voice-reader-root');
      root?.setAttribute('data-voice-reader-root', '');
    }
    // Spacing moves the text: redraw what's drawn over it once the page has reflowed.
    requestAnimationFrame(() => {
      drawMarks();
      updateFocus();
    });
  }

  function onResize() {
    drawMarks();
    updateFocus();
  }

  // Line focus: everything but the sentence being read is dimmed, with one box whose huge
  // shadow covers the rest of the window. It follows the sentence as the page scrolls.
  function updateFocus() {
    let el = document.getElementById('voice-reader-focus');
    // Not while the reader has scrolled away to look at something else.
    const range = settings.lineFocus && ui && state.current && !state.detached ? state.sentenceRange : null;
    const r = range?.getBoundingClientRect();
    if (!r || !r.height || r.bottom < 0 || r.top > innerHeight) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'voice-reader-focus';
      document.documentElement.appendChild(el);
    }
    const pad = 6;
    el.style.cssText = 'all:initial;position:fixed;pointer-events:none;z-index:2147483645;border-radius:8px;' +
      'box-shadow:0 0 0 200vmax rgba(15,18,28,.55);transition:left .15s,top .15s,width .15s,height .15s;' +
      `left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px;`;
  }

  function clearHighlights() {
    sentenceHL?.clear();
    wordHL?.clear();
    marked.sentence = [];
    marked.word = [];
    state.sentenceRange = null;
    drawMarks();
    updateFocus();
  }

  function clearWordHighlight() {
    wordHL?.clear();
    marked.word = [];
    drawMarks();
  }

  // Equations in a stretch of an item's model text.
  function equationsIn(item, start, end) {
    return item.model.segs.filter((s) => s.el && s.start < end && s.end > start).map((s) => s.el);
  }

  function highlightSentence(item) {
    if (!sentenceHL) return;
    sentenceHL.clear();
    wordHL.clear();
    marked.sentence = equationsIn(item, item.start, item.end);
    marked.word = [];
    drawMarks();
    const r = makeRange(item.model, item.start, item.end);
    state.sentenceRange = r;
    if (!r) return updateFocus();
    sentenceHL.add(r);
    // Reading has come back into view after scrolling away: follow it again.
    if (state.detached && inView(r)) setDetached(false);
    scrollIntoViewIfNeeded(item.model.el, r);
    updateFocus();
  }

  function highlightWord(item, start, end) {
    state.wordAt = item.start + start;
    if (!wordHL) return;
    wordHL.clear();
    const eqs = equationsIn(item, item.start + start, item.start + end);
    if (eqs.length !== marked.word.length || eqs.some((el, i) => el !== marked.word[i])) {
      marked.word = eqs;
      drawMarks();
    }
    const r = makeRange(item.model, item.start + start, item.start + end);
    if (r) wordHL.add(r);
  }

  // Highlights only color text, and equations are often images, so boxes are drawn over them.
  function drawMarks() {
    let layer = document.getElementById('voice-reader-marks');
    if (!marked.sentence.length && !marked.word.length) {
      layer?.remove();
      return;
    }
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'voice-reader-marks';
      // The layer itself blends with the page, so the equation shows through the yellow.
      layer.style.cssText = 'all:initial;position:absolute;left:0;top:0;width:0;height:0;z-index:2147483646;' +
        'pointer-events:none;mix-blend-mode:multiply;';
      document.documentElement.appendChild(layer);
    }
    const c = HL_COLORS[settings.hlColor] || HL_COLORS.yellow;
    const box = (el, strong) => {
      const img = el.querySelector('img');
      const r = (img && isVisible(img) ? img : el).getBoundingClientRect();
      const b = document.createElement('div');
      b.style.cssText = `position:absolute;left:${r.left + scrollX - 2}px;top:${r.top + scrollY - 1}px;` +
        `width:${r.width + 4}px;height:${r.height + 2}px;border-radius:3px;` +
        `background:${strong ? c.word : c.sentence};`;
      return b;
    };
    const showSentence = settings.hlStyle !== 'word';
    const showWord = settings.hlStyle !== 'sentence';
    layer.replaceChildren(
      ...(showSentence ? marked.sentence.filter((el) => !(showWord && marked.word.includes(el))) : []).map((el) => box(el, false)),
      ...(showWord ? marked.word : []).map((el) => box(el, true)),
    );
  }

  const BAR_SPACE = 110;

  function inView(range) {
    const rect = range.getBoundingClientRect();
    return rect.height > 0 && rect.top >= 40 && rect.bottom <= innerHeight - BAR_SPACE;
  }

  function scrollIntoViewIfNeeded(el, range, force = false) {
    if (!force && (!settings.follow || state.detached)) return;
    const rect = range.getBoundingClientRect();
    if (!rect.height || inView(range)) return;
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
      state.playing = false; // or teardown would try to message the extension again, and loop
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

  // Where to end the first piece of a sentence spoken from start to end: after a comma, semicolon,
  // colon or dash that leaves a few words on each side, so the break falls where a reader would
  // pause anyway. A sentence without one, or with an equation, isn't split.
  const PIECE_MIN_WORDS = 4;
  const PIECE_MAX_WORDS = 14;
  function firstPieceEnd(item, start, end) {
    if (equationsIn(item, start, end).length) return end;
    const text = item.text.slice(start - item.start, end - item.start);
    const re = /\S+/g;
    const words = [];
    for (let m; (m = re.exec(text));) words.push([m.index, m[0]]);
    for (let w = PIECE_MIN_WORDS - 1; w < Math.min(PIECE_MAX_WORDS, words.length - PIECE_MIN_WORDS); w++) {
      if (/[,;:—–]$/.test(words[w][1])) return start + words[w + 1][0];
    }
    return end;
  }

  // Where an AI voice's clip starting at `start` ends: a sentence prepared ahead is spoken whole.
  function pieceEnd(base, start, end) {
    const prepared = start === base.start && end === base.end && state.readAhead.includes(base);
    return prepared ? end : firstPieceEnd(base, start, end);
  }

  // An AI voice takes about a second to make a clip, so where reading is likely to start next (the
  // word under a resting pointer, a paragraph's play button, a mouse press) is prepared before the
  // click lands. The clip made is exactly the one speakCurrent will ask for.
  const PREPARE_DELAY = 200; // ms the pointer rests on a word first, so sweeping across text doesn't
  let prepareTimer = null;
  let preparedText = null;
  function prepareFrom(idx, off) {
    const voice = currentVoice();
    const base = state.queue[idx];
    if (voice?.engine !== 'ai' || state.aiUnavailable || !base) return;
    const start = off > base.start && off < base.end ? off : base.start;
    if (start === base.start && state.readAhead.includes(base)) return; // already being made
    const text = base.text.slice(start - base.start, pieceEnd(base, start, base.end) - base.start);
    if (`${voice.voiceName}|${text}` === preparedText) return;
    preparedText = `${voice.voiceName}|${text}`;
    send({ type: 'prepare', text, voiceName: voice.voiceName });
  }

  // The same starting point as a click there (see startAt). Text outside the queue isn't prepared.
  function prepareAt(node, offset) {
    const idx = findIndex(node, offset);
    if (idx < 0) return;
    const base = state.queue[idx];
    const t = base.model.text;
    let off = modelOffset(base.model, node, offset);
    while (off > base.start && /\S/.test(t[off - 1])) off--;
    prepareFrom(idx, off);
  }

  // Speak the current sentence. Reading can start at a word partway through it (a click or a
  // selection): `from` is that word's offset. Without it, a restart of the same sentence (a speed
  // or voice change, or resuming when the voice couldn't hold its place) carries on from the word
  // being read.
  // `rest` is set when this carries on from a first piece (see firstPieceEnd).
  function speakCurrent(from = null, rest = null) {
    clearTimers();
    const base = state.queue[state.idx];
    if (!base) return finish();
    if (from == null && (state.current?.base || state.current) === base) from = state.wordAt ?? state.current.start;
    const start = from != null && from > base.start && from < base.end ? from : base.start;
    // Reading just a selection: the last sentence stops where the selection does.
    const end = state.limit?.item === base ? Math.max(start + 1, Math.min(base.end, state.limit.end)) : base.end;
    const voice = currentVoice();
    const isAI = voice?.engine === 'ai';
    // Reading from somewhere new with an AI voice: the sentence wasn't prepared ahead, so its first
    // few words are spoken as their own piece, to be heard sooner. The rest is made while they play.
    const cut = isAI && !rest ? pieceEnd(base, start, end) : end;
    const slice = (a, b) => base.text.slice(a - base.start, b - base.start);
    const item = start === base.start && cut === base.end
      ? base
      : { ...base, start, end: cut, text: slice(start, cut), base };
    if (cut < end) item.restOf = { start, end }; // the stretch the sentence highlight shows
    state.current = item;
    const id = ++state.gen;
    state.playing = true;
    state.paused = null;
    state.resuming = null;
    state.wordAt = null;
    state.clipDuration = 0;
    state.startedAt = 0;
    state.sawWord = false;
    const shown = rest || item.restOf; // a split sentence is highlighted as a whole
    highlightSentence(shown ? { ...item, ...shown } : item);

    state.voiceKey = voice?.voiceName || 'default';
    if (voice?.eventTypes && !voice.eventTypes.includes('word') && !wordSupport.has(state.voiceKey)) {
      wordSupport.set(state.voiceKey, false);
    }
    // AI voices prepare the next few sentences while this one plays (after a first piece, its rest first).
    state.readAhead = isAI ? state.queue.slice(state.idx + 1, state.idx + 4) : [];
    const upcoming = isAI ? state.readAhead.map((q) => q.text) : undefined;
    if (item.restOf) upcoming.unshift(slice(cut, end));
    send({ type: 'speak', id, text: item.text, rate: settings.rate, voiceName: voice?.voiceName, lang: voice?.lang, upcoming });

    armWatchdog(id, isAI ? 60000 : (item.text.length / (5 * settings.rate) + 10) * 1000);
    updateUI();
  }

  function onTtsEvent(id, ev) {
    if (id !== state.gen) return;
    const item = state.current;
    if (!item) return;
    switch (ev.type) {
      case 'progress':
        // AI voice downloading or warming up.
        setStatus(ev.message);
        armWatchdog(id, 60000);
        break;
      case 'start':
        state.startedAt = performance.now();
        state.clipDuration = ev.duration || 0;
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
      case 'pause':
        if (state.paused) state.paused.held = true;
        break;
      case 'pauseFailed':
        dropHold();
        break;
      case 'resume':
        state.resuming = null;
        break;
      case 'resumeFailed':
        if (state.resuming === id) speakCurrent(); // from the word
        break;
      case 'word': {
        state.resuming = null;
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
        state.resuming = null;
        if (item.restOf) {
          speakCurrent(item.end, item.restOf); // the rest of the sentence, made while the first piece played
          break;
        }
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
        console.warn('[Wren] speech error:', ev.errorMessage);
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
    if (state.limit && state.queue[state.idx] === state.limit.item) return finishSelection();
    state.idx++;
    if (state.idx < state.queue.length) speakCurrent();
    else finish();
  }

  function play() {
    if (!state.queue.length) return;
    if (state.paused) return resumeReading();
    if (state.idx >= state.queue.length) state.idx = 0;
    speakCurrent();
  }

  // Pause holds the voice where it is, mid-word, so resume carries on from there. A voice that
  // can't hold its place says so (or doesn't confirm in time): it's stopped, and resume starts
  // again from the word that was being read.
  const PAUSE_WAIT = 300;   // ms for the voice to confirm it paused (real ones take a few ms)
  const RESUME_WAIT = 1200; // ms for it to confirm it resumed

  function pauseReading() {
    if (!state.playing) return;
    if (!state.startedAt) return pausePlayback(); // nothing heard yet (an AI voice still preparing)
    clearTimers();
    const id = state.gen;
    state.playing = false;
    state.resuming = null;
    state.paused = { id, at: performance.now(), held: false };
    send({ type: 'pause', id });
    state.timers.push(setTimeout(() => {
      if (state.paused?.id === id && !state.paused.held) dropHold();
    }, PAUSE_WAIT));
    updateUI();
  }

  // Let go of a paused voice. Resuming will start again from the word.
  function dropHold() {
    if (!state.paused) return;
    state.paused.held = false;
    state.gen++; // ignore anything more from the old sentence
    clearTimers();
    send({ type: 'stop' });
  }

  function resumeReading() {
    const p = state.paused;
    state.paused = null;
    if (!p.held || p.id !== state.gen) return speakCurrent();
    clearTimers();
    const item = state.current;
    state.playing = true;
    if (state.startedAt) state.startedAt += performance.now() - p.at; // the word estimate skips the pause
    state.resuming = p.id;
    send({ type: 'resume', id: p.id });
    state.timers.push(setTimeout(() => {
      if (state.resuming === p.id && state.gen === p.id) speakCurrent();
    }, RESUME_WAIT));
    armWatchdog(p.id, ((state.clipDuration || item.text.length / (5 * settings.rate)) + 10) * 1000);
    if (!state.sawWord && wordSupport.get(state.voiceKey) !== true) startWordEstimator(item, p.id, state.clipDuration || undefined);
    updateUI();
  }

  function pausePlayback(stopEngine = true) {
    state.gen++;
    clearTimers();
    state.playing = false;
    state.paused = null;
    state.resuming = null;
    if (stopEngine) send({ type: 'stop' });
    clearWordHighlight();
    updateUI();
  }

  // The end of a selection: stop, ready to carry on from just after it.
  function finishSelection() {
    state.limit = null;
    state.gen++;
    clearTimers();
    state.playing = false;
    state.current = null;
    state.idx = Math.min(state.idx + 1, state.queue.length);
    clearHighlights();
    updateUI();
    setStatus('Finished selection');
  }

  function finish() {
    state.gen++;
    clearTimers();
    state.playing = false;
    state.idx = state.queue.length;
    clearHighlights();
    updateUI();
    setStatus('Finished');
  }

  function jump(delta) {
    if (!state.queue.length) return;
    state.idx = Math.max(0, Math.min(state.queue.length - 1, state.idx + delta));
    if (state.limit && state.idx > state.queue.indexOf(state.limit.item)) state.limit = null;
    setDetached(false);
    state.wordAt = null;
    if (state.playing) {
      speakCurrent();
    } else {
      if (state.paused) {
        dropHold();
        state.paused = null;
      }
      highlightSentence(state.queue[state.idx]);
      updateUI();
    }
  }

  function setRate(rate) {
    settings.rate = Math.round(Math.max(RATE_MIN, Math.min(RATE_MAX, rate)) * 10) / 10;
    chrome.storage.sync.set({ rate: settings.rate }).catch(() => {});
    if (state.playing) speakCurrent(); // carry on from the word at the new speed
    else if (state.paused?.held) dropHold(); // resume will start from the word, at the new speed
    updateUI();
  }

  function setVoice(voiceName) {
    settings.voiceName = voiceName;
    state.readAhead = []; // prepared in the old voice
    chrome.storage.sync.set({ voiceName }).catch(() => {});
    updateVoiceUI();
    if (state.playing) speakCurrent();
    else if (state.paused?.held) dropHold();
  }

  // ---------- Starting points ----------

  function startAt(node, offset, canReload = true) {
    state.limit = null;
    setDetached(false);
    let idx = findIndex(node, offset);
    if (idx < 0) {
      // Maybe it's in a section that's unticked in the page map: tick it and read from there.
      const all = state.sections.flatMap(sectionItems);
      const i = findIn(all, node, offset);
      if (i >= 0) {
        all[i].sec.enabled = true;
        rebuildQueue();
        renderMap();
        idx = state.queue.indexOf(all[i]);
      }
    }
    if (idx < 0 && canReload) {
      // The page may have changed since it was mapped.
      loadSections();
      return startAt(node, offset, false);
    }
    if (idx < 0) {
      // Not part of the detected article (e.g. a caption or a sidebar).
      const block = blockAround(node);
      if (!block || !addTempSection([block], 'Clicked text')) return;
      idx = findIndex(node, offset);
      if (idx < 0) return;
    }
    if (!state.queue.length) return;
    state.idx = idx;
    // Start from the beginning of the word at that spot.
    const base = state.queue[idx];
    const t = base.model.text;
    let off = modelOffset(base.model, node, offset);
    while (off > base.start && /\S/.test(t[off - 1])) off--;
    speakCurrent(off);
  }

  // Read from the start of a sentence, ticking its section in the page map if needed.
  function startAtItem(item) {
    if (!item) return;
    state.limit = null;
    setDetached(false);
    if (!item.sec.enabled) {
      item.sec.enabled = true;
      rebuildQueue();
      renderMap();
    }
    state.idx = state.queue.indexOf(item);
    speakCurrent(item.start);
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
    loadSections();
    if (node) return startAt(node, offset, false);
    if (!state.queue.length) {
      updateUI();
      setStatus('No readable text found');
      return;
    }
    state.idx = 0;
    speakCurrent();
  }

  // Read just the selected text, then stop.
  function readSelection(range) {
    if (!state.sections.length) loadSections();
    const nodes = textNodesIn(range);
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const startOff = first === range.startContainer ? range.startOffset : 0;
    const endOff = last === range.endContainer ? range.endOffset : last.length;
    let a = locate(first, startOff);
    let b = locate(last, endOff, true);
    if (!a || !b) {
      // Some of it is outside the article: add those blocks as their own section.
      const blocks = [...new Set(nodes.map(blockAround).filter(Boolean))]
        .filter((bl, i, all) => !readableBlockAt(bl) && !all.some((o) => o !== bl && o.contains(bl)));
      addTempSection(blocks, 'Selected text');
      a = locate(first, startOff) || a;
      b = locate(last, endOff, true) || b;
    }
    if (!a) return;
    const all = state.sections.flatMap(sectionItems);
    // A selection ending right at the end of a sentence lands on the start of the next one.
    if (b && b.item !== a.item && b.off <= b.item.start) {
      const prev = all[all.indexOf(b.item) - 1];
      b = prev ? { item: prev, off: prev.end } : null;
    }
    const from = all.indexOf(a.item);
    const to = b ? all.indexOf(b.item) : from;
    for (let i = from; i <= to; i++) all[i].sec.enabled = true;
    rebuildQueue();
    renderMap();
    setDetached(false);
    // Whole words: back to the start of the first, on to the end of the last.
    const t = a.item.model.text;
    let start = a.off;
    while (start > a.item.start && /\S/.test(t[start - 1])) start--;
    if (b) {
      const tb = b.item.model.text;
      let end = b.off;
      while (end < b.item.end && /[\p{L}\p{N}]/u.test(tb[end])) end++;
      state.limit = { item: b.item, end };
    } else {
      state.limit = null;
    }
    state.idx = state.queue.indexOf(a.item);
    speakCurrent(start);
  }

  // The text nodes a range covers, in order.
  function textNodesIn(range) {
    const root = range.commonAncestorContainer;
    if (root.nodeType === Node.TEXT_NODE) return root.data.trim() ? [root] : [];
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.data.trim() && range.intersectsNode(n) && isVisible(n.parentElement)) out.push(n);
    }
    return out;
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
    voice: 'M9 13c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4zm6.08-7.95c.84 1.18.84 2.71 0 3.89l1.68 1.69c2.02-2.02 2.02-5.07 0-7.27l-1.68 1.69zM20.07 2l-1.63 1.63c2.77 3.02 2.77 7.56 0 10.74L20.07 16c3.9-3.89 3.91-9.95 0-14z',
    target: 'M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3A8.994 8.994 0 0 0 13 3.06V1h-2v2.06A8.994 8.994 0 0 0 3.06 11H1v2h2.06A8.994 8.994 0 0 0 11 20.94V23h2v-2.06A8.994 8.994 0 0 0 20.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z',
    shrink: 'M22 3.41 16.71 8.7 20 12h-8V4l3.29 3.29L20.59 2 22 3.41zM3.41 22l5.29-5.29L12 20v-8H4l3.29 3.29L2 20.59 3.41 22z',
    lock: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM9 6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9V6z',
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    map: 'M3 9h14V7H3v2zm0 4h14v-2H3v2zm0 4h14v-2H3v2zm16 0h2v-2h-2v2zm0-10v2h2V7h-2zm0 6h2v-2h-2v2z',
    gear: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
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

  // The Wren logo on the bar (drawn by wren-mark.js). Its tail sways while reading, easing in
  // and out over LOGO_EASE ms instead of starting or stopping abruptly.
  const LOGO_SIZE = 28;
  const LOGO_EASE = 700;

  function buildLogo() {
    const canvas = h('canvas');
    const scale = Math.max(2, Math.ceil(window.devicePixelRatio || 1));
    canvas.width = canvas.height = LOGO_SIZE * scale;
    const btn = h('button', { className: 'logo', type: 'button', title: 'Appearance (drag to move the player)' }, canvas,
      h('span', { className: 'badge', title: 'Position locked' }, icon('lock')));
    btn.setAttribute('aria-label', 'Logo and color');
    const logo = { btn, canvas, ctx: canvas.getContext('2d'), playing: false, levels: [1, 1, 1], from: [1, 1, 1], since: 0, raf: 0 };
    drawLogoFrame(logo, performance.now());
    return logo;
  }

  function drawLogoFrame(logo, now) {
    if (typeof WREN_MARK === 'undefined') return;
    const target = logo.playing ? WREN_MARK.levels(now / 1000) : [1, 1, 1];
    const p = Math.min(1, (now - logo.since) / LOGO_EASE);
    const ease = p * p * (3 - 2 * p);
    logo.levels = logo.from.map((f, i) => f + (target[i] - f) * ease);
    WREN_MARK.draw(logo.ctx, logo.canvas.width, { shape: settings.logo, color: settings.color, levels: logo.levels, round: true });
    logo.raf = logo.playing || p < 1 ? requestAnimationFrame((t) => drawLogoFrame(logo, t)) : 0;
  }

  function setLogoPlaying(logo, playing) {
    if (logo.playing === playing) return;
    logo.playing = playing;
    logo.from = logo.levels;
    logo.since = performance.now();
    if (!logo.raf) logo.raf = requestAnimationFrame((t) => drawLogoFrame(logo, t));
  }

  // Frosted glass that follows the system's light or dark mode, in the chosen color (applyLook
  // sets --g1, --g2 and the light and dark accents; Ember until then).
  const BAR_CSS = `
    :host { all: initial; }
    .root {
      --glass-rgb: 246,246,248; --glass: rgba(var(--glass-rgb), var(--glass-a, .78)); --panel-rgb: 248,248,250; --panel: rgba(var(--panel-rgb), var(--panel-a, .93)); --solid: #f6f6f8; --thumb: #fff; --fg: #1d1d1f; --muted: rgba(60,60,67,.62);
      --hover: rgba(0,0,0,.055); --press: rgba(0,0,0,.1); --line: rgba(0,0,0,.09); --edge: rgba(255,255,255,.75);
      --track: rgba(0,0,0,.1); --accent: var(--a-l, #ff5e3a); --accent-text: var(--t-l, #e5482a);
      --on: color-mix(in srgb, var(--accent) 13%, transparent);
      --brand: linear-gradient(135deg, var(--g1, #ffb547), var(--g2, #ff5e3a));
      --glow: color-mix(in srgb, var(--g2, #ff5e3a) 35%, transparent);
      --shadow: 0 12px 40px rgba(0,0,0,.14), 0 2px 8px rgba(0,0,0,.07);
      --spring: cubic-bezier(.3,1.3,.5,1);
      font: 13px/1.3 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
      color: var(--fg); -webkit-font-smoothing: antialiased; letter-spacing: -.005em;
    }
    @media (prefers-color-scheme: dark) {
      .root {
        --glass-rgb: 38,38,40; --panel-rgb: 36,36,38; --solid: #262628; --thumb: #636366; --fg: #f5f5f7; --muted: rgba(235,235,245,.6);
        --hover: rgba(255,255,255,.08); --press: rgba(255,255,255,.14); --line: rgba(255,255,255,.1); --edge: rgba(255,255,255,.1);
        --track: rgba(255,255,255,.16); --accent: var(--a-d, #ff6a45); --accent-text: var(--t-d, #ff8a66);
        --on: color-mix(in srgb, var(--accent) 22%, transparent);
        --shadow: 0 12px 40px rgba(0,0,0,.5), 0 2px 8px rgba(0,0,0,.3);
      }
    }
    .glass { background-color: var(--glass); -webkit-backdrop-filter: blur(var(--blur, 28px)) saturate(180%);
      backdrop-filter: blur(var(--blur, 28px)) saturate(180%);
      border: .5px solid var(--line); box-shadow: var(--shadow), inset 0 .5px 0 var(--edge); }
    @supports not (backdrop-filter: blur(1px)) { .glass { background-color: var(--solid); } }
    .tinted .glass { background-image: linear-gradient(135deg, color-mix(in srgb, var(--g1, #ffb547) 22%, transparent),
      color-mix(in srgb, var(--g2, #ff5e3a) 22%, transparent)); }
    .rounded .bar { border-radius: 18px; }
    .rounded .panel { border-radius: 14px; }
    .rounded .toast { border-radius: 12px; }
    .locked .bar { cursor: default; }
    .bar.shake { animation: shake .42s ease; }
    @keyframes shake { 20%, 60% { translate: -6px 0; } 40%, 80% { translate: 6px 0; } }

    .bar { position: fixed; left: 0; top: 0; display: flex; align-items: center; gap: 2px; padding: 6px 12px 6px 7px;
      border-radius: 999px; user-select: none; touch-action: none; cursor: grab;
      transition: left .5s var(--spring), top .5s var(--spring); }
    .bar.dragging, .bar.dragging .more { transition: none; cursor: grabbing; box-shadow: 0 20px 50px rgba(0,0,0,.22), inset 0 .5px 0 var(--edge); }
    .bar.instant, .bar.instant .more { transition: none; }
    .vertical .bar { flex-direction: column; padding: 7px 6px 10px; }
    .shrunk .bar { padding-right: 7px; }
    .vertical.shrunk .bar { padding-bottom: 7px; }
    /* The parts hidden when shrunk. Their size is set from the script so it can animate. */
    .more { display: flex; align-items: center; gap: 2px; flex: none; overflow: hidden; padding: 4px 0; margin: -4px 0;
      transition: width .5s var(--spring), height .5s var(--spring), opacity .3s ease; }
    .vertical .more { flex-direction: column; padding: 0 4px; margin: 0 -4px; }
    .shrunk .more { opacity: 0; pointer-events: none; }
    .shrunk .more.after-play { margin-left: -2px; }

    button { all: unset; box-sizing: border-box; cursor: pointer; display: grid; place-items: center; flex: none;
      width: 34px; height: 34px; border-radius: 50%; color: inherit; transition: background-color .15s, transform .15s; }
    button:hover { background-color: var(--hover); }
    button:active { transform: scale(.92); background-color: var(--press); }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    svg { width: 20px; height: 20px; fill: currentColor; }

    button.logo { position: relative; width: 36px; height: 36px; margin-right: 4px; cursor: grab; }
    .locked button.logo { cursor: pointer; }
    .badge { position: absolute; right: -2px; bottom: -2px; width: 15px; height: 15px; border-radius: 50%; display: none;
      place-items: center; background: var(--solid); color: var(--fg); box-shadow: 0 1px 3px rgba(0,0,0,.28); }
    .badge svg { width: 9px; height: 9px; }
    .locked .badge { display: grid; }
    button.logo:hover { background: none; transform: scale(1.06); }
    button.logo:active { background: none; }
    button.logo.on { background: none; box-shadow: 0 0 0 2px var(--accent); }
    button.logo canvas { width: 32px; height: 32px; border-radius: 50%; filter: drop-shadow(0 2px 5px var(--glow)); }
    .vertical button.logo { margin: 0 0 4px; }
    .ring { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; flex: none; margin: 0 2px;
      background: conic-gradient(var(--accent) calc(var(--p, 0) * 1turn), var(--track) 0); }
    .vertical .ring { margin: 2px 0; }
    button.play, button.play:hover { width: 38px; height: 38px; background: var(--brand); color: #fff;
      box-shadow: 0 2px 8px var(--glow), inset 0 .5px 0 rgba(255,255,255,.4); }
    button.play svg { width: 22px; height: 22px; }

    .group { display: flex; align-items: center; gap: 2px; }
    .vertical .group { flex-direction: column; }
    .vertical .group.rate-group { flex-direction: column-reverse; }
    button.small { width: 28px; height: 28px; font-size: 18px; font-weight: 500; }
    .rate { min-width: 40px; text-align: center; font-variant-numeric: tabular-nums; font-weight: 600; }
    .vertical .rate { min-width: 0; font-size: 12px; padding: 1px 0; }
    .sep { width: 1px; height: 22px; background: var(--line); margin: 0 6px; flex: none; }
    .vertical .sep { width: 22px; height: 1px; margin: 6px 0; }
    button.chip { width: auto; height: 32px; padding: 0 12px 0 8px; border-radius: 999px; gap: 6px; display: inline-flex;
      align-items: center; font-weight: 500; max-width: 160px; }
    button.chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .vertical button.chip { width: 34px; height: 34px; padding: 0; justify-content: center; }
    .vertical button.chip span { display: none; }
    button.on, button.on:hover { background-color: var(--on); color: var(--accent-text); }
    button.back, button.back:hover { background: var(--brand); color: #fff; margin: 0 4px; }
    button.back[hidden] { display: none; }
    .vertical button.back { margin: 4px 0; }
    .status { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap;
      min-width: 64px; padding: 0 8px; text-align: center; }
    .vertical .status { display: none; }

    .panel, .toast { position: fixed; left: 0; top: 0; animation: pop .28s var(--spring); }
    .panel.glass { background-color: var(--panel); }
    .panel { width: 340px; max-width: calc(100vw - 24px); display: flex; flex-direction: column; border-radius: 22px;
      overflow: hidden; user-select: none; }
    .panel[hidden], .toast[hidden] { display: none; }
    @keyframes pop { from { opacity: 0; transform: scale(.96); } }
    .toast { padding: 8px 14px; border-radius: 999px; font-size: 12px; font-weight: 500; white-space: nowrap; pointer-events: none; }
    .head { position: relative; padding: 15px 46px 8px 18px; font-size: 15px; font-weight: 600; letter-spacing: -.01em; }
    .head button.close { position: absolute; top: 10px; right: 10px; color: var(--muted); }
    .head button.close:hover { color: var(--fg); }
    .head button.close svg { width: 16px; height: 16px; }
    .head small { display: block; margin-top: 3px; font-size: 12px; font-weight: 400; letter-spacing: 0; color: var(--muted); }
    .list { position: relative; overflow-y: auto; overscroll-behavior: contain; padding: 2px 8px 10px; scrollbar-width: thin; }
    .label { padding: 12px 10px 5px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }

    .row { display: flex; align-items: center; gap: 8px; padding: 0 8px 0 calc(8px + var(--indent, 0) * 14px); border-radius: 10px; }
    .row:hover { background: var(--hover); }
    .row.off .title, .row.off .count { opacity: .45; }
    .row.current, .row.current:hover { background: var(--on); }
    .row.current .title { font-weight: 600; color: var(--accent-text); }
    .row button.title, .row button.title:hover { display: block; width: auto; height: auto; flex: 1; min-width: 0; padding: 8px 2px;
      border-radius: 6px; background: none; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row button.title:active { transform: none; }
    .row button.title:disabled { cursor: default; }
    .count { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; flex: none; }

    input.check { appearance: none; margin: 0; width: 18px; height: 18px; border-radius: 50%; border: 1.5px solid var(--muted);
      display: grid; place-items: center; flex: none; cursor: pointer; transition: background-color .15s, border-color .15s; }
    input.check:checked { background: var(--accent); border-color: var(--accent); }
    input.check:checked::after { content: ""; width: 4px; height: 8px; border: solid #fff; border-width: 0 2px 2px 0;
      transform: translateY(-1px) rotate(45deg); }

    .opt { display: flex; align-items: center; gap: 12px; padding: 9px 10px; border-radius: 10px; cursor: pointer; }
    .opt:hover { background: var(--hover); }
    .opt span { flex: 1; min-width: 0; }
    .opt small { display: block; margin-top: 2px; font-size: 12px; line-height: 1.35; color: var(--muted); }
    input.switch { appearance: none; margin: 0; position: relative; width: 40px; height: 24px; border-radius: 999px; flex: none;
      background: var(--track); cursor: pointer; transition: background-color .2s; }
    input.switch::before { content: ""; position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%;
      background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.3); transition: transform .3s var(--spring); }
    input.switch:checked { background: var(--accent); }
    input.switch:checked::before { transform: translateX(16px); }

    .swatches { display: flex; align-items: center; gap: 12px; padding: 6px 10px 4px; }
    button.swatch { width: 24px; height: 24px; box-shadow: inset 0 0 0 1px rgba(0,0,0,.12); }
    button.swatch.on { box-shadow: inset 0 0 0 1px rgba(0,0,0,.12), 0 0 0 2px var(--solid), 0 0 0 4px var(--accent); }
    .seg { display: flex; gap: 2px; margin: 8px 10px 6px; padding: 2px; border-radius: 9px; background: var(--track); }
    .seg button { flex: 1 1 0; min-width: 0; width: auto; height: 28px; padding: 0 6px; border-radius: 7px; font-size: 12px;
      font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: background-color .2s, box-shadow .2s; }
    .seg button:hover { background: none; }
    .seg button:active { transform: none; }
    .seg button:focus-visible { outline-offset: -2px; }
    .seg button.on, .seg button.on:hover { background: var(--thumb); color: var(--fg); font-weight: 600;
      box-shadow: 0 1px 3px rgba(0,0,0,.14), 0 0 0 .5px rgba(0,0,0,.04); }

    button.voice { display: flex; justify-content: space-between; gap: 8px; width: 100%; height: auto; padding: 8px 10px; border-radius: 10px; }
    button.voice:active { transform: none; }
    button.voice span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button.voice small { color: var(--muted); font-size: 12px; flex: none; }
    button.voice.on, button.voice.on:hover { background: var(--on); color: var(--accent-text); font-weight: 600; }

    .shapes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; padding: 4px 4px 2px; }
    button.shape { display: grid; gap: 6px; justify-items: center; width: auto; height: auto; padding: 10px 4px 8px; border-radius: 12px;
      font-size: 12px; font-weight: 500; color: var(--muted); }
    button.shape:active { transform: scale(.97); }
    button.shape canvas { width: 48px; height: 48px; }
    button.shape.on, button.shape.on:hover { background: var(--on); color: var(--accent-text); font-weight: 600; }
    .colors { display: flex; gap: 14px; padding: 6px 10px 4px; }
    .colors button.swatch { width: 28px; height: 28px; }
    .dockpick { display: flex; align-items: center; gap: 14px; padding: 6px 10px 4px; }
    .screen { position: relative; width: 112px; height: 72px; flex: none; border-radius: 10px; border: 1.5px solid var(--line); background: var(--hover); }
    .screen button { position: absolute; width: auto; height: auto; padding: 4px; border-radius: 999px; background: var(--track);
      background-clip: content-box; }
    .screen button:hover { background-color: color-mix(in srgb, var(--accent) 45%, transparent); }
    .screen button.on, .screen button.on:hover { background-color: var(--accent); }
    .screen .d-bottom { left: 28px; right: 28px; bottom: 2px; height: 15px; }
    .screen .d-top { left: 28px; right: 28px; top: 2px; height: 15px; }
    .screen .d-left { top: 16px; bottom: 16px; left: 2px; width: 15px; }
    .screen .d-right { top: 16px; bottom: 16px; right: 2px; width: 15px; }
    .screen .d-free { left: 40px; top: 26px; width: 32px; height: 20px; border-radius: 6px; pointer-events: none; opacity: 0; }
    .screen .d-free.on { opacity: 1; }
    .dockinfo { font-size: 12px; line-height: 1.35; color: var(--muted); }
    .dockinfo b { display: block; margin-bottom: 2px; font-size: 13px; font-weight: 600; color: var(--fg); }
    .slider { display: flex; align-items: center; gap: 10px; padding: 8px 10px; font-size: 12px; color: var(--muted); }
    input.range { appearance: none; flex: 1; min-width: 0; height: 4px; margin: 0; border-radius: 999px; cursor: pointer;
      background: linear-gradient(var(--accent), var(--accent)) 0 / calc(var(--v, 50) * 1%) 100% no-repeat, var(--track); }
    input.range::-webkit-slider-thumb { appearance: none; width: 22px; height: 22px; border-radius: 50%; background: #fff;
      box-shadow: 0 1px 4px rgba(0,0,0,.3), 0 0 0 .5px rgba(0,0,0,.08); }
    @media (prefers-reduced-motion: reduce) { .bar, .more, .panel, .toast, input.switch::before { transition: none; animation: none; } }
  `;

  // Where the bar sits: docked to an edge (vertical on the left and right), or floating where it
  // was dropped. Drag it by the logo or any empty part of the bar; double-click the logo to reset.
  const DOCK_MARGIN = 16; // px from the window edge
  const DOCK_ZONE = 24;   // a bar dragged this close to an edge docks there (vertical on the sides)
  const PANEL_GAP = 10;

  function buildUI() {
    const host = h('div', { id: 'voice-reader-host' });
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });

    const playBtn = button('play', 'Play / pause (Alt+Shift+R)', 'play', () => (state.playing ? pauseReading() : play()));
    const ring = h('div', { className: 'ring' }, playBtn);
    const rateLabel = h('span', { className: 'rate', title: 'Reading speed' });
    const status = h('span', { className: 'status' });
    const toast = h('div', { className: 'toast glass', hidden: true });

    const slower = h('button', { className: 'small', title: 'Slower (Alt+Shift+Down)', type: 'button' }, '−');
    slower.addEventListener('click', () => setRate(settings.rate - RATE_STEP));
    const faster = h('button', { className: 'small', title: 'Faster (Alt+Shift+Up)', type: 'button' }, '+');
    faster.addEventListener('click', () => setRate(settings.rate + RATE_STEP));

    const voiceLabel = h('span');
    const voiceBtn = h('button', { className: 'chip', title: 'Voice', type: 'button' }, icon('voice'), voiceLabel);
    voiceBtn.addEventListener('click', () => togglePanel('voice'));
    const mapBtn = button('', 'Page map', 'map', () => toggleMap());
    const optsBtn = button('', 'Options', 'gear', () => toggleOptions());
    const shrinkBtn = button('', 'Shrink when not in use', 'shrink', () => {
      setOption('autoShrink', !settings.autoShrink);
      showToast(settings.autoShrink ? 'Shrinks when you move away' : 'Stays open');
    });
    const backBtn = h('button', { className: 'chip back', type: 'button', hidden: true,
      title: 'Scroll back to the sentence being read, and follow it again' }, icon('target'), h('span', { textContent: 'Back to reading' }));
    backBtn.addEventListener('click', () => {
      setDetached(false);
      const item = state.current;
      if (item && state.sentenceRange) scrollIntoViewIfNeeded(item.model.el, state.sentenceRange, true);
    });

    const mapList = h('div', { className: 'list' });
    const mapPanel = h('div', { className: 'panel glass', hidden: true },
      panelHead('Page map', 'Tick the sections to read. Click a title to jump there.'),
      mapList);
    const voiceList = h('div', { className: 'list' });
    const voicePanel = h('div', { className: 'panel glass', hidden: true },
      panelHead('Voice', 'Natural AI voices run on this computer.'),
      voiceList);
    const opts = buildOptions();

    const logo = buildLogo();
    // A mouse press on the logo might be a drag, so onBarPointerUp opens the panel for those.
    // This handles the keyboard (Enter or Space), which sends a click with no pointer.
    logo.btn.addEventListener('click', (e) => {
      if (e.detail === 0) togglePanel('look');
    });
    const look = buildLook();
    // Shrunk, only the logo, the play button and "Back to reading" show; the rest is in .more.
    const mores = [
      h('div', { className: 'more' }, button('', 'Previous sentence (Alt+Shift+Left)', 'prev', () => jump(-1))),
      h('div', { className: 'more after-play' },
        button('', 'Next sentence (Alt+Shift+Right)', 'next', () => jump(1)),
        h('span', { className: 'sep' }),
        h('div', { className: 'group rate-group' }, slower, rateLabel, faster),
        h('span', { className: 'sep' }),
        voiceBtn,
        status),
      h('div', { className: 'more' }, mapBtn, optsBtn, shrinkBtn, button('', 'Close', 'close', teardown)),
    ];
    const bar = h('div', { className: 'bar glass' }, logo.btn, mores[0], ring, mores[1], backBtn, mores[2]);
    bar.addEventListener('pointerdown', onBarPointerDown);
    bar.addEventListener('pointermove', onBarPointerMove);
    bar.addEventListener('pointerup', onBarPointerUp);
    bar.addEventListener('pointercancel', onBarPointerUp);
    bar.addEventListener('animationend', () => bar.classList.remove('shake'));
    for (const panel of [mapPanel, voicePanel, opts.panel, look.panel]) panel.addEventListener('wheel', onPanelWheel, { passive: false });
    // Shrink when not in use: open while pointed at (the bar or a panel) or tabbed into.
    for (const el of [bar, mapPanel, voicePanel, opts.panel, look.panel]) {
      el.addEventListener('pointerenter', () => setHover(true));
      el.addEventListener('pointerleave', () => setHover(false));
    }
    bar.addEventListener('focusin', () => updateShrink());
    bar.addEventListener('focusout', () => scheduleShrink());

    const root = h('div', { className: 'root' }, mapPanel, voicePanel, opts.panel, look.panel, toast, bar);
    shadow.append(h('style', { textContent: BAR_CSS }), root);
    document.documentElement.appendChild(host);

    ui = {
      host, root, bar, mores, shrinkBtn, hover: false, shrunk: false, shrinkTimer: 0, logo, ring, toast, iconPlaying: false, playBtn, rateLabel, status, voiceBtn, voiceLabel, voiceList,
      mapBtn, optsBtn, backBtn, opts, mapPanel, mapList, mapRows: new Map(), statusText: '', drag: null, dragDock: null,
      look, panels: { look: { panel: look.panel, btn: logo.btn }, map: { panel: mapPanel, btn: mapBtn }, voice: { panel: voicePanel, btn: voiceBtn }, opts: { panel: opts.panel, btn: optsBtn } },
    };
    bar.classList.add('instant'); // appear in place, don't fly in from the corner
    ui.shrunk = shouldShrink();
    layoutUI();
    requestAnimationFrame(() => ui?.bar.classList.remove('instant'));
    window.addEventListener('resize', layoutUI);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('click', onAltClick, true);
    window.addEventListener('click', onPageClick, true);
    buildPointerButtons();
    installHighlights();
  }

  // ---------- Bar position ----------

  function viewport() {
    return { W: document.documentElement.clientWidth || innerWidth, H: innerHeight };
  }

  // Place the bar from its dock, then whatever floats beside it (an open panel, a message).
  function layoutUI() {
    if (!ui) return;
    const d = ui.dragDock || settings.dock || DEFAULT_SETTINGS.dock;
    const vertical = d.edge === 'left' || d.edge === 'right';
    ui.root.classList.toggle('vertical', vertical);
    ui.root.classList.toggle('shrunk', ui.shrunk);
    // The hidden parts grow and shrink along the bar, so it's placed by the size it's heading to:
    // its size now, plus how much they'll grow. Their size across the bar is left to them, or a
    // bar that just turned from vertical to horizontal would still be as tall as the vertical one.
    for (const m of ui.mores) m.style[vertical ? 'width' : 'height'] = '';
    const w0 = ui.bar.offsetWidth;
    const h0 = ui.bar.offsetHeight;
    let grow = 0;
    for (const m of ui.mores) {
      const now = vertical ? m.offsetHeight : m.offsetWidth;
      const want = !settings.autoShrink ? null : ui.shrunk ? 0 : vertical ? m.scrollHeight : m.scrollWidth;
      m.style[vertical ? 'height' : 'width'] = want != null ? `${want}px` : '';
      grow += (want ?? (vertical ? m.offsetHeight : m.offsetWidth)) - now;
    }
    const { W, H } = viewport();
    const M = DOCK_MARGIN;
    const w = w0 + (vertical ? 0 : grow);
    const hgt = h0 + (vertical ? grow : 0);
    if (!vertical && !ui.shrunk) ui.hSize = { w, h: hgt }; // for judging drags
    const clampX = (x) => Math.max(M, Math.min(W - M - w, x));
    const clampY = (y) => Math.max(M, Math.min(H - M - hgt, y));
    const left = d.edge === 'left' ? M : d.edge === 'right' ? W - M - w : clampX(d.x * W - w / 2);
    const top = d.edge === 'top' ? M : d.edge === 'bottom' ? H - M - hgt : clampY(d.y * H - hgt / 2);
    ui.bar.style.left = `${left}px`;
    ui.bar.style.top = `${top}px`;
    const rect = { left, top, right: left + w, bottom: top + hgt };
    // Panels open on the side facing the page.
    const side = { bottom: 'above', top: 'below', left: 'right', right: 'left' }[d.edge] ||
      (top + hgt / 2 > H / 2 ? 'above' : 'below');
    let panelOpen = false;
    for (const { panel } of Object.values(ui.panels)) {
      if (panel.hidden) continue;
      panelOpen = true;
      placeBeside(panel, rect, side, true);
    }
    ui.toast.hidden = !ui.toastText || panelOpen;
    if (!ui.toast.hidden) placeBeside(ui.toast, rect, side, false);
  }

  function placeBeside(el, rect, side, limitHeight) {
    const { W, H } = viewport();
    const M = DOCK_MARGIN;
    if (limitHeight) {
      const room = side === 'above' ? rect.top - PANEL_GAP - M
        : side === 'below' ? H - rect.bottom - PANEL_GAP - M : H - 2 * M;
      el.style.maxHeight = `${Math.max(160, Math.min(480, room))}px`;
    }
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    const cx = (rect.left + rect.right) / 2;
    const cy = (rect.top + rect.bottom) / 2;
    const clampX = (x) => Math.max(M, Math.min(W - M - w, x));
    const clampY = (y) => Math.max(M, Math.min(H - M - hgt, y));
    let left, top;
    if (side === 'above' || side === 'below') {
      left = clampX(cx - w / 2);
      top = side === 'above' ? rect.top - PANEL_GAP - hgt : rect.bottom + PANEL_GAP;
    } else {
      left = side === 'right' ? rect.right + PANEL_GAP : rect.left - PANEL_GAP - w;
      top = clampY(cy - hgt / 2);
    }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.transformOrigin = { above: 'bottom', below: 'top', right: 'left', left: 'right' }[side];
  }

  function setDock(dock) {
    settings.dock = dock;
    chrome.storage.sync.set({ dock }).catch(() => {});
    layoutUI();
    updateOptionsUI(); // the position picker
  }

  // Where the bar would go if dropped with the pointer here. It's judged by where the horizontal
  // bar would be, not the pointer: push either end of it up to the left or right side and it
  // turns vertical there, wherever it was grabbed.
  function dockAt(x, y) {
    const { W, H } = viewport();
    const g = ui.drag;
    const { w, h: hgt } = ui.hSize || { w: ui.bar.offsetWidth, h: ui.bar.offsetHeight };
    const left = x - g.fx * w;
    const top = y - g.fy * hgt;
    const edge = left < DOCK_ZONE ? 'left' : left + w > W - DOCK_ZONE ? 'right'
      : top + hgt > H - DOCK_ZONE ? 'bottom' : top < DOCK_ZONE ? 'top' : 'free';
    // Docked, the bar slides along the edge with the pointer. Floating, it keeps the spot where
    // it was grabbed under the pointer.
    const cx = edge === 'free' ? left + w / 2 : x;
    const cy = edge === 'free' ? top + hgt / 2 : y;
    return { edge, x: cx / W, y: cy / H };
  }

  function onBarPointerDown(e) {
    if (e.button !== 0 || e.target.closest('button:not(.logo),input,select')) return;
    e.preventDefault();
    const r = ui.bar.getBoundingClientRect();
    // Where along the horizontal bar it's held. A vertical bar counts as held by the end nearest
    // its side, so a short pull away from either side turns it horizontal again.
    const vertical = ui.root.classList.contains('vertical');
    const fx = !vertical ? (e.clientX - r.left) / r.width : r.left < viewport().W / 2 ? 0.05 : 0.95;
    const fy = vertical ? 0.5 : (e.clientY - r.top) / r.height;
    ui.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, fx, fy, moved: false, onLogo: !!e.target.closest('button.logo'),
      locked: settings.lockDock };
    try {
      ui.bar.setPointerCapture(e.pointerId); // keep getting moves when the pointer outruns the bar
    } catch {
      // Not a real pointer.
    }
  }

  function onBarPointerMove(e) {
    const g = ui?.drag;
    if (!g || e.pointerId !== g.id) return;
    if (!g.moved && Math.hypot(e.clientX - g.x0, e.clientY - g.y0) < 4) return;
    if (g.locked) {
      // Locked: a little shake says so, once per drag.
      if (!g.moved) {
        ui.bar.classList.remove('shake');
        void ui.bar.offsetWidth; // restart the animation
        ui.bar.classList.add('shake');
        showToast('Position locked');
      }
      g.moved = true;
      return;
    }
    g.moved = true;
    ui.bar.classList.add('dragging');
    ui.dragDock = dockAt(e.clientX, e.clientY);
    layoutUI();
  }

  function onBarPointerUp(e) {
    const g = ui?.drag;
    if (!g || e.pointerId !== g.id) return;
    ui.drag = null;
    ui.bar.classList.remove('dragging');
    // The bar holds on to the pointer while it's down, so the logo never gets the click itself.
    if (!g.moved) {
      if (g.onLogo) togglePanel('look');
      return;
    }
    if (g.locked) return;
    const dock = ui.dragDock;
    ui.dragDock = null;
    setDock(dock);
  }

  // ---------- Shrink when not in use ----------

  const EXPAND_DELAY = 80;  // ms of pointing before it opens, so passing over it doesn't
  const SHRINK_DELAY = 500; // ms after the pointer leaves (NN/g's timing for things shown on hover)

  function shouldShrink() {
    if (!ui || !settings.autoShrink || ui.hover || ui.drag) return false;
    if (Object.values(ui.panels).some(({ panel }) => !panel.hidden)) return false;
    return !ui.root.querySelector(':focus-visible'); // keyboard focus keeps it open; a mouse click doesn't
  }

  function updateShrink() {
    if (!ui) return;
    clearTimeout(ui.shrinkTimer);
    const shrunk = shouldShrink();
    if (shrunk === ui.shrunk) return;
    ui.shrunk = shrunk;
    layoutUI();
  }

  function scheduleShrink() {
    if (!ui) return;
    clearTimeout(ui.shrinkTimer);
    ui.shrinkTimer = setTimeout(updateShrink, SHRINK_DELAY);
  }

  function setHover(hover) {
    if (!ui) return;
    ui.hover = hover;
    clearTimeout(ui.shrinkTimer);
    if (hover) ui.shrinkTimer = setTimeout(updateShrink, EXPAND_DELAY);
    else scheduleShrink();
  }

  // ---------- Panels ----------

  // Scrolling over a panel scrolls only the panel, never the page behind it: the list stops at
  // its ends (overscroll-behavior), and the parts that can't scroll (the title) swallow the wheel.
  function onPanelWheel(e) {
    e.stopPropagation(); // and it isn't scrolling away from the reading
    const list = e.currentTarget.querySelector('.list');
    if (!list?.contains(e.target) || list.scrollHeight <= list.clientHeight) e.preventDefault();
  }

  // One panel at a time: the page map, voices, or Options.
  function togglePanel(name, open) {
    if (!ui) return;
    open ??= ui.panels[name].panel.hidden;
    for (const [key, { panel, btn }] of Object.entries(ui.panels)) {
      const on = open && key === name;
      panel.hidden = !on;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-expanded', String(on));
    }
    if (open) updateShrink(); // a panel keeps the bar open
    layoutUI();
    if (!open) scheduleShrink();
    if (open && name === 'map') updateMapCurrent(true);
    if (open && name === 'voice') ui.voiceList.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }

  function toggleMap(open) {
    togglePanel('map', open);
  }

  function toggleOptions(open) {
    togglePanel('opts', open);
  }

  function closePanels() {
    if (ui && Object.values(ui.panels).some(({ panel }) => !panel.hidden)) togglePanel('map', false);
  }

  // A panel's title and note, with a × to close it.
  function panelHead(title, note) {
    return h('div', { className: 'head' }, button('small close', 'Close', 'close', closePanels), title,
      h('small', { textContent: note }));
  }

  // ---------- Options panel ----------

  const SWITCHES = [
    ['Start reading', [
      ['clickToRead', 'Click to read', 'Click any text to read from that word. The dotted underline shows where it will start.'],
      ['selectionButton', 'Play button on selected text', 'Select text, then press the play button to hear just that part.'],
      ['paragraphButtons', 'Play buttons beside paragraphs', 'Rest the pointer on a paragraph to get a play button in the margin.'],
    ]],
    ['While reading', [
      ['follow', 'Follow along', 'Scroll with the reading. Scrolling by hand pauses this until you press "Back to reading".'],
      ['lineFocus', 'Line focus', 'Dim the page except the sentence being read.'],
      ['wideSpacing', 'Wider text spacing', 'More space between letters, words and lines. Can make text easier to read.'],
    ]],
  ];
  // [value, label, tooltip]
  const HL_STYLES = [['both', 'Both', 'Sentence and word'], ['sentence', 'Sentence', 'Sentence only'], ['word', 'Word', 'Word only']];

  function buildOptions() {
    const inputs = {};
    const body = h('div', { className: 'list' });
    for (const [group, rows] of SWITCHES) {
      body.append(h('div', { className: 'label', textContent: group }));
      for (const [key, label, help] of rows) {
        const input = h('input', { type: 'checkbox', className: 'switch' });
        input.setAttribute('role', 'switch');
        input.addEventListener('change', () => setOption(key, input.checked));
        inputs[key] = input;
        body.append(h('label', { className: 'opt' }, h('span', {}, label, h('small', { textContent: help })), input));
      }
    }
    body.append(h('div', { className: 'label', textContent: 'Highlight' }));
    const swatches = {};
    const swatchRow = h('div', { className: 'swatches' });
    for (const [key, c] of Object.entries(HL_COLORS)) {
      const b = h('button', { className: 'swatch', type: 'button', title: c.name });
      b.setAttribute('aria-label', `${c.name} highlight`);
      b.style.background = c.word;
      b.addEventListener('click', () => setOption('hlColor', key));
      swatches[key] = b;
      swatchRow.append(b);
    }
    const styles = {};
    const seg = h('div', { className: 'seg', role: 'group' });
    seg.setAttribute('aria-label', 'What to highlight');
    for (const [key, label, title] of HL_STYLES) {
      const b = h('button', { type: 'button', textContent: label, title });
      b.addEventListener('click', () => setOption('hlStyle', key));
      styles[key] = b;
      seg.append(b);
    }
    body.append(swatchRow, seg);
    const panel = h('div', { className: 'panel glass', hidden: true },
      panelHead('Options', 'Ways to start reading, and how reading looks.'),
      body);
    return { panel, inputs, swatches, styles };
  }

  function updateOptionsUI() {
    if (!ui) return;
    for (const [key, input] of Object.entries(ui.opts.inputs)) input.checked = !!settings[key];
    const look = ui.look;
    const edge = (settings.dock || DEFAULT_SETTINGS.dock).edge;
    for (const [key, b] of Object.entries(look.docks)) b.classList.toggle('on', key === edge);
    look.dockInfo.replaceChildren(h('b', { textContent: DOCK_NAMES[edge] || DOCK_NAMES.bottom }),
      settings.lockDock ? 'Locked in place. Tap an edge to move it.' : 'Drag the logo to move it, or tap an edge.');
    look.lock.checked = !!settings.lockDock;
    look.shrink.checked = !!settings.autoShrink;
    ui.shrinkBtn.classList.toggle('on', !!settings.autoShrink);
    ui.shrinkBtn.setAttribute('aria-pressed', String(!!settings.autoShrink));
    ui.shrinkBtn.title = `Shrink when not in use: ${settings.autoShrink ? 'on' : 'off'}`;
    look.tint.checked = !!settings.glassTint;
    look.clarity.value = settings.glassClarity;
    const shapes = Object.fromEntries(Object.entries(ui.look.shapes).map(([k, v]) => [k, v.btn]));
    for (const [group, value] of [[ui.opts.swatches, settings.hlColor], [ui.opts.styles, settings.hlStyle],
      [shapes, settings.logo], [ui.look.colors, settings.color], [ui.look.barShapes, settings.barShape]]) {
      for (const [key, b] of Object.entries(group)) {
        b.classList.toggle('on', key === value);
        b.setAttribute('aria-pressed', String(key === value));
      }
    }
  }

  function setOption(key, value) {
    settings[key] = value;
    chrome.storage.sync.set({ [key]: value }).catch(() => {});
    if (key === 'hlColor' || key === 'hlStyle' || key === 'wideSpacing' || key === 'lineFocus') applyDisplaySettings();
    if (key === 'hlColor') colorSelectionButton();
    if (key === 'clickToRead' && !value) hoverHL?.clear();
    if (key === 'selectionButton' && !value) hideSelectionButton();
    if (key === 'paragraphButtons' && !value) hideParagraphButton();
    if (key === 'follow' && value) setDetached(false);
    if (key === 'logo' || key === 'color') applyLook();
    if (/^(glass|barShape|lockDock)/.test(key)) applyGlass();
    if (key === 'autoShrink') scheduleShrink(); // shrinks once you've moved away
    updateOptionsUI();
  }

  // ---------- Appearance: the logo and color, chosen by clicking the logo ----------

  function lookPalette() {
    return (typeof WREN_MARK !== 'undefined' && WREN_MARK.palettes[settings.color]) ||
      { g: ['#ffb547', '#ff5e3a'], accent: ['#ff5e3a', '#ff6a45'], text: ['#e5482a', '#ff8a66'] };
  }

  function buildLook() {
    const shapes = {};
    const shapeRow = h('div', { className: 'shapes' });
    const colors = {};
    const colorRow = h('div', { className: 'colors' });
    if (typeof WREN_MARK !== 'undefined') {
      for (const [key, name] of Object.entries(WREN_MARK.shapes)) {
        const canvas = h('canvas', { width: 96, height: 96 });
        const b = h('button', { className: 'shape', type: 'button' }, canvas, name);
        b.addEventListener('click', () => setOption('logo', key));
        shapes[key] = { btn: b, canvas };
        shapeRow.append(b);
      }
      for (const [key, pal] of Object.entries(WREN_MARK.palettes)) {
        const b = h('button', { className: 'swatch', type: 'button', title: pal.name });
        b.setAttribute('aria-label', `${pal.name} color`);
        b.style.background = `linear-gradient(135deg, ${pal.g[0]}, ${pal.g[1]})`;
        b.addEventListener('click', () => setOption('color', key));
        colors[key] = b;
        colorRow.append(b);
      }
    }
    // Position: a small screen with the four edges to send the player to.
    const docks = {};
    const screen = h('div', { className: 'screen' });
    for (const [edge, title] of DOCK_TITLES) {
      const b = h('button', { className: `d-${edge}`, type: 'button', title });
      b.setAttribute('aria-label', title);
      if (edge === 'free') b.disabled = true;
      else b.addEventListener('click', () => setDock({ edge, x: 0.5, y: 0.5 }));
      docks[edge] = b;
      screen.append(b);
    }
    const dockInfo = h('div', { className: 'dockinfo' });
    const shrink = h('input', { type: 'checkbox', className: 'switch' });
    shrink.setAttribute('role', 'switch');
    shrink.addEventListener('change', () => setOption('autoShrink', shrink.checked));
    const lock = h('input', { type: 'checkbox', className: 'switch' });
    lock.setAttribute('role', 'switch');
    lock.addEventListener('change', () => setOption('lockDock', lock.checked));

    // Glass: how clear it is, its corners, and a tint.
    const clarity = h('input', { type: 'range', className: 'range', min: 0, max: 100, step: 1 });
    clarity.setAttribute('aria-label', 'Glass, from clear to frosted');
    clarity.addEventListener('input', () => {
      settings.glassClarity = +clarity.value; // live, saved when let go
      applyGlass();
    });
    clarity.addEventListener('change', () => setOption('glassClarity', +clarity.value));
    const barShapes = {};
    const shapeSeg = h('div', { className: 'seg', role: 'group' });
    shapeSeg.setAttribute('aria-label', 'Shape of the player');
    for (const [key, label] of [['pill', 'Pill'], ['rounded', 'Rounded']]) {
      const b = h('button', { type: 'button', textContent: label });
      b.addEventListener('click', () => setOption('barShape', key));
      barShapes[key] = b;
      shapeSeg.append(b);
    }
    const tint = h('input', { type: 'checkbox', className: 'switch' });
    tint.setAttribute('role', 'switch');
    tint.addEventListener('change', () => setOption('glassTint', tint.checked));

    const panel = h('div', { className: 'panel glass', hidden: true },
      panelHead('Appearance', 'The logo, color, glass, and where the player sits.'),
      h('div', { className: 'list' },
        h('div', { className: 'label', textContent: 'Logo' }), shapeRow,
        h('div', { className: 'label', textContent: 'Color' }), colorRow,
        h('div', { className: 'label', textContent: 'Position' }),
        h('div', { className: 'dockpick' }, screen, dockInfo),
        h('label', { className: 'opt' }, h('span', {}, 'Shrink when not in use', h('small', { textContent: 'Shows just the logo and play button. Point at it to see everything.' })), shrink),
        h('label', { className: 'opt' }, h('span', {}, 'Lock position', h('small', { textContent: 'Keep the player where it is, so it can\'t be dragged by accident.' })), lock),
        h('div', { className: 'label', textContent: 'Glass' }),
        h('div', { className: 'slider' }, 'Clear', clarity, 'Frosted'),
        shapeSeg,
        h('label', { className: 'opt' }, h('span', {}, 'Tint with color', h('small', { textContent: 'Shade the glass with your color.' })), tint)));
    return { panel, shapes, colors, docks, dockInfo, shrink, lock, clarity, barShapes, tint };
  }

  const DOCK_TITLES = [['top', 'Dock at the top'], ['bottom', 'Dock at the bottom'], ['left', 'Dock on the left (vertical)'],
    ['right', 'Dock on the right (vertical)'], ['free', 'Floating']];
  const DOCK_NAMES = { top: 'Docked at the top', bottom: 'Docked at the bottom', left: 'Docked on the left',
    right: 'Docked on the right', free: 'Floating' };

  // The glass of the bar, panels and messages: clarity sets how see-through and how blurred it
  // is, and the tint and shape apply to all of them.
  function applyGlass() {
    if (!ui) return;
    const c = Math.max(0, Math.min(100, settings.glassClarity)) / 100;
    ui.root.style.setProperty('--glass-a', (0.35 + 0.6 * c).toFixed(3));
    ui.root.style.setProperty('--panel-a', (0.62 + 0.34 * c).toFixed(3)); // panels stay readable over the page
    ui.root.style.setProperty('--blur', `${Math.round(10 + 30 * c)}px`);
    ui.look.clarity.style.setProperty('--v', settings.glassClarity);
    ui.root.classList.toggle('tinted', !!settings.glassTint);
    ui.root.classList.toggle('rounded', settings.barShape === 'rounded');
    ui.root.classList.toggle('locked', !!settings.lockDock);
  }

  // Color the player, the play buttons on the page, and the logo with the chosen palette.
  function applyLook() {
    if (!ui) return;
    const pal = lookPalette();
    const vars = { '--g1': pal.g[0], '--g2': pal.g[1], '--a-l': pal.accent[0], '--a-d': pal.accent[1], '--t-l': pal.text[0], '--t-d': pal.text[1] };
    for (const el of [ui.root, pointer?.host]) {
      if (el) for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
    }
    if (!ui.logo.raf) drawLogoFrame(ui.logo, performance.now());
    for (const [key, { canvas }] of Object.entries(ui.look.shapes)) {
      WREN_MARK.draw(canvas.getContext('2d'), canvas.width, { shape: key, color: settings.color, round: true });
    }
    applyGlass();
    applyDisplaySettings(); // the click-to-read underline
    updateOptionsUI();
  }

  // Scrolling by hand stops the page following the reading, until "Back to reading".
  function setDetached(detached) {
    if (state.detached === detached) return;
    state.detached = detached;
    if (ui) {
      ui.backBtn.hidden = !detached;
      layoutUI(); // the bar changed size
    }
    updateFocus();
  }

  function onUserScroll() {
    if (ui && state.playing && settings.follow && !state.detached) setDetached(true);
  }

  // ---------- Voices ----------

  // "AI: Heart (US, female)" -> "Heart", "Microsoft Aria Online (Natural) - English" -> "Aria".
  function shortVoiceName(name) {
    return name.replace(/^AI: /, '').replace(/^(Microsoft|Google) /, '').split(/ [(-]/)[0];
  }

  function populateVoices() {
    if (!ui) return;
    const lang = pageLang();
    const all = usableVoices();
    const ai = all.filter((v) => v.engine === 'ai');
    const voices = all.filter((v) => v.engine !== 'ai').sort((a, b) => a.voiceName.localeCompare(b.voiceName));
    const mine = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
    const other = voices.filter((v) => !mine.includes(v));
    const items = [];
    const addGroup = (label, list, strip = '') => {
      if (!list.length) return;
      items.push(h('div', { className: 'label', textContent: label }));
      for (const v of list) {
        const b = h('button', { className: 'voice', type: 'button', title: v.voiceName },
          h('span', { textContent: v.voiceName.replace(strip, '') }), h('small', { textContent: v.lang }));
        b.dataset.voice = v.voiceName;
        b.addEventListener('click', () => setVoice(v.voiceName));
        items.push(b);
      }
    };
    addGroup('Natural AI voices (English)', ai, 'AI: ');
    addGroup('Built-in voices: page language', mine);
    addGroup('Built-in voices: other languages', other);
    ui.voiceList.replaceChildren(...items);
    updateVoiceUI();
  }

  function updateVoiceUI() {
    if (!ui) return;
    const name = currentVoice()?.voiceName || '';
    ui.voiceLabel.textContent = name ? shortVoiceName(name) : 'Voice';
    ui.voiceBtn.title = name ? `Voice: ${name.replace(/^AI: /, '')}` : 'Voice';
    for (const b of ui.voiceList.querySelectorAll('button.voice')) {
      b.classList.toggle('on', b.dataset.voice === name);
      b.setAttribute('aria-pressed', String(b.dataset.voice === name));
    }
    layoutUI(); // the name changes the bar's width
  }

  // ---------- Page map ----------

  function renderMap() {
    if (!ui) return;
    ui.mapRows.clear();
    const minLevel = Math.min(...state.sections.map((s) => s.level));
    const rows = state.sections.map((sec) => {
      const count = sectionItems(sec).length;
      const check = h('input', { type: 'checkbox', className: 'check', checked: sec.enabled,
        title: sec.enabled ? 'Skip this section' : 'Read this section' });
      check.addEventListener('change', () => setSectionEnabled(sec, check.checked));
      const title = h('button', { className: 'title', type: 'button', textContent: sec.title, title: sec.title, disabled: !count });
      title.addEventListener('click', () => jumpToSection(sec));
      const row = h('div', { className: 'row' + (sec.enabled ? '' : ' off') }, check, title,
        h('span', { className: 'count', textContent: count, title: `${count} sentence${count === 1 ? '' : 's'}` }));
      row.style.setProperty('--indent', Math.min(sec.level - minLevel, 3));
      ui.mapRows.set(sec, row);
      return row;
    });
    ui.mapList.replaceChildren(...rows);
    ui.mapSec = null;
    updateMapCurrent(true);
  }

  // Mark the section being read, and keep it in view in the panel.
  function updateMapCurrent(force = false) {
    if (!ui) return;
    const sec = state.queue[state.idx]?.sec || null;
    if (sec === ui.mapSec && !force) return;
    ui.mapRows.get(ui.mapSec)?.classList.remove('current');
    ui.mapSec = sec;
    const row = ui.mapRows.get(sec);
    if (!row) return;
    row.classList.add('current');
    if (ui.mapPanel.hidden) return;
    const list = ui.mapList;
    if (row.offsetTop < list.scrollTop || row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = row.offsetTop - list.clientHeight / 3;
    }
  }

  // ---------- Status ----------

  // The sentence count sits on the bar. Messages ("Finished", "Loading AI voice 40%") replace it;
  // on a vertical bar, where there's no room, they show in a bubble beside it for a few seconds.
  const TOAST_TIME = 4000;

  function setStatus(text, isMessage = true) {
    if (!ui) return;
    ui.statusText = text;
    ui.status.textContent = text;
    showToast(isMessage && (ui.shrunk || ui.root.classList.contains('vertical')) ? text : '');
  }

  // A bubble beside the bar for a few seconds ('' hides it).
  function showToast(text) {
    if (!ui) return;
    clearTimeout(ui.toastTimer);
    ui.toastText = text;
    ui.toast.textContent = text;
    layoutUI();
    if (!text) return;
    ui.toastTimer = setTimeout(() => {
      if (!ui) return;
      ui.toastText = '';
      layoutUI();
    }, TOAST_TIME);
  }

  function updateUI() {
    if (!ui) return;
    ui.playBtn.replaceChildren(icon(state.playing ? 'pause' : 'play'));
    setLogoPlaying(ui.logo, state.playing);
    if (ui.iconPlaying !== state.playing) {
      ui.iconPlaying = state.playing;
      send({ type: 'iconState', playing: state.playing });
    }
    ui.rateLabel.textContent = settings.rate.toFixed(1) + '×';
    const total = state.queue.length;
    ui.ring.style.setProperty('--p', total ? Math.min(state.idx, total) / total : 0);
    if (total && state.idx < total) setStatus(`${state.idx + 1} / ${total}`, false);
    updateMapCurrent();
  }

  async function ensureReady() {
    if (!ui) buildUI();
    if (!state.voices) {
      try {
        Object.assign(settings, await chrome.storage.sync.get(DEFAULT_SETTINGS));
      } catch {
        // Fall back to defaults.
      }
      // Jump straight to the remembered spot rather than gliding there.
      ui?.bar.classList.add('instant');
      layoutUI();
      requestAnimationFrame(() => ui?.bar.classList.remove('instant'));
      scheduleShrink(); // the full bar shows briefly, then shrinks if that's switched on
      const voices = await send({ type: 'getVoices' });
      state.voices = Array.isArray(voices) ? voices : [];
      populateVoices();
    }
    applyLook();
    colorSelectionButton();
    updateUI();
  }

  function teardown() {
    if (state.playing || state.paused) send({ type: 'stop' });
    state.gen++;
    clearTimers();
    state.playing = false;
    state.sections = [];
    state.queue = [];
    state.idx = 0;
    state.current = null;
    state.limit = null;
    removeHighlights();
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('click', onAltClick, true);
    window.removeEventListener('click', onPageClick, true);
    removePointerButtons();
    if (ui?.iconPlaying) {
      ui.iconPlaying = false; // first, so an error from send can't bring us back here
      send({ type: 'iconState', playing: false });
    }
    if (ui) {
      cancelAnimationFrame(ui.logo.raf);
      clearTimeout(ui.toastTimer);
      clearTimeout(ui.shrinkTimer);
    }
    window.removeEventListener('resize', layoutUI);
    ui?.host.remove();
    ui = null;
  }

  // ---------- Input ----------

  const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ']);

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      hideSelectionButton();
      hideParagraphButton();
      closePanels();
    }
    if (!e.altKey && !e.ctrlKey && !e.metaKey && SCROLL_KEYS.has(e.key) && !e.target.closest?.(INTERACTIVE_SEL)) onUserScroll();
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    const actions = {
      ArrowRight: () => jump(1),
      ArrowLeft: () => jump(-1),
      ArrowUp: () => setRate(settings.rate + RATE_STEP),
      ArrowDown: () => setRate(settings.rate - RATE_STEP),
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
    startAt(pos.startContainer, pos.startOffset);
  }

  // ---------- Starting from where you point (like Speechify and NaturalReader) ----------
  // Each can be switched off in Options:
  // - Click to read: click any text to read from that word. Hovering underlines where it would start.
  // - Selecting text shows a play button that reads just the selection.
  // - Resting the pointer on a paragraph shows a play button in its margin.
  // Timings follow NN/g's guidance for things shown on hover: wait before showing and keep them
  // a moment after the pointer leaves, so nothing flickers as the pointer passes over the page.

  // Clicks on these keep their normal job.
  const INTERACTIVE_SEL = 'a,button,input,textarea,select,option,label,summary,video,audio,iframe,' +
    '[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[contenteditable=""],[contenteditable="true"]';
  const SHOW_DELAY = 400;        // pointer resting on a paragraph before its button shows
  const HIDE_DELAY = 500;        // button stays this long after the pointer leaves
  const DOUBLE_CLICK_WAIT = 300; // a second click within this is a double-click (selecting a word)
  const MIN_SELECTION = 3;       // characters, so a stray click-drag doesn't bring up a button

  let pointer = null; // the play buttons and their timers
  let clickTimer = null;

  // The text position under the pointer, or null if the pointer isn't over a character.
  function textAt(x, y) {
    const pos = document.caretRangeFromPoint?.(x, y);
    const node = pos?.startContainer;
    if (!node || node.nodeType !== Node.TEXT_NODE || !node.data.trim()) return null;
    // caretRangeFromPoint finds the nearest text even from empty space, so check a character is there.
    const r = document.createRange();
    for (const i of [pos.startOffset - 1, pos.startOffset]) {
      if (i < 0 || i >= node.length) continue;
      r.setStart(node, i);
      r.setEnd(node, i + 1);
      for (const rect of r.getClientRects()) {
        if (x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2) {
          return { node, offset: pos.startOffset };
        }
      }
    }
    return null;
  }

  function overOurUI(e) {
    return e.composedPath().some((n) => n === ui?.host || n === pointer?.host);
  }

  function onPageClick(e) {
    if (!ui || e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    clearTimeout(clickTimer);
    // Double and triple clicks select a word or line: leave those alone.
    if (!settings.clickToRead || e.detail > 1 || overOurUI(e)) return;
    if (e.target.closest?.(INTERACTIVE_SEL) || hasSelection()) return;
    const at = textAt(e.clientX, e.clientY);
    if (!at) return;
    // Wait a moment, in case this is the first click of a double-click.
    clickTimer = setTimeout(() => {
      if (!ui || hasSelection()) return;
      hoverHL?.clear();
      startAt(at.node, at.offset);
    }, DOUBLE_CLICK_WAIT);
  }

  // Click to read: underline from the word under the pointer to the end of its sentence, so it's
  // clear what a click would read.
  function updateHoverPreview(ev) {
    if (!hoverHL) return;
    hoverHL.clear();
    clearTimeout(prepareTimer);
    if (!settings.clickToRead || ev.buttons || hasSelection() || ev.target.closest?.(INTERACTIVE_SEL)) return;
    const at = textAt(ev.clientX, ev.clientY);
    if (!at) return;
    prepareTimer = setTimeout(() => prepareAt(at.node, at.offset), PREPARE_DELAY);
    const loc = locate(at.node, at.offset);
    if (loc) {
      const t = loc.item.model.text;
      let start = loc.off;
      while (start > loc.item.start && /\S/.test(t[start - 1])) start--;
      const r = makeRange(loc.item.model, start, loc.item.end);
      if (r) hoverHL.add(r);
    } else {
      // Outside the article: underline from the word to the end of this piece of text.
      const d = at.node.data;
      let start = at.offset;
      while (start > 0 && /\S/.test(d[start - 1])) start--;
      const r = document.createRange();
      r.setStart(at.node, start);
      r.setEnd(at.node, d.length);
      hoverHL.add(r);
    }
  }

  const POINTER_CSS = `
    button { all: unset; position: fixed; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%;
      background: linear-gradient(135deg, var(--g1, #ffb547), var(--g2, #ff5e3a)); color: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.3); cursor: pointer; }
    button:hover { filter: brightness(1.07); }
    button:focus-visible { outline: 2px solid var(--g2, #ff5e3a); outline-offset: 2px; }
    button[hidden] { display: none; }
    button.sel { color: #111; }
    button.sel:hover { filter: brightness(.93); }
    button.para { width: 24px; height: 24px; opacity: .85; }
    button.para:hover { opacity: 1; }
    svg { width: 18px; height: 18px; fill: currentColor; }
  `;

  function buildPointerButtons() {
    const host = h('div', { id: 'voice-reader-pointer' });
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    const make = (cls, title, onClick) => {
      const b = button(cls, title, 'play', onClick);
      b.hidden = true;
      b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
      return b;
    };
    const selBtn = make('sel', 'Read the selected text', () => {
      const r = pointer.selRange;
      hideSelectionButton();
      getSelection()?.removeAllRanges();
      if (r) readSelection(r);
    });
    const paraBtn = make('para', 'Read from this paragraph', () => {
      const block = pointer.paraBlock;
      hideParagraphButton();
      if (block) startAtItem(state.sections.flatMap(sectionItems).find((it) => it.model.el === block));
    });
    shadow.append(h('style', { textContent: POINTER_CSS }), selBtn, paraBtn);
    document.documentElement.appendChild(host);
    pointer = {
      host, selBtn, paraBtn, selRange: null,
      paraBlock: null, pendingBlock: null, showTimer: null, hideTimer: null,
      moveQueued: false, lastMove: null,
    };
    colorSelectionButton();
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('keyup', onKeyUp, true);
    document.addEventListener('mousemove', onMouseMove, { passive: true });
    document.addEventListener('mouseout', onMouseOut, true);
    document.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('wheel', onUserScroll, { passive: true });
    window.addEventListener('touchmove', onUserScroll, { passive: true });
  }

  function removePointerButtons() {
    clearTimeout(clickTimer);
    if (!pointer) return;
    clearTimeout(pointer.showTimer);
    clearTimeout(pointer.hideTimer);
    document.removeEventListener('selectionchange', onSelectionChange);
    document.removeEventListener('mouseup', onMouseUp, true);
    document.removeEventListener('keyup', onKeyUp, true);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseout', onMouseOut, true);
    document.removeEventListener('mousedown', onMouseDown, true);
    window.removeEventListener('scroll', onScroll, { capture: true });
    window.removeEventListener('wheel', onUserScroll);
    window.removeEventListener('touchmove', onUserScroll);
    pointer.host.remove();
    pointer = null;
  }

  // Put a button at a spot, kept inside the window.
  function place(btn, left, top) {
    const size = btn.offsetWidth || 30;
    btn.style.left = Math.max(4, Math.min(innerWidth - size - 4, left)) + 'px';
    btn.style.top = Math.max(4, Math.min(innerHeight - size - 4, top)) + 'px';
  }

  // ----- Selection button: shown once the selection is finished, not while dragging -----

  function onSelectionChange() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed) hideSelectionButton();
  }

  function onMouseUp(e) {
    if (pointer && !overOurUI(e)) setTimeout(updateSelectionButton, 10);
  }

  function onKeyUp(e) {
    if (e.shiftKey || e.key === 'Shift') updateSelectionButton(); // selecting with Shift+arrows
  }

  function updateSelectionButton() {
    if (!pointer) return;
    if (!settings.selectionButton) return hideSelectionButton();
    const sel = getSelection();
    const text = sel && sel.rangeCount && !sel.isCollapsed ? sel.toString() : '';
    if (text.replace(/\s+/g, '').length < MIN_SELECTION) return hideSelectionButton();
    const range = sel.getRangeAt(0);
    const common = range.commonAncestorContainer;
    const el = common.nodeType === Node.ELEMENT_NODE ? common : common.parentElement;
    if (!el || el.closest('input,textarea,[contenteditable=""],[contenteditable="true"]')) return hideSelectionButton();
    const rects = range.getClientRects();
    const last = rects[rects.length - 1];
    if (!last) return hideSelectionButton();
    pointer.selRange = range.cloneRange();
    pointer.selBtn.hidden = false;
    place(pointer.selBtn, last.right + 6, last.top + last.height / 2 - 15);
  }

  // The selection's play button matches the highlight color, so it reads as "play what I
  // highlighted". The other play buttons keep the bar's blue.
  function colorSelectionButton() {
    if (pointer) pointer.selBtn.style.background = (HL_COLORS[settings.hlColor] || HL_COLORS.yellow).word;
  }

  function hideSelectionButton() {
    if (!pointer) return;
    pointer.selBtn.hidden = true;
    pointer.selRange = null;
  }

  // ----- Paragraph button: shown after the pointer rests on a paragraph -----

  // The article block under the pointer, if it's one the reader knows about.
  let blockCache = { sections: null, blocks: null };
  function readableBlockAt(target) {
    if (blockCache.sections !== state.sections) {
      blockCache = { sections: state.sections, blocks: new Set(state.sections.flatMap((s) => s.blocks)) };
    }
    const blocks = blockCache.blocks;
    for (let el = target, d = 0; el && el !== document.body && d < 8; el = el.parentElement, d++) {
      if (blocks.has(el)) return el;
    }
    return null;
  }

  function onMouseMove(e) {
    if (!pointer || !ui) return;
    pointer.lastMove = e;
    if (pointer.moveQueued) return;
    pointer.moveQueued = true;
    requestAnimationFrame(() => {
      if (!pointer) return;
      pointer.moveQueued = false;
      const ev = pointer.lastMove;
      if (overOurUI(ev)) {
        hoverHL?.clear();
        if (ev.composedPath().includes(pointer.paraBtn)) cancelParagraphHide();
        return;
      }
      updateHoverPreview(ev);
      updateParagraphButton(ev);
    });
  }

  function updateParagraphButton(ev) {
    if (!settings.paragraphButtons) return;
    const block = ev.target.nodeType === Node.ELEMENT_NODE ? readableBlockAt(ev.target) : null;
    // No button beside the paragraph that's already being read.
    const reading = state.playing ? state.current?.model.el : null;
    const target = block && block !== reading ? block : null;
    if (target && target === pointer.paraBlock) {
      cancelParagraphHide();
      return;
    }
    if (target !== pointer.pendingBlock) {
      clearTimeout(pointer.showTimer);
      pointer.pendingBlock = target;
      if (target) pointer.showTimer = setTimeout(() => showParagraphButton(target), SHOW_DELAY);
    }
    // Left the paragraph: hide in a moment. Moving around doesn't restart the countdown.
    if (pointer.paraBlock && !pointer.hideTimer) pointer.hideTimer = setTimeout(hideParagraphButton, HIDE_DELAY);
  }

  function cancelParagraphHide() {
    clearTimeout(pointer.hideTimer);
    pointer.hideTimer = null;
  }

  function showParagraphButton(block) {
    if (!pointer || !settings.paragraphButtons) return;
    cancelParagraphHide();
    pointer.pendingBlock = null;
    pointer.paraBlock = block;
    const rect = block.getBoundingClientRect();
    pointer.paraBtn.hidden = false;
    place(pointer.paraBtn, rect.left - 32, rect.top);
    const idx = state.queue.findIndex((it) => it.model.el === block);
    if (idx >= 0) prepareFrom(idx, state.queue[idx].start);
  }

  function hideParagraphButton() {
    if (!pointer) return;
    clearTimeout(pointer.showTimer);
    cancelParagraphHide();
    pointer.paraBtn.hidden = true;
    pointer.paraBlock = null;
    pointer.pendingBlock = null;
  }

  function onMouseOut(e) {
    if (!pointer || e.relatedTarget) return;
    // The pointer left the window.
    hoverHL?.clear();
    clearTimeout(pointer.showTimer);
    pointer.pendingBlock = null;
  }

  function onMouseDown(e) {
    // Dragging the page's scrollbar counts as scrolling by hand.
    const doc = document.documentElement;
    if (e.clientX >= doc.clientWidth || e.clientY >= doc.clientHeight) onUserScroll();
    // A press that may become a click to read: prepare from there now, in case the pointer
    // didn't rest first.
    if (ui && settings.clickToRead && e.button === 0 && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey &&
        e.detail <= 1 && !overOurUI(e) && !e.target.closest?.(INTERACTIVE_SEL)) {
      clearTimeout(prepareTimer);
      const at = textAt(e.clientX, e.clientY);
      if (at) prepareAt(at.node, at.offset);
    }
  }

  function onScroll() {
    if (!pointer) return;
    hideParagraphButton();
    hoverHL?.clear();
    if (!pointer.selBtn.hidden) updateSelectionButton();
    if (settings.lineFocus) requestAnimationFrame(updateFocus);
  }

  window.addEventListener('pagehide', () => {
    if (state.playing) send({ type: 'stop' });
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    sendResponse({ ok: true });
    switch (msg.type) {
      case 'toggle':
        if (!ui || hasSelection()) startReading({ fromSelection: true });
        else if (state.playing) pauseReading();
        else play();
        break;
      case 'readPage':
        startReading({ fromSelection: false });
        break;
      case 'readSelection':
        startReading({ fromSelection: true });
        break;
      case 'readSelectionOnly': {
        const sel = getSelection();
        if (!sel?.rangeCount || sel.isCollapsed) break;
        const range = sel.getRangeAt(0).cloneRange();
        sel.removeAllRanges();
        ensureReady().then(() => readSelection(range));
        break;
      }
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
