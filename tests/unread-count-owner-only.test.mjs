// #C1287 (the owner, #T2129, mockup A): the "N new replies" pill and the "new" tag count only what is for him: a message from Manager, or a decision
// (kind "decision") from anyone but him. Other agents' messages in a thread, and his own, do not count. The pill and the tag follow the same rule.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const NAMES = ["threadOf", "initRow", "enrich", "gates", "newReplies", "countsNew", "seenAt", "markThreadSeen", "OWNER", "threadHtml", "msgHtml"];
const T = 1_800_000_000_000;
const msg = (from, text, at, extra = {}) => ({ id: `m${at}`, thread: "x", from, text, at, ...extra });
function board(messages) {
  const store = new Map();
  const realNow = Date.now; Date.now = () => T;
  const b = loadNames(NAMES, { localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => void store.set(k, String(v)) } });
  b.seenAt("x");
  Date.now = realNow;
  b.state.steps = []; b.state.waiting = []; b.state.messages = messages;
  return b;
}
const texts = (b) => [...b.newReplies("x")].map((m) => m.text);

test("only Manager's messages count; Builder, Checker, Release and the like do not", () => {
  const b = board([msg("Builder", "built it", T + 1), msg("Checker", "pass", T + 2), msg("Release", "shipping", T + 3), msg("Manager", "your call", T + 4)]);
  assert.deepEqual(texts(b), ["your call"]);
});

// Checker 2's F1 on e6de6cc9: the lead is the board's configured lead role (gate.managerRole), not the word "Manager".
test("on a board whose lead role is not called Manager, the lead's messages count and a role named Manager does not", () => {
  const template = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  const cfg = JSON.parse(template.match(/\/\*BOARD_CONFIG\*\/([\s\S]*?)\/\*END_CONFIG\*\//)[1]);
  const html = template.replace(/\/\*BOARD_CONFIG\*\/[\s\S]*?\/\*END_CONFIG\*\//, `/*BOARD_CONFIG*/${JSON.stringify({ ...cfg, gate: { managerRole: "Lead" } })}/*END_CONFIG*/`);
  const store = new Map();
  const realNow = Date.now; Date.now = () => T;
  const b = loadNames(NAMES, { localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => void store.set(k, String(v)) } }, html);
  b.seenAt("x");
  Date.now = realNow;
  b.state.steps = []; b.state.waiting = [];
  b.state.messages = [msg("Lead", "from the lead", T + 1), msg("Manager", "a role named Manager", T + 2), msg("Builder", "plain", T + 3)];
  assert.deepEqual(texts(b), ["from the lead"]);
});

test("a decision counts from anyone but the owner; his own never does", () => {
  const b = board([msg("Designer", "pick one", T + 1, { kind: "decision", options: [{ key: "A", label: "a" }] }), msg("Owner", "mine", T + 2, { kind: "decision" }), msg("Builder", "plain", T + 3)]);
  assert.deepEqual(texts(b), ["pick one"]);
});

test("the pill and the 'new' tag follow the same rule: another agent's message gets no tag", () => {
  const b = board([msg("Builder", "built it", T + 1), msg("Manager", "answer", T + 2)]);
  const html = b.initRow(b.gates(b.enrich({ id: "x", name: "X", status: "active", level: "Quick", skip: ["plan"] })));
  assert.match(html, /<span class="newpill"[^>]*>1 new reply<\/span>/);
  assert.equal((html.match(/t-newtag/g) ?? []).length, 1, "one 'new' tag, on Manager's message");
  assert.match(html, /t-new"><span class="t-from">Manager<\/span>/);
  assert.doesNotMatch(html, /t-new"><span class="t-from">Builder<\/span>/);
});
