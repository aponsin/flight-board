// #C665: "one question at a time": clicks and installs queue visibly under a "Your queue" line, numbered in the order he should
// do them, with a question alone above them. Fictional asks.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const T = Date.now();
function board(waiting) {
  const b = loadNames(["renderAll", "renderWaiting", "queueHtml", "isClick", "askHtml"]);
  Object.assign(b.state, { waiting, messages: [], threads: [], initRaw: [], ideas: [], todo: [] });
  return b;
}
const click = (id, since, steps = ["Do the thing"]) => ({ id, kind: "action", text: `Run ${id}`, steps, since });
const question = (id, since) => ({ id, kind: "decision", text: `Go for ${id}?`, options: [{ key: "A", label: "Go" }], since });
const html = (b) => b.els.waiting.innerHTML;

test("two open action asks render as a numbered queue, with the question alone above it", () => {
  const b = board([click("c-late", T - 1e5), question("q1", T - 3e5), click("c-early", T - 5e5)]);
  b.renderAll();
  const h = html(b);
  const at = (s) => h.indexOf(s);
  assert.ok(at("Go for q1?") >= 0 && at("Go for q1?") < at('id="queue-h"'), "the question is above the queue line");
  assert.match(h, /<div class="queue-h" id="queue-h">Your queue · 2 to do, in this order<\/div>/);
  assert.ok(at("Run c-early") > at('id="queue-h"') && at("Run c-late") > at("Run c-early"), "oldest click first");
  assert.match(h, /class="kind action">1\. Your click<\/span>[\s\S]*Run c-early/);
  assert.match(h, /class="kind action">2\. Your click<\/span>[\s\S]*Run c-late/);
  assert.doesNotMatch(h.slice(0, at('id="queue-h"')), /\d\. Your click/, "nothing above the line is numbered");
  assert.doesNotMatch(h, /class="kind decision">\d\./, "a question carries no number");
});

test("no clicks, no queue line; one click is still a queue of one; questions alone stay as they were", () => {
  const q = board([question("q1", T - 3e5), question("q2", T - 2e5)]);
  q.renderAll();
  assert.doesNotMatch(html(q), /Your queue/);
  assert.equal((html(q).match(/<details class="w-item"/g) || []).length, 2);
  const one = board([click("c1", T - 1e5)]);
  one.renderAll();
  assert.match(html(one), /Your queue · 1 to do/);
  assert.match(html(one), /1\. Your click/);
});

test("the queue line is styled and the label keeps the page's grid (the number is inside the kind label)", () => {
  const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.match(page, /\.queue-h\{[^}]*font-size:\.82rem/);
  assert.match(page, /\$\{qn\?qn\+"\. ":""\}\$\{esc\(KIND\[w\.kind\]/, "inside the kind span, no new grid cell");
});
