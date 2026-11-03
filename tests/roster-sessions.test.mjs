// Each roster role's agent is found by the session id the config holds for it (#C633), never by the newest session with the
// role's title; a role with no id there is found by title and marked. The ids are checked like gate.managerSession.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentStates } from "../collector/state.mjs";
import { stateErrors, STATE_VERSION } from "../collector/state-schema.mjs";
import { checkConfig } from "../scripts/config.mjs";

const T = 1_800_000_000_000;
const A = "local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", B = "local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab2";

function home() {
  const h = mkdtempSync(join(tmpdir(), "roster-")), cwd = "/Users/x/Code/teamrepo";
  const proj = join(h, ".claude", "projects", "-Users-x-Code-teamrepo");
  mkdirSync(proj, { recursive: true });
  const t = (n) => `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${n}`;
  for (const n of [1, 2]) writeFileSync(join(proj, `${t(n)}.jsonl`), "");
  return { h, cwd, t };
}
const run = (extra) => {
  const { h, cwd, t } = home();
  // two sessions titled Checker: the older one (A) is the one the config names, the newer one (B) is a stray
  const sessions = [{ id: A, title: "Checker", transcript: t(1), cwd, at: T - 9e6 }, { id: B, title: "Checker", transcript: t(2), cwd, at: T - 1e3 }];
  return agentStates({ roles: ["Checker"], sessions, homeDir: h, now: T, ids: new Set(), nums: new Map(), ...extra });
};

test("a role with its id in the config is that session, not the newest one with its title", () => {
  const a = run({ sessionIds: { Checker: A } });
  assert.equal(a.Checker.lastActivityAt, T - 9e6);
  assert.ok(!("by" in a.Checker), "found by id: no flag");
});

test("a role with no id is found by its newest titled session and marked by: title", () => {
  const a = run({ sessionIds: {} });
  assert.equal(a.Checker.lastActivityAt, T - 1e3);
  assert.equal(a.Checker.by, "title");
});

test("a role whose id is set but not among the open sessions has no agent, whatever else carries its title", () => {
  assert.deepEqual(run({ sessionIds: { Checker: "local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac3" } }), {});
});

test("the state accepts the title flag and nothing else in it", () => {
  const card = { state: "idle", lastActivityAt: T, tool: null, card: null, since: null };
  const s = (agent) => ({ v: STATE_VERSION, board: { boardId: "x".repeat(22), at: T, probe: "a".repeat(40), pageVersion: null }, cards: {}, agents: { Checker: agent } });
  assert.deepEqual(stateErrors(s({ ...card, by: "title" })).filter((e) => /by/.test(e)), []);
  assert.ok(stateErrors(s({ ...card, by: "id" })).some((e) => /by/.test(e)));
});

test("the config: rosterSessions are roster roles with session ids; gate.cardOwners a list of names", () => {
  assert.deepEqual(checkConfig({ roster: ["Checker"], rosterSessions: { Checker: A } }), []);
  assert.ok(checkConfig({ roster: ["Checker"], rosterSessions: { Steward: A } }).some((p) => /rosterSessions.Steward: not a roster role/.test(p)));
  assert.ok(checkConfig({ roster: ["Checker"], rosterSessions: { Checker: "abc" } }).some((p) => /rosterSessions.Checker: a session id/.test(p)));
  assert.deepEqual(checkConfig({ gate: { cardOwners: ["Pat"] } }), []);
  assert.ok(checkConfig({ gate: { cardOwners: [3] } }).some((p) => /gate.cardOwners/.test(p)));
});
