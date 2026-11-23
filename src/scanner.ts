import { parser as markdownParser } from "@lezer/markdown";
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
  if (contentFrom >= contentTo) return null;
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
function maskDelimiters(text: string, masks: readonly TextMask[]): string {
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
  barriers: readonly TextMask[] = [],
): EmphasisMatch[] {
  const matches: EmphasisMatch[] = [];
  const expression = pass.expression;
  expression.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(scannable)) !== null) {
    const from = match.index;
    const to = from + match[0].length;
    const range = { from, to };
    if (barriers.some((barrier) => overlaps(barrier, range))) {
      // Syntax such as a URL, an HTML tag or a link title cannot be crossed by
      // one emphasis span; the delimiters on either side belong to different
      // contexts.
      expression.lastIndex = from + 1;
      continue;
    }
    if (consumed.some((item) => overlaps(item, range))) {
      // This match reuses a delimiter that is already part of another span.
      // Resume after the opener so a later span on the same line can still be
      // found; otherwise `**甲** *乙。*续` loses the italic repair entirely.
      expression.lastIndex = from + 1;
      continue;
    }

    // Part of a longer run of the same marker, e.g. the inner `**` of `***`.
    if (isMarkerAt(text, from - 1, pass.marker) || isMarkerAt(text, to, pass.marker)) {
      continue;
    }

    const contentFrom = from + pass.delimiterLength;
    const contentTo = to - pass.delimiterLength;

    // A backslash-escaped marker is literal text, not a delimiter.
    if (isEscaped(text, from)) {
      expression.lastIndex = from + 1;
      continue;
    }
    if (isEscaped(text, contentTo)) {
      // Only a single-marker span recovers: `*中\*文。*续`. Runs such as
      // `**字\**文**` have different CommonMark semantics, so they keep the
      // conservative "no match" behaviour.
      if (pass.delimiterLength !== 1) {
        expression.lastIndex = from + 1;
        continue;
      }
      // Search the masked text so a delimiter inside inline code or math can
      // never close the span, and check escaping against the original.
      const closerStart = findNextDelimiter(scannable, pass.marker, 1, to);
      if (closerStart === -1 || isEscaped(text, closerStart)) {
        expression.lastIndex = from + 1;
        continue;
      }
      const extended = { from, to: closerStart + 1 };
      if (
        barriers.some((barrier) => overlaps(barrier, extended)) ||
        consumed.some((item) => overlaps(item, extended))
      ) {
        expression.lastIndex = from + 1;
        continue;
      }
      const escapedCandidate = isValidCandidate(
        text,
        from,
        extended.to,
        contentFrom,
        closerStart,
        pass,
      );
      if (escapedCandidate && canOpenEmphasis(text, from, pass.delimiterLength)) {
        matches.push(escapedCandidate);
        consumed.push(extended);
        expression.lastIndex = extended.to;
      } else {
        expression.lastIndex = from + 1;
      }
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

/** Start of the next unescaped marker run of exactly `length`. */
function findNextDelimiter(
  text: string,
  marker: DelimiterMarker,
  length: number,
  fromIndex: number,
): number {
  let index = fromIndex;
  while (index < text.length) {
    if (text[index] !== marker) {
      index++;
      continue;
    }
    const runStart = index;
    let runEnd = runStart;
    while (runEnd < text.length && text[runEnd] === marker) runEnd++;
    if (runEnd - runStart === length) return runStart;
    index = runEnd;
  }
  return -1;
}

export type InlineTokenKind = "code" | "inline" | "display";

export interface InlineToken extends TextMask {
  kind: InlineTokenKind;
}

/** Merge overlapping or touching ranges and sort them. */
function mergeRanges(ranges: readonly TextMask[]): TextMask[] {
  const sorted = ranges
    .filter((range) => range.to > range.from)
    .sort((a, b) => a.from - b.from);
  const merged: TextMask[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to) {
      last.to = Math.max(last.to, range.to);
    } else {
      merged.push({ from: range.from, to: range.to });
    }
  }
  return merged;
}

/**
 * Tokenize one gap between barriers. The gap is the only reachable text: no
 * opener, closer or escape may look outside it.
 */
function tokenizeGap(text: string, start: number, end: number): InlineToken[] {
  const escaped = (position: number): boolean => {
    let slashes = 0;
    let cursor = position - 1;
    while (cursor >= start && text[cursor] === "\\") {
      slashes++;
      cursor--;
    }
    return slashes % 2 === 1;
  };

  const tokens: InlineToken[] = [];
  let index = start;
  while (index < end) {
    const character = text[index];
    if (character !== "`" && character !== "$") {
      index++;
      continue;
    }
    if (escaped(index)) {
      index++;
      continue;
    }

    if (character === "`") {
      let runEnd = index;
      while (runEnd < end && text[runEnd] === "`") runEnd++;
      const width = runEnd - index;
      let cursor = runEnd;
      let close = -1;
      while (cursor < end) {
        if (text[cursor] !== "`") {
          cursor++;
          continue;
        }
        let candidateEnd = cursor;
        while (candidateEnd < end && text[candidateEnd] === "`") candidateEnd++;
        if (candidateEnd - cursor === width) {
          close = candidateEnd;
          break;
        }
        cursor = candidateEnd;
      }
      if (close === -1) {
        index = runEnd;
        continue;
      }
      tokens.push({ from: index, to: close, kind: "code" });
      index = close;
      continue;
    }

    const display =
      index + 1 < end && text[index + 1] === "$" && !escaped(index + 1);
    const width = display ? 2 : 1;
    const bodyStart = index + width;
    let cursor = bodyStart;
    let close = -1;
    if (display) {
      while (cursor + 1 < end) {
        if (
          text[cursor] === "$" &&
          !escaped(cursor) &&
          text[cursor + 1] === "$" &&
          !escaped(cursor + 1)
        ) {
          close = cursor + 2;
          break;
        }
        cursor++;
      }
    } else {
      while (cursor < end) {
        if (text[cursor] === "$" && !escaped(cursor)) {
          close = cursor + 1;
          break;
        }
        cursor++;
      }
    }
    if (close === -1) {
      // Failed owner: consume the opener only; never retry its second dollar.
      index = bodyStart;
      continue;
    }
    tokens.push({ from: index, to: close, kind: display ? "display" : "inline" });
    index = close;
  }
  return tokens;
}

/**
 * Inline code and math tokens for one line, in source order.
 *
 * Barriers (URL, HTML tag, link title, entity, wikilink) split the line into
 * independent gaps; a delimiter can neither open nor close across them. Inside
 * a gap, `$$` opens display math, `$` opens inline math, and backtick runs pair
 * by exact width. Escaped delimiters are literal, a failed opener consumes only
 * itself, and an unclosed span falls back to text. Ownership follows scan
 * order, so `$$a$$$x$` closes display with `$$` and then opens inline with the
 * remaining `$`.
 */
export function tokenizePreviewLine(
  text: string,
  barriers: readonly TextMask[] = [],
): InlineToken[] {
  const gaps: TextMask[] = [];
  let cursor = 0;
  for (const barrier of mergeRanges(barriers)) {
    const from = Math.max(0, Math.min(text.length, barrier.from));
    const to = Math.max(0, Math.min(text.length, barrier.to));
    if (from > cursor) gaps.push({ from: cursor, to: from });
    cursor = Math.max(cursor, to);
  }
  if (cursor < text.length) gaps.push({ from: cursor, to: text.length });

  const tokens: InlineToken[] = [];
  for (const gap of gaps) {
    tokens.push(...tokenizeGap(text, gap.from, gap.to));
  }
  return tokens;
}

function scanEmphasis(
  text: string,
  masks: readonly TextMask[],
  barriers: readonly TextMask[],
): EmphasisMatch[] {
  const scannable = maskDelimiters(text, masks);
  const consumed: TextMask[] = [];
  const matches: EmphasisMatch[] = [];
  for (const pass of SCAN_PASSES) {
    matches.push(...scanWithRegex(text, scannable, pass, consumed, barriers));
  }
  return matches.sort((a, b) => a.from - b.from);
}

/**
 * Legacy scanner used by the source-rewrite command: its own masks decide what
 * is code or math.
 */
export function scanLine(text: string): {
  matches: EmphasisMatch[];
  masks: TextMask[];
} {
  const masks = findMasks(text);
  return { masks, matches: scanEmphasis(text, masks, []) };
}

/**
 * Preview scanner: the tokenizer owns code and math, and barriers are syntax an
 * emphasis span must never cross.
 */
export function scanPreviewLine(
  text: string,
  barriers: readonly TextMask[] = [],
): { tokens: InlineToken[]; matches: EmphasisMatch[] } {
  const tokens = tokenizePreviewLine(text, barriers);
  return { tokens, matches: scanEmphasis(text, tokens, barriers) };
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
  "»": "«",
  "〙": "〘",
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
  // The rewrite only touches plain prose. Links, embeds, HTML, math and tables
  // all carry syntax a punctuation move can break (a link destination, an
  // attribute value, a comment), so the whole line is skipped. Inline code and
  // `$$` spans are masked first, so their content does not trip the check.
  const gate = maskDelimiters(text, findMasks(text));
  if (/[\][<!$&|]/.test(gate)) return [];

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

export interface ParserEmphasis extends TextMask {
  kind?: EmphasisKind;
}

export interface OverflowMatch {
  /** Absolute end of the marked span. */
  to: number;
  delimiterLength: number;
  kind?: EmphasisKind;
}

/**
 * Parser emphasis that reaches past an intended closing delimiter.
 *
 * Two shapes matter. A run that starts before the closer and ends after it is
 * overflow and is reset from the closer onwards. A run that starts at or just
 * after the closer is the parser opening a new span on the delimiter the
 * author used to close; that tail is reset too, unless whitespace separates the
 * two spans. Runs of another kind are separate constructs and stay styled.
 */
export function findExcessParserRanges(
  matches: readonly OverflowMatch[],
  parserRanges: readonly ParserEmphasis[],
  lineText: string,
  lineFrom: number,
  lineTo: number,
): TextMask[] {
  const excess: TextMask[] = [];
  for (const match of matches) {
    for (const range of parserRanges) {
      if (range.kind !== undefined && match.kind !== undefined && range.kind !== match.kind) {
        continue;
      }
      if (range.to <= match.to) continue;
      const to = Math.min(range.to, lineTo);
      if (to <= match.to) continue;

      if (range.from < match.to) {
        excess.push({ from: match.to, to });
        continue;
      }

      // Started at or after the closer: only treat it as overflow when it
      // begins inside the closing marker run itself.
      if (range.from > match.to + match.delimiterLength) continue;
      const gap = lineText.slice(match.to - lineFrom, range.from - lineFrom);
      if (/\s/.test(gap)) continue;
      if (range.from < to) excess.push({ from: range.from, to });
    }
  }
  return excess;
}

/** Offsets of each line start, plus one past the end of the document. */
function lineStartsFor(lines: readonly string[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  starts.push(offset);
  return starts;
}

function lineIndexAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = Math.max(0, starts.length - 2);
  while (low < high) {
    const middle = (low + high) >> 1;
    if (starts[middle + 1] <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Mark every line touched by the half-open range [from, to). */
function markLines(
  literal: boolean[],
  starts: readonly number[],
  from: number,
  to: number,
): void {
  if (to <= from) return;
  const first = lineIndexAt(starts, from);
  for (let index = first; index < literal.length && starts[index] < to; index++) {
    literal[index] = true;
  }
}

/** YAML frontmatter: `---` on line one, a closing delimiter without a limit. */
function findFrontmatterEnd(lines: readonly string[]): number {
  if (lines.length === 0) return -1;
  if (lines[0].replace(/\r$/, "") !== "---") return -1;
  const limit = lines.length;
  for (let index = 1; index < limit; index++) {
    const line = lines[index].replace(/\r$/, "").trim();
    if (line === "---" || line === "...") return index;
  }
  return -1;
}

/**
 * Mark the lines whose content is literal text: fenced code, indented code,
 * HTML blocks and multi-line inline code. Emphasis markers on those lines are
 * content, so neither the rewrite command nor the Live Preview decorations may
 * touch them.
 *
 * Block structure comes from `@lezer/markdown`, the parser behind CodeMirror's
 * Markdown mode, so a fence inside a list item or blockquote follows the same
 * container rules as the editor instead of a hand-written approximation.
 * Frontmatter and `$$` math are Obsidian constructs the parser does not know,
 * so they are layered on top.
 */
function stripMathMarkers(line: string): string {
  let value = line.trim();
  for (;;) {
    const next = value
      .replace(/^(?:>\s*)+/, "")
      .replace(/^(?:[-+*]|\d{1,9}[.)])\s+/, "")
      .trim();
    if (next === value) return value;
    value = next;
  }
}

export function findLiteralLines(lines: readonly string[]): boolean[] {
  const stripped = lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const starts = lineStartsFor(stripped);
  const frontmatterEnd = findFrontmatterEnd(lines);

  const parse = (text: string): { blockNodes: TextMask[]; inlineNodes: TextMask[] } => {
    const blockNodes: TextMask[] = [];
    const inlineNodes: TextMask[] = [];
    markdownParser.parse(text).iterate({
      enter(node) {
        if (
          node.name === "FencedCode" ||
          node.name === "CodeBlock" ||
          node.name === "HTMLBlock" ||
          node.name === "CommentBlock"
        ) {
          blockNodes.push({ from: node.from, to: node.to });
          return;
        }
        if (node.name === "InlineCode") {
          inlineNodes.push({ from: node.from, to: node.to });
        }
      },
    });
    return { blockNodes, inlineNodes };
  };

  const parsed = parse(stripped.join("\n"));
  const parserLiteral = new Array<boolean>(lines.length).fill(false);
  for (const node of parsed.blockNodes) {
    markLines(parserLiteral, starts, node.from, node.to);
  }

  const literal = new Array<boolean>(lines.length).fill(false);
  for (let index = 0; index <= frontmatterEnd && index < literal.length; index++) {
    literal[index] = true;
  }

  // Inline code that spans lines makes every line it touches literal. A span
  // on one line is handled by the per-line masks.
  for (const node of parsed.inlineNodes) {
    const first = lineIndexAt(starts, node.from);
    const last = lineIndexAt(starts, Math.max(node.from, node.to - 1));
    if (first === last) continue;
    for (let index = first; index <= last; index++) literal[index] = true;
  }

  // `$$` blocks are Obsidian syntax the parser does not know; find them line by
  // line, skipping anything already known to be code or frontmatter.
  const mathLines = new Array<boolean>(lines.length).fill(false);
  let inMathBlock = false;
  for (let index = 0; index < stripped.length; index++) {
    if (inMathBlock) {
      mathLines[index] = true;
      if (stripMathMarkers(stripped[index]) === "$$") inMathBlock = false;
      continue;
    }
    if (parserLiteral[index] || literal[index]) continue;
    const candidate = stripMathMarkers(stripped[index]);
    // Display math opens only on a standalone `$$` line, the same shape
    // Obsidian uses for a block; a line such as `$$$a$` is inline text.
    if (candidate === "$$") {
      mathLines[index] = true;
      inMathBlock = true;
    }
  }
  for (let index = 0; index < mathLines.length; index++) {
    if (mathLines[index]) literal[index] = true;
  }

  // Parse again with frontmatter, math and multi-line code blanked out. Without
  // this, a fence inside those regions changes how the parser reads the rest of
  // the document and hides real prose behind a phantom block. Only the literal
  // ranges are blanked, never whole lines: blanking a line that merely contains
  // a code span would also erase a list marker or a quote marker and change how
  // the second parse reads the fences around it.
  const characters = stripped.join("\n").split("");
  const blankRange = (from: number, to: number) => {
    for (let index = Math.max(0, from); index < Math.min(characters.length, to); index++) {
      if (characters[index] !== "\n") characters[index] = " ";
    }
  };
  for (let index = 0; index <= frontmatterEnd && index < stripped.length; index++) {
    blankRange(starts[index], starts[index] + stripped[index].length);
  }
  for (let index = 0; index < mathLines.length; index++) {
    if (mathLines[index]) {
      blankRange(starts[index], starts[index] + stripped[index].length);
    }
  }
  for (const node of parsed.inlineNodes) {
    const first = lineIndexAt(starts, node.from);
    const last = lineIndexAt(starts, Math.max(node.from, node.to - 1));
    if (first !== last) blankRange(node.from, node.to);
  }

  const reparsed = parse(characters.join(""));
  const blockLiteral = new Array<boolean>(lines.length).fill(false);
  for (const node of reparsed.blockNodes) {
    markLines(blockLiteral, starts, node.from, node.to);
  }
  for (let index = 0; index < literal.length; index++) {
    if (blockLiteral[index]) literal[index] = true;
  }
  for (const node of reparsed.inlineNodes) {
    const first = lineIndexAt(starts, node.from);
    const last = lineIndexAt(starts, Math.max(node.from, node.to - 1));
    if (first === last) continue;
    for (let index = first; index <= last; index++) literal[index] = true;
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