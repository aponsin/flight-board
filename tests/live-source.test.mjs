// The dashboard as it is reads the live state (board-state-probe's follow-up, the Director with the owner): the "Right
// now" panel is gone; every place the page shows stage (phase lights, the sub-step, waits, ETA, needs-you counts, the
// agent tiles) reads the live state first while its reading is under 3 min old, and the Collector's derived/all and the
// steps otherwise. Only the header stamp says which: "live · 40 s" or "from 14:02".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames, step } from "./harness.mjs";

const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const NOW = Date.now(), MIN = 60e3, HEAD = "a1b2c3d4e5f6" + "0".repeat(28);
const reading = (at, extra = {}) => ({
  v: 1, board: { boardId: "TestBoard42xyz", at, probe: null, pageVersion: null },
  cards: { "live-card": { num: 9, phase: "checker", headSha12: HEAD.slice(0, 12), signed: [], onMain: false, ci: "none", ciMin: null, liveVersion: null, at }, ...extra.cards },
  agents: { Checker: { state: "working", lastActivityAt: at, tool: "Bash", card: "live-card", since: at - 4 * MIN }, ...extra.agents },
});
function board({ live = null, derived = { phase: "build", head: HEAD, readyAt: NOW - 30 * MIN, waitingFor: ["checker", "security"], at: NOW - 40 * MIN } } = {}) {
  const b = loadNames(["derivedOf", "liveCard", "liveAgent", "liveSubstep", "agentOn", "stampText", "probeEvent", "enrich", "crewHtml", "renderAll"]);
  Object.assign(b.state, {
    initRaw: [], steps: [], waiting: [], todo: [], ideas: [], events: [], meta: [], ctx: [], messages: [], threads: [], plan: [], timings: [],
    derived: [{ id: "all", at: NOW - 40 * MIN, cards: { "live-card": derived } }],
    initiatives: [{ id: "live-card", num: 9, name: "A live card", status: "active", phase: "build", size: "S", who: "Boardsmith" }],
  });
  if (live) b.probeEvent({ type: "data", result: { payload: live } }, {});
  return b;
}

test("the Right now panel is gone: no section, no renderer; the connector's one watch and one call stay", () => {
  assert.doesNotMatch(html, /id="probe"|Right now <|probeHtml|renderProbe/);
  assert.equal([...html.matchAll(/watchTool\(|callTool\(/g)].length, 2);
});

test("a fresh live reading gives a card its phase and time; the db's other fields stay", () => {
  const b = board({ live: reading(NOW - 40e3) });
  const d = b.derivedOf("live-card");
  assert.deepEqual([d.phase, d.at, d.live, d.readyAt, d.waitingFor.join()], ["checker", NOW - 40e3, true, NOW - 30 * MIN, "checker,security"]);
  assert.equal(b.enrich(b.state.initiatives[0]).phase, "checker", "the phase lights read it (byEvidence)");
  assert.equal(b.derivedOf("db-only"), null, "a card the live state doesn't read: the db (none here)");
});

test("the live tip moved past the collector's: its READY and reviews are of an older commit and go", () => {
  const live = reading(NOW - 40e3);
  live.cards["live-card"].headSha12 = "ffffffffffff";
  const d = board({ live }).derivedOf("live-card");
  assert.deepEqual([d.phase, d.head, d.readyAt, d.waitingFor], ["checker", undefined, undefined, undefined]);
});

test("past 3 min, without the connector, or with an odd value, the db is the source", () => {
  assert.equal(board({ live: reading(NOW - 3 * MIN - 1e3) }).derivedOf("live-card").phase, "build", "a stale reading");
  assert.equal(board().derivedOf("live-card").phase, "build", "no connector");
  for (const odd of [{ phase: "<b>" }, { phase: "nope" }, { headSha12: "xyz" }, { headSha12: null }]) {
    const live = reading(NOW - 40e3);
    Object.assign(live.cards["live-card"], odd);
    assert.equal(board({ live }).derivedOf("live-card").phase, "build", JSON.stringify(odd));
  }
  const b = board({ live: reading(NOW - 40e3) });
  b.probeEvent({ type: "error", error: { code: "needs_reauth" } }, {});
  assert.equal(b.derivedOf("live-card").phase, "build", "an auth denial takes the reading down");
});

test("the sub-step: an agent working on the card now, in its own review phase, since its turn began; else the steps", () => {
  const b = board({ live: reading(NOW - 40e3) });
  const s = b.liveSubstep("live-card");
  assert.deepEqual([s.who, s.phase, s.at, s.live], ["Checker", "checker", NOW - 40e3 - 4 * MIN, true]);
  const live = reading(NOW - 40e3, { agents: { Checker: { state: "idle", lastActivityAt: NOW - MIN, tool: null, card: "live-card", since: NOW - MIN } } });
  const c = board({ live });
  c.state.steps = [step("live-card", "build", "Boardsmith", "start", NOW - 9 * MIN)];
  assert.deepEqual([c.liveSubstep("live-card").who, c.liveSubstep("live-card").live], ["Boardsmith", undefined], "nobody working: the steps");
  const d = board();
  d.state.steps = [step("live-card", "build", "Boardsmith", "start", NOW - 9 * MIN)];
  assert.equal(d.liveSubstep("live-card").who, "Boardsmith", "no live state: the steps");
});

test("the agent tiles: working, its card; idle under 15 min, its last card; past that, Idle since hh:mm; else the db", () => {
  const idle = (ago) => ({ state: "idle", lastActivityAt: NOW - ago, tool: null, card: "live-card", since: NOW - ago });
  const b = board({ live: reading(NOW - 40e3, { agents: { Admin: idle(403 * MIN), Security: idle(403 * MIN), Builder: idle(5 * MIN) } }) });
  const db = [{ id: "other", name: "From the db" }];
  assert.equal(b.agentOn("Checker", db, "", NOW).items[0].id, "live-card");
  assert.equal(b.agentOn("Builder", db, "", NOW).items[0].id, "live-card");
  const admin = b.agentOn("Admin", db, "Away", NOW);
  assert.deepEqual([admin.items.length, /^Idle since \d\d:\d\d/.test(admin.note)], [0, true]);
  assert.equal(JSON.stringify(b.agentOn("Designer", db, "Away", NOW)), JSON.stringify({ items: db, note: "Away" }), "an agent the live state doesn't read");
  assert.equal(JSON.stringify(board().agentOn("Checker", db, "", NOW)), JSON.stringify({ items: db, note: "Idle" }), "no live state");
  const tiles = b.crewHtml(NOW);
  assert.match(tiles, /data-agent="Security"[\s\S]*?<span class="idle">Idle since \d\d:\d\d[^<]*<\/span>/);
});

test("the header stamp: 'live · 40 s' while fresh, else 'from hh:mm' (the db's reading); a lapsed connector says why", () => {
  const b = board({ live: reading(NOW - 40e3) });
  assert.match(b.stampText(NOW), /^live · (39|40|41) s$/);
  assert.match(b.stampText(NOW + 5 * MIN), /^from \d\d:\d\d/, "stale: the db's");
  assert.match(board().stampText(NOW), /^from \d\d:\d\d/);
  b.probeEvent({ type: "error", error: { code: "server_unavailable" } }, {});
  assert.match(b.stampText(NOW), /^live · /, "a passing failure keeps the last reading while it's fresh");
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { at: "x" } } } }, {});
  assert.match(b.stampText(NOW), /^live · /, "an odd payload changes nothing");
});
