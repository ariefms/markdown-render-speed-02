// A fast, dependency-free Markdown renderer whose parse(markdown) returns
// exactly the HTML that marked 18.1.3 renders with its default options
// (GFM on, breaks off). Written from scratch against the CommonMark 0.31.2
// and GFM 0.29 specifications, verified case by case against marked's own
// output on the competition's practice set.
//
// Architecture: a line-based block parser builds a small block tree
// (containers are handled with an explicit open-block stack, as the
// CommonMark reference algorithm does), then a renderer walks the tree.
// Inline content is scanned into nodes and emphasis is resolved with the
// standard delimiter-stack algorithm.

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const BLOCK_TAG_RE = new RegExp(`^(?:${BLOCK_TAGS})$`, 'i');
const PUNCT_RE = /[\p{P}\p{S}]/u;

const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
// Unicode whitespace (JS \s: includes NBSP U+00A0 and other Zs/Zl/Zp),
// used for emphasis flanking per commonmark.js reUnicodeWhitespaceChar.
const isUniSpace = (c) => c !== undefined && /\s/.test(c);
const isDigit = (c) => c >= '0' && c <= '9';
const isPunct = (c) => c !== undefined && PUNCT_RE.test(c);
const isAsciiPunct = (c) => c !== undefined && /[!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~]/.test(c);
const isAlpha = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');

// Escape HTML. When encode is false, an & that starts something looking
// like an entity reference (&word; or &#123; or &#x1f;) is left alone;
// otherwise & is escaped too. < > " ' are always escaped.
function esc(s, encode) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) { // &
      if (encode) rep = '&amp;';
      else {
        // leave alone when it looks like &#...; &#x...; or &word;
        let j = i + 1;
        if (s[j] === '#') {
          j++;
          let hex = false;
          if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
          const max = hex ? 6 : 7;
          let k = j;
          while (k < s.length && k - j < max) {
            const ch = s[k];
            const isD = ch >= '0' && ch <= '9';
            const isH = hex && ((ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F'));
            if (!isD && !isH) break;
            k++;
          }
          if (k > j && s[k] === ';') continue;
        } else {
          let k = j;
          while (k < s.length && ((s[k] >= 'a' && s[k] <= 'z') || (s[k] >= 'A' && s[k] <= 'Z') || (s[k] >= '0' && s[k] <= '9'))) k++;
          if (k > j && s[k] === ';') continue;
        }
        rep = '&amp;';
      }
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Decode numeric character references in already-escaped text. A decoded
// character that needs escaping is emitted escaped (& -> &amp;, < -> &lt;,
// > -> &gt;, " -> &quot;, ' -> &#39;); 0, surrogates and > 0x10FFFF
// become U+FFFD. Named entities are NOT decoded.
const NUMREF_RE = /&#[Xx]([A-Fa-f0-9]{1,6});|&#(\d{1,7});/g;
function decodeNumeric(s) {
  if (s.indexOf('&#') === -1) return s;
  return s.replace(NUMREF_RE, (m, hex, dec) => {
    const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    if (cp === 60) return '&lt;';
    if (cp === 62) return '&gt;';
    if (cp === 34) return '&quot;';
    if (cp === 39) return '&#39;';
    return String.fromCodePoint(cp);
  });
}

// Render a run of plain text: escape (leaving entity-looking & alone),
// then decode numeric references.
function textHtml(s) {
  return decodeNumeric(esc(s, false));
}

// Decode numeric character references to the raw character (used for
// image alt text, which is escaped again by the caller).
function decodeNumericRaw(s) {
  if (s.indexOf('&#') === -1) return s;
  return s.replace(NUMREF_RE, (m, hex, dec) => {
    const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
    return String.fromCodePoint(cp);
  });
}

// Normalize a link label: trim, collapse whitespace to one space, and
// case-fold the way marked does.
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Encode a link destination the way marked does: encodeURI, except %
// that was already a %25 stays a single %.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Unescape backslash-escapes of ASCII punctuation.
function unescapePunct(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isPunct(s[i + 1])) {
      out += s.slice(start, i) + s[i + 1];
      start = i + 2;
      i++;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// ---- inline link helpers ----

// ---- inline link helpers (commonmark.js parseLinkLabel / parseLinkDestination) ----

// Match a link label at src[i] (the '['). marked's ref/def label
// (be/le): no '[' inside, escapes allowed, 1-999 chars. An empty label
// '[]' is NOT matched here (collapsed refs handle it separately).
const LINK_LABEL_RE = /^\[(?:\\[\s\S]|[^\[\]\\]){1,999}\]/;
function matchLabel(src, i) {
  const m = LINK_LABEL_RE.exec(src.slice(i));
  if (!m) return null;
  return { label: m[0].slice(1, -1), end: i + m[0].length };
}

// Skip spaces/tabs, plus at most one newline and following spaces/tabs.
function spnl(src, j) {
  const n = src.length;
  let k = j;
  while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
  if (k < n && src[k] === '\n') {
    let r = k + 1;
    while (r < n && (src[r] === ' ' || src[r] === '\t')) r++;
    return r;
  }
  return k;
}

// Parse a link destination at src[j]. Returns {href, end} or null.
// <...> form must close on the same line (and contain no '<'); a bare
// destination stops at whitespace/control with balanced parens; an empty
// destination is only valid when the next char is ')'.
function parseLinkDest(src, j) {
  const n = src.length;
  if (src[j] === '<') {
    let k = j + 1;
    while (k < n && src[k] !== '>' && src[k] !== '\n' && src[k] !== '<') {
      if (src[k] === '\\' && k + 1 < n) k += 2;
      else k++;
    }
    if (k >= n || src[k] !== '>') return null;
    return { href: unescapePunct(src.slice(j + 1, k)), end: k + 1 };
  }
  let k = j;
  let depth = 0;
  while (k < n) {
    const c = src[k];
    if (c === '\\' && k + 1 < n && isAsciiPunct(src[k + 1])) { k += 2; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) break;
      depth--;
    } else if (isSpace(c) || c.charCodeAt(0) < 32) break;
    k++;
  }
  if (k === j && src[k] !== ')') return null;
  if (depth !== 0) return null;
  return { href: unescapePunct(src.slice(j, k)), end: k };
}

// Parse an inline link destination + optional title starting at src[i]
// (which must be '('). Returns {href, title, end} or null.
// Title only if whitespace separated it from the destination.
function matchInlineLink(src, i) {
  const n = src.length;
  let j = spnl(src, i + 1);
  const d = parseLinkDest(src, j);
  if (!d) return null;
  let href = d.href;
  j = d.end;
  const beforeTitle = j;
  j = spnl(src, j);
  let title = null;
  if (j !== beforeTitle) {
    const t = parseTitle(src, j);
    if (t) { title = t.title; j = t.end; }
    else { j = beforeTitle; }
  }
  j = spnl(src, j);
  if (j < n && src[j] === ')') return { href, title, end: j + 1 };
  return null;
}

// Parse a link reference definition in `src` starting at index i (the `[`).
// The definition may span lines. Returns {label, href, title, end} where
// end is the index just past the definition's last line, or null.
// Parse a link reference definition in `src` starting at index i (the `[`).
// The definition may span lines. Returns {label, href, title, end} where
// end is the index just past the definition's last line, or null.
// Follows commonmark.js parseReference: label via reLinkLabel, title only
// if whitespace separated it from the destination, and if a title is
// present but junk follows it, the title is discarded and the destination
// alone must end the line.
function matchDef(src, i) {
  const lab = matchLabel(src, i);
  if (!lab) return null;
  let j = lab.end;
  if (src[j] !== ':') return null;
  j++;
  j = spnl(src, j);
  const d = parseLinkDest(src, j);
  if (!d) return null;
  const href = d.href;
  j = d.end;
  const beforeTitle = j;
  j = spnl(src, j);
  let title = null;
  if (j !== beforeTitle) {
    const t = parseTitle(src, j);
    if (t) { title = t.title; j = t.end; }
    else { j = beforeTitle; }
  }
  // must be at line end (only spaces, then newline or EOF)
  const atLineEnd = (p) => {
    let e = p;
    while (e < src.length && src[e] === ' ') e++;
    return e >= src.length || src[e] === '\n' ? e : -1;
  };
  let e = atLineEnd(j);
  if (e === -1) {
    if (title === null) return null;
    // discard the title and re-check the line end after the URL
    title = null;
    e = atLineEnd(beforeTitle);
    if (e === -1) return null;
  }
  const label = normLabel(lab.label);
  if (!label) return null;
  return { label, href, title, end: e };
}

// Parse a link title at src[i] (", ' or (). May span lines. Returns
// {title, end} or null. A ' title may not contain a blank line.
function parseTitle(src, i) {
  const open = src[i];
  const close = open === '(' ? ')' : open;
  let p = i + 1;
  const n = src.length;
  while (p < n) {
    const c = src[p];
    if (c === '\\' && p + 1 < n) { p += 2; continue; }
    if (c === close) return { title: unescapePunct(src.slice(i + 1, p)), end: p + 1 };
    if (open === "'" && c === '\n') {
      // blank line inside a ' title ends it
      let q = p + 1;
      while (q < n && (src[q] === ' ' || src[q] === '\t')) q++;
      if (src[q] === '\n' || q >= n) return null;
    }
    p++;
  }
  return null;
}

// Strip a snapshot of open containers from a line. Returns the remaining
// string, '' for a blank line inside the containers, or null when a
// container does not match (the line is outside them).
function stripContainers(line, containers) {
  let rest = line;
  for (const blk of containers) {
    if (blk.t === 'quote') {
      const stripped = stripQuotePrefix(rest);
      if (stripped === null) return null;
      rest = stripped;
    } else if (blk.t === 'item') {
      if (isBlankLine(rest)) return '';
      const stripped = stripItemIndent(rest, blk.indent);
      if (stripped === null) return null;
      rest = stripped;
    }
    // lists are transparent
  }
  return rest;
}

// ---- block parser ----

// Columns of leading whitespace (space = 1, tab = to next multiple of 4).
function indentCols(s) {
  let col = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ' ') col++;
    else if (c === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Remove `cols` columns from the start of s. A tab straddling the boundary
// becomes spaces.
function stripCols(s, cols) {
  let col = 0;
  let i = 0;
  while (i < s.length && col < cols) {
    const c = s[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= cols) { col += w; i++; }
      else return ' '.repeat(col + w - cols) + s.slice(i + 1);
    } else break;
  }
  return s.slice(i);
}

// Expand a leading run of spaces/tabs to spaces. A tab advances to the
// next multiple of 4 columns, starting from column 0.
function expandLeadingWs(s) {
  let i = 0;
  let col = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) {
    if (s[i] === ' ') col++;
    else col += 4 - (col % 4);
    i++;
  }
  if (i === 0) return s;
  return ' '.repeat(col) + s.slice(i);
}

// Strip a blockquote prefix: up to 3 spaces, '>', then the following
// whitespace run expanded to spaces (tabs to the next tab stop from the
// '>' column) minus one space. Returns null if no '>' prefix.
function stripQuotePrefix(s) {
  const m = /^ {0,3}>/.exec(s);
  if (!m) return null;
  const rest = s.slice(m[0].length);
  let i = 0;
  let col = m[0].length;
  while (i < rest.length && (rest[i] === ' ' || rest[i] === '\t')) {
    if (rest[i] === ' ') col++;
    else col += 4 - (col % 4);
    i++;
  }
  if (i === 0) return rest;
  const wsCols = col - m[0].length;
  return ' '.repeat(wsCols - 1) + rest.slice(i);
}

// Strip `indent` columns of list-item indent from a line. The leading
// whitespace is expanded to spaces first (marked's list rule).
// Returns null when the line's indent is smaller.
function stripItemIndent(s, indent) {
  const expanded = expandLeadingWs(s);
  if (indentCols(expanded) < indent) return null;
  return expanded.slice(indent);
}

const HR_RE = /^ {0,3}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$/;

const isBlankLine = (s) => {
  for (let i = 0; i < s.length; i++) if (s[i] !== ' ' && s[i] !== '\t') return false;
  return true;
};

// Match a list marker at the start of s (after 0-3 spaces). Returns
// {bullet, ordered, delim, markerLen, content, contentIndent, empty}
// or null. content is the item's content string (leading-whitespace expanded).
function matchListMarker(s) {
  let i = 0;
  while (i < s.length && s[i] === ' ' && i < 3) i++;
  if (i >= s.length) return null;
  const c = s[i];
  let bullet = null;
  let ordered = false;
  let delim = null;
  let markerLen = 0;
  if (c === '*' || c === '+' || c === '-') {
    bullet = c;
    markerLen = 1;
  } else if (isDigit(c)) {
    let j = i;
    while (j < s.length && isDigit(s[j]) && j - i < 9) j++;
    if (j === i || j >= s.length || (s[j] !== '.' && s[j] !== ')')) return null;
    delim = s[j];
    ordered = true;
    markerLen = j - i + 1;
  } else return null;
  // need whitespace or end of line after the marker
  let k = i + markerLen;
  if (k < s.length && s[k] !== ' ' && s[k] !== '\t') return null;
  // expand the whitespace run after the marker to spaces (a tab advances
  // to the next tab stop from the marker column)
  let col = i + markerLen;
  let wsEnd = k;
  let wsCols = 0;
  while (wsEnd < s.length && (s[wsEnd] === ' ' || s[wsEnd] === '\t')) {
    if (s[wsEnd] === ' ') { wsCols++; col++; }
    else { const w = 4 - (col % 4); wsCols += w; col += w; }
    wsEnd++;
  }
  const empty = wsEnd >= s.length;
  let contentIndent, content;
  if (empty) {
    contentIndent = i + markerLen + 1;
    content = '';
  } else if (wsCols >= 1 && wsCols <= 4) {
    contentIndent = i + markerLen + wsCols;
    content = s.slice(wsEnd);
  } else {
    // more than 4 spaces of whitespace: content indent is 1, the extra
    // expanded spaces stay in the content
    contentIndent = i + markerLen + 1;
    content = ' '.repeat(wsCols - 1) + s.slice(wsEnd);
  }
  return { bullet, ordered, delim, markerLen, content, contentIndent, empty, indent: i };
}

// Can this list item interrupt a paragraph? Bullet lists with non-empty
// first item, or ordered lists starting at 1.
function listInterrupts(m, s, inItem) {
  if (m.empty) return false;
  if (!m.ordered) return true;
  // inside a list item, any ordered list interrupts a paragraph
  // (marked deviates from CommonMark here); at the top level only 1.
  if (inItem) return true;
  const num = parseInt(s.slice(m.indent, m.indent + m.markerLen - 1), 10);
  return num === 1;
}

// Match a table delimiter line. Returns align array or null.
function matchTableDelim(s) {
  // a table delimiter with 4+ spaces of indent is not a delimiter (cm-087)
  if (indentCols(s) >= 4) return null;
  let t = s;
  // strip up to 3 leading spaces
  let i = 0;
  while (i < t.length && t[i] === ' ' && i < 3) i++;
  t = t.slice(i);
  const cells = splitTableRow(t);
  const align = [];
  for (const cell of cells) {
    const c = cell.trim();
    if (!/^:?-+:?$/.test(c)) return null;
    if (c.startsWith(':') && c.endsWith(':') && c.length > 2) align.push('center');
    else if (c.endsWith(':')) align.push('right');
    else if (c.startsWith(':')) align.push('left');
    else align.push(null);
  }
  return align;
}

// Split a table row on unescaped pipes. A line with no pipes is a single
// cell. Leading/trailing empty cells from outer pipes are dropped.
function splitTableRow(s) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '|') { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  // drop empty outer cells from leading/trailing pipes
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((x) => x.trim());
}

// HTML block type (1-7) for a line, or 0 if it does not start one.
function htmlBlockType(s) {
  let i = 0;
  while (i < s.length && s[i] === ' ' && i < 3) i++;
  const rest = s.slice(i);
  if (rest.length === 0 || rest[0] !== '<') return 0;
  const m1 = /^<(script|pre|style|textarea)(?:\s|>|$)/i.exec(rest);
  if (m1) return 1;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (/^<![A-Za-z]/.test(rest)) return 4;
  if (rest.startsWith('<![CDATA[')) return 5;
  // type 6: a block tag name followed by whitespace, >, /> or end of line;
  // the tag need not close on this line (cm-153/154/156/157)
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t]|\/?>|$)/.exec(rest);
  if (m6 && BLOCK_TAG_RE.test(m6[1])) return 6;
  // type 7: any other complete open/close tag, alone on the line — the
  // tag must be well-formed (a loose [^>]* would accept malformed
  // attributes like href="\"" , cm-632)
  const t7 = rest.trim();
  const tag7 = matchHtmlTag(t7, 0);
  if (tag7 !== null && tag7 === t7) return 7;
  return 0;
}

// Can this HTML block type interrupt a paragraph? Types 1-6 can, 7 cannot.
function htmlInterrupts(t) {
  return t >= 1 && t <= 6;
}

// marked's list-item text extraction strips leading whitespace of each line:
// up to 4 leading whitespace chars are removed; if more than 4, only 1 is.
function stripLazyLine(s) {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  if (i === 0) return s;
  return i <= 4 ? s.slice(i) : s.slice(1);
}

// Strip containers like stripContainers, but report which container failed:
// {ok, text} or {ok:false, failIdx, partial} where partial is the text after
// stripping the containers that did match.
function stripContainersLeaf(line, containers) {
  // a blank line is inside every list item (it needs no indent); strip
  // the item indents from it (keeping any extra spaces) so a fenced code
  // block or HTML block in nested list items is not cut short by it.
  // But a blank line inside a blockquote ENDS the quote (cm-128), so it
  // must not pass through a quote.
  if (isBlankLine(line)) {
    let rest = line;
    for (let k = 0; k < containers.length; k++) {
      const b = containers[k];
      if (b.t === 'quote') return { ok: false, failIdx: k, partial: line };
      if (b.t === 'item') rest = stripCols(rest, b.indent);
    }
    return { ok: true, text: rest };
  }
  let rest = line;
  for (let k = 0; k < containers.length; k++) {
    const b = containers[k];
    if (b.t === 'quote') {
      const s = stripQuotePrefix(rest);
      if (s === null) return { ok: false, failIdx: k, partial: rest };
      rest = s;
    } else if (b.t === 'item') {
      const s = stripItemIndent(rest, b.indent);
      if (s === null) return { ok: false, failIdx: k, partial: rest };
      rest = s;
    }
  }
  return { ok: true, text: rest };
}

function parseBlocks(lines, refs, endsWithNl) {
  const root = { t: 'doc', children: [] };
  const open = [root]; // containers + optional trailing paragraph
  let lastBlank = false;
  // index in `open` of the innermost container the last blank line was
  // inside (1 for a raw blank line, which counts at every level). A blank
  // line inside a quote must not make a sibling list item loose (cm-320).
  let blankLevel = 1;
  let expectingRows = null; // table node collecting rows

  const tip = () => open[open.length - 1];
  const lastContainerIdx = () => {
    for (let i = open.length - 1; i >= 0; i--) {
      const b = open[i];
      if (b.t === 'doc' || b.t === 'quote' || b.t === 'list' || b.t === 'item') return i;
    }
    return 0;
  };
  const blankBeforeAt = (parentIdx) => lastBlank && blankLevel <= parentIdx;
  const deepestContainer = () => {
    for (let i = open.length - 1; i >= 0; i--) {
      const b = open[i];
      if (b.t === 'doc' || b.t === 'quote' || b.t === 'item') return b;
    }
    return root;
  };
  const addBlock = (blk) => {
    blk.blankBefore = blankBeforeAt(open.indexOf(deepestContainer()));
    deepestContainer().children.push(blk);
    return blk;
  };
  const closeFrom = (idx) => {
    // finalize lists that close
    for (let i = open.length - 1; i >= idx; i--) {
      const b = open[i];
      if (b.t === 'list') finalizeList(b);
    }
    open.length = idx;
  };
  const closePara = () => {
    if (tip().t === 'para') open.pop();
  };
  // Replace the open paragraph with blk (used by setext/table conversion):
  // the paragraph node is removed from its parent's children.
  const replacePara = (blk) => {
    open.pop();
    const parent = deepestContainer();
    parent.children.pop();
    addBlock(blk);
  };
  function finalizeList(list) {
    let loose = false;
    const items = list.items;
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      if (k > 0 && it.blankBefore) loose = true;
      const ch = it.children;
      for (let m = 1; m < ch.length; m++) if (ch[m].blankBefore) loose = true;
    }
    list.loose = loose;
  }

  for (let li = 0; li < lines.length; li++) {
    let rest = lines[li];
    // A space-only line that is the last line of the input is paragraph
    // content, not a blank line, when the paragraph is inside a blockquote
    // (whose text has no trailing newline) or at the top level with no
    // trailing newline. Inside a list item it is always blank.
    const isLastSpaceLine = (s) => {
      if (li !== lines.length - 1) return false;
      if (s.length === 0 || !/^[ \t]+$/.test(s)) return false;
      if (tip().t !== 'para') return false;
      if (open.some((b) => b.t === 'quote')) return true;
      return open.length === 2 && !endsWithNl;
    };
    // a lone-tab line is a table row (empty cells), not a blank line
    // (marked: a tab-only row renders <tr><td></td>...</tr>, while a
    // spaces-only line ends the table)
    if (isBlankLine(rest) && !isLastSpaceLine(rest) && !(expectingRows && /^\t+$/.test(rest))) {
      closePara();
      expectingRows = null;
      // a blank line ends any open blockquote (cm-242); lists stay open
      let qi = -1;
      for (let k = 1; k < open.length; k++) if (open[k].t === 'quote') { qi = k; break; }
      if (qi !== -1) closeFrom(qi);
      lastBlank = true;
      blankLevel = 1;
      continue;
    }
    let consumed = false;
    let phaseADone = false;
    while (!consumed) {
      // Phase A: match open containers (runs once per line)
      if (!phaseADone) {
        phaseADone = true;
      let idx = 1;
      let failed = -1;
      while (idx < open.length) {
        const blk = open[idx];
        if (blk.t === 'quote') {
          const stripped = stripQuotePrefix(rest);
          if (stripped !== null) { rest = stripped; idx++; continue; }
          failed = idx;
          break;
        }
        if (blk.t === 'item') {
          // an empty item followed by a blank line is closed: a later
          // indented line is not its content (cm-280)
          if (blk.children.length === 0 && lastBlank) { failed = idx; break; }
          const stripped = stripItemIndent(rest, blk.indent);
          if (stripped !== null) { rest = stripped; idx++; continue; }
          failed = idx;
          break;
        }
        if (blk.t === 'list') { idx++; continue; }
        break;
      }
      if (failed !== -1) {
        // a container failed, but the line is blank within the containers
        // that did match: if a quote failed, the line is outside the quote
        // (close it, cm-242); if an item failed, it is a blank line inside
        // the item (keep containers open, cm-259/260)
        if (isBlankLine(rest) && !isLastSpaceLine(rest)) {
          if (open[failed].t === 'quote') closeFrom(failed);
          closePara();
          expectingRows = null;
          lastBlank = true;
          blankLevel = failed;
          consumed = true;
          continue;
        }
        // a container failed
        const failedItem = open[failed];
        // sibling list item? (applies regardless of tip type)
        const m = matchListMarker(rest);
        if (m && failedItem.t === 'item') {
          const parentList = open[failed - 1];
          if (parentList && parentList.t === 'list' && listsMatch(parentList, m) && !HR_RE.test(rest)) {
            // sibling item of the enclosing list
            closeFrom(failed);
            const item = { t: 'item', children: [], indent: m.contentIndent, task: false, checked: false, blankBefore: blankBeforeAt(failed - 1) };
            parentList.items.push(item);
            open.push(item);
            rest = m.content;
            const task = matchTask(rest);
            if (task) { item.task = true; item.checked = task.checked; rest = task.rest; }
            if (rest === '' || isBlankLine(rest)) {
              consumed = true;
              lastBlank = false;
              continue;
            }
            lastBlank = false;
            continue; // reprocess content as a block start (Phase B)
          }
        }
        if (tip().t === 'para') {
          // a list marker that is not a sibling ends the list (not a lazy line)
          if (m) {
            closeFrom(failed);
            // fall through to Phase B at this level
          } else if (startsInterruptingBlock(rest)) {
            closeFrom(failed);
            // fall through to Phase B at this level
          } else {
            // lazy continuation
            let line = rest;
            if (failedItem.t === 'quote') {
              // blockquote lazy setext: a setext underline becomes literal
              // text with a 4-space prefix (cm-093)
              const sm = /^ {0,3}((?:=+|-+)[ \t]*)$/.exec(rest);
              if (sm) line = '    ' + sm[1];
              else if (indentCols(rest) >= 4) line = stripCols(rest, 4);
            } else if (failedItem.t === 'item') {
              // a lazy line indented 4+ is lexed as indented code appended
              // to the paragraph, so it loses 4 columns (cm-291/312)
              if (indentCols(rest) >= 4) line = stripCols(rest, 4);
            }
            tip().lines.push(line);
            consumed = true;
            lastBlank = false;
            continue;
          }
        } else {
          closeFrom(failed);
          expectingRows = null;
        }
      }
      }
      // a line that becomes blank after container matching (or after a
      // blockquote marker is stripped) is a blank line — except a
      // lone-tab line while a table expects rows (it is an empty row)
      if (isBlankLine(rest) && !isLastSpaceLine(rest) && !(expectingRows && /^\t+$/.test(rest))) {
        closePara();
        expectingRows = null;
        lastBlank = true;
        blankLevel = lastContainerIdx();
        consumed = true;
        continue;
      }
      // Phase B
      const tp = tip();
      if (tp.t === 'para') {
        // setext underline?
        const sm = /^ {0,3}(=+|-+)[ \t]*$/.exec(rest);
        if (sm) {
          const level = sm[1][0] === '=' ? 1 : 2;
          const text = tp.lines.join('\n').trim();
          replacePara({ t: 'heading', level, text });
          consumed = true;
          lastBlank = false;
          continue;
        }
        // table delimiter (single-line paragraph)?
        if (tp.lines.length === 1) {
          const align = matchTableDelim(rest);
          if (align !== null) {
            const header = splitTableRow(tp.lines[0]);
            if (header.length === align.length) {
              const table = { t: 'table', align, header, rows: [] };
              replacePara(table);
              expectingRows = table;
              consumed = true;
              lastBlank = false;
              continue;
            }
          }
        }
        // interrupting block?
        if (startsInterruptingBlock(rest, open.some((b) => b.t === 'item'))) {
          closePara();
          continue; // reprocess as a block start
        }
        // a continuation line inside a container with 4+ indent is lexed
        // as indented code appended to the paragraph: it loses 4 columns
        let line = rest;
        if (open.length > 2 && indentCols(rest) >= 4) line = stripCols(rest, 4);
        tp.lines.push(line);
        consumed = true;
        lastBlank = false;
        continue;
      }
      // Block starts (tip is a container)
      // table row continuation?
      if (expectingRows) {
        if (!startsRowBlockingBlock(rest)) {
          expectingRows.rows.push(splitTableRow(rest));
          consumed = true;
          lastBlank = false;
          continue;
        }
        expectingRows = null;
      }
      // link reference definition (only at block start, line starts with [)
      if (rest.startsWith('[') || /^ {0,3}\[/.test(rest)) {
        const containers = open.slice(1).filter((b) => b.t === 'quote' || b.t === 'item' || b.t === 'list');
        const parts = [rest];
        // a definition's title may span several lines (cm-196); collect
        // until a blank line (a def cannot span one), capped for safety
        for (let k = 1; k <= 20 && li + k < lines.length; k++) {
          const stripped = leafLine(lines[li + k], containers);
          if (stripped === null) break;
          if (isBlankLine(stripped)) break;
          parts.push(stripped);
        }
        const joined = parts.join('\n');
        const off = rest.startsWith('[') ? 0 : /^ {0,3}/.exec(rest)[0].length;
        const d = matchDef(joined, off);
        if (d) {
          if (!refs.has(d.label)) refs.set(d.label, { href: d.href, title: d.title });
          const usedLines = joined.slice(0, d.end).split('\n').length;
          li += usedLines - 1;
          consumed = true;
          // a definition does not clear a preceding blank line: the blank
          // still separates the surrounding blocks (cm-317)
          continue;
        }
      }
      // indented code
      if (indentCols(rest) >= 4) {
        const containers = open.slice(1).filter((b) => b.t === 'quote' || b.t === 'item' || b.t === 'list');
        const buf = [];
        let j = li;
        while (j < lines.length) {
          const raw = j === li ? rest : stripContainers(lines[j], containers);
          if (raw === null) break;
          if (isBlankLine(raw)) { buf.push(stripCols(raw, 4)); j++; continue; }
          if (indentCols(raw) >= 4) { buf.push(stripCols(raw, 4)); j++; continue; }
          break;
        }
        // drop trailing blank lines
        while (buf.length > 0 && buf[buf.length - 1] === '') buf.pop();
        const toEof = j >= lines.length;
        addBlock({ t: 'code', text: buf.join('\n') + (buf.length ? (toEof && !endsWithNl ? '' : '\n') : ''), lang: null, fenced: false });
        li = j - 1;
        consumed = true;
        lastBlank = false;
        continue;
      }
      // fenced code
      {
        const fm = /^ {0,3}(`{3,}|~{3,})/.exec(rest);
        if (fm) {
          const fence = fm[1];
          const ch = fence[0];
          const info = rest.slice(fm[0].length);
          if (!(ch === '`' && info.includes('`'))) {
            const fenceIndent = fm[0].length - fence.length;
            const containers = open.slice(1).filter((b) => b.t === 'quote' || b.t === 'item' || b.t === 'list');
            const lang = info.trim().split(/\s+/)[0] || '';
            const buf = [];
            let j = li + 1;
            let closedFence = false;
            const closeRe = new RegExp(`^ {0,3}${ch}{${fence.length},}[ \\t]*$`);
            while (j < lines.length) {
              const r = stripContainersLeaf(lines[j], containers);
              let raw;
              if (r.ok) raw = r.text;
              else {
                // fails a container: a closing fence still closes it, a
                // plain line is loose content, anything else ends the
                // fence. The failure may be at ANY item (a low-indent line
                // fails the outermost item first); only a quote failure
                // ends the fence.
                const failed = containers[r.failIdx];
                if (!failed || failed.t !== 'item') break;
                if (closeRe.test(r.partial)) { closedFence = true; j++; break; }
                if (matchListMarker(r.partial) !== null || startsInterruptingBlock(r.partial)) break;
                raw = r.partial;
              }
              if (closeRe.test(raw)) { closedFence = true; j++; break; }
              // marked strips the opening fence's indent from content
              // lines ONLY for backtick fences (its indentCodeCompensation
              // regex is /^(\s+)(?:```)/); tilde fences keep full indent
              buf.push(stripCols(raw, ch === '`' ? fenceIndent : 0));
              j++;
            }
            let text = buf.join('\n');
            if (buf.length > 0) {
              // the newline just before the closing fence is the separator,
              // not content: a closed fence whose last line is empty gets
              // no extra trailing newline (cm-318); a whitespace-only last
              // line still gets one (cm-129)
              if (closedFence) { if (buf[buf.length - 1] !== '') text += '\n'; }
              else if (endsWithNl) { text += '\n'; }
            }
            addBlock({ t: 'code', text, lang: lang ? unescapePunct(lang) : null, fenced: true });
            li = j - 1;
            consumed = true;
            lastBlank = false;
            continue;
          }
        }
      }
      // ATX heading
      {
        const hm = /^ {0,3}(#{1,6})(.*)$/.exec(rest);
        if (hm && (hm[2] === '' || hm[2][0] === ' ' || hm[2][0] === '\t')) {
          // strip a closing run of #s when preceded by whitespace
          let text = hm[2].replace(/[ \t]+#+[ \t]*$/, '').trim();
          addBlock({ t: 'heading', level: hm[1].length, text });
          consumed = true;
          lastBlank = false;
          continue;
        }
      }
      // hr
      if (HR_RE.test(rest)) {
        addBlock({ t: 'hr' });
        consumed = true;
        lastBlank = false;
        continue;
      }
      // blockquote
      if (/^ {0,3}>/.test(rest)) {
        const q = { t: 'quote', children: [] };
        addBlock(q);
        open.push(q);
        rest = stripQuotePrefix(rest);
        continue; // reprocess the same line inside the quote
      }
      // list
      {
        const m = matchListMarker(rest);
        if (m) {
          // new list (or nested list) at this level
          const list = { t: 'list', ordered: m.ordered, start: 0, bullet: m.bullet, delim: m.delim, items: [], loose: false };
          if (m.ordered) list.start = parseInt(rest.slice(m.indent, m.indent + m.markerLen - 1), 10);
          addBlock(list);
          open.push(list);
          const item = { t: 'item', children: [], indent: m.contentIndent, task: false, checked: false, blankBefore: blankBeforeAt(open.length - 1) };
          list.items.push(item);
          open.push(item);
          rest = m.content;
          const task = matchTask(rest);
          if (task) { item.task = true; item.checked = task.checked; rest = task.rest; }
          if (rest === '' || isBlankLine(rest)) {
            consumed = true;
            lastBlank = false;
            continue;
          }
          lastBlank = false;
          continue; // reprocess content as a block start (Phase B)
        }
      }
      // html block
      {
        const ht = htmlBlockType(rest);
        if (ht > 0) {
          const containers = open.slice(1).filter((b) => b.t === 'quote' || b.t === 'item' || b.t === 'list');
          const buf = [rest];
          let j = li + 1;
          const nextLine = () => {
            if (j >= lines.length) return null;
            return leafLine(lines[j], containers);
          };
          if (ht === 1) {
            const tag = /<(script|pre|style|textarea)/i.exec(rest)[1].toLowerCase();
            const closeRe = new RegExp(`</${tag}`, 'i');
            if (!closeRe.test(rest)) {
              let raw;
              while ((raw = nextLine()) !== null && !closeRe.test(raw)) { buf.push(raw); j++; }
              if (raw !== null) { buf.push(raw); j++; }
            }
          } else if (ht === 2) {
            if (!rest.includes('-->')) {
              let raw;
              while ((raw = nextLine()) !== null && !raw.includes('-->')) { buf.push(raw); j++; }
              if (raw !== null) { buf.push(raw); j++; }
            }
          } else if (ht === 3) {
            if (!rest.includes('?>')) {
              let raw;
              while ((raw = nextLine()) !== null && !raw.includes('?>')) { buf.push(raw); j++; }
              if (raw !== null) { buf.push(raw); j++; }
            }
          } else if (ht === 4) {
            if (!rest.includes('>')) {
              let raw;
              while ((raw = nextLine()) !== null && !raw.includes('>')) { buf.push(raw); j++; }
              if (raw !== null) { buf.push(raw); j++; }
            }
          } else if (ht === 5) {
            if (!rest.includes(']]>')) {
              let raw;
              while ((raw = nextLine()) !== null && !raw.includes(']]>')) { buf.push(raw); j++; }
              if (raw !== null) { buf.push(raw); j++; }
            }
          } else {
            // types 6-7 end at a blank line
            let raw;
            while ((raw = nextLine()) !== null && !isBlankLine(raw)) { buf.push(raw); j++; }
          }
          // marked's ge(): the block text keeps a single trailing newline,
          // but loses it when the block is followed by a blank line (the
          // raw match then ends with 2+ newlines), or when the block ends
          // because its container ends (the chunk has no trailing newline).
          let endsBlank;
          if (j >= lines.length) endsBlank = false; // EOF: endsWithNl decides
          else {
            const s = leafLine(lines[j], containers);
            endsBlank = s === null ? true : isBlankLine(s);
          }
          addBlock({ t: 'html', text: buf.join('\n') + (endsBlank ? '' : (j >= lines.length && !endsWithNl ? '' : '\n')) });
          li = j - 1;
          consumed = true;
          lastBlank = false;
          continue;
        }
      }
      // paragraph start
      {
        const p = { t: 'para', lines: [rest] };
        addBlock(p);
        open.push(p);
        consumed = true;
        lastBlank = false;
        continue;
      }
    }
  }
  closeFrom(1);
  return root;

  function listsMatch(list, m) {
    if (list.ordered !== m.ordered) return false;
    if (!m.ordered) return list.bullet === m.bullet;
    return list.delim === m.delim;
  }
  function matchTask(s) {
    const m = /^\[([ xX])\][ \t]+/.exec(s);
    if (!m) return null;
    return { checked: m[1] === 'x' || m[1] === 'X', rest: s.slice(m[0].length) };
  }
  function startsInterruptingBlock(s, inItem) {
    // a backtick fence whose info string contains a backtick is not a
    // fence at all (it is a code span in the paragraph), so it does not
    // interrupt — this must agree with the fence-open check
    const fm = /^ {0,3}(`{3,}|~{3,})/.exec(s);
    if (fm) {
      const info = s.slice(fm[0].length);
      if (!(fm[1][0] === '`' && info.includes('`'))) return true;
    }
    if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(s)) return true;
    if (HR_RE.test(s)) return true;
    const ht = htmlBlockType(s);
    if (ht > 0 && htmlInterrupts(ht)) return true;
    if (/^ {0,3}>/.test(s)) return true;
    const m = matchListMarker(s);
    if (m && listInterrupts(m, s, inItem)) return true;
    return false;
  }
  // For a leaf block (fenced code / HTML block / def continuation) inside
  // containers: get the next content line. A line that fails the innermost
  // container still belongs to the leaf when the failing container is an
  // item and the line does not start a block that ends the item (any list
  // marker, or a paragraph-interrupting block); a failing quote always ends
  // the leaf. Returns the content line, or null to stop.
  function leafLine(line, containers) {
    const r = stripContainersLeaf(line, containers);
    if (r.ok) return r.text;
    const failed = containers[r.failIdx];
    if (!failed || failed.t !== 'item') return null;
    if (r.failIdx !== containers.length - 1) return null;
    if (matchListMarker(r.partial) !== null || startsInterruptingBlock(r.partial)) return null;
    return r.partial;
  }
  function startsRowBlockingBlock(s) {
    const fm = /^ {0,3}(`{3,}|~{3,})/.exec(s);
    if (fm) {
      const info = s.slice(fm[0].length);
      if (!(fm[1][0] === '`' && info.includes('`'))) return true;
    }
    if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(s)) return true;
    if (/^ {0,3}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$/.test(s)) return true;
    const ht = htmlBlockType(s);
    if (ht > 0 && htmlInterrupts(ht)) return true;
    if (/^ {0,3}>/.test(s)) return true;
    if (matchListMarker(s)) return true;
    // a lone-tab line is a table row (empty cells), not indented code
    if (indentCols(s) >= 4 && !/^\t+$/.test(s)) return true;
    return false;
  }
}

// ---- inline scanner ----

// marked's inLink lexer state (see parse()): a raw <a ...> tag opens it,
// only </a> closes it; it persists across blocks. The GFM bare-autolink
// rule (www./scheme://, email) only runs when !inLink.
let inLinkState = false;
const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;

// Node kinds: 0 text, 1 code, 2 hardbreak, 3 raw html, 4 link, 5 image,
// 6 delimiter run, 7 em/strong/del wrapper.

const EMAIL_RE = /^[A-Za-z0-9._+\-]+@[a-zA-Z0-9\-_]+(?:\.[a-zA-Z0-9\-_]*[a-zA-Z0-9])+/;
const EMAIL_LOCAL = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~\-]/;
const SCHEME_RE = /^(?:[a-zA-Z][a-zA-Z0-9+.\-]{1,31}):\/\/[^\s<]*/;
const WWW_RE = /^www\.(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*/;
const AUTOLINK_RE = /^<([a-zA-Z][a-zA-Z0-9+.\-]{1,31}:[^\s\x00-\x1f<>]*)>/;
const AUTOLINK_EMAIL_RE = /^<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~\-]+@[a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)+)>/;

// marked's backpedal: match a prefix of the URL candidate, excluding a
// trailing entity (&...;) and unbalanced trailing punctuation. Applied
// repeatedly until it stops changing (marked's url() fixed-point loop).
const BACKPEDAL_RE = /^(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function backpedal(u) {
  let cur = u;
  for (;;) {
    const m = BACKPEDAL_RE.exec(cur);
    const next = m ? m[0] : '';
    if (next === cur) return cur;
    cur = next;
  }
}

// Try to match an inline HTML tag at src[i] (i at '<'). Returns the tag
// string or null.
// Inline HTML tag, per marked's St regex: open tag (attributes must be
// whitespace-separated, unquoted values may not contain ' " = < > `),
// close tag (no attributes), comment (<!--> and <!---> are complete),
// processing instruction, declaration (needs whitespace after the name),
// CDATA. Unterminated PI/CDATA/declaration are NOT tags.
const HTML_TAG_RE = /^(?:<!--(?:-?>|[\s\S]*?(?:-->|$))|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![a-zA-Z]+\s[\s\S]*?>|<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>)/;
function matchHtmlTag(src, i) {
  const m = HTML_TAG_RE.exec(src.slice(i));
  return m ? m[0] : null;
}

// Try strikethrough starting at a ~ run at src[i]. Returns {html, end}
// or null.
function tryDel(src, i, refs) {
  const n = src.length;
  let run = 0;
  while (i + run < n && src[i + run] === '~') run++;
  const openLen = Math.min(run, 2);
  const first = src[i + openLen];
  if (first === undefined || isSpace(first) || first === '~') return null;
  // find the earliest valid closer run of exactly openLen tildes; a
  // closer whose content ends in whitespace is invalid for THIS opener
  // (it may be an inner opener), so keep searching past it — that is
  // what lets ~~a ~~b~~ c~~ nest instead of stranding the outer pair
  let j = i + openLen;
  while (j < n) {
    if (src[j] === '~') {
      let k = j;
      while (k < n && src[k] === '~') k++;
      if (k - j === openLen && (k >= n || src[k] !== '~')) {
        const content = src.slice(i + openLen, j);
        if (content.length > 0) {
          const last = content[content.length - 1];
          const lastOk = !isSpace(last) && last !== '~';
          if (lastOk) {
            return { kids: inlineNodes(content, refs), end: k };
          }
        }
        // invalid closer for this opener — keep searching
      }
      j = k;
    } else j++;
  }
  return null;
}

// Scan inline markdown into a node list (no emphasis resolution yet).
// Links use the commonmark.js bracket stack: '[' pushes a bracket, ']'
// resolves the most recent one (inline, full/collapsed/shortcut ref).
function inlineNodes(src, refs) {
  const nodes = [];
  const delims = [];
  const brackets = [];
  const n = src.length;
  let i = 0;
  let textStart = 0;
  const flushText = (end) => {
    if (end > textStart) nodes.push({ k: 0, s: src.slice(textStart, end) });
  };
  const pushNode = (node) => { flushText(i); nodes.push(node); };
  while (i < n) {
    const c = src[i];
    if (c === '\n') {
      // hard break: two or more trailing spaces in the text run
      let t = i;
      while (t > textStart && src[t - 1] === ' ') t--;
      if (i - t >= 2) {
        flushText(t);
        nodes.push({ k: 2 });
        i++;
        // after a hard break, leading spaces of the next line are consumed
        while (i < n && src[i] === ' ') i++;
        textStart = i;
      } else {
        flushText(i);
        nodes.push({ k: 0, s: '\n' });
        i++;
        textStart = i;
      }
      continue;
    }
    if (c === '\\') {
      const nx = src[i + 1];
      if (nx === '\n') {
        flushText(i);
        nodes.push({ k: 2 });
        i += 2;
        while (i < n && src[i] === ' ') i++;
        textStart = i;
        continue;
      }
      if (nx !== undefined && isAsciiPunct(nx)) {
        flushText(i);
        nodes.push({ k: 0, s: nx });
        i += 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '`') {
      let j = i;
      while (j < n && src[j] === '`') j++;
      const run = j - i;
      // find closing run of exactly this length
      let p = j;
      let closed = -1;
      while (p < n) {
        if (src[p] === '`') {
          let q = p;
          while (q < n && src[q] === '`') q++;
          if (q - p === run) { closed = p; break; }
          p = q;
        } else p++;
      }
      if (closed === -1) { i = j; continue; }
      let content = src.slice(j, closed);
      content = content.replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      pushNode({ k: 1, s: content });
      i = closed + run;
      textStart = i;
      continue;
    }
    if (c === '<') {
      let m = AUTOLINK_RE.exec(src.slice(i, i + 200)) || AUTOLINK_EMAIL_RE.exec(src.slice(i, i + 200));
      if (m) {
        const url = m[1];
        const isEmail = url.indexOf(':') === -1;
        const href = cleanUrl(isEmail ? 'mailto:' + url : url);
        if (href !== null) {
          pushNode({ k: 4, href, title: null, kids: [{ k: 0, s: url }] });
          i += m[0].length;
          textStart = i;
          continue;
        }
      }
      const tag = matchHtmlTag(src, i);
      if (tag !== null) {
        if (!inLinkState && START_A_TAG.test(tag)) inLinkState = true;
        else if (inLinkState && END_A_TAG.test(tag)) inLinkState = false;
        pushNode({ k: 3, s: tag });
        i += tag.length;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '!' && src[i + 1] === '[') {
      // image bracket (commonmark.js parseBang): the '![' stays literal
      // unless the image forms
      flushText(i);
      if (brackets.length > 0) brackets[brackets.length - 1].bracketAfter = true;
      brackets.push({ nodeIdx: nodes.length, srcPos: i + 1, image: true, active: true, bracketAfter: false, delimCount: delims.length });
      nodes.push({ k: 0, s: '![' });
      i += 2;
      textStart = i;
      continue;
    }
    if (c === '[') {
      flushText(i);
      if (brackets.length > 0) brackets[brackets.length - 1].bracketAfter = true;
      brackets.push({ nodeIdx: nodes.length, srcPos: i, image: false, active: true, bracketAfter: false, delimCount: delims.length });
      nodes.push({ k: 0, s: '[' });
      i++;
      textStart = i;
      continue;
    }
    if (c === ']') {
      // resolve the most recent bracket (commonmark.js parseCloseBracket)
      const opener = brackets.length > 0 ? brackets[brackets.length - 1] : null;
      if (!opener || !opener.active) {
        if (opener) brackets.pop();
        i++;
        continue;
      }
      const rawText = src.slice(opener.srcPos + 1, i);
      let href = null;
      let title = null;
      let end = i + 1;
      let matched = false;
      // inline link
      if (src[i + 1] === '(') {
        const d = matchInlineLink(src, i + 1);
        if (d) { href = d.href; title = d.title; end = d.end; matched = true; }
      }
      if (!matched) {
        // reference: explicit label, else collapsed [] / shortcut (unless
        // a '[' follows the opener, which blocks the shortcut form)
        let reflabel = null;
        let labelEnd = i + 1;
        if (src[i + 1] === '[' && src[i + 2] === ']') {
          // collapsed []
          if (!opener.bracketAfter) { reflabel = rawText; labelEnd = i + 3; }
        } else {
          const lab = matchLabel(src, i + 1);
          if (lab) { reflabel = lab.label; labelEnd = lab.end; }
          else if (!opener.bracketAfter) { reflabel = rawText; labelEnd = i + 1; }
        }
        if (reflabel !== null) {
          const ref = refs.get(normLabel(reflabel));
          if (ref) { href = ref.href; title = ref.title; end = labelEnd; matched = true; }
        }
      }
      if (matched) {
        const clean = cleanUrl(href);
        if (clean !== null) {
          // drop delimiters recorded inside the link text (re-parsed below)
          delims.length = opener.delimCount;
          // inside a link, inLink is true (marked's link tokenizer sets
          // it while parsing the text), so bare URLs in the text do not
          // become autolinks; restore it afterwards
          const savedInLink = inLinkState;
          inLinkState = true;
          const kids = inlineNodes(rawText, refs);
          inLinkState = savedInLink;
          const linkNode = opener.image
            ? { k: 5, href: clean, title, kids }
            : { k: 4, href: clean, title, kids };
          nodes.length = opener.nodeIdx;
          nodes.push(linkNode);
          brackets.pop();
          // no links in links: deactivate earlier non-image brackets
          if (!opener.image) {
            for (const b of brackets) if (!b.image) b.active = false;
          }
          i = end;
          textStart = i;
          continue;
        }
      }
      // no match: pop the opener, the ']' stays literal
      brackets.pop();
      i++;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      // delimiter run (strikethrough ~ is a delimiter-stack construct
      // like * and _; 1 or 2 tildes both form <del>)
      let j = i;
      while (j < n && src[j] === c) j++;
      const runLen = j - i;
      // a run of 3+ tildes is not a strikethrough delimiter (gfm-493)
      if (c === '~' && runLen > 2) { i = j; continue; }
      const prev = i > 0 ? src[i - 1] : undefined;
      const next = j < n ? src[j] : undefined;
      // flanking uses Unicode whitespace (NBSP counts, cm-353)
      const prevWs = prev === undefined || isUniSpace(prev);
      const nextWs = next === undefined || isUniSpace(next);
      const prevPunct = isPunct(prev);
      const nextPunct = isPunct(next);
      const leftFlanking = !nextWs && (!nextPunct || prevWs || prevPunct);
      const rightFlanking = !prevWs && (!prevPunct || nextWs || nextPunct);
      let canOpen, canClose;
      if (c === '*') { canOpen = leftFlanking; canClose = rightFlanking; }
      else if (c === '~') { canOpen = leftFlanking; canClose = rightFlanking; }
      else {
        canOpen = leftFlanking && (!rightFlanking || prevPunct);
        canClose = rightFlanking && (!leftFlanking || nextPunct);
      }
      flushText(i);
      const node = { k: 6, ch: c, n: runLen };
      nodes.push(node);
      delims.push({ node, ch: c, n: runLen, orig: runLen, canOpen, canClose, pos: i });
      i = j;
      textStart = i;
      continue;
    }
    // GFM extended autolinks: www., scheme://, email — only when not
    // inside a link (marked: url rule runs only when !inLink) and not
    // inside an ACTIVE bracket (link text is parsed with inLink true, so
    // a www./scheme inside [text](url) stays plain text; but a bracket
    // already deactivated by an inner link no longer blocks autolinks)
    // inside a link (marked: url rule runs only when !inLink) and not
    // inside an ACTIVE bracket (link text is parsed with inLink true, so
    // a www./scheme inside [text](url) stays plain text; but a bracket
    // already deactivated by an inner link no longer blocks autolinks)
    if (!inLinkState && !brackets.some((b) => b.active) && (c === 'w' || c === 'h' || c === 'f' || isAlpha(c))) {
      const prev = i > 0 ? src[i - 1] : undefined;
      let url = null;
      let href = null;
      let adv = 0;
      if (src.startsWith('www.', i) && (prev === undefined || isSpace(prev) || prev === '*' || prev === '_' || prev === '~' || prev === '(')) {
        const m = WWW_RE.exec(src.slice(i));
        if (m) { url = backpedal(m[0]); href = 'http://' + url; adv = url.length; }
      } else if (/^(?:https?|ftp):\/\//i.test(src.slice(i, i + 8))) {
        const m = SCHEME_RE.exec(src.slice(i));
        if (m) { url = backpedal(m[0]); href = url; adv = url.length; }
      } else if ((src.startsWith('mailto:', i) || src.startsWith('xmpp:', i)) && (prev === undefined || isSpace(prev) || prev === '*' || prev === '_' || prev === '~' || prev === '(')) {
        // mailto:/xmpp: + email is a single autolink (gfm-634/635);
        // xmpp may carry one /resource segment. The email must not be
        // followed by a word char or '-' (marked's It lookahead (?![\w-]))
        const isXmpp = src.startsWith('xmpp:', i);
        const eStart = i + (isXmpp ? 5 : 7);
        const m = EMAIL_RE.exec(src.slice(eStart));
        if (m) {
          let end = eStart + m[0].length;
          if (isXmpp && src[end] === '/') {
            const r = /^\/[A-Za-z0-9@.]+/.exec(src.slice(end));
            if (r) end += r[0].length;
          }
          const after = src[end];
          if (after === undefined || !/[A-Za-z0-9\-_]/.test(after)) {
            url = src.slice(i, end);
            href = url;
            adv = url.length;
          }
        }
      } else if (prev === undefined || !EMAIL_LOCAL.test(prev)) {
        const m = EMAIL_RE.exec(src.slice(i));
        if (m) {
          // email must not be immediately followed by a word char or -
          const after = src[i + m[0].length];
          if (after === undefined || !/[A-Za-z0-9\-_]/.test(after)) {
            url = m[0];
            href = 'mailto:' + url;
            adv = url.length;
          }
        }
      }
      if (url !== null && url.length > 0) {
        const clean = cleanUrl(href);
        if (clean !== null) {
          pushNode({ k: 4, href: clean, title: null, kids: [{ k: 0, s: url }] });
          i += adv;
          textStart = i;
          continue;
        }
      }
    }
    i++;
  }
  flushText(n);
  resolveEmphasis(nodes, delims, src);
  return nodes;
}


// Resolve emphasis/delimiter runs with the CommonMark delimiter-stack
// algorithm (commonmark.js processEmphasis): openers_bottom indexed by
// (char, can_open, origdelims % 3); on a failed closer the bottom is set
// to the delimiter BEFORE the closer and a closer that cannot open is
// removed; the odd-match rule uses ORIGINAL run lengths; delimiters
// between a matched pair are removed from the stack and can never match
// again; a closer with delims left is re-processed.
function resolveEmphasis(nodes, delims, src) {
  if (delims.length === 0) return;
  // matched closing delimiters: a strong/em whose closing run is
  // immediately followed by a word run leading to a later closer blocks
  // that closer when the counts differ (marked's emStrong quirk:
  // `*a **b**c*` stays literal, `*a **b** c*` forms em)
  const matchedClosers = [];
  const isWordChar = (ch) => /[A-Za-z0-9]/.test(ch);
  const isBlocked = (found, cur) => {
    for (const mc of matchedClosers) {
      if (mc.endPos <= found.pos || mc.endPos >= cur.pos) continue;
      if (mc.count === cur.orig) continue;
      if (!mc.openerPrecededByWs) continue;
      let allWord = true;
      for (let p = mc.endPos; p < cur.pos; p++) {
        if (!isWordChar(src[p])) { allWord = false; break; }
      }
      if (allWord && cur.pos > mc.endPos) return true;
    }
    return false;
  };
  for (let idx = 0; idx < delims.length; idx++) {
    delims[idx].prev = idx > 0 ? delims[idx - 1] : null;
    delims[idx].next = idx + 1 < delims.length ? delims[idx + 1] : null;
    if (delims[idx].orig === undefined) delims[idx].orig = delims[idx].n;
  }
  const bottom = new Map();
  const bottomKey = (d) => d.ch + '|' + (d.canOpen ? 1 : 0) + '|' + (d.orig % 3);
  const removeDelim = (d) => {
    if (d.prev) d.prev.next = d.next;
    if (d.next) d.next.prev = d.prev;
    d.prev = null;
    d.next = null;
  };
  const removeBetween = (opener, closer) => {
    let d = opener.next;
    while (d && d !== closer) {
      const nx = d.next;
      removeDelim(d);
      d = nx;
    }
  };
  let cur = delims[0];
  while (cur) {
    if (cur.canClose && cur.n > 0) {
      let opener = cur.prev;
      let found = null;
      const limit = bottom.has(bottomKey(cur)) ? bottom.get(bottomKey(cur)) : null;
      // NOTE: no old_closer guard here — commonmark.js only checks the
      // openers_bottom limit (a previous closer can still be an opener)
      while (opener && opener !== limit) {
        // the odd-match rule (mod 3) applies to * and _ (CommonMark
        // emphasis) and to ~ (GFM del behaves like * here)
        const oddMatch =
          (cur.canOpen || opener.canClose) &&
          cur.orig % 3 !== 0 &&
          (opener.orig + cur.orig) % 3 === 0;
        if (opener.ch === cur.ch && opener.canOpen && opener.n > 0 && !oddMatch && !isBlocked(opener, cur)) {
          found = opener;
          break;
        }
        opener = opener.prev;
      }
      if (found) {
        // ~ always renders <del> (1 or 2 tildes, like em/strong counts)
        const use = found.n >= 2 && cur.n >= 2 ? 2 : 1;
        const tag = cur.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
        matchedClosers.push({ endPos: cur.pos + use, count: use, openerPrecededByWs: found.pos > 0 && isUniSpace(src[found.pos - 1]) });
        removeBetween(found, cur);
        const oi = nodes.indexOf(found.node);
        const ci = nodes.indexOf(cur.node);
        const kids = nodes.slice(oi + 1, ci);
        const wrap = { k: 7, tag, kids };
        found.n -= use;
        cur.n -= use;
        const replacement = [];
        if (found.n > 0) { found.node.n = found.n; replacement.push(found.node); }
        replacement.push(wrap);
        if (cur.n > 0) { cur.node.n = cur.n; replacement.push(cur.node); }
        nodes.splice(oi, ci - oi + 1, ...replacement);
        if (found.n === 0) removeDelim(found);
        if (cur.n === 0) {
          const nx = cur.next;
          removeDelim(cur);
          cur = nx;
        }
        // a closer with delims left is re-processed (same cur)
      } else {
        const prev = cur.prev;
        const nx = cur.next;
        if (!cur.canOpen) removeDelim(cur);
        bottom.set(bottomKey(cur), prev);
        cur = nx;
      }
    } else {
      cur = cur.next;
    }
  }
}

// Render inline nodes to plain text (image alt text): no tags, numeric
// refs decoded, hard breaks dropped.
function renderText(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.k) {
      case 0: out += decodeNumericRaw(nd.s); break;
      case 1: out += nd.s; break;
      case 2: break;
      case 3: out += nd.s; break;
      case 4: out += renderText(nd.kids); break;
      case 5: out += renderText(nd.kids); break;
      case 6: out += nd.ch.repeat(nd.n); break;
      case 7: out += renderText(nd.kids); break;
    }
  }
  return out;
}

// Render inline nodes to HTML.
function renderInline(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.k) {
      case 0: out += textHtml(nd.s); break;
      case 1: out += '<code>' + esc(nd.s, true) + '</code>'; break;
      case 2: out += '<br>'; break;
      case 3: out += nd.s; break;
      case 4: {
        out += '<a href="' + esc(nd.href, false) + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + esc(nd.title, false) + '"';
        out += '>' + renderInline(nd.kids) + '</a>';
        break;
      }
      case 5: {
        out += '<img src="' + esc(nd.href, false) + '" alt="' + esc(renderText(nd.kids), false) + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + esc(nd.title, false) + '"';
        out += '>';
        break;
      }
      case 6: out += nd.ch.repeat(nd.n); break;
      case 7: out += '<' + nd.tag + '>' + renderInline(nd.kids) + '</' + nd.tag + '>'; break;
    }
  }
  return out;
}

function inline(src, refs) {
  return renderInline(inlineNodes(src, refs));
}


// ---- renderer ----

function renderBlocks(node, refs, loose) {
  switch (node.t) {
    case 'doc': {
      let out = '';
      for (const ch of node.children) out += renderBlocks(ch, refs, false);
      return out;
    }
    case 'para':
      return '<p>' + inline(node.lines.join('\n'), refs) + '</p>\n';
    case 'heading':
      return `<h${node.level}>` + inline(node.text, refs) + `</h${node.level}>\n`;
    case 'code': {
      const lang = node.lang ? ` class="language-${esc(node.lang, false)}"` : '';
      return `<pre><code${lang}>` + esc(node.text, true) + '</code></pre>\n';
    }
    case 'hr':
      return '<hr>\n';
    case 'html':
      return node.text;
    case 'quote': {
      let out = '<blockquote>\n';
      for (const ch of node.children) out += renderBlocks(ch, refs, false);
      return out + '</blockquote>\n';
    }
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const start = node.ordered && node.start !== 1 ? ` start="${node.start}"` : '';
      let out = `<${tag}${start}>\n`;
      for (const item of node.items) out += renderItem(item, node.loose, refs);
      return out + `</${tag}>\n`;
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let i = 0; i < node.header.length; i++) {
        const a = node.align[i] ? ` align="${node.align[i]}"` : '';
        out += `<th${a}>` + inline(node.header[i], refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (node.rows.length > 0) {
        out += '<tbody>';
        for (const row of node.rows) {
          out += '<tr>\n';
          for (let i = 0; i < node.header.length; i++) {
            const a = node.align[i] ? ` align="${node.align[i]}"` : '';
            out += `<td${a}>` + inline(row[i] || '', refs) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
  }
  return '';
}

function renderItem(item, loose, refs) {
  const checkbox = item.task
    ? (item.checked ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">')
    : '';
  let out = '<li>';
  if (item.children.length === 0) {
    return out + checkbox + '</li>\n';
  }
  for (let i = 0; i < item.children.length; i++) {
    const ch = item.children[i];
    if (ch.t === 'para') {
      const body = inline(ch.lines.join('\n'), refs);
      if (loose) {
        out += '<p>' + (i === 0 && checkbox ? checkbox + ' ' : '') + body + '</p>\n';
      } else {
        out += (i === 0 && checkbox ? checkbox + ' ' : '') + body;
      }
    } else {
      if (i === 0 && checkbox) out += checkbox + ' ';
      out += renderBlocks(ch, refs, loose);
    }
  }
  return out + '</li>\n';
}

export function parse(markdown) {
  const src = markdown.replace(/\r\n?/g, '\n');
  const refs = new Map();
  const endsWithNl = src.endsWith('\n');
  const lines = src.split('\n');
  if (endsWithNl) lines.pop();
  // marked's lexer keeps inLink across blocks: a raw <a ...> tag opens it
  // and only </a> closes it, so a bare URL/email after an unclosed <a>
  // is NOT an autolink (the url rule only runs when !inLink)
  inLinkState = false;
  const root = parseBlocks(lines, refs, endsWithNl);
  return renderBlocks(root, refs, false);
}
