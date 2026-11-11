// #C871 and #C859 on the page: an agent's queue on its Crew tile (the #C numbers in the dispatch's order, the owner's up and down buttons,
// "order set by the owner"), the stack switch bar, and a card's stack tag. All of it on the store's page only.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const T = Date.now();
const card = (num, id, extra) => ({ id, num, name: `Name of ${id}`, size: "S", status: "active", phase: "plan", who: "Boardsmith", createdAt: T - num * 1e3, ...extra });
const cards = () => [card(1, "c1-one", { queuePos: 1 }), card(2, "c2-two", { queuePos: 2 }), card(3, "c3-three", { queuePos: 3, queueSetBy: "owner" })];

function store(host, onFetch = () => ({ ok: true })) {
  const listeners = {};
  const el = () => ({ innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {} });
  const document = { documentElement: { getAttribute: () => host }, getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener(t, f) { (listeners[t] ||= []).push(f); }, activeElement: null, createRange: () => ({}) };
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return onFetch(url); };
  const b = loadNames(["queueTile", "stackBar", "stackTag", "stackRow", "queueOf", "isQueued"], { document, fetch });
  Object.assign(b.state, { steps: [], derived: [], waiting: [], ideas: [], messages: [], threads: [], initRaw: cards(), initiatives: cards(), meta: [{ id: "stackSwitch", rows: [{ repo: "board", stack: true, setBy: "default", setAt: 0 }, { repo: "product", stack: false, setBy: "owner", setAt: T }] }] });
  return { b, listeners, calls };
}

test("a tile lists the agent's queued cards in the dispatch's order, the name on hover, an arrow each way, and says when the owner placed them", () => {
  const { b } = store("store");
  const html = b.queueTile("Boardsmith");
  assert.deepEqual([...html.matchAll(/class="qc" title="([^"]*)">(#C\d)/g)].map((m) => [m[1], m[2]]), [["Name of c1-one", "#C1"], ["Name of c2-two", "#C2"], ["Name of c3-three", "#C3"]]);
  assert.match(html, /data-qmove="c1-one" data-dir="up"[^>]*disabled/, "the first cannot go up");
  assert.match(html, /data-qmove="c3-three" data-dir="down"[^>]*disabled/, "the last cannot go down");
  assert.doesNotMatch(html, /data-qmove="c2-two" data-dir="up"[^>]*disabled/);
  assert.match(html, /order set by the owner/);
  assert.equal(b.queueTile("Checker"), "", "an agent with nothing queued has no line");
});

test("an order nobody but an agent set does not say the owner did", () => {
  const { b } = store("store");
  for (const i of b.state.initiatives) delete i.queueSetBy;
  assert.doesNotMatch(b.queueTile("Boardsmith"), /order set by the owner/);
});

test("the old board's page draws none of it: no queue line, no stack bar, no stack tag", () => {
  const { b } = store(null);
  assert.equal(b.queueTile("Boardsmith"), "");
  assert.equal(b.stackBar(), "");
  assert.equal(b.stackTag({ stack: { tip: "abcdef012345", size: 3 } }), "");
});

test("the stack bar shows each repository's switch and the button that flips it", () => {
  const { b } = store("store");
  const html = b.stackBar();
  assert.match(html, /Board: <b>on<\/b><button type="button" data-sw="board" data-on="0">Turn off<\/button>/);
  assert.match(html, /Product: <b>off<\/b><button type="button" data-sw="product" data-on="1">Turn on<\/button><small>by owner,/);
});

test("a card's tag: 'stack of 3 · tip abcdef0' for a member, 'outside the stack' for one not cut from the tip, nothing for no stack", () => {
  const { b } = store("store");
  assert.match(b.stackTag({ stack: { tip: "abcdef012345", size: 3, branch: "build/stack" } }), /stack of 3 · tip <code>abcdef0<\/code>/);
  const out = b.stackTag({ stack: { outside: true, branch: "build/stack" } });
  assert.match(out, /class="stk out"[^>]*>outside the stack · build\/stack/);
  assert.equal(b.stackTag({}), "");
  assert.doesNotMatch(b.stackTag({ stack: { outside: true, branch: "<img onerror=x>" } }), /<img/, "escaped");
});

test("a click on an arrow posts {id, dir} to the store's route; on the switch, {repo, stack}", async () => {
  const { b, listeners, calls } = store("store");
  const press = async (dataset) => {
    const btn = { dataset, disabled: false, textContent: "↑" };
    // The page registers several click listeners; each takes the event as it would, and only the owner's queue and switch buttons post.
    for (const fn of listeners.click) { try { await fn({ target: { closest: (sel) => (/data-qmove|data-sw/.test(sel) ? btn : null) }, preventDefault() {}, stopPropagation() {} }); } catch { /* another listener's business */ } }
  };
  await press({ qmove: "c3-three", dir: "up" });
  await press({ sw: "board", on: "0" });
  assert.deepEqual(calls, [{ url: "/api/queue-move", body: { id: "c3-three", dir: "up" } }, { url: "/api/stack-switch", body: { repo: "board", stack: false } }]);
  assert.ok(b.stackRow("board"));
});
