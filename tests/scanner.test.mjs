import assert from "node:assert/strict";
import {
  scanLine,
  scanPreviewLine,
  findSourceFixes,
  findDocumentFixes,
  findExcessParserRanges,
  findLiteralLines,
  tokenizePreviewLine,
  subtractRanges,
} from "./scanner.bundle.mjs";

function kinds(text) {
  return scanLine(text).matches.map((m) => m.kind);
}

// bold / italic / bold+italic
assert.deepEqual(kinds("**文字。**x"), ["strong"]);
assert.deepEqual(kinds("*文字。*接着"), ["em"]);
assert.deepEqual(kinds("***文字。***继续"), ["strong-em"]);

// highlight / strikethrough
assert.deepEqual(kinds("==文字。==继续"), ["highlight"]);
assert.deepEqual(kinds("前==重要！==后"), ["highlight"]);
assert.deepEqual(kinds("~~文字。~~继续"), ["strike"]);
assert.deepEqual(kinds("==文字。== 继续"), ["highlight"]);

// boundaries that already work
assert.deepEqual(kinds("**文字。**"), ["strong"]);
assert.deepEqual(kinds("**文字。**，"), ["strong"]);
assert.deepEqual(kinds("**文字。 **"), []);
assert.deepEqual(kinds("** 文字。**"), []);

// non-CJK content is left to the parser
assert.deepEqual(kinds("**hello.**x"), []);
assert.deepEqual(kinds("==hello.==x"), []);

// masked regions
assert.deepEqual(kinds("`**文字。**x`"), []);
assert.deepEqual(kinds("$$**文字。**x$$"), []);
assert.deepEqual(kinds("`==文字。==x`"), []);

// Inline code and math are resolved in source order, so neither syntax can
// swallow the other's delimiters.
assert.deepEqual(kinds("`$$`**字。**后$$x$$"), ["strong"]);
assert.deepEqual(kinds("$$`$$**字。**后`"), ["strong"]);
assert.deepEqual(scanLine("`**字。**后``").masks, []);
assert.deepEqual(kinds("`**字。**后``"), ["strong"]);

// Emphasis is allowed to contain inline code. The code span must hide its own
// delimiters, not split the line in half.
assert.deepEqual(kinds("**加粗含 `code` 的文本。**后续"), ["strong"]);
assert.deepEqual(kinds("==高亮含 `code` 的文本。==后续"), ["highlight"]);
assert.deepEqual(kinds("~~删除含 `code` 的文本。~~后续"), ["strike"]);

const inlineCodeLine =
  "因此，未来不是“编译器消灭 MKL”，而是**“高级抽象（`std::linalg`/张量 DSL）+ 专用调度编译器（处理融合与不规则尺寸）+ 底层专家级微内核（MKL/BLIS/CUTLASS）”**长期共存的格局。 ";
const inlineCodeMatches = scanLine(inlineCodeLine).matches;
assert.equal(inlineCodeMatches.length, 1, "emphasis around inline code");
assert.equal(inlineCodeMatches[0].kind, "strong");
assert.equal(
  inlineCodeLine.slice(inlineCodeMatches[0].contentFrom, inlineCodeMatches[0].contentTo),
  "“高级抽象（`std::linalg`/张量 DSL）+ 专用调度编译器（处理融合与不规则尺寸）+ 底层专家级微内核（MKL/BLIS/CUTLASS）”",
);
// The automatic rewrite skips it: the trailing `）”` closes a pair opened
// inside the span, and the opener would still not satisfy CommonMark.
assert.equal(findSourceFixes(inlineCodeLine).length, 0);

// setext underline must not be read as highlight
assert.deepEqual(kinds("==="), []);
assert.deepEqual(kinds("===="), []);

const fixes = findSourceFixes("前面**文字。**继续");
assert.equal(fixes.length, 1);
assert.equal(fixes[0].replacement, "**文字**。");

// A span whose content ends in inline code: the closing backtick is ASCII
// punctuation, so the rewrite walker used to move it and corrupt the span.
assert.equal(findSourceFixes("**`字`**后").length, 0);
assert.equal(findSourceFixes("**字`x`。**后").length, 0);
assert.equal(findSourceFixes("**` 字 `**后").length, 0);
assert.equal(findSourceFixes("**𠀀`😀`。**𠀀").length, 0);

// Closing characters that belong to a pair opened inside the span.
assert.equal(findSourceFixes("**[字](u)**后").length, 0);
assert.equal(findSourceFixes("中**“字”**后").length, 0);
assert.equal(findSourceFixes("中**（字。**后").length, 0);

// Punctuation that is safe to move even though the span contains code.
const codeFix = findSourceFixes("**加粗含 `code` 的文本。**后续");
assert.equal(codeFix.length, 1);
assert.equal(codeFix[0].replacement, "**加粗含 `code` 的文本**。");

// The rewrite only touches plain prose. Links, embeds, HTML, math and tables
// carry syntax a punctuation move can break, so the whole line is skipped.
assert.equal(findSourceFixes("[](*字。*后)").length, 0);
assert.equal(findSourceFixes("*字<br/>*后").length, 0);
assert.equal(findSourceFixes("<!--*字。*后-->").length, 0);
assert.equal(findSourceFixes("a <i x=\"*字。*后\">").length, 0);
assert.equal(findSourceFixes("![[==字。==后]]").length, 0);
assert.equal(findSourceFixes("$*字。*后$").length, 0);
assert.equal(findSourceFixes("| *字。*后 |").length, 0);
assert.equal(findSourceFixes("*«字»*后").length, 0);
assert.equal(findSourceFixes("**甲** [](*乙。*续)").length, 0);

// A list item whose first line holds a multi-line code span must keep its
// marker when the document is re-parsed.
assert.equal(findDocumentFixes("- `\n  `\n  ~~~\n~~~\n*字。*后\n").length, 0);
assert.equal(findDocumentFixes("$$\n~~~\n$$\n`\n*字。*后`\n").length, 0);

// Escaped markers are literal text, not delimiters.
assert.deepEqual(kinds("a*\\*字。*后"), []);
assert.equal(findSourceFixes("a*\\*字。*后").length, 0);
assert.deepEqual(scanLine("\\`x`*字。*后").masks, []);

// Punctuation the hand-written table missed still counts for flanking.
assert.equal(findSourceFixes("**［字］**后").length, 0);
assert.equal(findSourceFixes("中**«字。**后").length, 0);

// Empty content after the move.
assert.equal(findSourceFixes("**。**后").length, 0);

// A closer that cannot close must not swallow the real span.
assert.deepEqual(kinds("**`x` **字。**后"), ["strong"]);
assert.equal(scanLine("**`x` **字。**后").matches[0].from, 6);
assert.deepEqual(kinds("*`x` *字。*后"), ["em"]);

// A consumed span must not swallow the next span on the same line.
assert.deepEqual(kinds("**甲** *乙。*续"), ["strong", "em"]);
assert.deepEqual(kinds("**甲** *乙。*续 *丙。*续"), ["strong", "em", "em"]);

// An escaped marker inside the span must not discard the real closer.
assert.deepEqual(kinds("*中\\*文。*续"), ["em"]);
assert.deepEqual(kinds("**中\\*文。**后"), ["strong"]);
// Recovery never reaches into inline code or across accepted spans.
assert.deepEqual(kinds("*字\\*`*`"), []);
const recovered = findSourceFixes("*字\\* **甲。**乙。*后");
for (let first = 0; first < recovered.length; first++) {
  for (let second = first + 1; second < recovered.length; second++) {
    const a = recovered[first];
    const b = recovered[second];
    assert.ok(a.to <= b.from || b.to <= a.from, "rewrite edits must not overlap");
  }
}

// A barrier (URL, tag, title) cannot be crossed by one emphasis span.
assert.deepEqual(
  scanPreviewLine("[中*](u)文。*后", [{ from: 5, to: 6 }]).matches.map((match) => match.kind),
  [],
);

// Tokenizer: code and math ownership in source order.
const tokenRanges = (text, barriers = []) =>
  tokenizePreviewLine(text, barriers).map((token) => [token.from, token.to, token.kind]);
assert.deepEqual(tokenRanges("$$a$$$x$"), [
  [0, 5, "display"],
  [5, 8, "inline"],
]);
assert.deepEqual(tokenRanges("$$a$b$$*字。*后$x$"), [
  [0, 7, "display"],
  [12, 15, "inline"],
]);
assert.deepEqual(tokenRanges("[]($$)*字。*后$$", [{ from: 3, to: 5 }]), []);
assert.deepEqual(tokenRanges("$*字。*后$"), [[0, 7, "inline"]]);
assert.deepEqual(tokenRanges("$x\\$$"), [[0, 5, "inline"]]);
assert.deepEqual(tokenRanges("\\$$x$"), [[2, 5, "inline"]]);
assert.deepEqual(tokenRanges("$a$$"), [[0, 3, "inline"]]);
assert.deepEqual(tokenRanges("`a`$x$"), [
  [0, 3, "code"],
  [3, 6, "inline"],
]);
assert.deepEqual(tokenRanges("`$$`"), [[0, 4, "code"]]);
assert.deepEqual(tokenRanges("$$`$$"), [[0, 5, "display"]]);
assert.deepEqual(tokenRanges("$$`$$**字。**后"), [[0, 5, "display"]]);
assert.deepEqual(tokenRanges("`**字。**后``"), []);
assert.deepEqual(tokenRanges("`*字。*后\\`"), [[0, 8, "code"]]);

// Preview repair follows the tokenizer and keeps prose outside tokens.
assert.deepEqual(
  scanPreviewLine("[]($$)*字。*后$$", [{ from: 3, to: 5 }]).matches.map((match) => [
    match.from,
    match.to,
  ]),
  [[6, 10]],
);
assert.deepEqual(
  scanPreviewLine("$*字$*文。*后").matches.map((match) => [match.from, match.to]),
  [[4, 8]],
);
assert.deepEqual(
  scanPreviewLine("*$5元。*后").matches.map((match) => [match.from, match.to]),
  [[0, 6]],
);
assert.deepEqual(scanPreviewLine("$*字。*后$").matches, []);
assert.deepEqual(
  scanPreviewLine("$$`$$**字。**后").matches.map((match) => [match.from, match.to]),
  [[5, 11]],
);
assert.deepEqual(
  scanPreviewLine("😀$𠀀$*字。*后").matches.map((match) => [match.from, match.to]),
  [[6, 10]],
);
assert.deepEqual(scanPreviewLine("**加粗含 `code` 的文本。**后续").matches.map((match) => match.kind), [
  "strong",
]);

// The command keeps its historical display boundaries; preview requires a
// standalone `$$`.
assert.equal(findDocumentFixes("$$$\n**字。**后\n").length, 0);
assert.equal(findDocumentFixes("$$\nb$$\n**字。**后\n").length, 0);
assert.deepEqual(findLiteralLines(["$$$", "**字。**后"], { displayBlocks: "standalone" }), [
  false,
  false,
]);
assert.deepEqual(
  findLiteralLines(["$$", "b$$", "**字。**后"], { displayBlocks: "standalone" }),
  [true, true, true],
);
// Overflow resets stop at barriers.
assert.deepEqual(
  subtractRanges({ from: 0, to: 10 }, [{ from: 3, to: 5 }, { from: 7, to: 8 }]),
  [
    { from: 0, to: 3 },
    { from: 5, to: 7 },
    { from: 8, to: 10 },
  ],
);
// A long token line must not blow the call stack.
assert.equal(tokenizePreviewLine("$x$".repeat(130000)).length, 130000);

// Command must not edit literal math, link metadata, nested delimiters or
// Obsidian comments, and must recognize a BOM before frontmatter.
assert.equal(findDocumentFixes("$$\n```\n$$\n$$\n*字。*后\n$$\n").length, 0);
assert.equal(findDocumentFixes("---\nx: |\n  ```\n---\n$$\n*字。*后\n$$\n").length, 0);
assert.equal(findDocumentFixes("[a](\n*字。*后\n)\n").length, 0);
assert.equal(findDocumentFixes("[a]: u\n  \"*字。*后\"\n").length, 0);
assert.equal(findDocumentFixes("*字 _甲_。*后\n").length, 0);
assert.equal(findDocumentFixes("%%*字。*后%%\n").length, 0);
assert.equal(
  findDocumentFixes("\uFEFF---\na: \"*字。*后\"\n---\n**字。**后\n").length,
  1,
);
const nestedHighlight = findDocumentFixes("*==字==。*x\n");
assert.equal(nestedHighlight.length, 1);
assert.equal(nestedHighlight[0].replacement, "*==字==*。");
const nestedStrike = findDocumentFixes("*~~字~~。*x\n");
assert.equal(nestedStrike.length, 1);
assert.equal(nestedStrike[0].replacement, "*~~字~~*。");
assert.equal(findDocumentFixes("****。**x\n").length, 0);
assert.equal(findDocumentFixes("%%\n*字。*x\n%%\n").length, 0);
assert.equal(findDocumentFixes("$$\n~~~\n$$\n$$\n```\n$$\n```\n*字。*x\n```\n").length, 0);
assert.equal(findDocumentFixes("$$\n```\n$$\n[a](\n*字。*x\n)\n").length, 0);
assert.equal(findDocumentFixes("---\na: |\n  ---\n  *字。*x\n---\n").length, 0);
assert.equal(findDocumentFixes("$$\n`\n$$\n$$\n`\n*字。*x\n$$\n").length, 0);
assert.equal(findDocumentFixes("`\n` [](\n*字。*x\n)\n").length, 0);
assert.equal(findDocumentFixes("`%%`\n%%\n*字。*x\n%%\n").length, 0);
assert.equal(findDocumentFixes("---\ns: \"*字。*x\"\n--- \n").length, 0);
assert.equal(findDocumentFixes("$$\n`\n$$\n`\n` [](\n*字。*x\n)\n").length, 0);
assert.equal(findDocumentFixes("$$`\nb$$\n$$\n`\n*字。*x\n$$\n").length, 0);
assert.equal(findDocumentFixes("---\na: \"`x` %%\"\n---\n%%\n*字。*x\n%%\n").length, 0);
assert.equal(findDocumentFixes("$$%%$$\n%%\n*字。*x\n%%\n").length, 0);
assert.equal(findDocumentFixes("$$\n`\n$$\n`*字。*x\n`\n").length, 0);
assert.equal(findDocumentFixes("~~~\n$$\n~~~\n`*字。*x\n`\n").length, 0);
assert.equal(findDocumentFixes("[]($) %% $\n*字。*x\n%%\n").length, 0);
assert.equal(findDocumentFixes("---\na: |\n  $$\n---\n`*字。*x\n`\n").length, 0);
assert.equal(findDocumentFixes("`x`*字。*x\n").length, 0);
assert.equal(findDocumentFixes("[](%%)\n%%\n*字。*x\n%%\n").length, 0);
assert.equal(findDocumentFixes("\t$$\n$$\n`\n$$\n`\n*字。*x\n`\n").length, 0);
assert.equal(findDocumentFixes("[[%%]]\n%%\n*字。*x\n%%\n").length, 0);
assert.equal(findDocumentFixes("%%`%%`%%\n*字。*x\n%%\n").length, 0);
// A URL starting with a backtick must not swallow the URL barrier.
assert.deepEqual(
  scanPreviewLine("[](`)*字。*x`", [{ from: 3, to: 4 }]).matches.map((match) => [
    match.from,
    match.to,
  ]),
  [[5, 9]],
);
// A wiki link containing a code token stays a barrier.
assert.deepEqual(scanPreviewLine("[[`x`*字*]]", [{ from: 0, to: 10 }]).matches, []);


// A wiki-link-looking match inside code is code content; one spanning two code
// spans is not a wiki link and must not suppress the prose between them.
assert.deepEqual(scanPreviewLine("`[[a]]*字*`").matches, []);
assert.deepEqual(
  scanPreviewLine("`[[` *字。* `]]`").matches.map((match) => [match.from, match.to]),
  [[5, 9]],
);


assert.equal(findSourceFixes("*字&amp;*后").length, 0);
assert.equal(findSourceFixes("*字&#65;*后").length, 0);
// Frontmatter is searched without a line limit.
const longFrontmatter = [
  "---",
  ...Array.from({ length: 205 }, (_, index) => `# comment ${index}`),
  'a: "*字。*后"',
  "---",
  "**字。**后",
].join("\n");
assert.equal(findDocumentFixes(longFrontmatter).length, 1);

// The command treats multi-line code lines as literal.
assert.deepEqual(findLiteralLines(["`a", "b` **字。**后"]), [true, true]);

const highlightFix = findSourceFixes("前==重要！==后");
assert.equal(highlightFix[0].replacement, "==重要==！");

const strikeFix = findSourceFixes("~~删除。~~继续");
assert.equal(strikeFix[0].replacement, "~~删除~~。");

const document = [
  "正常**文字。**继续",
  "```md",
  "坏的 **代码。**继续",
  "```",
  "再次*文字！*后文",
  "高亮==重点。==后续",
].join("\n");
const documentFixes = findDocumentFixes(document);
assert.equal(documentFixes.length, 0);

// Blocks whose content is literal text, never rewritten.
assert.equal(findDocumentFixes("$$\n**字。**后\n$$\n").length, 0);
assert.equal(findDocumentFixes("    **字。**后\n").length, 0);
assert.equal(findDocumentFixes("\t**字。**后\n").length, 0);
assert.equal(findDocumentFixes(" \t**字。**后\n").length, 0);
assert.equal(findDocumentFixes("```\n\t```\n**字。**后\n").length, 0);
assert.equal(findDocumentFixes("> ```\n> **字。**后\n> ```\n").length, 0);
assert.equal(findDocumentFixes("```\n**字。**后\n```x\n**字。**后\n```\n").length, 0);
assert.equal(
  findDocumentFixes(["```", "**字。**后", "```x", "**字。**后", "```", "**字。**后"].join("\n")).length,
  0,
);
assert.equal(findDocumentFixes("~~~\n**字。**后\n~~~\n").length, 0);

// A `$$` span closed on the same line is a mask, not a block; the prose on
// that line and after it is still fixed.
assert.equal(findDocumentFixes("$$x$$ **字。**后\n**字。**后\n").length, 0);
assert.equal(findDocumentFixes("$$$$\n**字。**后\n").length, 0);
assert.equal(findDocumentFixes("    $$\n**字。**后\n").length, 0);
// Backticks inside a math block are content, not a fence opener.
assert.equal(findDocumentFixes("$$\n```\n$$\n**字。**后\n").length, 0);

// The same classifier drives Live Preview decorations.
assert.deepEqual(findLiteralLines(["```", "**字。**后", "```", "**字。**后"]), [true, true, true, false]);
assert.deepEqual(findLiteralLines(["$$", "**字。**后", "$$"]), [true, true, true]);
assert.deepEqual(findLiteralLines(["    **字。**后", "**字。**后"]), [true, false]);
// Indented code cannot interrupt a paragraph.
assert.deepEqual(findLiteralLines(["文字", "    **字。**后"]), [false, false]);
assert.equal(findDocumentFixes("文字\n    **字。**后\n").length, 1);
assert.deepEqual(findLiteralLines(["> ```", "> **字。**后", "> ```", "> **字。**后"]), [
  true,
  true,
  true,
  false,
]);
assert.deepEqual(
  findLiteralLines(["```", "**字。**后", "```x", "**字。**后", "```", "**字。**后"]),
  [true, true, true, true, true, false],
);

// Literal regions must not leak into the rest of the document, in either
// direction, and must follow the container they belong to.
assert.deepEqual(findLiteralLines("`a\n$$\nb`\n\n**文。**续\n".split("\n")), [
  true, true, true, false, false, false,
]);
assert.deepEqual(findLiteralLines("- $$\n  **中。**续\n  $$\n\n**文。**续\n".split("\n")), [
  true, true, true, false, false, false,
]);
assert.deepEqual(findLiteralLines("---\nx: |\n  ```\n---\n**中。**续\n".split("\n")), [
  true, true, true, true, false, false,
]);
assert.equal(findDocumentFixes("---\na: \"**字。**后\"\n\n---\n**字。**后\n").length, 1);
assert.deepEqual(findLiteralLines("$$\n```\n$$\n```mermaid\n**中。**续\n```\n".split("\n")), [
  true, true, true, true, true, true, false,
]);

// A fence belongs to the container it opened in.
assert.deepEqual(findLiteralLines(["> ~~~", "**字。**后"]), [true, false]);
assert.equal(findDocumentFixes("> ~~~\n**字。**后\n").length, 1);
assert.equal(findDocumentFixes("> ~~~\n~~~\n**字。**后\n").length, 0);
assert.equal(findDocumentFixes("~~~\n> ~~~\n**字。**后\n").length, 0);
assert.deepEqual(findLiteralLines(["> > ~~~", "> **字。**后"]), [true, false]);
assert.equal(findDocumentFixes("> > ~~~\n> **字。**后\n").length, 1);

// List items: an indented continuation is prose, a fence inside an item is code.
assert.equal(findDocumentFixes("- a\n\n    **字。**后\n").length, 1);
assert.equal(findDocumentFixes("- a\n\n    - **字。**后\n").length, 1);
assert.equal(findDocumentFixes("- ~~~\n  **字。**后\n").length, 0);

// A backtick fence may not carry a backtick in its info string.
assert.equal(findDocumentFixes("``` a`\n**字。**后\n").length, 0);

// A closing backtick run is not escaped by a preceding backslash.
assert.equal(findSourceFixes("`*字。*后\\`").length, 0);

// Frontmatter and raw HTML are not prose.
assert.equal(findDocumentFixes("---\na: \"**字。**后\"\n---\n**字。**后\n").length, 1);
assert.equal(findDocumentFixes("<pre>\n**字。**后\n</pre>\n").length, 0);
assert.equal(findDocumentFixes("<div>\n**字。**后\n</div>\n\n**字。**后\n").length, 0);

// CRLF line endings.
assert.equal(findDocumentFixes("~~~\r\nx\r\n~~~\r\n**字。**后").length, 1);

// Parser runs that overflow a marked span, including split runs.
const overflowText = "x".repeat(200);
assert.deepEqual(
  findExcessParserRanges([{ to: 102, delimiterLength: 2 }], [{ from: 23, to: 111 }], overflowText, 0, 200),
  [{ from: 102, to: 111 }],
);
assert.deepEqual(
  findExcessParserRanges(
    [{ to: 102, delimiterLength: 2 }],
    [{ from: 23, to: 29 }, { from: 42, to: 111 }],
    overflowText,
    0,
    200,
  ),
  [{ from: 102, to: 111 }],
);
assert.deepEqual(
  findExcessParserRanges([{ to: 102, delimiterLength: 2 }], [{ from: 102, to: 111 }], overflowText, 0, 200),
  [{ from: 102, to: 111 }],
);
assert.deepEqual(
  findExcessParserRanges([{ to: 102, delimiterLength: 2 }], [{ from: 102, to: 100 }], overflowText, 0, 200),
  [],
);
assert.deepEqual(
  findExcessParserRanges([{ to: 102, delimiterLength: 2 }], [{ from: 120, to: 130 }], overflowText, 0, 200),
  [],
);
// A run of another kind is a separate construct, not overflow.
assert.deepEqual(
  findExcessParserRanges(
    [{ to: 5, delimiterLength: 2, kind: "strong" }],
    [{ from: 5, to: 8, kind: "em" }],
    "      ",
    0,
    8,
  ),
  [],
);
// Whitespace between the spans keeps a separate bold intact.
assert.deepEqual(
  findExcessParserRanges(
    [{ to: 6, delimiterLength: 2, kind: "strong" }],
    [{ from: 7, to: 11, kind: "strong" }],
    "**字。** **粗**",
    0,
    12,
  ),
  [],
);
// No whitespace: the parser opened a new span on the closing delimiter.
assert.deepEqual(
  findExcessParserRanges(
    [{ to: 6, delimiterLength: 2, kind: "strong" }],
    [{ from: 8, to: 12, kind: "strong" }],
    "**字。****粗**",
    0,
    13,
  ),
  [{ from: 8, to: 12 }],
);

// Every common Chinese punctuation mark, both for rendering and for the
// optional source rewrite.
const punctuation = [
  "。", "、", "，", "；", "：", "！", "？", "）", "】", "》", "」", "』",
  "…", "—", "～", "·", "“", "”", "‘", "’", "〈", "〔", "〖", "／", "．", "％", "＃",
];
for (const mark of punctuation) {
  assert.deepEqual(kinds(`**文字${mark}**继续`), ["strong"], `render ${mark}`);
  const fix = findSourceFixes(`**文字${mark}**继续`);
  assert.equal(fix.length, 1, `fix ${mark}`);
  assert.equal(fix[0].replacement, `**文字**${mark}`, `fix result ${mark}`);
}

console.log("scanner tests: ok");
