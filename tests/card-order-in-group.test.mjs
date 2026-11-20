// #C1296 (the owner: put a card first inside its group): each queued card of an open group on the store page has up and down arrows (data-qmove, the Crew queue's own
// /api/queue-move: owner-only, kept inside the group by the store). The rail lists started cards first, then the queued ones in the owner's order (queuePos). Also: the repo
// badge's name goes through esc(), and a group row's tooltip says "group" (Security's INFO and Checker 2's nit on #C1293).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const NAMES = ["groupRow", "gates", "enrich", "probeEvent", "state", "repoBadge", "cardRepo"];
function board(initRaw, host = "store") {
  const el = () => ({ innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {} });
  const document = { documentElement: { getAttribute: () => host }, getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) };
  const b = loadNames(NAMES, { document });
  Object.assign(b.state, { initRaw, initiatives: initRaw.map((i) => b.gates(b.enrich(i))), steps: [], waiting: [], derived: [], messages: [], threads: [] });
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { at: Date.now() - 20e3 }, cards: {}, agents: {} } } }, {});
  return { row: () => b.groupRow("g5-thing", b.state.initiatives), b };
}
const card = (id, num, extra = {}) => ({ id, num, name: `Card ${num}`, size: "S", level: "Quick", status: "active", phase: "build", who: "Boardsmith", repo: "flight-board", batch: "g5-thing", createdAt: 1_800_000_000_000 + num * 60e3, queuePos: num, ...extra });
const rail = (html) => html.split('<div class="g-rail">')[1] || "";
const order = (html) => [...rail(html).matchAll(/<span class="g-num">#C(\d+)<\/span>/g)].map((m) => Number(m[1]));
const arrows = (html) => [...rail(html).matchAll(/data-qmove="([^"]+)" data-dir="(up|down)"[^>]*?(disabled)?>/g)].map((m) => `${m[1]}:${m[2]}${m[3] ? ":off" : ""}`);

test("two queued cards: each has up and down arrows, the first one's up and the last one's down are off", () => {
  const { row } = board([card("a", 1), card("b", 2)]);
  assert.deepEqual(arrows(row()), ["a:up:off", "a:down", "b:up", "b:down:off"]);
});

test("the rail follows the owner's order (queuePos), whatever order the cards come in", () => {
  const { row } = board([card("a", 1, { queuePos: 3 }), card("b", 2, { queuePos: 1 }), card("c", 3, { queuePos: 2 })]);
  assert.deepEqual(order(row()), [2, 3, 1]);
  assert.deepEqual(arrows(row()).filter((x) => x.includes(":up")), ["b:up:off", "c:up", "a:up"]);
});

test("a started card sits first and has no arrows; the arrows are among the queued cards only", () => {
  const { row } = board([card("q1", 1), card("s", 2, { branch: "build/s", queuePos: 9 }), card("q2", 3)]);
  assert.deepEqual(order(row()), [2, 1, 3]);
  assert.ok(!arrows(row()).some((x) => x.startsWith("s:")), "no arrows on the started card");
  assert.deepEqual(arrows(row()), ["q1:up:off", "q1:down", "q2:up", "q2:down:off"]);
});

test("a group with one queued card has no arrows, and the page that is not the store's has none either", () => {
  assert.deepEqual(arrows(board([card("a", 1), card("s", 2, { branch: "build/s" })]).row()), []);
  assert.deepEqual(arrows(board([card("a", 1), card("b", 2)], "page").row()), []);
});

test("the repo badge escapes the name, and a group's tooltip says group while a card's says card", () => {
  const { row, b } = board([card("a", 1), card("b", 2)]);
  assert.match(row(), /<span class="c-repo fb" title="This group is about the [^"]*repository">/);
  assert.match(b.repoBadge(b.state.initiatives[0]), /title="This card is about the /);
  const src = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.ok(/function repoBadge\(i,what="card"\)\{const r=cardRepo\(i\);return `[^`]*\$\{esc\(r\)\}<\/span> `\}/.test(src) && /about the \$\{esc\(r\)\} repository/.test(src), "both places the name is written go through esc()");
});
