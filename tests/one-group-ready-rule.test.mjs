// #C1391 (the one "group ready" rule, option A: a paused or blocked card holds its group): docs/DATA.d/one-group-ready-rule.md. One function says a card's stage and a group's stage
// (worker/group-rule.mjs) and the five readers of "is this group ready?" ask it: the reading's group wait, the dispatch (openGroupWithheld), stack-ready (through the queue file's `stage`),
// and the landing's two answers (land-holds.json). This file holds: the stage of each kind of card, the fold law, one table over every member state read by every caller, the three bugs
// the old five rules disagreed on, the three kinds of rework, the shape of land-holds.json, and that the old rules are gone.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stageOf, stageRank, STAGES, groupStage, groupWaitsFor, reworkKind, ownerRework } from "../worker/group-rule.mjs";
import { openGroupWithheld, isRework } from "../worker/board-rules.mjs";
import { stackQueueFile, landHoldsFile } from "../collector/store-dispatch.mjs";
import { stackReady } from "../scripts/stack-ready.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-11-20T12:00:00Z");
const H = (n) => ({ headSha12: String(n).repeat(12).slice(0, 12), headSha: String(n).repeat(40).slice(0, 40) });

// Evidence of each stage and of each way to be below `built`.
const EV = {
  nothing: undefined,
  start: { ...H(1), phase: "build", lit: ["build"], wipHead: true },
  noReady: { ...H(2), phase: "build", lit: ["build"], stackHold: true },
  atBuild: { ...H(3), phase: "build", lit: ["build"] },
  sentBack: { ...H(4), phase: "checker", lit: ["checker"], findings: ["checker"] },
  built: { ...H(5), phase: "checker", lit: ["checker"] },
  signed: { ...H(6), phase: "ship", lit: ["ship"], signed: ["checker", "security"] },
  landed: { ...H(7), phase: "ship", lit: ["ship"], onMain: true },
  live: { ...H(8), phase: "live", lit: ["live"], onMain: true },
};
const STAGE_OF = { nothing: "unbuilt", start: "unbuilt", noReady: "unbuilt", atBuild: "unbuilt", sentBack: "unbuilt", built: "built", signed: "signed", landed: "landed", live: "live" };
const card = (id, extra = {}) => ({ id, num: Number(id.replace(/\D/g, "")) || null, owner_role: "Builder", paused: 0, dropped: 0, done_at: null, batch: "sample-group", repo: "flight-board", ...extra });

test("a card's stage: nothing pushed, a start push, no READY, a reading at build and a card sent back are unbuilt; then built, signed, landed, live", () => {
  for (const [name, stage] of Object.entries(STAGE_OF)) assert.equal(stageOf(card("sample-a"), EV[name]), stage, name);
  assert.deepEqual(STAGES, ["unbuilt", "built", "signed", "landed", "live"]);
});

test("a head that carries a waiting note (its builder ran stack-ready and was told to wait) declared READY: built, though no signal covers it yet; without the note it is unbuilt", () => {
  const c = card("sample-a");
  const held = { ...H(9), phase: "build", lit: ["build"], stackHold: true };
  assert.equal(stageOf(c, held), "unbuilt", "no signal, no waiting note: no READY yet");
  assert.equal(stageOf(c, { ...held, builtWaiting: true }), "built", "the waiting note is the READY it declared");
  assert.equal(stageOf(c, { ...held, builtWaiting: true, wipHead: true }), "unbuilt", "a start push never declared READY");
  assert.equal(stageOf(c, { ...held, builtWaiting: true, rework: true }), "unbuilt", "sent back is unbuilt whatever its notes say");
});

test("the owner's rework is unbuilt; the reviewer's `unexplained` is not rework for the stage: the card keeps its stage", () => {
  const c = card("sample-a");
  assert.equal(stageOf(c, { ...EV.built, rework: true }), "unbuilt", "a step back with no reason");
  assert.equal(stageOf({ ...c, rework_reason: "bug" }, { ...EV.built, rework: true }), "built", "reason attached: not rework any more");
  assert.equal(stageOf(c, { ...EV.built, rework: "unexplained" }), "built", "unexplained keeps its stage");
});

test("rework has three kinds: findings, reason, unexplained; a re-cut after sign-offs is none of them", () => {
  const c = card("sample-a");
  assert.equal(reworkKind(c, EV.sentBack), "findings");
  assert.equal(reworkKind(c, { ...EV.built, rework: true }), "reason");
  assert.equal(reworkKind({ ...c, rework_reason: "bug" }, { ...EV.built, rework: true }), null);
  assert.equal(reworkKind(c, { ...EV.built, rework: "unexplained" }), "unexplained");
  assert.equal(reworkKind(c, { ...EV.built, rework: "unexplained", phase: "ship", lit: ["ship"] }), null, "unexplained only from a review phase");
  assert.equal(reworkKind(c, { ...EV.built, signed: ["checker"], headSha12: "bbbbbbbbbbbb" }), null, "a new head after sign-offs alone is not rework");
  assert.equal(reworkKind(c, EV.built), null);
  // the owner's rework is findings and reason; isRework is that
  assert.equal(ownerRework(c, EV.sentBack), true);
  assert.equal(ownerRework(c, { ...EV.built, rework: "unexplained" }), false);
  assert.equal(isRework(c, { ...EV.built, rework: "unexplained" }), false);
  assert.equal(isRework(c, EV.sentBack), true);
});

test("a group's stage is the lowest stage of its counted members (fold law), a card in no group is a group of one", () => {
  const names = Object.keys(STAGE_OF);
  for (const a of names) for (const b of names) {
    const cards = [card("sample-a"), card("sample-b")];
    const ev = { "sample-a": EV[a], "sample-b": EV[b] };
    const g = groupStage(cards[0], cards, (id) => ev[id]);
    const lowest = [STAGE_OF[a], STAGE_OF[b]].sort((x, y) => stageRank(x) - stageRank(y))[0];
    assert.equal(g.stage, lowest, `${a} + ${b}`);
    assert.equal(g.ready, stageRank(lowest) >= stageRank("built"));
  }
  const alone = card("sample-z", { batch: null });
  assert.equal(groupStage(alone, [alone, card("sample-b")], () => EV.built).stage, "built");
});

test("the fold law on the recorded view: every group's stage is the lowest stageOf of its open members", () => {
  const view = JSON.parse(readFileSync(join(HERE, "fixtures/view-recorded.json"), "utf8"));
  const evidenceOf = (id) => view.evidence?.[`cards.${id}`]?.value;
  let checked = 0;
  for (const c of view.cards) {
    if (!c.batch || c.dropped || c.done_at != null) continue;
    const members = view.cards.filter((k) => k.batch === c.batch && !k.dropped && k.done_at == null);
    const g = groupStage(c, view.cards, evidenceOf);
    const known = members.filter((k) => !k.repo || !c.repo || String(k.repo).toLowerCase() === String(c.repo).toLowerCase() || [k.repo, c.repo].every((r) => /^(?:.*\/)?(?:flight-)?board(?:\.git)?$/i.test(r)));
    const lowest = known.map((k) => stageOf(k, evidenceOf(k.id))).sort((x, y) => stageRank(x) - stageRank(y))[0];
    assert.equal(g.stage, lowest, `${c.id}`);
    checked++;
  }
  assert.ok(checked > 0, "the recorded view has grouped cards");
});

// ---- one table: every member state, with each extra, read by every caller ----
const EXTRAS = {
  plain: {},
  paused: { paused: 1 },
  blocked: { blocked_reason: "waiting for a decision" },
  otherRepo: { repo: "other-product" },
  unknownRepo: { repo: "" },
};
const fakeGit = (id) => (args) => {
  const a = args.join(" ");
  if (a === "rev-parse --is-inside-work-tree") return "true\n";
  if (a === "status --porcelain") return "";
  if (args[0] === "symbolic-ref") return "build/sample-a\n";
  if (args[0] === "log" && args[1] === "-1") return `${id}\n`;
  if (a === "rev-parse HEAD") return "a".repeat(40);
  if (args[0] === "push" || args[0] === "fetch" || args[0] === "notes") return "";
  throw new Error("not in this fake");
};

test("one table: asker built, a groupmate in each state with each extra; the reading, stack-ready, the landing words and the dispatch all agree with groupStage", () => {
  for (const [state, ev] of Object.entries(EV)) for (const [extra, fields] of Object.entries(EXTRAS)) {
    const asker = card("sample-a", { batch: "sample-group" }), mate = card("sample-b", fields);
    const cards = [asker, mate];
    const evidence = { "sample-a": EV.built, "sample-b": ev };
    const evidenceOf = (id) => evidence[id];
    const label = `${state}/${extra}`;
    const counted = extra !== "otherRepo";
    const mateStage = STAGE_OF[state];
    const g = groupStage(asker, cards, evidenceOf, { except: asker.id });
    const mateBelow = counted && stageRank(mateStage) < stageRank("built");
    assert.equal(g.waitsFor.length > 0, mateBelow, `${label}: groupStage`);
    // 1. the reading's group wait
    assert.equal(groupWaitsFor(asker, EV.built, cards, evidence).length > 0, mateBelow, `${label}: the reading`);
    // 2. stack-ready, through the queue file
    const view = { cards, evidence: Object.fromEntries(Object.entries(evidence).filter(([, v]) => v).map(([id, v]) => [`cards.${id}`, { value: v }])) };
    const queue = stackQueueFile(view, NOW);
    const sr = stackReady({ run: fakeGit("sample-a"), queue, now: () => new Date(NOW).toISOString() });
    assert.equal(sr.signal, !mateBelow, `${label}: stack-ready`);
    // 3. the landing: the card's word and its peers
    const holds = landHoldsFile(view, NOW);
    const unsigned = counted && stageRank(mateStage) < stageRank("signed") && !(mate.dropped);
    const word = holds.cards["sample-a"];
    assert.equal(word, unsigned ? "group" : "", `${label}: land word`);
    const toLand = counted && stageRank(mateStage) < stageRank("landed");
    assert.deepEqual(holds.groups["sample-a"] ?? [], toLand ? ["sample-b"] : [], `${label}: land peers`);
    // 4. the dispatch: a loose card of another group is withheld while an ACTIVE unbuilt member holds the group open (a paused or blocked one is the role's other work, as today)
    const rows = [asker, { ...mate, batch: "sample-group" }, card("sample-c", { batch: "other-group" })];
    const withheld = openGroupWithheld({ now: NOW, cards: rows, evidenceOf: (id) => ({ ...evidence, "sample-c": undefined })[id], askedCards: new Set(), endPassed: () => false });
    const holds4 = mateStage === "unbuilt" && !fields.paused && !fields.blocked_reason && state !== "nothing" ? true : state === "nothing" && !fields.paused && !fields.blocked_reason ? true : false;
    // a group is started once any member is pushed; with the asker built it is, so an unbuilt active member opens it for its own role
    assert.equal(withheld({ role: "Builder", id: "sample-c", group: "other-group" }), holds4, `${label}: dispatch`);
  }
});

test("the three bugs the five rules disagreed on", () => {
  const asker = card("sample-a"), cardsOf = (mate) => [asker, mate];
  const run = (cards, evidence) => {
    const view = { cards, evidence: Object.fromEntries(Object.entries(evidence).filter(([, v]) => v).map(([id, v]) => [`cards.${id}`, { value: v }])) };
    return stackReady({ run: fakeGit("sample-a"), queue: stackQueueFile(view, NOW), now: () => new Date(NOW).toISOString() });
  };
  // (1) a groupmate with only a start push is not built for stack-ready
  assert.equal(run(cardsOf(card("sample-b")), { "sample-a": EV.built, "sample-b": EV.start }).signal, false);
  // (2) a paused groupmate holds the READY, as it holds the landing
  assert.equal(run(cardsOf(card("sample-b", { paused: 1 })), { "sample-a": EV.built, "sample-b": EV.nothing }).signal, false);
  // (3) a member sent back with findings reads unbuilt to the cards stacked on it
  assert.equal(run(cardsOf(card("sample-b")), { "sample-a": EV.built, "sample-b": EV.sentBack }).signal, false);
  assert.deepEqual(groupWaitsFor(asker, EV.built, cardsOf(card("sample-b")), { "sample-b": EV.sentBack }).map((x) => x.id), ["sample-b"]);
  // the control: the same group with the mate built signals
  assert.equal(run(cardsOf(card("sample-b")), { "sample-a": EV.built, "sample-b": EV.built }).signal, true);
});

test("an old queue file with no stage gives the waiting note, never a signal; a lone card still signals", () => {
  const queue = { at: NOW, cards: [{ id: "sample-a", owner_role: "Builder", repo: "flight-board", batch: "sample-group", started: true, dependsOn: [] }, { id: "sample-b", owner_role: "Builder", repo: "flight-board", batch: "sample-group", started: true, dependsOn: [] }] };
  const r = stackReady({ run: fakeGit("sample-a"), queue, now: () => new Date(NOW).toISOString() });
  assert.equal(r.signal, false);
  const lone = stackReady({ run: fakeGit("sample-a"), queue: { at: NOW, cards: [queue.cards[0]] }, now: () => new Date(NOW).toISOString() });
  assert.equal(lone.signal, true);
});

test("land-holds.json keeps its shape: { at, cards: { id: word }, groups: { id: [ids] } }, plain words and ids only", () => {
  const cards = [card("sample-a"), card("sample-b", { paused: 1 }), card("sample-c", { batch: null })];
  const evidence = { "cards.sample-a": { value: EV.signed }, "cards.sample-b": { value: EV.built }, "cards.sample-c": { value: EV.signed } };
  const holds = landHoldsFile({ cards, evidence, asks: [] }, NOW);
  assert.deepEqual(Object.keys(holds).sort(), ["at", "cards", "groups"]);
  assert.equal(holds.at, NOW);
  assert.deepEqual(holds.cards, { "sample-a": "group", "sample-b": "paused", "sample-c": "" });
  assert.deepEqual(holds.groups, { "sample-a": ["sample-b"], "sample-b": ["sample-a"] });
  for (const w of Object.values(holds.cards)) assert.match(w, /^[a-z_]*$/);
});

// ---- the old rules are gone, and nothing else decides about a group ----
const read = (p) => readFileSync(join(HERE, "..", p), "utf8");
test("the five old group-ready rules are deleted and the callers import the one module", () => {
  const files = ["worker/board-rules.mjs", "worker/reading.mjs", "collector/store-dispatch.mjs", "scripts/stack-ready.mjs", "worker/group-rule.mjs"];
  for (const f of files) {
    const src = read(f);
    assert.doesNotMatch(src, /\bgroupWaits\b(?!For)/, `${f}: groupWaits`);
    assert.doesNotMatch(src, /\bsignedOrLanded\b|\blandedOnMain\b|\bREVIEW_NOTE_PHASES\b/, `${f}: the landing's own signed/landed readings`);
  }
  assert.match(read("collector/store-dispatch.mjs"), /from "\.\.\/worker\/group-rule\.mjs"/);
  assert.match(read("worker/board-rules.mjs"), /from "\.\/group-rule\.mjs"/);
  assert.match(read("worker/reading.mjs"), /from "\.\/group-rule\.mjs"/);
  assert.match(read("scripts/stack-ready.mjs"), /from "\.\.\/worker\/group-rule\.mjs"/);
  assert.doesNotMatch(read("worker/group-rule.mjs"), /^\s*import\s/m, "the rule imports nothing");
  // stack-ready's group wait reads a groupmate's stage, not its start push or its pause
  assert.doesNotMatch(read("scripts/stack-ready.mjs"), /k\.held !== true/);
});

test("board-land.mjs and its import closure are untouched by this card", () => {
  const src = read("scripts/board-land.mjs");
  assert.doesNotMatch(src, /group-rule/, "the owner's pinned landing script does not import the rule: it only reads land-holds.json");
});
