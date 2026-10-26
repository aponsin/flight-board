// An item's own text sits in its own block under the #T number, title and badge (#C234: "waiting on youOne sitting,").
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const T = Date.now() - 60_000;

test("every ask kind puts its text in a block after the badge, never on the badge's line", () => {
  const b = loadNames(["askHtml"]);
  for (const [kind, extra] of [["decision", { options: [{ key: "A", label: "one" }, { key: "B", label: "two" }] }], ["action", { steps: ["Do it"] }], ["answer", { question: "q" }], ["action", { later: true, steps: ["Later"] }]]) {
    const w = { id: `w-${kind}`, kind, text: "One sitting, two steps.", since: T, ...extra };
    Object.assign(b.state, { threads: [{ id: w.id, num: 4, title: "Ask" }], waiting: [w], messages: [] });
    const html = b.askHtml(w, new Set());
    assert.match(html, /waiting on you<\/span>(?:<div class="w-sub">[^<]*<\/div>)?<div class="(?:w-body|w-answer)">One sitting, two steps\./, kind);
  }
});

test("the block has its own line and a small gap, in the page's styles", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.match(page, /\.w-body,\.w-answer\{display:block;margin-top:4px\}/);
});
