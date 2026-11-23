import assert from "node:assert/strict";
import { scanLine, findSourceFixes, findDocumentFixes } from "./scanner.bundle.mjs";

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

// Nothing left to wrap after the move.
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
