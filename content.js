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
    return last ? last.end : 0;
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
      for (let j = i; j < q.length && q[j].model === model; j++) {
        if (q[j].end > off) return j;
      }
      return i;
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
        '::highlight(voice-reader-hover){text-decoration:underline 2px dotted #4f8cff;text-underline-offset:4px;}' +
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

  // Speak the current sentence. Reading can start at a word partway through it (a click or a
  // selection): `from` is that word's offset. Without it, a restart of the same sentence (pause
  // and play, speed or voice change) keeps the word it started from.
  function speakCurrent(from = null) {
    clearTimers();
    const base = state.queue[state.idx];
    if (!base) return finish();
    if (from == null && state.current?.base === base) from = state.current.start;
    const start = from != null && from > base.start && from < base.end ? from : base.start;
    // Reading just a selection: the last sentence stops where the selection does.
    const end = state.limit?.item === base ? Math.max(start + 1, Math.min(base.end, state.limit.end)) : base.end;
    const item = start === base.start && end === base.end
      ? base
      : { ...base, start, end, text: base.text.slice(start - base.start, end - base.start), base };
    state.current = item;
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
    if (state.limit && state.queue[state.idx] === state.limit.item) return finishSelection();
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
    button.on { background: rgba(138,180,255,.22); color: #cfe0ff; }
    .wrap { display: flex; flex-direction: column; align-items: center; gap: 8px; }
    .map { width: 380px; max-width: calc(100vw - 32px); max-height: min(50vh, 440px); display: flex; flex-direction: column;
      background: #1f2330; color: #f2f4f8; border-radius: 14px; box-shadow: 0 8px 28px rgba(0,0,0,.35);
      font: 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; user-select: none; overflow: hidden; }
    .map[hidden] { display: none; }
    .map-head { padding: 10px 14px 8px; font-weight: 600; border-bottom: 1px solid rgba(255,255,255,.1); }
    .map-head small { display: block; font-weight: 400; opacity: .6; margin-top: 2px; }
    .map-list { position: relative; overflow-y: auto; padding: 4px 0; scrollbar-width: thin; }
    .row { display: flex; align-items: center; gap: 6px; padding: 0 10px 0 calc(10px + var(--indent, 0) * 16px);
      border-left: 3px solid transparent; }
    .row.off .title, .row.off .count { opacity: .45; }
    .row.current { border-left-color: #ffd54f; background: rgba(255,213,79,.08); }
    .row.current .title { font-weight: 600; }
    .row input { margin: 0; accent-color: #4f8cff; cursor: pointer; flex: none; }
    .row button.title { display: block; width: auto; height: auto; flex: 1; min-width: 0; padding: 6px; border-radius: 6px;
      font-weight: 400; font-size: 13px; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row button.title:disabled { cursor: default; }
    .count { opacity: .55; font-variant-numeric: tabular-nums; font-size: 12px; flex: none; }
    .group { padding: 10px 14px 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; opacity: .55; }
    .opt { display: flex; gap: 10px; align-items: flex-start; padding: 7px 14px; cursor: pointer; }
    .opt:hover { background: rgba(255,255,255,.05); }
    .opt input { margin: 2px 0 0; accent-color: #4f8cff; cursor: pointer; flex: none; }
    .opt small { display: block; opacity: .6; font-size: 12px; margin-top: 2px; line-height: 1.35; }
    .swatches { display: flex; align-items: center; gap: 10px; padding: 6px 14px 12px; }
    button.swatch { width: 22px; height: 22px; border-radius: 50%; box-shadow: inset 0 0 0 2px rgba(0,0,0,.15); }
    button.swatch.on { outline: 2px solid #fff; outline-offset: 2px; }
    .swatches select { margin-left: auto; }
    button.back { width: auto; height: 28px; padding: 0 12px; border-radius: 999px; background: #ffd54f; color: #111;
      font-size: 12px; font-weight: 600; white-space: nowrap; }
    button.back:hover { background: #ffe082; }
    button.back[hidden] { display: none; }
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

    const mapBtn = button('', 'Page map', 'map', () => toggleMap());
    const optsBtn = button('', 'Options', 'gear', () => toggleOptions());
    const opts = buildOptions();
    const backBtn = h('button', { className: 'back', type: 'button', hidden: true, textContent: 'Back to reading',
      title: 'Scroll back to the sentence being read, and follow it again' });
    backBtn.addEventListener('click', () => {
      setDetached(false);
      const item = state.current;
      if (item && state.sentenceRange) scrollIntoViewIfNeeded(item.model.el, state.sentenceRange, true);
    });
    const mapList = h('div', { className: 'map-list' });
    const mapPanel = h('div', { className: 'map', hidden: true },
      h('div', { className: 'map-head' }, 'Page map',
        h('small', { textContent: 'Tick the sections to read. Click a title to jump there.' })),
      mapList,
    );

    const bar = h('div', { className: 'bar' },
      button('', 'Previous sentence (Alt+Shift+Left)', 'prev', () => jump(-1)),
      playBtn,
      button('', 'Next sentence (Alt+Shift+Right)', 'next', () => jump(1)),
      h('span', { className: 'sep' }),
      slower, rateLabel, faster,
      h('span', { className: 'sep' }),
      voiceSelect,
      status,
      backBtn,
      mapBtn,
      optsBtn,
      button('', 'Close', 'close', teardown),
    );
    shadow.append(h('style', { textContent: BAR_CSS }), h('div', { className: 'wrap' }, mapPanel, opts.panel, bar));
    document.documentElement.appendChild(host);

    ui = { host, playBtn, rateLabel, status, voiceSelect, mapBtn, optsBtn, backBtn, opts, mapPanel, mapList, mapRows: new Map(), statusText: '' };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('click', onAltClick, true);
    window.addEventListener('click', onPageClick, true);
    buildPointerButtons();
    installHighlights();
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

  function buildOptions() {
    const inputs = {};
    const body = h('div', { className: 'map-list opts-list' });
    for (const [group, rows] of SWITCHES) {
      body.append(h('div', { className: 'group', textContent: group }));
      for (const [key, label, help] of rows) {
        const input = h('input', { type: 'checkbox' });
        input.addEventListener('change', () => setOption(key, input.checked));
        inputs[key] = input;
        body.append(h('label', { className: 'opt' }, input, h('span', {}, label, h('small', { textContent: help }))));
      }
    }
    body.append(h('div', { className: 'group', textContent: 'Highlight' }));
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
    const styleSelect = h('select', { title: 'What to highlight' },
      h('option', { value: 'both', textContent: 'Sentence and word' }),
      h('option', { value: 'sentence', textContent: 'Sentence only' }),
      h('option', { value: 'word', textContent: 'Word only' }));
    styleSelect.addEventListener('change', () => setOption('hlStyle', styleSelect.value));
    swatchRow.append(styleSelect);
    body.append(swatchRow);
    const panel = h('div', { className: 'map opts', hidden: true },
      h('div', { className: 'map-head' }, 'Options', h('small', { textContent: 'Ways to start reading, and how reading looks.' })),
      body);
    return { panel, inputs, swatches, styleSelect };
  }

  function updateOptionsUI() {
    if (!ui) return;
    for (const [key, input] of Object.entries(ui.opts.inputs)) input.checked = !!settings[key];
    for (const [key, b] of Object.entries(ui.opts.swatches)) {
      b.classList.toggle('on', key === settings.hlColor);
      b.setAttribute('aria-pressed', String(key === settings.hlColor));
    }
    ui.opts.styleSelect.value = settings.hlStyle;
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
    updateOptionsUI();
  }

  function toggleOptions(open) {
    if (!ui) return;
    open ??= ui.opts.panel.hidden;
    if (open) toggleMap(false);
    ui.opts.panel.hidden = !open;
    ui.optsBtn.classList.toggle('on', open);
    ui.optsBtn.setAttribute('aria-pressed', String(open));
  }

  // Scrolling by hand stops the page following the reading, until "Back to reading".
  function setDetached(detached) {
    if (state.detached === detached) return;
    state.detached = detached;
    if (ui) ui.backBtn.hidden = !detached;
    updateFocus();
  }

  function onUserScroll() {
    if (ui && state.playing && settings.follow && !state.detached) setDetached(true);
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

  function toggleMap(open) {
    if (!ui) return;
    open ??= ui.mapPanel.hidden;
    if (open) toggleOptions(false);
    ui.mapPanel.hidden = !open;
    ui.mapBtn.classList.toggle('on', open);
    ui.mapBtn.setAttribute('aria-pressed', String(open));
    if (open) updateMapCurrent(true);
  }

  function renderMap() {
    if (!ui) return;
    ui.mapRows.clear();
    const minLevel = Math.min(...state.sections.map((s) => s.level));
    const rows = state.sections.map((sec) => {
      const count = sectionItems(sec).length;
      const check = h('input', { type: 'checkbox', checked: sec.enabled, title: sec.enabled ? 'Skip this section' : 'Read this section' });
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
      const voices = await send({ type: 'getVoices' });
      state.voices = Array.isArray(voices) ? voices : [];
      populateVoices();
    }
    applyDisplaySettings();
    colorSelectionButton();
    updateOptionsUI();
    updateUI();
  }

  function teardown() {
    if (state.playing) send({ type: 'stop' });
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
    ui?.host.remove();
    ui = null;
  }

  // ---------- Input ----------

  const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ']);

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      hideSelectionButton();
      hideParagraphButton();
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
    if (!settings.clickToRead || ev.buttons || hasSelection() || ev.target.closest?.(INTERACTIVE_SEL)) return;
    const at = textAt(ev.clientX, ev.clientY);
    if (!at) return;
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
      background: #4f8cff; color: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.3); cursor: pointer; }
    button:hover { background: #3f7cf0; }
    button:focus-visible { outline: 2px solid #8ab4ff; outline-offset: 2px; }
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
        else if (state.playing) pausePlayback();
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
