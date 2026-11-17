// #C1135 (found on #C1129): the Worker checked roles against ROSTER_ROLES, a list hard-coded in worker/board-rules.mjs. It matched board.config.json only by luck: "Checker 2" is on the config and
// not on the list (it passed because the check strips trailing digits), a role added to the config but not to the list never got a Remote Control line, and any "roster name plus digits" passed
// ("Checker 7"). The probe posts the config's roster (the `roster` evidence) and the Worker compares by exact name.
import test from "node:test";
import assert from "node:assert/strict";
import { rcOffWakes, RC_OFF_CARD, rosterShape, rosterRole, evidenceRefusal, ROSTER_ROLES } from "../worker/board-rules.mjs";
import { rosterWrite, evidenceJob } from "../collector/probe-evidence.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, writeEvidence, takeInbox, wakeAsk } from "../worker/board-store.mjs";

const T = 1_800_000_000_000, MIN = 60_000;
const ROSTER = ["Builder", "Checker", "Checker 2", "Security", "Release", "Manager", "Boardsmith", "Auditor"]; // "Auditor": on the config, not on the Worker's old list
const off = (...names) => Object.fromEntries(names.map((n) => [n, { rcOff: true }]));
const ids = (lines) => lines.map((l) => l.card_id);

test("with the config's roster, a role counts by its exact name: a role the old list lacks gets its line, a roster name plus other digits does not", () => {
  assert.equal(ROSTER_ROLES.includes("Auditor"), false, "control: the old list has no Auditor");
  const got = rcOffWakes(off("Auditor", "Checker 2", "Checker 7", "Checker 2 3", "Ghost", "Manager"), ROSTER);
  assert.deepEqual(ids(got), [`${RC_OFF_CARD}Auditor`, `${RC_OFF_CARD}Checker 2`, `${RC_OFF_CARD}Manager`], "Checker 7, Checker 2 3 and Ghost are not on the config");
  assert.equal(rosterRole("Checker 7", ROSTER), false);
  assert.equal(rosterRole("Checker 2", ROSTER), true);
  assert.equal(rosterRole("Checker", ["Checker 2"]), false, "a name is only itself: the bare Checker is not Checker 2");
  assert.equal(rosterRole("bad|name", ["bad|name"]), false, "a plain-name check still comes first");
});

test("with no roster posted yet, the old list-plus-digits rule stands; an empty roster names nobody", () => {
  assert.deepEqual(ids(rcOffWakes(off("Checker 2", "Auditor", "Manager"))), [`${RC_OFF_CARD}Checker 2`, `${RC_OFF_CARD}Manager`]);
  assert.deepEqual(ids(rcOffWakes(off("Checker 2", "Auditor", "Manager"), undefined)), [`${RC_OFF_CARD}Checker 2`, `${RC_OFF_CARD}Manager`]);
  assert.deepEqual(rcOffWakes(off("Manager"), []), []);
});

test("the roster evidence: { roster: [up to 40 distinct plain role names] } and nothing else is accepted from the probe", () => {
  assert.equal(rosterShape({ roster: ROSTER }), true);
  assert.equal(rosterShape({ roster: [] }), true);
  for (const bad of [null, [], "x", {}, { roster: "Manager" }, { roster: ["Manager", "Manager"] }, { roster: [1] }, { roster: ["a|b"] }, { roster: ["x".repeat(25)] }, { roster: Array.from({ length: 41 }, (_, i) => `R${i}`) }, { roster: ROSTER, extra: 1 }]) assert.equal(rosterShape(bad), false, JSON.stringify(bad)?.slice(0, 50));
  assert.equal(evidenceRefusal("roster", { roster: ROSTER }, "probe"), null, "the probe may write it");
  assert.notEqual(evidenceRefusal("roster", { roster: "x" }, "probe"), null);
  assert.notEqual(evidenceRefusal("roster", { roster: ROSTER }, "Builder"), null, "an agent may not");
});

test("rosterWrite: the config's roster under the key roster; nothing for a config that cannot be read, has no roster, or has an odd one", () => {
  assert.deepEqual(rosterWrite(JSON.stringify({ roster: ROSTER })), { key: "roster", value: { roster: ROSTER } });
  const logs = [];
  assert.equal(rosterWrite("not json", { log: (l) => logs.push(l) }), null);
  assert.equal(rosterWrite(JSON.stringify({})), null, "no roster key: nothing posted, the Worker keeps its last list");
  for (const roster of ["Manager", ["Manager", "Manager"], [1], ["a|b"], Array.from({ length: 41 }, (_, i) => `R${i}`), null]) assert.equal(rosterWrite(JSON.stringify({ roster }), { log: (l) => logs.push(l) }), null, JSON.stringify(roster)?.slice(0, 40));
  assert.ok(logs.length >= 7, "each refusal says why");
});

test("the evidence job posts the roster beside the other config-derived keys, and nothing when the config cannot be read", async () => {
  const CONFIG = JSON.stringify({ collector: { repoPath: "/r" }, roster: ROSTER });
  const read = (cfg) => (p) => { if (p === "/c") { if (cfg === null) throw new Error("none"); return cfg; } if (p === "/s/state.json") return JSON.stringify({ v: 1, board: { boardId: "b", at: 1 }, cards: {}, agents: {} }); throw new Error("none"); };
  const posted = [];
  const run = (cfg) => evidenceJob({
    job: "evidence", base: "https://x.example", headers: {}, configPath: "/c", stateFile: "/s/state.json", build: async () => {}, read: read(cfg), ghCheck: () => true,
    deployRead: async () => ({ worker: "", tree: "" }), liveFetch: async () => ({ ok: false, status: 500 }), log: () => {},
    fetchImpl: async (url, o) => { posted.push(JSON.parse(o.body)); return { ok: true, status: 200 }; }, e2e: { read: () => { throw new Error("none"); } },
  });
  await run(CONFIG);
  assert.deepEqual(posted.find((b) => b.key === "roster")?.value, { roster: ROSTER });
  posted.length = 0;
  await run(null);
  assert.equal(posted.some((b) => b.key === "roster"), false);
});

test("the store: with the roster posted, an off role the old list lacks reaches Manager and a made-up Checker 7 does not; with none posted the old rule applies", async () => {
  const lines = async (post) => {
    const db = makeDb();
    await createCard(db, T, "Manager", { id: "c", title: "A card", owner_role: "Boardsmith" });
    const agent = (extra = {}) => ({ state: "idle", lastActivityAt: T, tool: null, card: null, since: null, ...extra });
    await writeEvidence(db, T + 1, "probe", "agents", { Auditor: agent({ rcOff: true }), "Checker 7": agent({ rcOff: true }), "Checker 2": agent({ rcOff: true }), Security: agent() });
    if (post) assert.equal((await writeEvidence(db, T + 2, "probe", "roster", { roster: ROSTER })).ok, true);
    await wakeAsk(db, T + 2 * MIN);
    return (await takeInbox(db, T + 3 * MIN)).stalls.map((s) => s.reason).filter((r) => /Remote Control/.test(r)).sort();
  };
  const withRoster = await lines(true);
  assert.deepEqual(withRoster.map((r) => r.split(" has ")[0]), ["Auditor", "Checker 2"], "exact names on the config: Auditor and Checker 2 get a line, Checker 7 does not");
  const without = await lines(false);
  assert.deepEqual(without.map((r) => r.split(" has ")[0]), ["Checker 2", "Checker 7"], "no roster yet: the old rule (list plus digits) as before");
});
