// #C1122 (split from #C1111): the probe reads each role's Remote Control switch from the app's session files. The live try of 11-16 (a session of the roster, off then on, the file read at
// 5, 30 and 60 s each way) showed remoteControlUserEnabled follows the switch within 5 s both ways; steeredByRemoteClient stays true after the switch is off (history), and
// the key is null on a session whose switch was never touched. So: only an explicit false is "off"; only that one key is read; the agent's reading says rcOff: true and nothing else; the
// board puts an off role in Manager's batch and the Crew tile shows it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentStates, appSessions } from "../collector/state.mjs";
import { stateErrors, STATE_VERSION } from "../collector/state-schema.mjs";
import { rcOffWakes, RC_OFF_CARD } from "../worker/board-rules.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, writeEvidence } from "../worker/board-store.mjs";
import { wakeAsk, takeInbox } from "./helpers/beating-store.mjs";
import { loadNames } from "./harness.mjs";

const T = 1_800_000_000_000, MIN = 60e3;
const sid = (n) => `local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${n}`;
const tid = (n) => `cccccccc-cccc-4ccc-8ccc-ccccccccccc${n}`;

function root(files) {
  const r = mkdtempSync(join(tmpdir(), "rc-")), org = join(r, tid(8), tid(9));
  mkdirSync(org, { recursive: true });
  for (const [n, extra] of files) writeFileSync(join(org, `${sid(n)}.json`), JSON.stringify({ title: `S${n}`, cliSessionId: tid(n), cwd: "/Users/x/Code/teamrepo", lastActivityAt: T, ...extra }));
  return r;
}

test("appSessions: rcOff is true only for an explicit false; null, absent, true, or any other value is not off; steeredByRemoteClient is never read", () => {
  const r = root([[1, { remoteControlUserEnabled: false }], [2, { remoteControlUserEnabled: true }], [3, { remoteControlUserEnabled: null }], [4, {}], [5, { remoteControlUserEnabled: "false" }], [6, { remoteControlUserEnabled: 0 }], [7, { steeredByRemoteClient: false, remoteControlAutoEligible: false, bridgeSessionIds: [] }]]);
  const by = Object.fromEntries(appSessions(r).map((s) => [s.title, s.rcOff]));
  assert.deepEqual(by, { S1: true, S2: false, S3: false, S4: false, S5: false, S6: false, S7: false });
  assert.deepEqual(Object.keys(appSessions(r)[0]).sort(), ["at", "cwd", "effort", "from", "id", "model", "rcOff", "scheduledTaskId", "title", "transcript"], "one new boolean and no other Remote Control key (effort is #C1111's)");
});

test("agentStates: an off role says rcOff: true, every other reading has no such key", () => {
  const h = mkdtempSync(join(tmpdir(), "rc-home-")), proj = join(h, ".claude", "projects", "-Users-x-Code-teamrepo");
  mkdirSync(proj, { recursive: true }); for (const n of [1, 2]) writeFileSync(join(proj, `${tid(n)}.jsonl`), "");
  const row = (n, title, rcOff) => ({ id: sid(n), title, transcript: tid(n), cwd: "/Users/x/Code/teamrepo", at: T - n * MIN, from: null, rcOff });
  const a = agentStates({ roles: ["Manager", "Checker"], sessions: [row(1, "Manager", true), row(2, "Checker", false)], homeDir: h, now: T, ids: new Set(), nums: new Map() });
  assert.equal(a.Manager.rcOff, true);
  assert.equal(Object.hasOwn(a.Checker, "rcOff"), false);
});

test("the state accepts rcOff: true on an agent and refuses false and other types", () => {
  const base = { state: "idle", lastActivityAt: T, tool: null, card: null, since: null };
  const s = (agent) => ({ v: STATE_VERSION, board: { boardId: "x".repeat(22), at: T, probe: "a".repeat(40), pageVersion: null }, cards: {}, agents: { Checker: agent } });
  const errs = (agent) => stateErrors(s(agent)).filter((e) => /rcOff/.test(e));
  assert.deepEqual(errs({ ...base, rcOff: true }), []);
  assert.deepEqual(errs(base), [], "left out is fine");
  assert.notDeepEqual(errs({ ...base, rcOff: false }), []);
  assert.notDeepEqual(errs({ ...base, rcOff: "yes" }), []);
});

test("rcOffWakes: one line per role whose reading says rcOff: true, in name order; nothing for others, odd names or no readings", () => {
  const lines = rcOffWakes({ Sales: { rcOff: true }, Checker: { state: "idle" }, Admin: { rcOff: true }, "bad|name": { rcOff: true }, Other: { rcOff: "true" } });
  assert.deepEqual(lines.map((l) => l.card_id), [`${RC_OFF_CARD}Admin`, `${RC_OFF_CARD}Sales`]);
  assert.match(lines[0].reason, /^Admin has Remote Control turned off in the app/);
  assert.equal(lines[0].num, null);
  for (const none of [undefined, null, {}, [], "x"]) assert.deepEqual(rcOffWakes(none), []);
});

// #C1129 (Security's INFO I1 on #C1122): a plain name is not enough; the role is a roster role (or one with digits after it, like Checker 2).
test("rcOffWakes: only a roster role's name, with optional digits, names a role; a made-up title that is a plain word does not", () => {
  const all = rcOffWakes({ "Checker 2": { rcOff: true }, Manager: { rcOff: true }, Ghost: { rcOff: true }, "Ghost 2": { rcOff: true }, "Not A Role": { rcOff: true }, "Checker 2 3": { rcOff: true }, "Checker2": { rcOff: true }, "Sales ": { rcOff: true } });
  assert.deepEqual(all.map((l) => l.card_id), [`${RC_OFF_CARD}Checker 2`, `${RC_OFF_CARD}Manager`], "Ghost, Ghost 2, Not A Role, Checker 2 3, Checker2 and a trailing space name no role");
});

test("the store: an off role reaches Manager once; when the switch is on again its line is no longer pending", async () => {
  const db = makeDb();
  await createCard(db, T, "Manager", { id: "c", title: "A card", owner_role: "Boardsmith" });
  const agent = (extra = {}) => ({ state: "idle", lastActivityAt: T, tool: null, card: null, since: null, ...extra });
  await writeEvidence(db, T + 1, "probe", "agents", { Sales: agent({ rcOff: true }), Checker: agent() });
  await wakeAsk(db, T + 2 * MIN);
  const first = (await takeInbox(db, T + 3 * MIN)).stalls.map((s) => s.reason).filter((r) => /Remote Control/.test(r));
  assert.deepEqual(first, ["Sales has Remote Control turned off in the app: switch it on in the session's toolbar"]);
  await wakeAsk(db, T + 4 * MIN);
  assert.deepEqual((await takeInbox(db, T + 5 * MIN)).stalls.map((s) => s.reason).filter((r) => /Remote Control/.test(r)), [], "told once");
  await writeEvidence(db, T + 6 * MIN, "probe", "agents", { Sales: agent(), Checker: agent() });
  await wakeAsk(db, T + 7 * MIN);
  await writeEvidence(db, T + 8 * MIN, "probe", "agents", { Sales: agent({ rcOff: true }), Checker: agent() });
  await wakeAsk(db, T + 9 * MIN);
  assert.equal((await takeInbox(db, T + 10 * MIN)).stalls.filter((s) => /Remote Control/.test(s.reason)).length, 1, "a later spell tells again");
});

const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
test("the Crew tile shows Remote Control off for a role that reads off, and nothing for the others; a stale reading draws no chip", () => {
  const b = loadNames(["liveAgent", "probeEvent", "crewRoster", "crewDoc", "crewHtml"], { Date: class extends Date { constructor(...a) { a.length ? super(...a) : super(T); } static now() { return T; } } });
  Object.assign(b.state, { initRaw: [], steps: [], waiting: [], todo: [], ideas: [], events: [], meta: [], ctx: [], messages: [], threads: [], plan: [], timings: [], derived: [], initiatives: [], crew: [] });
  const a = (at, extra = {}) => ({ state: "idle", lastActivityAt: at, tool: null, card: null, since: null, ...extra });
  const live = (at) => ({ v: 1, board: { boardId: "TestBoard42xyz", at, probe: null, pageVersion: null }, cards: {}, agents: { Checker: a(at, { rcOff: true }), Security: a(at) } });
  b.probeEvent({ type: "data", result: { payload: live(T - 40e3) } }, {});
  const out = b.crewHtml();
  assert.match(out.split('data-agent="Checker"')[1].split('data-agent=')[0], /Remote Control off/);
  assert.doesNotMatch(out.split('data-agent="Security"')[1].split('data-agent=')[0], /Remote Control off/);
  b.probeEvent({ type: "data", result: { payload: live(T - 10 * MIN) } }, {});
  assert.doesNotMatch(b.crewHtml(), /Remote Control off/, "a stale reading draws no tile and no chip");
  assert.match(html, /rcOff===true/);
});
