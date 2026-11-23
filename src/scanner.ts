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

function findBacktickMasks(text: string): TextMask[] {
  const masks: TextMask[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "`") {
      i++;
      continue;
    }
    let runEnd = i + 1;
    while (runEnd < text.length && text[runEnd] === "`") runEnd++;
    const delimiter = text.slice(i, runEnd);
    const close = text.indexOf(delimiter, runEnd);
    if (close === -1) {
      i = runEnd;
      continue;
    }
    masks.push({ from: i, to: close + delimiter.length });
    i = close + delimiter.length;
  }
  return masks;
}

function findDisplayMathMasks(text: string): TextMask[] {
  const masks: TextMask[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("$$", i);
    if (open === -1) break;
    const close = text.indexOf("$$", open + 2);
    if (close === -1) break;
    masks.push({ from: open, to: close + 2 });
    i = close + 2;
  }
  return masks;
}

export function findMasks(text: string): TextMask[] {
  return [...findBacktickMasks(text), ...findDisplayMathMasks(text)].sort(
    (a, b) => a.from - b.from,
  );
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
 * Scan an entire document for CJK emphasis fixes.
 * Skips fenced code blocks so inline markers inside code are never touched.
 */
export function findDocumentFixes(text: string): SourceFix[] {
  const fixes: SourceFix[] = [];
  const lines = text.split("\n");
  let inFence: string | null = null;
  let lineFrom = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const lineText = lines[lineIndex];
    const lineLeading = lineText.match(/^(\s*)/)?.[1] ?? "";

    const fenceMatch = lineText.slice(lineLeading.length).match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      if (!inFence) {
        inFence = fence;
        lineFrom += lineText.length + 1;
        continue;
      } else if (fence[0] === inFence[0] && fence.length >= inFence.length) {
        inFence = null;
        lineFrom += lineText.length + 1;
        continue;
      }
    }
    if (!inFence) {
      for (const fix of findSourceFixes(lineText)) {
        fixes.push({
          from: lineFrom + fix.from,
          to: lineFrom + fix.to,
          replacement: fix.replacement,
        });
      }
    }
    lineFrom += lineText.length + 1;
  }
  return fixes;
}