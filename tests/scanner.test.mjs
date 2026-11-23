import assert from "node:assert/strict";
import {
  scanLine,
  findSourceFixes,
  findDocumentFixes,
  findExcessParserRanges,
  findLiteralLines,
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
assert.equal(documentFixes.length, 3);

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
  1,
);
assert.equal(findDocumentFixes("~~~\n**字。**后\n~~~\n").length, 0);

// A `$$` span closed on the same line is a mask, not a block; the prose on
// that line and after it is still fixed.
assert.equal(findDocumentFixes("$$x$$ **字。**后\n**字。**后\n").length, 2);
assert.equal(findDocumentFixes("$$$$\n**字。**后\n").length, 1);
assert.equal(findDocumentFixes("    $$\n**字。**后\n").length, 1);
// Backticks inside a math block are content, not a fence opener.
assert.equal(findDocumentFixes("$$\n```\n$$\n**字。**后\n").length, 1);

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

// Parser runs that overflow a marked span, including split runs.
assert.deepEqual(findExcessParserRanges([102], [{ from: 23, to: 111 }], 200), [
  { from: 102, to: 111 },
]);
assert.deepEqual(
  findExcessParserRanges([102], [{ from: 23, to: 29 }, { from: 42, to: 111 }], 200),
  [{ from: 102, to: 111 }],
);
assert.deepEqual(findExcessParserRanges([102], [{ from: 102, to: 111 }], 200), []);
assert.deepEqual(findExcessParserRanges([5], [{ from: 5, to: 8 }], 8), []);
assert.deepEqual(findExcessParserRanges([102], [{ from: 23, to: 100 }], 200), []);
assert.deepEqual(findExcessParserRanges([102], [{ from: 120, to: 130 }], 200), []);

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
