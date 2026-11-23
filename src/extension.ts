import {
  ViewPlugin,
  ViewUpdate,
  Decoration,
  DecorationSet,
  EditorView,
} from "@codemirror/view";
import { Extension, Prec, Range, Text } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { editorLivePreviewField } from "obsidian";
import { getSettings } from "./settings";
import {
  findExcessParserRanges,
  findLiteralLines,
  scanLine,
  EmphasisMatch,
  ParserEmphasis,
  TextMask,
} from "./scanner";

/**
 * Emphasis runs the parser actually produced. Obsidian sometimes produces a
 * run wider than what the author marked: when the closing delimiter fails the
 * flanking rule the run stays open and everything up to the end of the
 * paragraph is styled. Those ranges let the excess be neutralised.
 *
 * Node names are matched as emphasis kinds rather than substrings: `ListItem`
 * contains "em" and would otherwise report the whole list item as emphasis.
 */
const CONTAINER_NODE = /list|table|paragraph|document|blockquote|quote/;

function parserEmphasisKind(name: string): EmphasisMatch["kind"] | null {
  const lower = name.toLowerCase();
  if (lower.includes("formatting") || lower.includes("mark") || CONTAINER_NODE.test(lower)) {
    return null;
  }
  if (lower.includes("strongem") || lower.includes("strong-em")) return "strong-em";
  if (lower.includes("strong")) return "strong";
  if (lower.includes("strikethrough") || lower.includes("strike")) return "strike";
  if (lower.includes("highlight")) return "highlight";
  if (lower === "em" || lower.includes("emphasis")) return "em";
  return null;
}

function collectParserEmphasis(view: EditorView): ParserEmphasis[] {
  const ranges: ParserEmphasis[] = [];
  syntaxTree(view.state).iterate({
    enter(node) {
      const kind = parserEmphasisKind(node.name);
      if (kind) ranges.push({ from: node.from, to: node.to, kind });
    },
  });
  return ranges;
}

/**
 * Class names Obsidian itself uses, so themes style the marked span the same
 * way they style regular emphasis (bold colour, highlight background, ...).
 */
function classesFor(kind: EmphasisMatch["kind"]): string[] {
  switch (kind) {
    case "strong-em":
      return ["cm-strong", "cm-em", "cm-cjk-strong-em"];
    case "strong":
      return ["cm-strong", "cm-cjk-strong"];
    case "highlight":
      return ["cm-highlight", "cm-cjk-highlight"];
    case "strike":
      return ["cm-strikethrough", "cm-cjk-strike"];
    default:
      return ["cm-em", "cm-cjk-emphasis"];
  }
}

/** Syntax the decoration pass must not reach into. */
const PROTECTED_NODES = new Set([
  "InlineCode",
  "HTMLTag",
  "Comment",
  "Entity",
  "URL",
  "LinkTitle",
]);

function collectProtectedRanges(view: EditorView): TextMask[] {
  const ranges: TextMask[] = [];
  syntaxTree(view.state).iterate({
    enter(node) {
      if (PROTECTED_NODES.has(node.name)) {
        ranges.push({ from: node.from, to: node.to });
      }
    },
  });
  return ranges;
}

/** Literal-line map for a whole document, computed once per edit. */
function literalLinesFor(doc: Text): boolean[] {
  const lines: string[] = [];
  for (const line of doc.iterLines(1, doc.lines + 1)) {
    lines.push(line);
  }
  return findLiteralLines(lines);
}

function buildDecorations(view: EditorView, literalLines: boolean[]): DecorationSet {
  const settings = getSettings();
  if (!settings.enableLivePreviewFix) return Decoration.none;

  // Source mode shows raw markdown; decorations would corrupt it visually.
  const livePreview = view.state.field(editorLivePreviewField, false);
  if (livePreview === false) return Decoration.none;

  const decorations: Range<Decoration>[] = [];
  const doc = view.state.doc;
  const parserRanges = collectParserEmphasis(view);
  const protectedRanges = collectProtectedRanges(view);
  const cursorHead = view.state.selection.main.head;

  const marks = new Map<string, Decoration>();
  const markFor = (kind: EmphasisMatch["kind"]) => {
    let mark = marks.get(kind);
    if (!mark) {
      mark = Decoration.mark({ class: classesFor(kind).join(" ") });
      marks.set(kind, mark);
    }
    return mark;
  };

  const hideMarkerMark = Decoration.mark({ class: "cm-cjk-hide-marker" });
  const plainMark = Decoration.mark({ class: "cm-cjk-plain" });
  const neutralised = new Set<string>();

  const visibleLines = new Set<number>();
  for (const { from, to } of view.visibleRanges) {
    const startLine = doc.lineAt(from).number;
    const endLine = doc.lineAt(to).number;
    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
      visibleLines.add(lineNumber);
    }
  }

  for (const lineNumber of visibleLines) {
    if (literalLines[lineNumber - 1]) continue;
    const line = doc.line(lineNumber);
    // Dollar math and currency share the same character; pairing them reliably
    // needs an inline parser, so such lines are left undecorated. This avoids
    // hiding prose next to math at the cost of a repair on those lines.
    if (line.text.includes("$")) continue;
    // Table rows are rendered by a widget; decorating them would compete with
    // the cell layout. Require a leading and trailing pipe so ordinary prose
    // that happens to start with "|" is not skipped.
    if (/^\s*\|.*\|\s*$/.test(line.text)) continue;

    const lineMasks: TextMask[] = [];
    for (const range of protectedRanges) {
      if (range.from >= line.to || range.to <= line.from) continue;
      lineMasks.push({
        from: Math.max(range.from, line.from) - line.from,
        to: Math.min(range.to, line.to) - line.from,
      });
    }
    const wikilink = /!?\[\[[^\]\n]+\]\]/g;
    let link: RegExpExecArray | null;
    while ((link = wikilink.exec(line.text)) !== null) {
      lineMasks.push({ from: link.index, to: link.index + link[0].length });
    }
    const { matches } = scanLine(line.text, lineMasks);
    if (matches.length === 0) continue;

    const cursorOnLine = cursorHead >= line.from && cursorHead <= line.to;
    const lineParser = parserRanges.filter(
      (range) => range.from < line.to && range.to > line.from,
    );

    // The parser may style a wider run than the author marked. Several runs
    // can be involved, so the excess is collected for the whole line first.
    const excess = findExcessParserRanges(
      matches.map((match) => ({
        to: line.from + match.to,
        delimiterLength: match.delimiterLength,
        kind: match.kind,
      })),
      lineParser,
      line.text,
      line.from,
      line.to,
    );
    for (const range of excess) {
      const key = `${range.from}:${range.to}`;
      if (neutralised.has(key)) continue;
      neutralised.add(key);
      decorations.push(plainMark.range(range.from, range.to));
    }

    for (const match of matches) {
      const mFrom = line.from + match.from;
      const mTo = line.from + match.to;
      const cFrom = line.from + match.contentFrom;
      const cTo = line.from + match.contentTo;

      // Always style the content: the syntax tree is not a reliable signal
      // that the editor rendered it, and restyling is harmless.
      decorations.push(markFor(match.kind).range(cFrom, cTo));

      if (!(settings.keepMarkersNearCursor && cursorOnLine)) {
        const delimiter = match.delimiterLength;
        decorations.push(hideMarkerMark.range(mFrom, mFrom + delimiter));
        decorations.push(hideMarkerMark.range(mTo - delimiter, mTo));
      }
    }
  }

  decorations.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(decorations, true);
}

const cjkEmphasisViewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    literalLines: boolean[];

    constructor(view: EditorView) {
      this.literalLines = literalLinesFor(view.state.doc);
      this.decorations = buildDecorations(view, this.literalLines);
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.literalLines = literalLinesFor(update.state.doc);
      }
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view, this.literalLines);
      }
    }
  },
  {
    decorations: (view) => view.decorations,
  },
);

const cjkEmphasisTheme = EditorView.baseTheme({
  // Everything the editor's own emphasis styling would normally add is rolled
  // back to the surrounding plain-text appearance. Theme colours come from
  // Obsidian's own variables, so nothing is hard-coded.
  // Doubled selector so this outranks any single-class theme rule, and the
  // properties cover everything themes commonly attach to emphasis: colour,
  // weight, style, background, underline and shadow. Colours come from
  // Obsidian's own variables so each theme keeps its own palette.
  ".cm-cjk-plain.cm-cjk-plain": {
    color: "var(--text-normal) !important",
    fontWeight: "normal !important",
    fontStyle: "normal !important",
    textDecoration: "none !important",
    backgroundColor: "transparent !important",
    textShadow: "none !important",
    borderBottom: "none !important",
    letterSpacing: "normal !important",
  },
  ".cm-cjk-hide-marker": {
    fontSize: "0 !important",
    overflow: "hidden !important",
  },
});

export function cjkEmphasisExtension(): Extension {
  return [Prec.highest(cjkEmphasisViewPlugin), cjkEmphasisTheme];
}

export type { EmphasisMatch };
