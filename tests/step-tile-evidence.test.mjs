// #C655: the strip lights a build from the evidence first. A plain build start with no commit, no branch, no live agent and no
// commit on main citing the card is "start logged, no work seen": grey, no elapsed time, no STALLED, and after the probe's
// 30 minutes (derived abandonedAt) closed, the card back to "up next". Fictional board.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames, step } from "./harness.mjs";
import { collect } from "../collector/collect.mjs";
import { fullConfig } from "../scripts/config.mjs";

const MIN = 60e3;
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const NAMES = ["initRow", "enrich", "gates", "stalled", "notStarted", "checkLine"];
const card = (extra = {}) => ({ id: "x", num: 655, name: "X", size: "S", level: "Quick", skip: ["plan"], status: "active", who: "Smith", createdAt: Date.now() - 3600e3, ...extra });
function row(steps, derivedCard = null, extra = {}, now = Date.now()) {
  const b = loadNames(NAMES);
  b.state.steps = steps;
  b.state.waiting = [];
  b.state.derived = derivedCard ? [{ id: "all", at: now - MIN, cards: { x: derivedCard } }] : [];
  const c = b.gates(b.enrich(card(extra)));
  return { b, c, html: b.initRow(c) };
}

test("a lone plain build start with no work seen is grey: 'start logged HH:MM, no work seen', no name, no elapsed time", () => {
  const now = Date.now(), at = now - 12 * MIN;
  const { c, html } = row([step("x", "build", "Smith", "start", at)]);
  assert.equal(c.noWork, at);
  assert.match(html, new RegExp(`<small class="nowork">start logged ${hhmm(at).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, no work seen</small>`));
  assert.doesNotMatch(html, /<small>Smith/, "the tile does not say the agent is on it");
  assert.doesNotMatch(html, /class="step now"/, "and does not pulse as work");
});

test("any evidence of work lights it as before: a commit head, a branch, a commit on main", () => {
  const at = Date.now() - 12 * MIN;
  for (const [what, d, extra] of [["a head", { phase: "build", head: "abc1234" }, {}], ["a branch", null, { branch: "build/x" }], ["a commit on main", { phase: null, workSeen: true }, {}]]) {
    const { c, html } = row([step("x", "build", "Smith", "start", at)], d, extra);
    assert.equal(c.noWork, undefined, what);
    assert.doesNotMatch(html, /no work seen/, what);
    assert.match(html, /<small>Smith · /, `${what}: the agent and the elapsed time show`);
  }
});

test("the live state is evidence too: an agent working on the card now lights it, whatever the commits say", () => {
  const now = Date.now(), at = now - 12 * MIN;
  const b = loadNames([...NAMES, "probeEvent"]);
  b.state.steps = [step("x", "build", "Smith", "start", at)];
  b.state.waiting = [];
  b.state.derived = [];
  const reading = { v: 1, board: { boardId: "TestBoard42xyz", at: now - 5e3, probe: null, pageVersion: null }, cards: {}, agents: { Smith: { state: "working", lastActivityAt: now - 5e3, tool: "Read", card: "x", since: now - 6 * MIN } } };
  b.probeEvent({ type: "data", result: { payload: reading } }, {});
  const c = b.gates(b.enrich(card()));
  assert.equal(c.noWork, undefined);
  assert.doesNotMatch(b.initRow(c), /no work seen/);
});

test("not STALLED while it is a start and nothing more; a start with work behind it still stalls after 30 minutes", () => {
  const at = Date.now() - 45 * MIN;
  const lone = row([step("x", "build", "Smith", "start", at)]);
  assert.equal(lone.b.stalled(lone.c), 0);
  assert.doesNotMatch(lone.html, /Stalled/);
  const worked = row([step("x", "build", "Smith", "start", at)], { phase: "build", head: "abc1234" });
  assert.ok(worked.b.stalled(worked.c) >= 30, "work seen: the old rule");
});

test("a start the probe closed as abandoned is not a finished build: the card is up next, grey, and review is not lit", () => {
  const now = Date.now(), at = now - 50 * MIN;
  const { c, html } = row([step("x", "build", "Smith", "start", at)], { phase: null, abandonedAt: at + 30 * MIN });
  assert.equal(c.phase, "build");
  assert.ok(c.phaseLog.some((e) => e.phase === "build" && e.abandoned && e.end === at + 30 * MIN));
  assert.equal(c.noWork, at);
  assert.match(html, /start logged .*, no work seen/);
  assert.doesNotMatch(html, /class="step now"/);
  const after = row([step("x", "build", "Smith", "start", at), step("x", "build", "Smith", "start", now - 5 * MIN)], { phase: null, abandonedAt: at + 30 * MIN });
  assert.match(after.html, /start logged/, "a newer start after the close is its own start with nothing behind it yet");
});

test("a busy start is still queued, with the queue label, not 'start logged'", () => {
  const { c, html } = row([step("x", "build", "Smith", "start", Date.now() - 12 * MIN, { wait: "busy" })], null, { queuePos: 2 });
  assert.equal(c.noWork, undefined);
  assert.doesNotMatch(html, /no work seen/);
});

test("the Check line no longer says the Collector run is late", () => {
  const now = Date.now(), b = loadNames(NAMES);
  b.state.derived = [{ id: "all", at: now - 70 * MIN, cards: { x: { at: now - 70 * MIN, phase: "build" } } }];
  assert.equal(b.checkLine({ id: "x", status: "active" }, { at: now - 5 * MIN }, now), "No live state");
  b.state.derived = [{ id: "all", at: now - 20 * MIN, cards: { x: { at: now - 20 * MIN, phase: "build" } } }];
  assert.match(b.checkLine({ id: "x", status: "active" }, { at: now - 5 * MIN }, now), /^No live state · Collector next /);
});

test("the probe: a commit on main starting '#C<num>:' is work seen for a card with no branch; one for another number is not", () => {
  const config = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01" });
  const now = 1_792_998_566_221;
  const git = (args) => (args[0] === "log" && args.some((a) => /--first-parent/.test(a)) ? ["a".repeat(40), String(Math.floor(now / 1000)), "#C655: the tile"].join("\x1f") : "");
  const cards = [{ id: "x", num: 655, status: "active" }, { id: "y", num: 656, status: "active" }];
  const { doc } = collect({ config, cards, git, gh: () => "[]", now });
  assert.equal(doc.cards.x.workSeen, true);
  assert.equal(doc.cards.y.workSeen, undefined);
  const steps = cards.map((k) => step(k.id, "build", "Smith", "start", now - 50 * MIN));
  const again = collect({ config, cards, git, gh: () => "[]", now, steps }).doc.cards;
  assert.equal(again.x.abandonedAt, undefined, "work seen on main: its start is not abandoned");
  assert.equal(again.y.abandonedAt, now - 50 * MIN + 30 * MIN);
});
