// Voice Reader math speech: turns MathML (the machine-readable copy that Wikipedia, MathJax and
// KaTeX keep behind their equations) into English for the voice, e.g. E=mc² -> "E equals m c
// squared", and names Greek letters and math symbols that appear in ordinary text.
// Injected before content.js, which uses VoiceReaderMath.
var VoiceReaderMath = (() => {
  // Some names are respelled so the voices say them right: Kokoro reads "xi" as "Roman eleven"
  // and "mu" as "moo".
  const GREEK_NAMES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota',
    'kappa', 'lambda', 'mew', 'nu', 'zye', 'omicron', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi',
    'chi', 'psi', 'omega'];
  const GREEK = {};
  for (let i = 0, cp = 0x3b1; cp <= 0x3c9; cp++) {
    if (cp === 0x3c2) continue; // final sigma, added below
    GREEK[String.fromCodePoint(cp)] = GREEK_NAMES[i];
    GREEK[String.fromCodePoint(cp - 0x20)] = GREEK_NAMES[i]; // capital
    i++;
  }
  Object.assign(GREEK, { 'ς': 'sigma', 'ϵ': 'epsilon', 'ϑ': 'theta', 'ϰ': 'kappa', 'ϖ': 'pi', 'ϱ': 'rho', 'ϕ': 'phi' });

  const LETTERS = {
    ...GREEK,
    'ℏ': 'h bar', 'ħ': 'h bar', 'ℓ': 'ell', '∞': 'infinity', '∂': 'partial', '∇': 'del', '∅': 'the empty set',
    'ℝ': 'R', 'ℕ': 'N', 'ℤ': 'Z', 'ℚ': 'Q', 'ℂ': 'C',
    a: 'A', // a lone "a" is read as the article "uh"
  };

  const FUNCTIONS = {
    sin: 'sine', cos: 'cosine', tan: 'tangent', sec: 'secant', csc: 'cosecant', cot: 'cotangent',
    arcsin: 'arc sine', arccos: 'arc cosine', arctan: 'arc tangent', ln: 'natural log', log: 'log',
    exp: 'exp', det: 'determinant', lim: 'the limit', max: 'the maximum', min: 'the minimum',
  };

  const OPERATORS = {
    '=': 'equals', '+': 'plus', '-': 'minus', '−': 'minus', '–': 'minus', '±': 'plus or minus', '∓': 'minus or plus',
    '×': 'times', '⋅': 'times', '·': 'times', '∗': 'times', '*': 'times', '÷': 'divided by', '/': 'over',
    '<': 'is less than', '>': 'is greater than', '≤': 'is less than or equal to', '≥': 'is greater than or equal to',
    '≦': 'is less than or equal to', '≧': 'is greater than or equal to', '≪': 'is much less than', '≫': 'is much greater than',
    '≠': 'is not equal to', '≈': 'is approximately', '≃': 'is approximately', '≅': 'is congruent to', '∼': 'is similar to',
    '~': 'is similar to', '∝': 'is proportional to', '≡': 'is equivalent to', ':=': 'is defined as', '≔': 'is defined as',
    '→': 'goes to', '⟶': 'goes to', '↦': 'maps to', '⇒': 'implies', '⟹': 'implies', '⇔': 'if and only if', '⟺': 'if and only if',
    '∈': 'is in', '∉': 'is not in', '⊂': 'is a subset of', '⊆': 'is a subset of', '∪': 'union', '∩': 'intersect',
    '∀': 'for all', '∃': 'there exists', '∧': 'and', '∨': 'or', '¬': 'not', '∘': 'composed with', '⊗': 'tensor',
    '∑': 'the sum of', '∏': 'the product of', '∫': 'the integral of', '∮': 'the contour integral of', '√': 'the square root of',
    '∞': 'infinity', '∂': 'partial', '∇': 'del', '′': 'prime', '″': 'double prime', '!': 'factorial', '%': 'percent',
    '°': 'degrees', '…': 'dot dot dot', '⋯': 'dot dot dot', '∣': 'divides', '∥': 'is parallel to', '⊥': 'is perpendicular to',
    ',': ',', '.': '.', ';': ';', ':': ':',
    '\u2061': '', '\u2062': '', '\u2063': ',', '\u2064': 'plus',
  };
  const SILENT = new Set(['(', ')', '[', ']', '{', '}', '⟨', '⟩', '|', '‖', '⌊', '⌋', '⌈', '⌉', '']);

  // Operators that take limits ("the sum from i equals 1 to n of ...").
  const BIG_OPS = { '∑': 'the sum', '∏': 'the product', '∫': 'the integral', '∬': 'the double integral',
    '∭': 'the triple integral', '∮': 'the contour integral', '⋃': 'the union', '⋂': 'the intersection',
    lim: 'the limit', max: 'the maximum', min: 'the minimum', sup: 'the supremum', inf: 'the infimum' };

  const ACCENTS = { '^': 'hat', 'ˆ': 'hat', '\u0302': 'hat', '¯': 'bar', '‾': 'bar', '\u0304': 'bar', '\u0305': 'bar', '―': 'bar', '_': 'bar',
    '˙': 'dot', '\u0307': 'dot', '¨': 'double dot', '\u0308': 'double dot', '~': 'tilde', '˜': 'tilde', '\u0303': 'tilde' };
  const VECTOR_ARROWS = new Set(['→', '⃗', '\u20d7', '⇀']);

  const WRAPPERS = new Set(['math', 'mrow', 'mstyle', 'mpadded', 'menclose', 'mtd', 'merror']);

  const name = (n) => (n.localName || n.tagName || '').toLowerCase().replace(/^m:/, '');
  const kids = (n) => [...n.children].filter((c) => !/^annotation/.test(name(c)) && name(c) !== 'mprescripts' && name(c) !== 'none');
  const text = (n) => n.textContent.replace(/\s+/g, ' ').trim()
    .replace(/[\u{1D400}-\u{1D7FF}]/gu, (c) => c.normalize('NFKC')); // styled math letters like 𝑥 -> x

  // The node itself, or its only child if it's just a wrapper.
  function core(n) {
    while (n && (WRAPPERS.has(name(n)) || name(n) === 'semantics') && kids(n).length === 1) n = kids(n)[0];
    return n;
  }

  function isSimple(n) {
    const c = core(n);
    if (!c) return true;
    const k = name(c);
    if (k === 'mi' || k === 'mn' || k === 'mtext' || k === 'mo') return true;
    // A negative number: "-1"
    if (WRAPPERS.has(k)) {
      const parts = kids(c);
      return parts.length === 2 && name(parts[0]) === 'mo' && /^[-−]$/.test(text(parts[0])) && name(core(parts[1])) === 'mn';
    }
    return false;
  }

  // Short enough to say without "the fraction": x, 2, v squared, E sub rel.
  function isSmall(n) {
    const c = core(n);
    if (isSimple(c)) return true;
    const k = kids(c);
    return ['msup', 'msub', 'msubsup'].includes(name(c)) && k.every(isSimple);
  }

  function identifier(t) {
    if (LETTERS[t]) return LETTERS[t];
    if (FUNCTIONS[t]) return FUNCTIONS[t];
    // Names made of several symbols, e.g. "ΔE" in one <mi>.
    if ([...t].length > 1 && [...t].some((c) => GREEK[c])) return [...t].map((c) => LETTERS[c] || c).join(' ');
    return t;
  }

  function operator(t) {
    if (t in OPERATORS) return OPERATORS[t];
    if (SILENT.has(t)) return '';
    return [...t].map((c) => OPERATORS[c] ?? LETTERS[c] ?? c).join(' ');
  }

  function join(parts) {
    return parts.filter(Boolean).join(' ').replace(/\s+([,.;:])/g, '$1').replace(/[,;:]+(?=\.)/g, '')
      .replace(/([,;:])(?:\s*[,;:])+/g, '$1').replace(/\s+/g, ' ').trim();
  }

  // The words for the end of "x squared", "x to the power of n" and so on.
  function powerWords(exp) {
    const e = text(exp);
    if (e === '2') return 'squared';
    if (e === '3') return 'cubed';
    if (/^[′']$/.test(e)) return 'prime';
    if (/^(″|′′|'')$/.test(e)) return 'double prime';
    if (e === '∗' || e === '*') return 'star';
    if (e === '†') return 'dagger';
    if (e === '∘' || e === '°') return 'degrees';
    return `to the power of ${speak(exp)}${isSimple(exp) ? '' : ','}`;
  }

  function base(n) {
    const c = core(n);
    if (isSimple(c)) return speak(c);
    // "(a + b)²" -> "the quantity a plus b, squared"
    const parts = kids(c);
    if (WRAPPERS.has(name(c)) && parts.length > 2 && SILENT.has(text(parts[0])) && name(parts[0]) === 'mo') {
      return `the quantity ${join(parts.slice(1, -1).map(speak))},`;
    }
    return speak(c);
  }

  function bigOp(n) {
    const t = text(core(n));
    return name(core(n)) !== 'mn' && BIG_OPS[t] ? BIG_OPS[t] : null;
  }

  function limits(op, under, over) {
    if (op === 'the limit') return `the limit as ${speak(under)} of`;
    if (under && over) return `${op} from ${speak(under)} to ${speak(over)} of`;
    if (under) return `${op} over ${speak(under)} of`;
    return `${op} of`;
  }

  // "f(x)" -> "f of x": a letter followed by a short bracketed list without operators.
  function isArgumentList(items, i) {
    const open = items[i];
    if (name(open) !== 'mo' || text(open) !== '(') return -1;
    for (let j = i + 1; j < items.length && j < i + 8; j++) {
      const k = name(items[j]);
      const t = text(items[j]);
      if (k === 'mo' && t === ')') return j;
      if (k === 'mo' && !/^[,\u2063]$/.test(t)) return -1;
      if (k !== 'mi' && k !== 'mn' && !(k === 'mo')) return -1;
    }
    return -1;
  }

  const OPEN = new Set(['(', '[', '{']);
  const CLOSE = new Set([')', ']', '}']);
  const GROUPING_OPS = /^[+\-\u2212\u00b1\u2213=<>\u2264\u2265\u2248\u00d7\u22c5\u00b7/]$/;

  // The bracket an item closes with. TeX's "(pc)^2" puts the power on the closing bracket.
  function closingBracket(n) {
    const c = core(n);
    if (name(c) === 'mo') return text(c);
    if (name(c) === 'msup' || name(c) === 'msubsup') {
      const b = core(kids(c)[0]);
      if (name(b) === 'mo') return text(b);
    }
    return null;
  }

  function matchingClose(items, i) {
    let depth = 0;
    for (let j = i; j < items.length; j++) {
      const t = closingBracket(items[j]);
      if (name(core(items[j])) === 'mo' && OPEN.has(t)) depth++;
      else if (CLOSE.has(t) && --depth === 0) return j;
    }
    return -1;
  }

  function row(items) {
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const n = items[i];
      const k = name(n);
      if (k === 'mo' && OPEN.has(text(n))) {
        if (text(n) === '(' && i > 0) {
          const prev = core(items[i - 1]);
          const prevName = name(prev);
          const isFunc = (prevName === 'mi' || prevName === 'msub' || (prevName === 'mo' && text(prev) === '\u2061'));
          const close = isFunc ? isArgumentList(items, i) : -1;
          if (close > 0) {
            out.push('of', join(items.slice(i + 1, close).map(speak)));
            i = close;
            continue;
          }
        }
        // "(a + b)" -> "the quantity a plus b,", so the grouping can be heard.
        const j = matchingClose(items, i);
        if (j > 0) {
          const inner = items.slice(i + 1, j);
          const closer = core(items[j]);
          const exp = name(closer) === 'msup' ? kids(closer)[1] : null;
          const grouped = exp || inner.some((x) => name(x) === 'mo' && GROUPING_OPS.test(text(x)));
          if (grouped) {
            const prev = i > 0 ? name(core(items[i - 1])) : '';
            if (prev && prev !== 'mo') out.push('times');
            out.push('the quantity', row(inner) + ',', exp ? powerWords(exp) : '');
          } else {
            out.push(row(inner));
          }
          i = j;
          continue;
        }
      }
      // "c² (1 + ...)": a bracketed group straight after a term multiplies it.
      const first = WRAPPERS.has(k) ? kids(n)[0] : null;
      if (first && name(first) === 'mo' && OPEN.has(text(first)) && i > 0 && name(core(items[i - 1])) !== 'mo') out.push('times');
      out.push(speak(n));
    }
    return join(out);
  }

  // Subscripts like "rel" are often written as separate letters: say them as one word.
  function subscript(n) {
    const c = core(n);
    const parts = WRAPPERS.has(name(c)) ? kids(c) : [];
    if (parts.length >= 3 && parts.every((p) => name(p) === 'mi' && /^[a-z]$/i.test(text(p)))) {
      return parts.map(text).join('');
    }
    return speak(n);
  }

  function speak(n) {
    if (!n) return '';
    const k = kids(n);
    switch (name(n)) {
      case 'math': case 'mrow': case 'mstyle': case 'mpadded': case 'menclose': case 'mtd': case 'merror':
        return row(k);
      case 'semantics':
        return k[0] ? speak(k[0]) : '';
      case 'mphantom': case 'mspace':
        return '';
      case 'mi':
        return identifier(text(n));
      case 'mn':
        return text(n);
      case 'mo':
        return operator(text(n));
      case 'mtext': case 'ms':
        return text(n);
      case 'msup': {
        const op = bigOp(k[0]);
        if (op) return limits(op, null, k[1]);
        return join([base(k[0]), powerWords(k[1])]);
      }
      case 'msub': {
        const op = bigOp(k[0]);
        if (op) return limits(op, k[1], null);
        return join([base(k[0]), 'sub', subscript(k[1]) + (isSimple(k[1]) ? '' : ',')]);
      }
      case 'msubsup': {
        const op = bigOp(k[0]);
        if (op) return limits(op, k[1], k[2]);
        return join([base(k[0]), 'sub', subscript(k[1]) + ',', powerWords(k[2])]);
      }
      case 'munder': case 'mover': case 'munderover': {
        const op = bigOp(k[0]);
        const under = name(n) === 'mover' ? null : k[1];
        const over = name(n) === 'mover' ? k[1] : name(n) === 'munderover' ? k[2] : null;
        if (op) return limits(op, under, over);
        if (over) {
          const t = text(over);
          if (VECTOR_ARROWS.has(t)) return join(['vector', speak(k[0])]);
          if (ACCENTS[t]) return join([speak(k[0]), ACCENTS[t]]);
        }
        if (under && ACCENTS[text(under)] === 'bar') return speak(k[0]); // underline
        return join([speak(k[0]), under && `under ${speak(under)},`, over && `over ${speak(over)},`]);
      }
      case 'mfrac': {
        const [num, den] = k;
        if (n.getAttribute?.('linethickness') === '0' || n.getAttribute?.('linethickness') === '0px') {
          return join([speak(num), 'choose', speak(den)]);
        }
        if (isSmall(num)) return join([speak(num), 'over', speak(den) + (isSmall(den) ? '' : ',')]);
        return join(['the fraction,', speak(num) + ',', 'over', speak(den) + ',']);
      }
      case 'msqrt': {
        const inner = row(k);
        return join(['the square root of', inner + (k.length === 1 && isSimple(k[0]) ? '' : ',')]);
      }
      case 'mroot': {
        const idx = text(k[1]);
        const which = idx === '3' ? 'cube root' : idx === '2' ? 'square root' : `${speak(k[1])}th root`;
        return join([`the ${which} of`, speak(k[0]) + (isSimple(k[0]) ? '' : ',')]);
      }
      case 'mfenced':
        return join(k.map(speak).flatMap((s, i) => (i ? [',', s] : [s])));
      case 'mtable':
        return k.map((tr) => speak(tr)).filter(Boolean).join('; ');
      case 'mtr': case 'mlabeledtr':
        return join(k.map(speak));
      case 'mmultiscripts':
        return join([speak(k[0]), k.slice(1).map(speak).join(' ')]);
      default:
        return k.length ? row(k) : text(n);
    }
  }

  // A rough reading of TeX, for equations that come without MathML.
  function texToSpeech(tex) {
    const commands = { ...Object.fromEntries(GREEK_NAMES.map((g) => [g, g])), mu: 'mew', xi: 'zye', varepsilon: 'epsilon', vartheta: 'theta', varphi: 'phi',
      cdot: 'times', times: 'times', pm: 'plus or minus', leq: 'is less than or equal to', le: 'is less than or equal to',
      geq: 'is greater than or equal to', ge: 'is greater than or equal to', neq: 'is not equal to', approx: 'is approximately',
      infty: 'infinity', partial: 'partial', nabla: 'del', sum: 'the sum of', int: 'the integral of', prod: 'the product of',
      sqrt: 'the square root of', frac: 'the fraction', to: 'goes to', rightarrow: 'goes to', hbar: 'h bar', ell: 'ell', ...FUNCTIONS };
    return join([tex
      // "mc" in TeX is m times c, so say the letters apart (commands like \sin are left alone).
      .replace(/(^|[^\\a-zA-Z])([a-zA-Z]{2,3})(?![a-zA-Z])/g, (m, pre, w) => pre + [...w].join(' '))
      .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, ' $1 over $2 ')
      .replace(/\\sqrt\{([^{}]*)\}/g, ' the square root of $1 ')
      .replace(/\\(displaystyle|textstyle|left|right|big|Big|bigg|Bigg|mathrm|mathbf|mathit|operatorname|text|,|;|!|quad|qquad)\b/g, ' ')
      .replace(/\^\{?2\}?/g, ' squared ').replace(/\^\{?3\}?/g, ' cubed ')
      .replace(/\^/g, ' to the power of ').replace(/_/g, ' sub ')
      .replace(/\\([a-zA-Z]+)/g, (m, c) => ` ${commands[c] ?? c} `)
      .replace(/[{}\\]/g, ' ')
      .replace(/[=+−<>≤≥]|-(?=\s|\d|[a-z])/gi, (c) => ` ${OPERATORS[c] ?? c} `)]);
  }

  // Spoken form of an equation element (Wikipedia's .mwe-math-element, MathJax, KaTeX, or <math>).
  function equationToSpeech(el) {
    const math = el.localName === 'math' ? el : el.querySelector('math');
    if (math) {
      const spoken = speak(math);
      if (spoken) return spoken;
    }
    const tex = math?.getAttribute('alttext') || el.querySelector('annotation[encoding="application/x-tex"]')?.textContent ||
      el.querySelector('img[alt]')?.getAttribute('alt') || el.querySelector('script[type^="math/tex"]')?.textContent || '';
    return tex ? texToSpeech(tex) : '';
  }

  // Symbols in ordinary text that voices say badly or not at all. Greek letters are only named
  // when they stand alone, so Greek words are left for the voice.
  const TEXT_SYMBOLS = /[\u0391-\u03a9\u03b1-\u03c9\u03d1\u03d5\u03d6\u03f0\u03f1\u03f5]|[≤≥≠≈±∓×÷√∞→⇒∝∂∇∑∏∫∈≡]|−(?=\s?\d)|°[CF]?\b|°/gu;
  const IS_GREEK = /\p{Script=Greek}/u;

  // [{ index, length, spoken }] for the symbols in a piece of ordinary text.
  function textSymbols(str) {
    const found = [];
    for (const m of str.matchAll(TEXT_SYMBOLS)) {
      const c = m[0];
      const before = str[m.index - 1] || '';
      const after = str[m.index + c.length] || '';
      let spoken;
      if (GREEK[c]) {
        if (IS_GREEK.test(before) || IS_GREEK.test(after)) continue; // part of a Greek word
        // μm, μs, μg: the micro prefix
        spoken = (c === 'μ' && /[a-zA-Z]/.test(after) && !/[a-zA-Z]/.test(before)) ? 'micro' : GREEK[c];
      } else if (c[0] === '°') {
        spoken = c === '°C' ? 'degrees Celsius' : c === '°F' ? 'degrees Fahrenheit' : 'degrees';
      } else if (c === '−') {
        spoken = 'minus';
      } else {
        spoken = OPERATORS[c] || LETTERS[c];
      }
      // Keep the spoken word apart from its neighbours: "5×10" -> "5 times 10".
      if (/[\p{L}\p{N}]/u.test(before)) spoken = ' ' + spoken;
      if (/[\p{L}\p{N}]/u.test(after) && spoken !== 'micro') spoken += ' ';
      found.push({ index: m.index, length: c.length, spoken });
    }
    return found;
  }

  return { equationToSpeech, mathmlToSpeech: speak, texToSpeech, textSymbols };
})();

if (typeof module !== 'undefined') module.exports = VoiceReaderMath;
