import { findLiteralLines } from "./scanner.bundle.mjs";
const doc = ["$$", "~~~", "$$", "`", "*字*", "`"];
const codes = [];
findLiteralLines(doc, { displayBlocks: "standalone", multilineCode: false }, codes);
console.error("DBG codes", JSON.stringify(codes));
