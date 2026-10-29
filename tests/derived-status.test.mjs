// A card's status is derived from the live state, never typed (#C449, derived-status): while the reading is fresh, a card
// whose branch has a commit beyond main, or whose agent is working on it, is building (badge, tile, the queued line and
// "never started" all follow); the typed status counts only when the reading is stale. The gate refuses status
// "queued" on a card the live state shows building. Fictional board.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fullConfig } from "../scripts/config.mjs";
import { checkWrites } from "../gate/rules.mjs";
import { run } from "../gate/gate.mjs";
import { buildingNow, liveFresh, typedClashes } from "../collector/state-schema.mjs";
import { nudges } from "../collector/nudges.mjs";
import { readLiveState, runNudges } from "../collector/collect.mjs";
import { loadNames } from "./harness.mjs";

const NOW = Date.now(), MIN = 60e3, ID = "our-work-editor";
const reading = (at, { card = {}, agent = {} } = {}) => ({
  v: 1, board: { boardId: "TestBoard42xyz", at, probe: null, pageVersion: null },
  cards: { [ID]: { num: 48, phase: "build", headSha12: "a1b2c3d4e5f6", signed: [], onMain: false, ci: "passed", ciMin: 4, liveVersion: null, at, ...card } },
  agents: { Builder: { state: "working", lastActivityAt: at, tool: "Bash", card: ID, since: at - 11 * MIN, ...agent } },
});
// the owner's 21:32Z case: the db says queued, created 26 min ago, no step logged; the live state has the branch and Builder on it.
const typed = { id: ID, num: 48, name: "Our work editor", status: "queued", phase: "build", size: "S", who: "Builder", createdAt: NOW - 26 * MIN, level: "Quick", nextNote: "build", nextNoteAt: NOW - 20 * MIN, etaLive: NOW + 3 * 3600e3 };
function board(live, card = typed) {
  const b = loadNames(["enrich", "initRow", "probeEvent", "renderCrew", "liveBuilding", "typedClashes", "stalled"]);
  Object.assign(b.state, { initRaw: [card], steps: [], waiting: [], todo: [], ideas: [], events: [], meta: [], ctx: [], messages: [], threads: [], plan: [], timings: [], derived: [{ id: "all", at: NOW - 40 * MIN, cards: {} }] });
  if (live) b.probeEvent({ type: "data", result: { payload: live } }, {});
  b.state.initiatives = b.state.initRaw.map(b.enrich);
  return b;
}
const badge = (html) => /<span class="state [^"]*">([^<]*)<\/span>/.exec(html)[1];

test("the owner's case: queued in the db, a branch with commits and Builder on it: Building, no queued line, no 'never started'", () => {
  const b = board(reading(NOW - 30e3));
  const i = b.state.initiatives[0], html = b.initRow(i);
  assert.equal(i.status, "active");
  assert.equal(badge(html), "Building");
  assert.doesNotMatch(html, /Queued \d|never started|queued · Builder/);
  b.renderCrew();
  assert.match(b.els.crew.innerHTML, /<span class="ci active">Our work editor<\/span>/, "the tile: no ⧗");
});

// The whole card, as the board draws it: the words a person reads. Its class names are code, and the source's hover is
// where the typed value is meant to show (#C450: disagreements in a hover, not inline).
const words = (html) => html.replace(/ title="[^"]*"/g, "").replace(/ class="[^"]*"/g, "");
test("no typed field outranks the live state: the owner's case reads neither 'queued' nor 'never started' anywhere on the card", () => {
  const b = board(reading(NOW - 30e3));
  const html = b.initRow(b.state.initiatives[0]);
  assert.doesNotMatch(words(html), /queued|never started/i);
  assert.match(html, /<button type="button" class="evidence differs" data-evdiff="our-work-editor" aria-expanded="false" title="typed: queued">Live: Build<\/button>/, "the typed value, in the source's hover");
  const stale = board(reading(NOW - 4 * MIN)), was = stale.initRow(stale.state.initiatives[0]);
  assert.match(words(was), /queued/i, "a stale reading: the typed status shows as before");
  assert.doesNotMatch(was, /typed: /, "and no typed line");
});

test("who, waiting on, phase: the live value shows, the typed one in the note; Stalled and an old Next line follow the agent", () => {
  const b = board(reading(NOW - 30e3, { agent: {} }), { ...typed, status: "active", who: "Designer", waitingOn: "Checker's word", phase: "plan", lastStepAt: NOW - 50 * MIN, nextNoteAt: NOW - 15 * MIN });
  const i = b.state.initiatives[0], html = b.initRow(i);
  assert.equal(i.who, "Builder", "who: the agent on it");
  assert.equal(i.waitingOn, null, "a typed wait while it builds is hidden");
  assert.match(html, /title="typed: phase plan · typed: who Designer · typed: waiting on Checker&#39;s word">Live: Build</, "each typed value once, in the hover (the steps' plan is the typed one)");
  assert.doesNotMatch(words(html), /Waiting on <b>Checker|Designer/);
  assert.equal(b.stalled(i), 0, "an agent on it now: not stalled, whatever the steps");
  assert.match(html, /an agent has moved since/, "Builder working since after the Next line: it fades");
  assert.doesNotMatch(html, /up next/, "Builder on it now: the Build box isn't 'up next' (the 390 shot)");
  assert.match(html, /<div class="step now"[^>]*>Build<small>Builder/, "it names Builder");
  const same = board(reading(NOW - 30e3), { ...typed, status: "active", who: "Designer" });
  assert.equal(same.state.initiatives[0].who, "Builder", "the typed phase is the live one: who still follows the agent on it");
  const lead = board(reading(NOW - 30e3, { agent: {} }), { ...typed, status: "active", who: "Builder" });
  lead.probeEvent({ type: "data", result: { payload: { ...reading(NOW - 30e3), agents: { Manager: { state: "working", lastActivityAt: NOW, tool: "Bash", card: ID, since: NOW - MIN } } } } }, {});
  assert.equal(lead.typedClashes({ ...typed, status: "active" }).length, 0, "the lead reading a card is no one else on it");
});

// The Collector's nudge 8: the card and the field, after 5 min, never the typed value.
test("the Collector tells the lead of a typed field the live state contradicts for 5 min, card and field only", () => {
  const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x" } });
  const docs = { initiatives: [{ ...typed, waitingOn: "a secret-ish note" }], steps: [], waiting: [], messages: [], ctx: [] };
  const run1 = nudges({ config: cfg, docs, now: NOW, live: reading(NOW) });
  assert.deepEqual(run1.lines.filter((l) => /typed/.test(l)), [], "just seen: a write's lag is no clash");
  const run2 = nudges({ config: cfg, docs, now: NOW + 6 * MIN, state: run1.state, live: reading(NOW + 6 * MIN) });
  const lines = run2.lines.filter((l) => /typed/.test(l));
  assert.deepEqual(lines, [
    `NUDGE ${ID} (#C48): its typed status disagrees with the live state for 6 min; the board shows the live one, so fix or clear the typed one`,
    `NUDGE ${ID} (#C48): its typed waitingOn disagrees with the live state for 6 min; the board shows the live one, so fix or clear the typed one`,
  ]);
  assert.doesNotMatch(lines.join(), /secret-ish/);
  const gap = nudges({ config: cfg, docs, now: NOW + 3 * MIN, state: run1.state, live: null });
  assert.equal(gap.state.typedSeen[`${ID}:status`], NOW, "no reading this run: the clock waits");
  const fixed = nudges({ config: cfg, docs: { ...docs, initiatives: [{ ...typed, status: "active" }] }, now: NOW + 7 * MIN, state: run2.state, live: reading(NOW + 7 * MIN) });
  assert.equal(Object.hasOwn(fixed.state.typedSeen, `${ID}:status`), false, "fixed: forgotten, so it can come back");
  const phaseOnly = { ...docs, initiatives: [{ ...typed, status: "active", phase: "plan" }] };
  const p1 = nudges({ config: cfg, docs: phaseOnly, now: NOW, live: reading(NOW) });
  assert.deepEqual(nudges({ config: cfg, docs: phaseOnly, now: NOW + 6 * MIN, state: p1.state, live: reading(NOW + 6 * MIN) }).lines.filter((l) => /typed/.test(l)), [], "a phase clash alone: the CONFLICT line says it, no nudge 8 (Checker)");
  assert.deepEqual(nudges({ config: cfg, docs: { ...docs, initiatives: [{ ...typed, status: "done", waitingOn: "x" }] }, now: NOW + 6 * MIN, state: run1.state, live: reading(NOW + 6 * MIN) }).lines.filter((l) => /typed/.test(l)), [], "a closed card");
  // Wired: the run reads it from the reading the Collector passes, its clocks in nudges.json.
  const dir = mkdtempSync(join(tmpdir(), "fb-nudge8-"));
  try {
    runNudges(dir, cfg, docs, NOW, new Set(), {}, {}, reading(NOW));
    assert.equal(runNudges(dir, cfg, docs, NOW + 6 * MIN, new Set(), {}, {}, reading(NOW + 6 * MIN)).filter((l) => /typed/.test(l)).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no clash where nothing contradicts: a wait on a card not building; the lead on a card", () => {
  const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x" } });
  const idle = reading(NOW - 30e3, { card: { headSha12: null }, agent: { card: "other-card" } }), card = { ...typed, status: "active", waitingOn: "Checker's word" };
  assert.deepEqual(typedClashes(card, idle, cfg), [], "the Collector's rule");
  assert.equal(board(idle, card).typedClashes(card).length, 0, "the page's");
  assert.equal(board(idle, card).initRow(board(idle, card).state.initiatives[0]).includes("Waiting on <b>Checker"), true, "the wait shows");
  const lead = { ...reading(NOW - 30e3), agents: { Manager: { state: "working", lastActivityAt: NOW, tool: "Bash", card: ID, since: NOW - MIN } } };
  assert.deepEqual(typedClashes({ ...typed, status: "active" }, lead, cfg), [], "the lead reading a card is no one else on it");
});

test("the page's typedClashes is state-schema.mjs's, case by case", () => {
  const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x" } });
  const cases = [
    [typed, reading(NOW - 30e3)],
    [{ ...typed, status: "active" }, reading(NOW - 30e3)],
    [{ ...typed, phase: "plan", who: "Designer", waitingOn: "x" }, reading(NOW - 30e3)],
    [{ ...typed, phase: "checker", who: "Designer", waitingOn: "x" }, reading(NOW - 30e3, { card: { phase: "checker" } })],
    [typed, reading(NOW - 30e3, { card: { headSha12: null }, agent: { state: "idle" } })],
    [{ ...typed, who: "Designer" }, reading(NOW - 30e3, { card: { headSha12: null } })],
    [typed, reading(NOW - 30e3, { card: { onMain: true, phase: "ship" }, agent: { state: "idle" } })],
  ];
  for (const [card, live] of cases) {
    const b = board(live, card);
    assert.deepEqual(JSON.parse(JSON.stringify(b.typedClashes(card))), typedClashes(card, live, cfg), JSON.stringify(card) + JSON.stringify(live.cards));
  }
});

test("either sign alone is enough: the branch, or the agent", () => {
  const branchOnly = board(reading(NOW - 30e3, { agent: { state: "idle", card: null } }));
  assert.equal(badge(branchOnly.initRow(branchOnly.state.initiatives[0])), "Building", "the branch alone");
  const agentOnly = board(reading(NOW - 30e3, { card: { headSha12: null } }));
  assert.equal(badge(agentOnly.initRow(agentOnly.state.initiatives[0])), "Building", "the agent alone");
});

test("no branch beyond main and no agent on it: queued as typed; a stale reading falls back to the typed status", () => {
  for (const [why, live] of [
    ["neither", reading(NOW - 30e3, { card: { headSha12: null }, agent: { card: "other-card" } })],
    ["on main, agent idle", reading(NOW - 30e3, { card: { onMain: true }, agent: { state: "idle" } })],
    ["stale", reading(NOW - 4 * MIN)],
    ["no reading", null],
  ]) {
    const b = board(live), html = b.initRow(b.state.initiatives[0]);
    assert.equal(b.state.initiatives[0].status, "queued", why);
    assert.equal(badge(html), "Queued", why);
    assert.match(html, /Queued 26 min/, why);
    assert.match(html, /never started/, why);
  }
});

// The gate: the same rule, on the live state's file beside the mirror.
const config = fullConfig({ owner: "Sam", collector: { repoPath: "/x" } });
const lead = { role: "Manager", manager: true };
const upd = (data) => ({ op: "update", collection: "initiatives", doc_id: ID, data });
const refusal = (live, w = upd({ status: "queued" }), who = lead) => checkWrites([w], { config, who, now: NOW, state: {}, mirror: null, live }).errors.filter((e) => /queued/.test(e));

test("the gate refuses status queued on a card the live state shows building; else it goes", () => {
  assert.deepEqual(refusal(reading(NOW - 30e3)), [`initiatives/${ID}: status: the live state shows ${ID} building (its branch has commits beyond main, or an agent is on it); its status is derived, not queued`]);
  assert.equal(refusal(reading(NOW - 30e3), { op: "set", collection: "initiatives", doc_id: ID, data: { ...typed } }).length, 1, "a set too");
  assert.deepEqual(refusal(reading(NOW - 30e3), upd({ status: "active" })), []);
  assert.deepEqual(refusal(reading(NOW - 30e3, { card: { headSha12: null }, agent: { card: null } })), [], "nothing building");
  assert.deepEqual(refusal(null), [], "no fresh live state: the typed status");
});

test("the gate reads <stateDir>/<board>/state.json, only while fresh", () => {
  const root = mkdtempSync(join(tmpdir(), "fb-derived-status-"));
  try {
    const URL_ = "https://claude.ai/" + "artifact/TestBoard01", dir = join(root, "TestBoard01");
    const cfg = fullConfig({ artifactUrl: URL_, gate: { stateDir: root } });
    mkdirSync(dir, { recursive: true });
    const transcript = join(root, "t.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "custom-title", customTitle: "Manager" }) + "\n");
    const call = { tool_name: "ArtifactData", transcript_path: transcript, tool_input: { url: URL_, action: "update", collection: "initiatives", doc_id: ID, data: { status: "queued" } } };
    writeFileSync(join(dir, "state.json"), JSON.stringify(reading(NOW - 30e3)));
    assert.match(run(call, { config: cfg, env: {}, now: NOW }).block ?? "", /its status is derived, not queued/);
    writeFileSync(join(dir, "state.json"), JSON.stringify(reading(NOW - 4 * MIN)));
    assert.doesNotMatch(run(call, { config: cfg, env: {}, now: NOW }).block ?? "", /derived, not queued/, "a stale one counts as none");
    writeFileSync(join(dir, "state.json"), "{not json");
    assert.doesNotMatch(run(call, { config: cfg, env: {}, now: NOW }).block ?? "", /derived, not queued/, "an unreadable one counts as none");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the shared rule: buildingNow and liveFresh, and the collector's reader uses the same freshness", () => {
  const s = reading(NOW - 30e3);
  assert.equal(buildingNow(s, ID), true);
  assert.equal(buildingNow(reading(NOW, { agent: { card: null } }), ID), true, "the branch");
  assert.equal(buildingNow(reading(NOW, { card: { headSha12: null } }), ID), true, "the agent");
  assert.equal(buildingNow(reading(NOW, { card: { onMain: true }, agent: { state: "idle" } }), ID), false, "on main, nobody on it");
  assert.equal(buildingNow(s, "toString"), false, "an inherited key is no card");
  assert.equal(buildingNow(null, ID), false);
  assert.equal(liveFresh(s, NOW), true);
  assert.equal(liveFresh(reading(NOW - 3 * MIN), NOW), false, "3 min: stale");
  assert.equal(liveFresh(reading(NOW + 2 * MIN), NOW), false, "from the future");
  assert.equal(liveFresh({ ...s, extra: 1 }, NOW), false, "off the schema");
  const root = mkdtempSync(join(tmpdir(), "fb-live-read-"));
  try {
    writeFileSync(join(root, "state.json"), JSON.stringify(reading(NOW - 4 * MIN)));
    assert.equal(readLiveState(root, NOW), null);
    writeFileSync(join(root, "state.json"), JSON.stringify(s));
    assert.deepEqual(readLiveState(root, NOW), s);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
