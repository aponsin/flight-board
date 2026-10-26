// Board v3, step 2: the page's Plan view (page/board.template.html planHtml), behind "Try the new layout". Fictional plan.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const board = (plan, { derived = null, initiatives = [], ideas = [], threads = [], waiting = [] } = {}) => {
  const b = loadNames(["planHtml", "setView", "setV3View", "nowHtml"]);
  Object.assign(b.state, { plan, initiatives, ideas, threads, waiting, derived: derived ? [{ id: "all", plan: derived }] : [] });
  return b;
};
const obj = { id: "obj-shop", parent: null, order: 1, kind: "objective", text: "Open the shop", outcome: "Doors open", measure: "1 shop", due: "2030-01-20" };
const sign = { id: "step-sign", parent: "obj-shop", order: 2, kind: "step", text: "Sign up" };
const door = { id: "step-door", parent: "obj-shop", order: 1, kind: "step", text: "Door fixed", waitsOn: ["the landlord's yes"] };

test("the outline: nested by parent, in order, each node with its derived state and the cards serving it", () => {
  const derived = { at: 1, nodes: { "obj-shop": { state: "active" }, "step-sign": { state: "active", cards: ["sign-a"] }, "step-door": { state: "gated", gates: [{ on: "the landlord's yes", kind: "text" }] } }, objectives: { "obj-shop": { done: 1, total: 4, hoursLeft: 3, chip: "on-track" } } };
  const html = board([sign, obj, door], { derived, initiatives: [{ id: "sign-a", name: "Paint the sign", plan: "step-sign", phase: "build", status: "active" }] }).planHtml();
  assert.ok(html.indexOf("Open the shop") < html.indexOf("Door fixed") && html.indexOf("Door fixed") < html.indexOf("Sign up"), "objective, then its steps by order");
  assert.match(html, /<li class="pn k-objective pn-active" data-node="obj-shop">/);
  assert.match(html, /<ul class="plan"><li class="pn k-step pn-gated" data-node="step-door">/, "steps nest under the objective");
  assert.match(html, /In progress/);
  assert.match(html, /Waits on: the landlord&#39;s yes/);
  assert.match(html, /Paint the sign · Build/);
  assert.match(html, /aria-label="1 of 4 done"><span style="width:25%">/);
  assert.match(html, /On track/);
  assert.match(html, /Doors open · Measure: 1 shop/);
  assert.match(html, /due 2030-01-20/);
});

test("a replaced node stays, struck through, with when, why, its replacement and the decision's thread", () => {
  const old = { ...sign, replacedBy: "step-neon", changedAt: Date.parse("2030-01-05T12:00:00Z"), why: "neon is cheaper", decisionThread: "t-sign" };
  const neon = { id: "step-neon", parent: "obj-shop", order: 3, kind: "step", text: "Neon sign" };
  const html = board([obj, old, neon], { threads: [{ id: "t-sign", num: 12 }] }).planHtml();
  assert.match(html, /pn-replaced[^>]*><div class="pn-line"><span class="pn-st st-muted">Changed<\/span><span class="pn-text"><s>Sign up<\/s>/);
  assert.match(html, /: neon is cheaper · now “Neon sign” · <a href="#" class="t-ref" data-tref="t-sign">#T12<\/a>/);
  assert.ok(html.indexOf("Sign up") < html.indexOf("Neon sign"), "the new node below the old one");
});

test("before the collector has run: only what the nodes say, and a line saying states come later", () => {
  const html = board([obj, { ...sign, state: "done", evidence: "photo of the sign" }]).planHtml();
  assert.match(html, /pn-done/);
  assert.match(html, /photo of the sign/);
  assert.match(html, /States show once the collector has run on the plan/);
  assert.doesNotMatch(html, /pn-bar/, "no bar without the collector's count");
});

test("ideas not in the plan sit at the bottom; no plan says who writes it", () => {
  const ideas = [{ id: "i1", text: "A loyalty card", kind: "assess", rank: 1 }, { id: "i2", text: "closed one", done: true }];
  const html = board([obj], { ideas }).planHtml();
  assert.ok(html.indexOf("Ideas not in the plan yet") > html.indexOf("Open the shop"));
  assert.match(html, /A loyalty card/);
  assert.doesNotMatch(html, /closed one/);
  assert.match(board([]).planHtml(), /No plan yet\. (Manager|The lead) writes it with Owner at the go-gate\./);
});

test("plan text never injects markup: every value is escaped, links only through linkify", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const derived = { nodes: { "obj-shop": { state: "gated", gates: [{ on: evil, kind: "text" }, { on: "c1", kind: "card", who: evil }] } }, objectives: { "obj-shop": { done: evil, total: 2, chip: evil } } };
  const html = board([{ ...obj, text: evil, outcome: evil, measure: evil, due: evil, note: `${evil} https://example.com/x"onmouseover=1` }, { ...sign, id: "x\"><b>", parent: "obj-shop", replacedBy: "nope", why: evil, decisionThread: evil }],
    { derived, initiatives: [{ id: "c1", name: evil, plan: "obj-shop", phase: evil }], ideas: [{ id: "i", text: evil, kind: evil }] }).planHtml();
  assert.doesNotMatch(html, /<img|<b>|"onmouseover/, "no raw tag, no attribute breaking out of a link");
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /aria-label="0 of 2 done"/, "a count that isn't a number counts as 0");
});

test("a broken plan renders once: a parent loop and a node that is its own parent don't hang or repeat", () => {
  const html = board([{ id: "a", parent: "b", order: 1, kind: "step", text: "A" }, { id: "b", parent: "a", order: 1, kind: "step", text: "B" }, { id: "c", parent: "c", order: 1, kind: "step", text: "C" }]).planHtml();
  for (const id of ["a", "b", "c"]) assert.equal((html.match(new RegExp(`data-node="${id}"`, "g")) ?? []).length, 1, `${id} shows once`);
  assert.match(html, /<ul class="plan">/);
});

test("the view switch: the current board by default, the new layout on the viewer's choice, and back", () => {
  const b = board([obj]);
  b.setView("v3");
  const v2 = b.els.v2, v3 = b.els.v3, link = b.els.viewlink;
  assert.equal(v3.hidden, false);
  assert.equal(v2.hidden, true);
  assert.equal(link.textContent, "Back to the current board");
  assert.match(b.els.now.innerHTML, /Nothing in flight/, "the new layout opens on Now");
  b.setV3View("plan");
  assert.deepEqual([b.els.v3now.hidden, b.els.v3plan.hidden], [true, false]);
  assert.match(b.els.plan.innerHTML, /Open the shop/, "the plan renders when shown");
  b.setView("v2");
  assert.deepEqual([v2.hidden, v3.hidden, link.textContent], [false, true, "Try the new layout"]);
});

test("Now: open cards grouped under their plan node in the plan's order, with the path above it; unlinked cards last", () => {
  const ms = { id: "ms-front", parent: "obj-shop", order: 1, kind: "milestone", text: "The front" };
  const steps = [{ ...sign, parent: "ms-front", order: 1 }, { ...door, parent: "ms-front", order: 2 }];
  const t = Date.now() + 36e5;
  const initiatives = [
    { id: "c-door", name: "Hang the door", plan: "step-door", phase: "build", status: "active", etaLive: t },
    { id: "c-sign-b", name: "Sign in build", plan: "step-sign", phase: "build", status: "active", etaLive: t },
    { id: "c-sign-a", name: "Sign at ship", plan: "step-sign", phase: "ship", status: "active", etaLive: t },
    { id: "c-free", name: "Loose card", phase: "plan", status: "active", etaLive: t },
    { id: "c-gone", name: "Card on a missing node", plan: "nope", phase: "plan", status: "active", etaLive: t },
    { id: "c-done", name: "Done long ago", plan: "step-sign", status: "done", doneAt: Date.now() - 3 * 864e5 },
  ];
  const derived = { nodes: { "step-sign": { state: "active" }, "step-door": { state: "gated" } }, objectives: {} };
  const html = board([steps[1], obj, steps[0], ms], { initiatives, derived }).nowHtml(); // stored in any order
  const at = (x) => html.indexOf(x);
  assert.ok(at('data-node="step-sign"') < at('data-node="step-door"') && at('data-node="step-door"') < at('data-node=""'), "plan order, unlinked last");
  assert.ok(at("Sign at ship") < at("Sign in build"), "within a group, the board's order: the furthest phase first");
  assert.match(html, /<span class="now-path">Open the shop › The front<\/span>/);
  assert.match(html, /data-node="step-door"><h3 class="now-head"><span class="pn-st st-warn">Gated<\/span>/);
  assert.ok(at("Loose card") > at('data-node=""') && at("Card on a missing node") > at('data-node=""'), "no node, or a node not on the board: unlinked");
  assert.doesNotMatch(html, /Done long ago/, "older than 24 h: not here");
  assert.doesNotMatch(html, /data-node="obj-shop"/, "a node with no card has no group");
});

test("Now: what shipped and the threads resolved in the last 24 hours, folded at the bottom; nothing in flight says so", () => {
  const now = Date.now();
  const initiatives = [{ id: "c-shipped", name: "Shipped today", plan: "step-sign", status: "done", doneAt: now - 36e5, phase: "live" }];
  const b = board([obj, sign], { initiatives });
  const html = b.nowHtml(now);
  assert.match(html, /Nothing in flight\./);
  assert.match(html, /<details class="now-fold panel"><summary>Shipped in the last 24 h \(1\)<\/summary>[\s\S]*Shipped today/);
  assert.doesNotMatch(html, /Threads resolved/, "none resolved: no fold");
});

test("Now never injects markup: node text, paths and card names are escaped", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const html = board([{ ...obj, text: evil }, { ...sign, text: evil }], { initiatives: [{ id: "c1", name: evil, plan: "step-sign", phase: "build", status: "active" }] }).nowHtml();
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
