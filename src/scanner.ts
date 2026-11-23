import {
  hasCJKRelatedContent,
  isPunctuation,
  isWhitespace,
  isWhitespaceOrPunctuation,
} from "./cjk";

export type EmphasisKind =
  | "em"
  | "strong"
  | "strong-em"
  | "highlight"
  | "strike";

export type DelimiterMarker = "*" | "=" | "~";

export interface EmphasisMatch {
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
  delimiterLength: number;
  marker: DelimiterMarker;
  kind: EmphasisKind;
  cjkRelated: boolean;
}

export interface TextMask {
  from: number;
  to: number;
}

interface ScanPass {
  expression: RegExp;
  delimiterLength: number;
  marker: DelimiterMarker;
  kind: EmphasisKind;
}

/**
 * Order matters: longer asterisk runs must win before shorter ones.
 * Highlight and strikethrough use their own marker characters so they never
 * compete with emphasis, but they still run after it so nested markup stays
 * untouched.
 */
const SCAN_PASSES: ScanPass[] = [
  { expression: /\*\*\*(.+?)\*\*\*/g, delimiterLength: 3, marker: "*", kind: "strong-em" },
  { expression: /\*\*(.+?)\*\*/g, delimiterLength: 2, marker: "*", kind: "strong" },
  { expression: /\*([^*\n]+)\*/g, delimiterLength: 1, marker: "*", kind: "em" },
  { expression: /==(.+?)==/g, delimiterLength: 2, marker: "=", kind: "highlight" },
  { expression: /~~(.+?)~~/g, delimiterLength: 2, marker: "~", kind: "strike" },
];

function overlaps(a: TextMask, b: TextMask): boolean {
  return a.from < b.to && b.from < a.to;
}

function isMarkerAt(text: string, index: number, marker: DelimiterMarker): boolean {
  return index >= 0 && index < text.length && text[index] === marker;
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  let cursor = index - 1;
  while (cursor >= 0 && text[cursor] === "\\") {
    backslashes++;
    cursor--;
  }
  return backslashes % 2 === 1;
}

function backtickRunEnd(text: string, start: number): number {
  let end = start;
  while (end < text.length && text[end] === "`") end++;
  return end;
}

/** End of the first backtick run after `start` whose length matches exactly. */
function closingBacktickRunEnd(text: string, start: number, length: number): number {
  let cursor = start;
  while (cursor < text.length) {
    const runStart = text.indexOf("`", cursor);
    if (runStart === -1) return -1;
    const runEnd = backtickRunEnd(text, runStart);
    if (runEnd - runStart === length) return runEnd;
    cursor = runEnd;
  }
  return -1;
}

/**
 * Inline code and `$$` math masks, found in source order.
 *
 * One pass, because each syntax can contain the other's delimiters: in
 * `` `$$` `` the dollars are code, in `$$ `$$` ` the backticks are math.
 * Whichever opens first owns its delimiters, which two independent scans got
 * wrong. A code span also has to close on a backtick run of exactly the same
 * length, as CommonMark requires.
 */
export function findMasks(text: string): TextMask[] {
  const masks: TextMask[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "`") {
      if (isEscaped(text, i)) {
        i++;
        continue;
      }
      const runEnd = backtickRunEnd(text, i);
      const close = closingBacktickRunEnd(text, runEnd, runEnd - i);
      if (close === -1) {
        i = runEnd;
        continue;
      }
      masks.push({ from: i, to: close });
      i = close;
      continue;
    }
    if (text[i] === "$" && text[i + 1] === "$") {
      if (isEscaped(text, i)) {
        i++;
        continue;
      }
      let close = text.indexOf("$$", i + 2);
      while (close !== -1 && isEscaped(text, close)) {
        close = text.indexOf("$$", close + 2);
      }
      if (close === -1) {
        i += 2;
        continue;
      }
      masks.push({ from: i, to: close + 2 });
      i = close + 2;
      continue;
    }
    i++;
  }
  return masks;
}

function isMasked(position: number, masks: TextMask[]): boolean {
  return masks.some((mask) => mask.from <= position && position < mask.to);
}

function isValidCandidate(
  text: string,
  from: number,
  to: number,
  contentFrom: number,
  contentTo: number,
  pass: ScanPass,
): EmphasisMatch | null {
  if (contentFrom >= contentTo) return null;
  const content = text.slice(contentFrom, contentTo);
  if (/^\s/u.test(content) || /\s$/u.test(content)) return null;

  const cjkRelated = hasCJKRelatedContent(content);
  if (!cjkRelated) return null;

  const after = text.codePointAt(to);
  const relaxedClosingBoundary = cjkRelated && !isWhitespaceOrPunctuation(after);

  // A CJK-aware match accepts a non-space/non-punctuation character after a
  // punctuation-ending span. Otherwise retain the normal CommonMark boundary.
  if (!relaxedClosingBoundary && after !== undefined && !isWhitespaceOrPunctuation(after)) {
    return null;
  }

  const before = text.codePointAt(contentTo - 1);
  if (before === undefined || isWhitespace(before)) return null;

  return {
    from,
    to,
    contentFrom,
    contentTo,
    delimiterLength: pass.delimiterLength,
    marker: pass.marker,
    kind: pass.kind,
    cjkRelated,
  };
}

/**
 * Replace every character inside a mask with a placeholder that cannot act as a
 * delimiter. Indices are preserved, so a match found in the masked text can be
 * mapped straight back onto the real line.
 *
 * Masked spans only need to be hidden from the delimiter pattern: emphasis may
 * legitimately contain inline code (`**see `npm test` for details。**继续`), and
 * splitting the line at every mask would lose such a span entirely.
 */
function maskDelimiters(text: string, masks: TextMask[]): string {
  if (masks.length === 0) return text;
  const characters = text.split("");
  for (const mask of masks) {
    const end = Math.min(text.length, mask.to);
    for (let i = Math.max(0, mask.from); i < end; i++) {
      characters[i] = "\u0000";
    }
  }
  return characters.join("");
}

/**
 * Scan one line for one delimiter type. Delimiters inside masks were replaced
 * with placeholders beforehand, so they can never open or close a span, while
 * masked content in the middle of a span is harmless.
 *
 * Lookbehind is avoided on purpose: iOS before 16.4 does not support it, and
 * Obsidian ships on mobile, so the boundary checks are done by index instead.
 */
function scanWithRegex(
  text: string,
  scannable: string,
  pass: ScanPass,
  consumed: TextMask[],
): EmphasisMatch[] {
  const matches: EmphasisMatch[] = [];
  const expression = pass.expression;
  expression.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(scannable)) !== null) {
    const from = match.index;
    const to = from + match[0].length;
    const range = { from, to };
    if (consumed.some((item) => overlaps(item, range))) continue;

    // Part of a longer run of the same marker, e.g. the inner `**` of `***`.
    if (isMarkerAt(text, from - 1, pass.marker) || isMarkerAt(text, to, pass.marker)) {
      continue;
    }

    const contentFrom = from + pass.delimiterLength;
    const contentTo = to - pass.delimiterLength;

    // A backslash-escaped marker is literal text, not a delimiter.
    if (isEscaped(text, from) || isEscaped(text, contentTo)) {
      expression.lastIndex = from + 1;
      continue;
    }

    const candidate = isValidCandidate(text, from, to, contentFrom, contentTo, pass);
    if (!candidate) {
      // The closer the pattern picked may be a false one: a space before it, a
      // run that cannot close, ... Resuming one character after the opener lets
      // the next delimiter be tried instead of dropping the rest of the line.
      expression.lastIndex = from + 1;
      continue;
    }

    matches.push(candidate);
    consumed.push(range);
  }
  return matches;
}

export function scanLine(text: string): { matches: EmphasisMatch[]; masks: TextMask[] } {
  const masks = findMasks(text);
  const scannable = maskDelimiters(text, masks);
  const consumed: TextMask[] = [];
  const matches: EmphasisMatch[] = [];

  for (const pass of SCAN_PASSES) {
    matches.push(...scanWithRegex(text, scannable, pass, consumed));
  }

  return {
    matches: matches.sort((a, b) => a.from - b.from),
    masks,
  };
}

/**
 * Read the code point that ends at `index`. `codePointAt(index - 1)` alone
 * returns the trailing surrogate of a surrogate pair.
 */
function codePointBefore(text: string, index: number): number | undefined {
  if (index <= 0) return undefined;
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.codePointAt(index - 2);
  }
  return text.codePointAt(index - 1);
}

export function trailingPunctuationLength(text: string, from: number, to: number): number {
  let cursor = to;
  while (cursor > from) {
    const code = codePointBefore(text, cursor);
    if (code === undefined || !isPunctuation(code)) break;
    cursor -= code > 0xffff ? 2 : 1;
  }
  return to - cursor;
}

export interface SourceFix {
  from: number;
  to: number;
  replacement: string;
}

/** Opening character for each closing character the punctuation walker may meet. */
const CLOSING_TO_OPENING: Record<string, string> = {
  "”": "“",
  "’": "‘",
  "）": "（",
  "】": "【",
  "」": "「",
  "』": "『",
  "》": "《",
  "〉": "〈",
  "〕": "〔",
  "〗": "〖",
  ")": "(",
  "]": "[",
  "}": "{",
  "］": "［",
  "｝": "｛",
};

function overlapsAnyMask(masks: TextMask[], from: number, to: number): boolean {
  return masks.some((mask) => overlaps(mask, { from, to }));
}

/**
 * A closing bracket or quote in the trailing run belongs to a pair opened
 * inside the span, so moving only the closer would break that pair.
 */
function containsOpenedPair(content: string, trailing: string): boolean {
  for (const character of trailing) {
    const opening = CLOSING_TO_OPENING[character];
    if (opening !== undefined && content.includes(opening)) return true;
  }
  return false;
}

function canOpenEmphasis(text: string, start: number, length: number): boolean {
  const after = text.codePointAt(start + length);
  if (after === undefined || isWhitespace(after)) return false;
  if (!isPunctuation(after)) return true;
  const before = codePointBefore(text, start);
  return before === undefined || isWhitespace(before) || isPunctuation(before);
}

function canCloseEmphasis(text: string, start: number, length: number): boolean {
  const before = codePointBefore(text, start);
  if (before === undefined || isWhitespace(before)) return false;
  if (!isPunctuation(before)) return true;
  const after = text.codePointAt(start + length);
  return after === undefined || isWhitespace(after) || isPunctuation(after);
}

export function findSourceFixes(text: string): SourceFix[] {
  const { matches, masks } = scanLine(text);
  const fixes: SourceFix[] = [];
  for (const match of matches) {
    if (isMasked(match.from, masks)) continue;
    const after = text.codePointAt(match.to);
    if (after === undefined || isWhitespaceOrPunctuation(after)) continue;

    const punctLength = trailingPunctuationLength(text, match.contentFrom, match.contentTo);
    if (punctLength === 0) continue;

    const punctuationFrom = match.contentTo - punctLength;
    const punctuation = text.slice(punctuationFrom, match.contentTo);
    const contentWithoutPunctuation = text.slice(match.contentFrom, punctuationFrom);

    // Punctuation that reaches into inline code is code content: moving it
    // would rewrite what the code span contains.
    if (overlapsAnyMask(masks, punctuationFrom, match.contentTo)) continue;
    if (contentWithoutPunctuation.length === 0) continue;
    if (containsOpenedPair(contentWithoutPunctuation, punctuation)) continue;

    const delimiter = text.slice(match.from, match.contentFrom);
    const replacement = `${delimiter}${contentWithoutPunctuation}${delimiter}${punctuation}`;

    // Emphasis has to satisfy CommonMark's flanking rules on both sides after
    // the rewrite. Moving punctuation out of a span that starts with an opening
    // quote leaves the delimiter unable to open, so skip instead of producing
    // text that still renders as literal markers.
    if (match.marker === "*") {
      const rewritten =
        text.slice(0, match.from) + replacement + text.slice(match.to);
      const closerStart = match.from + delimiter.length + contentWithoutPunctuation.length;
      if (
        !canOpenEmphasis(rewritten, match.from, delimiter.length) ||
        !canCloseEmphasis(rewritten, closerStart, delimiter.length)
      ) {
        continue;
      }
    }

    fixes.push({
      from: match.from,
      to: match.to,
      replacement,
    });
  }
  return fixes;
}

/**
 * Parser emphasis that reaches past an intended closing delimiter.
 *
 * A parser run that starts inside or before the span and ends after the
 * delimiter styles characters the author did not mark. Several runs may cover
 * the same span, so every one of them is considered instead of only the first
 * range that happens to cover the whole content.
 */
export function findExcessParserRanges(
  matchEnds: readonly number[],
  parserRanges: readonly TextMask[],
  lineTo: number,
): TextMask[] {
  const excess: TextMask[] = [];
  for (const matchEnd of matchEnds) {
    for (const range of parserRanges) {
      if (range.to <= matchEnd || range.from >= matchEnd) continue;
      const from = Math.max(matchEnd, range.from);
      const to = Math.min(range.to, lineTo);
      if (to > from) excess.push({ from, to });
    }
  }
  return excess;
}

interface Fence {
  character: string;
  length: number;
  quoteDepth: number;
  containerIndent: number;
}

interface MathBlock {
  quoteDepth: number;
  containerIndent: number;
}

const LIST_ITEM = /^( {0,3})([-+*]|\d{1,9}[.)])( +)/;
const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

function parseQuoteMarkers(line: string): { depth: number; rest: string } {
  let rest = line;
  let depth = 0;
  for (;;) {
    const match = rest.match(/^ {0,3}> ?/);
    if (!match) break;
    depth++;
    rest = rest.slice(match[0].length);
  }
  return { depth, rest };
}

/** Strip exactly `depth` blockquote markers; null when the line is shallower. */
function stripQuoteDepth(line: string, depth: number): string | null {
  let rest = line;
  for (let level = 0; level < depth; level++) {
    const match = rest.match(/^ {0,3}> ?/);
    if (!match) return null;
    rest = rest.slice(match[0].length);
  }
  return rest;
}

/** Indentation width, counting a tab as advancing to the next multiple of 4. */
function indentationColumns(line: string): number {
  let column = 0;
  for (const character of line) {
    if (character === " ") column++;
    else if (character === "\t") column += 4 - (column % 4);
    else break;
  }
  return column;
}

/** Remove `columns` of leading whitespace; null when the line is shallower. */
function stripIndent(line: string, columns: number): string | null {
  let column = 0;
  let index = 0;
  while (index < line.length && column < columns) {
    const character = line[index];
    if (character === " ") column++;
    else if (character === "\t") column += 4 - (column % 4);
    else return null;
    index++;
  }
  return column >= columns ? line.slice(index) : null;
}

function isClosingFence(line: string, fence: Fence): boolean {
  const match = line.match(CLOSING_FENCE);
  return (
    match !== null &&
    match[1][0] === fence.character &&
    match[1].length >= fence.length
  );
}

/** YAML frontmatter: `---` on line one, a closing delimiter, no blank line. */
function findFrontmatterEnd(lines: readonly string[]): number {
  if (lines.length === 0) return -1;
  if (lines[0].replace(/\r$/, "") !== "---") return -1;
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, "");
    if (line.trim() === "") return -1;
    if (line === "---" || line === "...") return index;
  }
  return -1;
}

type HtmlBlock =
  | { kind: "until-pattern"; pattern: RegExp }
  | { kind: "until-blank" }
  | { kind: "single" };

/** Block-level tags: their content is raw HTML up to the next blank line. */
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "base", "basefont", "blockquote", "body",
  "caption", "center", "col", "colgroup", "dd", "details", "dialog", "dir",
  "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form",
  "frame", "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header",
  "hr", "html", "iframe", "legend", "li", "link", "main", "menu", "menuitem",
  "nav", "noframes", "ol", "optgroup", "option", "p", "param", "search",
  "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead",
  "title", "tr", "track", "ul",
]);

/** Open an HTML block whose body must not be rewritten. */
function openHtmlBlock(line: string): HtmlBlock | null {
  const tag = line.match(/^ {0,3}<(pre|code|script|style)(?=[\s>]|$)/i);
  if (tag) {
    const closer = new RegExp(`</${tag[1].toLowerCase()}\\s*>`, "i");
    return closer.test(line) ? { kind: "single" } : { kind: "until-pattern", pattern: closer };
  }
  if (/^ {0,3}<!--/.test(line)) {
    return line.includes("-->") ? { kind: "single" } : { kind: "until-pattern", pattern: /-->/ };
  }
  const block = line.match(/^ {0,3}<\/?([a-z][a-z0-9-]*)(?=[\s>]|$)/i);
  if (block && BLOCK_TAGS.has(block[1].toLowerCase())) {
    return { kind: "until-blank" };
  }
  return null;
}

/**
 * Mark the lines whose content is literal text: fenced code, `$$` math blocks
 * and indented code. Emphasis markers on those lines are content, so neither
 * the rewrite command nor the Live Preview decorations may touch them.
 *
 * Both call sites share this classifier so a line can never be treated as
 * prose for rendering but as code for rewriting, or the other way round.
 */
export function findLiteralLines(lines: readonly string[]): boolean[] {
  const literal: boolean[] = [];
  const frontmatterEnd = findFrontmatterEnd(lines);
  let fence: Fence | null = null;
  let math: MathBlock | null = null;
  let htmlBlock: HtmlBlock | null = null;
  let inIndentedCode = false;
  let listIndent = 0;
  // An indented code block cannot interrupt a paragraph: it needs a blank line
  // (or the start of the document) before it.
  let afterBlankLine = true;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, "");
    const { depth, rest } = parseQuoteMarkers(line);
    const trimmed = rest.trim();
    const blank = trimmed.length === 0;

    if (index <= frontmatterEnd) {
      literal.push(true);
      afterBlankLine = blank;
      continue;
    }

    if (htmlBlock) {
      literal.push(true);
      if (htmlBlock.kind === "until-blank") {
        if (blank) htmlBlock = null;
      } else if (htmlBlock.kind === "until-pattern" && htmlBlock.pattern.test(rest)) {
        htmlBlock = null;
      }
      afterBlankLine = blank;
      continue;
    }

    // A fence belongs to the container it opened in: a line from a shallower
    // blockquote, or one indented less than the list item, ends it. Quote
    // markers beyond the fence's own depth are content, not nesting.
    if (fence) {
      const quoted = stripQuoteDepth(line, fence.quoteDepth);
      const inner = quoted === null ? null : stripIndent(quoted, fence.containerIndent);
      if (inner !== null) {
        if (isClosingFence(inner, fence)) fence = null;
        literal.push(true);
        afterBlankLine = blank;
        continue;
      }
      fence = null;
    }

    if (math) {
      const quoted = stripQuoteDepth(line, math.quoteDepth);
      const inner = quoted === null ? null : stripIndent(quoted, math.containerIndent);
      if (inner !== null) {
        if (inner.trimEnd().endsWith("$$")) math = null;
        literal.push(true);
        afterBlankLine = blank;
        continue;
      }
      math = null;
    }

    const html = openHtmlBlock(rest);
    if (html) {
      if (html.kind !== "single") htmlBlock = html;
      literal.push(true);
      afterBlankLine = blank;
      continue;
    }

    // Track the innermost list item so its indented content is prose, not code.
    let contentColumn = 0;
    let body = rest;
    const marker = rest.match(LIST_ITEM);
    if (marker) {
      const spaces = Math.min(marker[3].length, 4);
      contentColumn = marker[1].length + marker[2].length + spaces;
      listIndent = contentColumn;
      body = rest.slice(marker[0].length);
    } else if (!blank && listIndent > 0 && indentationColumns(rest) < listIndent) {
      listIndent = 0;
    }

    const bodyIndent = indentationColumns(body);
    const opening = bodyIndent < 4 ? body.match(OPENING_FENCE) : null;
    // A backtick fence may not carry a backtick in its info string; such a
    // line is a paragraph, not a code block.
    if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) {
      fence = {
        character: opening[1][0],
        length: opening[1].length,
        quoteDepth: depth,
        containerIndent: contentColumn,
      };
      literal.push(true);
      afterBlankLine = blank;
      continue;
    }

    // A line that opens and closes `$$` on its own is a mask for the line
    // scanner, not a block; only an unclosed opener starts block state.
    const bodyTrimmed = body.trim();
    if (
      bodyIndent < 4 &&
      bodyTrimmed.startsWith("$$") &&
      bodyTrimmed.indexOf("$$", 2) === -1
    ) {
      math = { quoteDepth: depth, containerIndent: contentColumn };
      literal.push(true);
      afterBlankLine = blank;
      continue;
    }

    const codeIndent = listIndent > 0 ? listIndent + 4 : 4;
    if (bodyIndent >= codeIndent && (inIndentedCode || afterBlankLine)) {
      inIndentedCode = true;
      literal.push(true);
      afterBlankLine = blank;
      continue;
    }

    inIndentedCode = false;
    literal.push(false);
    afterBlankLine = blank;
  }

  return literal;
}

/**
 * Scan an entire document for CJK emphasis fixes.
 *
 * Lines inside fenced code, `$$` math blocks and indented code are content,
 * not prose: their markers are literal and must never be rewritten.
 */
export function findDocumentFixes(text: string): SourceFix[] {
  const fixes: SourceFix[] = [];
  const lines = text.split("\n");
  const literal = findLiteralLines(lines);
  let lineFrom = 0;

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const lineText = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!literal[index]) {
      for (const fix of findSourceFixes(lineText)) {
        fixes.push({
          from: lineFrom + fix.from,
          to: lineFrom + fix.to,
          replacement: fix.replacement,
        });
      }
    }
    lineFrom += raw.length + 1;
  }
  return fixes;
}