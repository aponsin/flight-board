// #C662: one set of rules a card must meet (gate/card-rules.mjs). The gate refuses a write that brings in a problem and names the
// field or step; the probe's collect() writes the problems of every open card as red lines in derived/all; the page shows them.
// Fictional board and cards.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fullConfig, checkConfig } from "../scripts/config.mjs";
import { writeErrors, mirrorErrors } from "../gate/rules.mjs";
import { CARD_KEYS, allowedFor, fieldProblems, stepProblems, cardProblems, newProblems, safeText } from "../gate/card-rules.mjs";
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
  assert.deepEqual(allowedFor("status", config), ["queued", "active", "paused", "parked", "stuck", "done", "dropped"]);
  assert.deepEqual(allowedFor("wait", config), [], "no card carries a wait");
  assert.deepEqual(allowedFor("phase", config), config.phases.map((p) => p[0]));
  assert.deepEqual(allowedFor("who", config), ["Manager", "Builder", "Checker", "Sam"], "the roster, the card owners and the owner");
  assert.deepEqual(checkConfig({ cardFields: { size: ["XS", "S"] } }), []);
  assert.match(checkConfig({ cardFields: { colour: ["red"] } })[0], /unknown field "colour"/);
  assert.match(checkConfig({ cardFields: { size: "S" } })[0], /cardFields\.size: a list/);
  assert.equal(fullConfig({ cardFields: { size: ["S"] } }).cardFields.status.length, 7, "the other lists keep their defaults");
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

test("#C663 (Security): only Release and the lead write a card's version or liveVersion, so a version cannot move a card past its reviews", () => {
  const m = board([card({ phase: "security" })], [step({ kind: "end" })]);
  const lie = upd({ phase: "ship", version: "9.9.9" });
  const refused = gate(lie, m, { who });
  assert.ok(refused.some((x) => /version: only Release and Manager write a card's version/.test(x)), "Builder's version is refused");
  assert.ok(refused.some((x) => /liveVersion|version/.test(x)));
  assert.ok(gate(upd({ liveVersion: "9.9.9" }), board([card()]), { who }).some((x) => /liveVersion: only Release and Manager/.test(x)), "liveVersion too");
  assert.deepEqual(gate(upd({ version: "1.2.3" }), board([card({ version: "1.2.3" })]), { who }), [], "a value the card already has is left alone");
  assert.deepEqual(gate(upd({ version: "1.2.3" }), board([card({ phase: "ship" })]), { who: { role: "Release", manager: false } }).filter((x) => /version/.test(x)), [], "Release writes it");
  assert.deepEqual(gate(upd({ version: "1.2.3" }), board([card({ phase: "ship" })]), { who: { role: "Manager", manager: true } }).filter((x) => /only Release/.test(x)), [], "the lead writes it");
  assert.deepEqual(gate(upd({ version: "1.2.3" }), board([card({ phase: "ship" })]), { who: {} }).filter((x) => /only Release/.test(x)), [], "no role known: not this rule's");
});

test("ship only with a commit on main or a release note", () => {
  const withEnd = [step({ kind: "end" })];
  const m = board([card({ phase: "security" })], withEnd);
  const e = gate(upd({ phase: "ship" }), m);
  assert.equal(e.length, 1);
  assert.match(e[0], /phase: #C700 is on ship but the repository does not show it signed, and it has no commit on main and no release version \(a ship step is not evidence\)/);
  assert.deepEqual(gate(upd({ phase: "ship", version: "1.2.3" }), m), [], "a release note");
  assert.deepEqual(gate(upd({ phase: "ship" }), board([card({ phase: "security" })], withEnd, { menu: { phase: "ship", onMain: true } })), [], "the export says it is on main");
  // Checker 1: a signed card waiting for Release is on ship by the repository's own reading (every review signed, not on main
  // yet). A ship step (Release logs its start when the ship begins) is NOT evidence for a move to ship (#C663, Security: it let a
  // security-phase card move to ship with no sign-off); it still covers live.
  assert.deepEqual(gate(upd({ phase: "ship" }), board([card({ phase: "security" })], withEnd, { menu: { phase: "ship" } })), [], "signed, waiting for Release: ship reads clean");
  assert.equal(gate(upd({ phase: "ship" }), board([card({ phase: "security" })], [...withEnd, step({ id: "r", phase: "ship", who: "Release" })])).length, 1, "a ship step alone is no evidence for ship");
  assert.equal(gate(upd({ phase: "ship" }), board([card({ phase: "security" })], [...withEnd, step({ id: "r", phase: "ship", who: "Release" })], { menu: { phase: "security" } })).length, 1, "the repository says security: still refused");
  assert.equal(gate(upd({ phase: "live" }), board([card({ phase: "ship" })], withEnd, { menu: { phase: "ship" } })).length, 1, "signed is not live");
  assert.deepEqual(gate(upd({ phase: "live" }), board([card({ phase: "ship" })], withEnd, { menu: { phase: "ship", onMain: true } })), [], "on main by the export: live reads clean");
  assert.equal(gate(upd({ phase: "live" }), board([card({ phase: "ship" })], [...withEnd, step({ id: "r", phase: "ship", who: "Release" })])).length, 0, "a ship step in the mirror covers live too");
  assert.deepEqual(codes(cardProblems(card({ phase: "ship" }), { steps: withEnd, derived: { phase: "ship" }, config })), [], "the probe draws no red line for it");
  assert.equal(codes(cardProblems(card({ phase: "ship" }), { steps: withEnd, derived: { phase: "checker" }, config })).length, 1, "but one for a card the repository has not signed");
  const head = "a".repeat(12);
  const live = { version: 1, board: { boardId: "TestBoard01", at: NOW, probe: null, pageVersion: null }, cards: { menu: { phase: "ship", headSha12: head, onMain: true } }, agents: {} };
  assert.deepEqual(stepProblems(card({ phase: "ship" }), { steps: withEnd, live, config }), [], "so does a fresh live reading (a reading the schema accepts)");
  assert.match(gate(upd({ phase: "live" }), board([card({ phase: "ship" })], withEnd))[0], /on live but it has no ship step, no commit on main and no release version/);
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
  assert.match(red("a649").join(), /#C649 is on ship but the repository does not show it signed, and it has no commit on main and no release version/);
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

test("Checker 3: a build end older than the mirror's week of steps is stood in for by the repository's reading", () => {
  const c = card({ phase: "checker" });
  assert.equal(codes(stepProblems(c, { steps: [], config })).join(), "no-build-end", "no step and no reading");
  assert.deepEqual(stepProblems(c, { steps: [], derived: { phase: "checker", readyAt: NOW - 20 * 24 * HOUR }, config }), [], "READY by the repository");
  assert.deepEqual(stepProblems(c, { steps: [], derived: { phase: "security" }, config }), [], "a phase past build by the repository");
  assert.equal(codes(stepProblems(c, { steps: [], derived: { phase: "build" }, config })).join(), "no-build-end", "the repository still says build");
});

test("Checker 2: parked and stuck are statuses, and so is anything nudges.parked lists", () => {
  for (const s of ["parked", "stuck", "paused"]) assert.deepEqual(gate(upd({ status: s }), board([card()])), [], s);
  assert.match(gate(upd({ status: "snoozed" }), board([card()])).join(), /status: "snoozed" is not allowed/);
  const own = fullConfig({ nudges: { parked: ["snoozed"] }, roster: ["Manager", "Builder", "Checker"], collector: { repoPath: "/x", deployWorkflow: "CI" } });
  assert.ok(allowedFor("status", own).includes("snoozed"), "the config's parked statuses");
  assert.deepEqual(fieldProblems(card({ status: "snoozed" }), own), []);
});

// Security on b24f872: a field holding {"toString":1,"valueOf":1} made String(v) throw inside the gate, and the CLI let a throwing
// call through unchecked, every other op of the same db_write with it. The text helper never converts; the CLI refuses a throw
// on an artifact tool; the probe reads each card in its own try.
const ODD = JSON.parse('{"toString":1,"valueOf":1}');
const UUID = ["11ff6eeb", "bfd4", "4ffa", "96ed", "8a144a6b7f97"].join("-");
const BOARD_URL = "https://claude.ai/" + "artifact/TestBoard01";

test("safeText never converts a value with String(): an object that cannot be converted, a cycle and a symbol-less list read as text", () => {
  assert.throws(() => String(ODD), "the shape really throws");
  assert.equal(safeText(ODD), '{"toString":1,"valueOf":1}');
  assert.equal(safeText("x".repeat(100)).length, 40);
  assert.equal(safeText(undefined), "undefined");
  const cyc = {}; cyc.self = cyc;
  assert.equal(safeText(cyc), "object");
  assert.equal(safeText(null), "null");
});

test("an object in a typed field is refused as text-not-object, never thrown on, for every typed field and a step's fields", () => {
  for (const f of ["phase", "status", "who", "size", "level", "wait", "kind"]) {
    let errs;
    assert.doesNotThrow(() => { errs = gate(upd({ [f]: ODD }), board([card()])); }, f);
    assert.ok(errs.length >= 1, `${f}: refused`);
    assert.match(errs.join(), new RegExp(`${f === "phase" ? "unknown phase" : `${f}: must be text, not an object`}`), f);
    assert.deepEqual(codes(fieldProblems({ ...card(), [f]: ODD }, config)).filter((c) => c.endsWith(`:${f}`)).length, 1, `${f}: one problem in the list`);
  }
  for (const f of ["phase", "kind", "init", "who", "at"]) {
    assert.doesNotThrow(() => writeErrors({ op: "set", collection: "steps", doc_id: "s1", data: { id: "s1", init: "menu", phase: "build", kind: "start", who: "Builder", at: NOW - HOUR, [f]: ODD } }, { config, who, now: NOW }), `step ${f}`);
  }
  assert.doesNotThrow(() => writeErrors({ op: "set", collection: "waiting", doc_id: "w", data: { kind: ODD, text: ODD, updatedAt: NOW } }, { config, who, now: NOW }), "a waiting item");
  assert.doesNotThrow(() => gate(upd({ status: "dropped", dropReason: ODD }), board([card()])), "dropReason");
  assert.doesNotThrow(() => writeErrors({ op: "set", collection: "waiting", doc_id: "w", data: { kind: "decision", text: ODD, options: [{ key: "a", label: "A" }, { key: "b", label: "B" }], updatedAt: NOW } }, { config, who, now: NOW }), "a decision's text");
  assert.doesNotThrow(() => cardProblems(card({ num: ODD, phase: "checker" }), { steps: [], config }), "a card number that is an object");
});

test("the gate's CLI refuses an object in each typed field (exit 2), and refuses a call it cannot check on an artifact tool", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "fb-inv-"));
  const cfgFile = join(dir, "board.config.json");
  writeFileSync(cfgFile, JSON.stringify({ artifactUrl: BOARD_URL, artifactSlug: UUID, owner: "Sam", roster: ["Manager", "Builder"], gate: { stateDir: dir } }));
  const cli = (input, role = "Builder") => spawnSync("node", ["--max-old-space-size=512", new URL("../gate/gate.mjs", import.meta.url).pathname, "--config", cfgFile], { input: JSON.stringify(input), encoding: "utf8", timeout: 20000, env: { ...process.env, FLIGHT_BOARD_ROLE: role } });
  const dbWrite = (ops, slug = UUID) => ({ tool_name: "mcp__claude-artifacts__db_write", tool_input: { slug, ops } });
  for (const f of ["phase", "status", "who", "size", "level", "wait", "kind"]) {
    const r = cli(dbWrite([{ op: "update", path: "initiatives/menu", data: { updatedAt: Date.now() - 4321, [f]: ODD } }]));
    assert.equal(r.status, 2, `${f}: ${r.stderr}`);
  }
  // Shapes that still make a rule throw (an object where the gate reads text in an op, a message or an ask): fail closed on an
  // artifact tool, open on anything else, and an unrelated op in the same call is not let through with it.
  for (const ops of [
    [{ op: ODD, path: "initiatives/x", data: { name: "n" } }],
    [{ op: "set", path: "messages/m1", data: { text: ODD, thread: ODD, from: ODD, to: ODD, at: 1 } }],
    [{ op: "set", path: "waiting/w1", data: { text: ODD, title: ODD, kind: "decision", options: ODD, initiative: ODD } }],
    [{ op: "set", path: "threads/t1", data: { num: 1, title: "ok" } }, { op: ODD, path: "initiatives/x", data: { name: "n" } }],
  ]) {
    const thrown = cli(dbWrite(ops));
    assert.equal(thrown.status, 2, thrown.stderr);
    assert.match(thrown.stderr, /could not check it|refused|Flight board/);
    // The same call under another server's name (normName reads it as the board's tool): fail closed too (Security).
    const renamed = cli({ ...dbWrite(ops), tool_name: "mcp__other-artifacts__db_write" });
    assert.equal(renamed.status, 2, `renamed: ${renamed.stderr}`);
  }
  assert.equal(cli({ tool_name: "mcp__other-artifacts__list_things", tool_input: { slug: ODD } }).status, 0, "an unrelated tool of another server still passes when unreadable");
  const other = cli({ tool_name: { toString: 1 }, tool_input: { slug: ODD } });
  assert.equal(other.status, 0, "a call that is not on an artifact tool still passes when unreadable");
  assert.equal(cli({ tool_name: "Bash", tool_input: { command: "ls" } }).status, 0);
});

test("the probe reads each open card in its own try: one card with an object field is a red line, the others are still read", () => {
  const cards = [card({ id: "odd", num: 660, status: ODD }), card({ id: "fine", num: 661, phase: "checker" })];
  const git = () => "";
  let out;
  assert.doesNotThrow(() => { out = collect({ config, cards, git, gh: () => "[]", now: NOW, steps: [] }).doc; });
  assert.match((out.cards.odd.red ?? []).join(), /status: must be text, not an object/);
  assert.match((out.cards.fine.red ?? []).join(), /#C661 is on checker/, "the next card is still read");
  // A card whose rules throw anyway (a getter that does): its own red line, and the run goes on.
  const boom = card({ id: "boom", num: 662 });
  Object.defineProperty(boom, "phase", { enumerable: true, get() { throw new Error("unreadable"); } });
  assert.doesNotThrow(() => { out = collect({ config, cards: [boom, card({ id: "fine", num: 661, phase: "checker" })], git, gh: () => "[]", now: NOW, steps: [] }).doc; });
  assert.match((out.cards.boom?.red ?? []).join(), /cannot read/, "its own red line");
  assert.match((out.cards.fine.red ?? []).join(), /#C661/, "the others are still read");
});

test("a memory reading's numbers are numbers: an object in pct, tokens or at is refused in ctx/<Role> and in meta/context", () => {
  const ctx = (data, op = "set", id = "Builder") => writeErrors({ op, collection: "ctx", doc_id: id, data }, { config, who, now: NOW });
  assert.deepEqual(ctx({ pct: 24, tokens: 235548, at: NOW }), [], "a good reading");
  assert.deepEqual(ctx({ pct: 24, at: NOW }), [], "tokens are optional");
  assert.deepEqual(ctx({ pct: 24, tokens: null, at: NOW }), [], "a null token count is a reading without it");
  for (const [bad, re] of [[{ pct: ODD, at: NOW }, /pct is a whole number/], [{ pct: 24.5, at: NOW }, /pct is a whole/], [{ pct: 101, at: NOW }, /pct is a whole/], [{ pct: 5, tokens: ODD, at: NOW }, /tokens is a whole/], [{ pct: 5, tokens: -1, at: NOW }, /tokens is a whole/], [{ pct: 5, at: ODD }, /at is a time/], [{ pct: "5", at: NOW }, /pct is a whole/]]) {
    let errs;
    assert.doesNotThrow(() => { errs = ctx(bad); }, JSON.stringify(bad));
    assert.match(errs.join(), re, JSON.stringify(bad));
    assert.match(ctx(bad, "update").join(), re, "update too");
  }
  const meta = (agents) => writeErrors({ op: "update", collection: "meta", doc_id: "context", data: { agents } }, { config, who, now: NOW });
  assert.deepEqual(meta({ Builder: { pct: 3, tokens: 10, at: NOW } }), []);
  assert.match(meta({ Builder: { pct: ODD, at: NOW } }).join(), /meta\/context agents\.Builder: pct is a whole/);
});

test("the gate's CLI refuses an object pct in a memory tile (exit 2)", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "fb-inv-"));
  const cfgFile = join(dir, "board.config.json");
  writeFileSync(cfgFile, JSON.stringify({ artifactUrl: BOARD_URL, artifactSlug: UUID, owner: "Sam", roster: ["Manager", "Builder"], gate: { stateDir: dir } }));
  const call = (data) => ({ tool_name: "mcp__claude-artifacts__db_write", tool_input: { slug: UUID, ops: [{ op: "set", path: "ctx/Builder", data }] } });
  const cli = (input) => spawnSync("node", ["--max-old-space-size=512", new URL("../gate/gate.mjs", import.meta.url).pathname, "--config", cfgFile], { input: JSON.stringify(input), encoding: "utf8", timeout: 20000, env: { ...process.env, FLIGHT_BOARD_ROLE: "Builder" } });
  assert.equal(cli(call({ pct: ODD, at: Date.now() - 4321 })).status, 2);
  assert.equal(cli(call({ pct: 12, tokens: 1234, at: Date.now() - 4321 })).status, 0, "a good reading passes");
});

test("cardProblems is the one list: fields first, then the steps", () => {
  assert.deepEqual(codes(cardProblems(card({ size: "XXL", status: "queued" }), { steps: [step()], config })), ["value:size", "queued-step"]);
});
