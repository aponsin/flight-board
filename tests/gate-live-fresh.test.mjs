// A card is closed on the freshest reading (#C567): the live state's (every minute) outranks the Collector's export (a run
// old), which lagged a deploy and refused a card that was live. Fictional repo.
import test from "node:test";
import assert from "node:assert/strict";
import { fullConfig } from "../scripts/config.mjs";
import { liveCard } from "../collector/state-schema.mjs";
import { mirrorErrors, checkWrites } from "../gate/rules.mjs";

const config = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: { language: "refs/notes/linguist", checker: "refs/notes/checker", security: "refs/notes/security" }, deployWorkflow: "CI" } });
const mirror = (phase) => ({ docs: { initiatives: [{ id: "tabs", status: "active", phase: "ship", who: "Release" }], waiting: [], messages: [], derived: [{ id: "all", cards: { tabs: { phase, evidence: "aaaaaaaa is on main, not deployed yet" } } }] } });
const done = { op: "update", collection: "initiatives", doc_id: "tabs", data: { status: "done", doneAt: 1 } };
const state = (card) => ({ cards: { tabs: card }, agents: {} });
const at = { headSha12: "aaaaaaaa1111", onMain: true };

test("a fresh live reading of live lets a card close that the export still has in ship", () => {
  assert.match(mirrorErrors(done, { config, mirror: mirror("ship") }).join(), /repository says ship, not live \(aaaaaaaa is on main, not deployed yet\)/, "no live state: the export decides, as before");
  assert.deepEqual(mirrorErrors(done, { config, mirror: mirror("ship"), live: state({ ...at, phase: "live" }) }), []);
});

test("a fresh live reading short of live refuses, whatever the export says, and says whose reading it is", () => {
  const e = mirrorErrors(done, { config, mirror: mirror("live"), live: state({ ...at, phase: "ship" }) }).join();
  assert.match(e, /repository says ship, not live \(the live state: aaaaaaaa1111 is on main\)/);
  assert.match(mirrorErrors(done, { config, mirror: mirror("live"), live: state({ headSha12: "bbbbbbbb2222", onMain: false, phase: "checker" }) }).join(), /says checker, not live \(the live state: bbbbbbbb2222 is not on main\)/);
});

test("a live state that doesn't list the card, or lists it unreadably, leaves the export to decide", () => {
  assert.match(mirrorErrors(done, { config, mirror: mirror("ship"), live: { cards: {}, agents: {} } }).join(), /not live/);
  assert.deepEqual(mirrorErrors(done, { config, mirror: mirror("live"), live: state({ ...at, phase: "nonsense" }) }), [], "a phase the config doesn't name: the export (live) decides");
  assert.match(mirrorErrors(done, { config, mirror: mirror("ship"), live: state({ headSha12: "short", phase: "live" }) }).join(), /not live/, "no head");
  assert.deepEqual(mirrorErrors(done, { config, mirror: mirror("live"), live: state({ headSha12: "short", phase: "ship" }) }), [], "no head: the export (live) decides");
  assert.equal(liveCard(JSON.parse('{"cards":{"__proto__":{"phase":"live","headSha12":"aaaaaaaa1111"}},"agents":{}}'), "constructor", config), null, "own keys only");
  assert.equal(liveCard(null, "tabs", config), null);
});

test("the gate hands its live reading to the rule: a whole write through checkWrites", () => {
  const who = { role: "Manager", manager: true };
  const run = (live) => checkWrites([done], { config, who, now: 5, state: {}, mirror: mirror("ship"), live }).errors.filter((e) => /repository says/.test(e));
  assert.equal(run(null).length, 1);
  assert.deepEqual(run(state({ ...at, phase: "live" })), []);
});

test("dropping a card never needs a reading, and a card not yet closing is not judged", () => {
  assert.deepEqual(mirrorErrors({ ...done, data: { status: "dropped", dropReason: "no longer wanted" } }, { config, mirror: mirror("ship"), live: state({ ...at, phase: "build" }) }), []);
  assert.deepEqual(mirrorErrors({ ...done, data: { nextNote: "x" } }, { config, mirror: mirror("ship"), live: state({ ...at, phase: "build" }) }), []);
});
