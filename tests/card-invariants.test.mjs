// #C662: one set of rules a card must meet (gate/card-rules.mjs). The gate refuses a write that brings in a problem and names the
// field or step; the probe's collect() writes the problems of every open card as red lines in derived/all; the page shows them.
// Fictional board and cards.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fullConfig, checkConfig } from "../scripts/config.mjs";
import { writeErrors, mirrorErrors } from "../gate/rules.mjs";
import { CARD_KEYS, allowedFor, fieldProblems, stepProblems, cardProblems, newProblems } from "../gate/card-rules.mjs";
import { collect } from "../collector/collect.mjs";

const config = fullConfig({ owner: "Sam", roster: ["Manager", "Builder", "Checker"], collector: { repoPath: "/x", deployWorkflow: "CI" } });
const NOW = Date.UTC(2030, 0, 1, 4, 0) + 12345, HOUR = 3600e3;
const who = { role: "Builder", manager: false };
const card = (extra = {}) => ({ id: "menu", num: 700, name: "Menu", status: "active", phase: "build", size: "S", level: "Full", who: "Builder", ...extra });
const step = (extra = {}) => ({ id: "s", init: "menu", phase: "build", kind: "start", who: "Builder", at: NOW - HOUR, ...extra });
const board = (cards, steps = [], derived = {}) => ({ docs: { initiatives: cards, steps, messages: [], waiting: [], derived: [{ id: "all", cards: derived }] }, at: NOW });
const upd = (data, id = "menu") => ({ op: "update", collection: "initiatives", doc_id: id, data: { updatedAt: NOW, ...data } });
const gate = (w, m, extra = {}) => [...writeErrors(w, { config, who, now: NOW }), ...mirrorErrors(w, { config, mirror: m, batch: [w], now: NOW, ...extra })];
const codes = (list) => list.map((p) => p.code);

test("the config lists the values of a card's typed fields, checkConfig accepts it, and a bad list is named", () => {
  assert.deepEqual(allowedFor("status", config), ["queued", "active", "paused", "done", "dropped"]);
  assert.deepEqual(allowedFor("wait", config), [], "no card carries a wait");
  assert.deepEqual(allowedFor("phase", config), config.phases.map((p) => p[0]));
  assert.deepEqual(allowedFor("who", config), ["Manager", "Builder", "Checker", "Sam"], "the roster, the card owners and the owner");
  assert.deepEqual(checkConfig({ cardFields: { size: ["XS", "S"] } }), []);
  assert.match(checkConfig({ cardFields: { colour: ["red"] } })[0], /unknown field "colour"/);
  assert.match(checkConfig({ cardFields: { size: "S" } })[0], /cardFields\.size: a list/);
  assert.equal(fullConfig({ cardFields: { size: ["S"] } }).cardFields.status.length, 5, "the other lists keep their defaults");
});

test("invariant 6: a field the card schema does not name is refused, and the refusal names it", () => {
  const e = gate(upd({ summery: "typo" }), board([card()]));
  assert.equal(e.length, 1);
  assert.match(e[0], /summery: a card has no such field/);
  assert.ok(CARD_KEYS.has("summary") && CARD_KEYS.has("deleted") && CARD_KEYS.has("doneWhen"), "the fields the code writes are named");
  assert.deepEqual(gate(upd({ summary: "fine", name: "x" }), board([card()])), []);
  assert.deepEqual(gate(upd({ summery: { __delete__: true } }), board([card({ summery: "old" })])), [], "removing a stray field is allowed");
  assert.match(gate({ op: "set", collection: "initiatives", doc_id: "new", data: { updatedAt: NOW, name: "n", num: 701, plan: "p", size: "S", whoo: "x" } }, board([])).join(), /whoo: a card has no such field/);
});

test("every typed field is checked against its list, null included; a removal is not a value", () => {
  for (const [f, v] of [["status", "busy"], ["size", "XXL"], ["level", "Medium"], ["wait", "install"], ["kind", "x"], ["phase", null], ["status", null], ["who", "Nobody"]]) {
    const e = gate(upd({ [f]: v }), board([card()])).filter((m) => m.startsWith(`${f}:`) || /unknown phase/.test(m));
    assert.ok(e.length >= 1, `${f}=${JSON.stringify(v)} is refused`);
  }
  assert.match(gate(upd({ wait: null }), board([card()]))[0], /wait: null is not a value.*__delete__/);
  assert.match(gate(upd({ size: "XXL" }), board([card()]))[0], /size: "XXL" is not allowed \(use XS, S, M, L, XL\)/);
  assert.match(gate(upd({ wait: "install" }), board([card()]))[0], /wait: "install" is not allowed \(no card carries this field/);
  assert.deepEqual(gate(upd({ wait: { __delete__: true }, level: "Quick", size: "M", status: "paused" }), board([card({ wait: "busy" })])), []);
  assert.deepEqual(fieldProblems(card({ wait: null, size: "XXL" }), config).map((p) => p.code).sort(), ["null:wait", "value:size"]);
});

test("a queued card with a build step is refused with the reason; queued in plan or build with no step of its own passes", () => {
  const m = board([card({ status: "queued", phase: "plan" })], [step({ wait: "busy" })]);
  assert.deepEqual(gate(upd({ summary: "x" }), m), [], "a busy start is the way a queued card is logged");
  const plain = board([card({ status: "active" })], [step()]);
  const e = gate(upd({ status: "queued" }), plain);
  assert.equal(e.length, 1);
  assert.match(e[0], /status: #C700 is queued but has a start step on build \(Builder\)/);
  assert.match(e[0], /"wait": "busy"/, "the way out");
  assert.match(gate(upd({ status: "queued", phase: "checker" }), board([card({ phase: "build" })], [step(), step({ kind: "end", id: "e" })]))[0], /queued but its phase is checker/);
  assert.deepEqual(gate(upd({ status: "queued" }), board([card()], [])), [], "no step at all");
  assert.deepEqual(gate(upd({ status: "queued" }), board([card()], [step({ phase: "plan" })])), [], "a plan step is not a build step");
});

test("past build only with a build end step; this batch's end step counts; a card that skips build, and a dropped one, are left alone", () => {
  const m = board([card()], [step()]);
  const e = gate(upd({ phase: "test" }), m);
  assert.equal(e.length, 1);
  assert.match(e[0], /phase: #C700 is on test, past build, but has no build end step: log steps\/menu-build-end-<now> first/);
  const endStep = { op: "set", collection: "steps", doc_id: "menu-build-end-1", data: step({ kind: "end", id: "menu-build-end-1" }) };
  const w = upd({ phase: "test" });
  assert.deepEqual(mirrorErrors(w, { config, mirror: m, batch: [endStep, w], now: NOW }).filter((x) => /build end step/.test(x)), []);
  assert.deepEqual(gate(upd({ phase: "test" }), board([card()], [step({ kind: "end" })])), []);
  assert.deepEqual(gate(upd({ phase: "test" }), board([card()], [step({ kind: "end", init: "C700" })])), [], "its #C number names the card too");
  assert.deepEqual(gate(upd({ phase: "test", skip: ["build"] }), m), []);
  assert.deepEqual(gate(upd({ status: "dropped", dropReason: "r", phase: "test" }), m), []);
  assert.deepEqual(gate(upd({ phase: "test" }), board([card()], [step({ kind: "end", wait: "busy" })])).filter((x) => /build end step/.test(x)).length, 1, "a busy end closes no work");
});

test("ship only with a commit on main or a release note", () => {
  const withEnd = [step({ kind: "end" })];
  const m = board([card({ phase: "security" })], withEnd);
  const e = gate(upd({ phase: "ship" }), m);
  assert.equal(e.length, 1);
  assert.match(e[0], /phase: #C700 is on ship but no commit of it is on main and it names no release version/);
  assert.deepEqual(gate(upd({ phase: "ship", version: "1.2.3" }), m), [], "a release note");
  assert.deepEqual(gate(upd({ phase: "ship" }), board([card({ phase: "security" })], withEnd, { menu: { phase: "ship", onMain: true } })), [], "the export says it is on main");
  assert.equal(gate(upd({ phase: "ship" }), board([card({ phase: "security" })], withEnd, { menu: { phase: "ship" } })).length, 1, "signed but not on main is not shipped");
  const head = "a".repeat(12);
  const live = { version: 1, board: { boardId: "TestBoard01", at: NOW, probe: null, pageVersion: null }, cards: { menu: { phase: "ship", headSha12: head, onMain: true } }, agents: {} };
  assert.deepEqual(stepProblems(card({ phase: "ship" }), { steps: withEnd, live, config }), [], "so does a fresh live reading (a reading the schema accepts)", { skip: false });
  assert.match(gate(upd({ phase: "live" }), board([card({ phase: "ship" })], withEnd))[0], /on live but no commit/);
});

test("a write is refused only for a problem it brings in: a card already broken can still be fixed or touched", () => {
  const broken = card({ status: "queued" });
  const m = board([broken], [step()]);
  assert.deepEqual(gate(upd({ summary: "still queued" }), m), [], "the probe's red line carries the old problem");
  assert.deepEqual(gate(upd({ status: "active" }), m), []);
  assert.deepEqual(codes(newProblems({ ...broken, phase: "checker" }, broken, { steps: [step()], config })).sort(), ["no-build-end", "queued-phase"]);
  assert.deepEqual(newProblems(broken, broken, { steps: [step()], config }), []);
});

test("the probe writes a red line for each open card that breaks a rule, and none for a clean one or a closed one", () => {
  const cards = [
    card({ id: "a647", num: 647, phase: "checker" }),
    card({ id: "a640", num: 640, status: "queued", phase: "build" }),
    card({ id: "a649", num: 649, phase: "ship" }),
    card({ id: "clean", num: 650, phase: "build" }),
    card({ id: "old", num: 651, status: "done", phase: "ship", summery: "x" }),
  ];
  const steps = [step({ init: "a640" }), step({ init: "clean" })];
  const git = (args) => { if (args[0] === "log" || args[0] === "for-each-ref" || args[0] === "branch" || args[0] === "ls-remote") return ""; return ""; };
  const { doc } = collect({ config, cards, git, gh: () => "[]", now: NOW, steps });
  const red = (id) => doc.cards[id]?.red ?? [];
  assert.match(red("a647").join(), /#C647 is on checker, past build, but has no build end step/);
  assert.match(red("a640").join(), /#C640 is queued but has a start step on build/);
  assert.match(red("a649").join(), /#C649 is on ship but no commit of it is on main/);
  assert.deepEqual(red("clean"), []);
  assert.equal(doc.cards.old, undefined, "a closed card gets no reading, so no line");
  for (const id of ["a647", "a640", "a649"]) assert.ok(red(id).every((l) => l.length <= 240) && red(id).length <= 3, id);
});

test("the page shows a card's red lines as they are, escaped, and nothing for a card without any", () => {
  const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  const from = html.indexOf("function redLines(i){");
  assert.ok(from > 0, "the page defines redLines");
  let depth = 0, end = from;
  for (let k = html.indexOf("{", from); k < html.length; k++) { if (html[k] === "{") depth++; else if (html[k] === "}" && --depth === 0) { end = k + 1; break; } }
  const src = [html.slice(from, end)];
  const ctx = { esc: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"), derivedOf: (id) => ({ x: { red: ["phase: a <b>", "second"] }, none: {}, bad: { red: [1, null, ""] } })[id] ?? null };
  vm.createContext(ctx);
  vm.runInContext(`${src[0]};globalThis.redLines=redLines`, ctx);
  const out = ctx.redLines({ id: "x", status: "active" });
  assert.match(out, /<span class="redline" role="alert"><span>phase: a &lt;b><\/span><span>second<\/span><\/span>/);
  assert.equal(ctx.redLines({ id: "none", status: "active" }), "");
  assert.equal(ctx.redLines({ id: "bad", status: "active" }), "", "only text lines");
  assert.equal(ctx.redLines({ id: "x", status: "done" }), "", "a closed card shows none");
  assert.match(html, /\.redline\{/, "styled");
});

test("derivePhase says onMain for a card whose commit is on main (the ship rule's evidence), and not before", async () => {
  const { derivePhase } = await import("../collector/derive.mjs");
  const head = { branch: "build/menu", sha: "b".repeat(40), message: "x\n\nBoard-Id: menu", at: 1 };
  const facts = (extra) => ({ head, signed: new Set(["checker"]), onMain: false, deployed: false, version: null, ...extra });
  assert.equal(derivePhase(card(), facts({ onMain: true }), config).onMain, true, "on main, not deployed: ship");
  assert.equal(derivePhase(card(), facts({ onMain: true, deployed: true }), config).onMain, true, "live");
  assert.equal(derivePhase(card(), facts({}), config).onMain, undefined, "READY and signed but not on main");
});

test("cardProblems is the one list: fields first, then the steps", () => {
  assert.deepEqual(codes(cardProblems(card({ size: "XXL", status: "queued" }), { steps: [step()], config })), ["value:size", "queued-step"]);
});
