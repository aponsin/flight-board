// #C1117 (11-16 ~3:30 pm MT: "#C1115 waits at Checker 15 min, no session for Checker 2" while Checker 2 was reviewing it): the roster accepts "Checker 2", but
// collector.contextRoles allowed only letters, digits, _ and -, so "Checker 2" could not be listed and its session never reached the agents evidence. contextRoles now takes the
// same names as the roster: letters, digits, _ and -, and spaces inside (not at either end).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkConfig } from "../scripts/config.mjs";
import { agentStates } from "../collector/state.mjs";
import { stateErrors, STATE_VERSION, ROLE } from "../collector/state-schema.mjs";
import { stalledWaits } from "../worker/board-rules.mjs";

// The real cause (Checker 2's finding on 21a2fe2c): contextRoles is read by nothing any more (#C642); the false stall came from the agents evidence, which kept only roles
// matching ROLE (letters and digits, no space), so a roster role "Checker 2" never reached it and the store said "no session for Checker 2".
const T = 1_800_000_000_000, MIN = 60e3;
const sid = (n) => `local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${n}`, tid = (n) => `cccccccc-cccc-4ccc-8ccc-ccccccccccc${n}`;
function home() {
  const h = mkdtempSync(join(tmpdir(), "ctxrole-")), proj = join(h, ".claude", "projects", "-Users-x-Code-teamrepo");
  mkdirSync(proj, { recursive: true });
  for (const n of [1, 2]) writeFileSync(join(proj, `${tid(n)}.jsonl`), "");
  return h;
}
const row = (n, title, extra = {}) => ({ id: sid(n), title, transcript: tid(n), cwd: "/Users/x/Code/teamrepo", at: T - n * MIN, from: null, ...extra });

test("ROLE takes a space inside, between words or digits, at 2 to 24 characters; nothing else new", () => {
  for (const ok of ["Checker", "Checker 2", "Checker 12", "Boardsmith", "ab", "A".repeat(24)]) assert.ok(ROLE.test(ok), ok);
  for (const bad of ["", "A", " Checker", "Checker ", "Checker  2", "Check er!", "2Checker", "A".repeat(25), "Checker\t2", "Checker\n2"]) assert.ok(!ROLE.test(bad), JSON.stringify(bad));
});

test("a roster role Checker 2 with a session of that title reaches the agents evidence, the schema accepts it, and a card it claimed raises no no-session stall", () => {
  const agents = agentStates({ roles: ["Checker", "Checker 2"], sessions: [row(1, "Checker"), row(2, "Checker 2")], homeDir: home(), now: T, ids: new Set(), nums: new Map() });
  assert.deepEqual(Object.keys(agents).sort(), ["Checker", "Checker 2"], "both roster roles are agents");
  assert.equal(agents["Checker 2"].by, "title");
  const state = { v: STATE_VERSION, board: { boardId: "x".repeat(22), at: T, probe: "a".repeat(40), pageVersion: null }, cards: {}, agents };
  assert.deepEqual(stateErrors(state).filter((e) => /agents/.test(e)), [], "the state schema takes the key");
  const cards = [{ id: "card-a", num: 1, owner_role: "Boardsmith" }], evidence = { "card-a": { lit: ["checker"], phase: "checker", ci: "none" } };
  const idleOrBusy = (a) => ({ ...a, state: "working", card: "card-a", since: T });
  const stalls = (ag) => stalledWaits({ now: T + 20 * MIN, cards, evidence, agents: ag, openAskCards: new Set(), phaseStart: new Map([["card-a|checker", T]]), claims: new Map([["card-a", "Checker 2"]]) });
  assert.deepEqual(stalls({ Checker: agents.Checker, "Checker 2": idleOrBusy(agents["Checker 2"]) }), [], "Checker 2 is working its claim: no stall");
  const without = stalls({ Checker: agents.Checker });
  assert.equal(without.length, 1);
  assert.match(without[0].reason, /no session for Checker 2$/, "the stall that used to be false: it is now only raised when the session really is missing");
});

const bad = (contextRoles) => checkConfig({ collector: { contextRoles } }).filter((e) => /contextRoles/.test(e));

test("a role name with a space and digits, like Checker 2, passes checkConfig; so do the plain names that passed before", () => {
  assert.deepEqual(bad(["Manager", "Checker 2", "Checker 12", "Boardsmith", "a-b_c", "x"]), []);
  assert.deepEqual(bad(["Checker 2"]), []);
  assert.deepEqual(bad([]), []);
  assert.deepEqual(checkConfig({ collector: {} }).filter((e) => /contextRoles/.test(e)), [], "unset is fine");
});

test("a name that starts or ends with a space, is empty, is too long, or carries another character is refused; so is a list that is not a list or is too long", () => {
  for (const r of [" Checker", "Checker ", " ", "", "Checker\t2", "Checker/2", "Check\ner", "x".repeat(61), "Checker 2!", 7, null]) assert.equal(bad([r]).length, 1, JSON.stringify(r));
  assert.equal(bad(["x".repeat(60)]).length, 0, "60 characters is the limit");
  assert.equal(bad("Checker 2").length, 1, "a string is not a list");
  assert.equal(bad(Array.from({ length: 41 }, (_, i) => `R ${i}`)).length, 1, "up to 40 names");
  assert.equal(bad(Array.from({ length: 40 }, (_, i) => `R ${i}`)).length, 0);
  assert.match(bad([" x"])[0], /spaces inside/, "the message says what is allowed");
});
