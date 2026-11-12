// #C974 (Manager's A, 11-11 ~11 pm MT): the team's config lives in the team's repository (collector.configInRepo) and is changed by a branch,
// signed and landed like code; each minute the probe makes the live copy equal to main's. #C897's reviewPaths went live before review and skipped
// a Language review. Must still allow, as tests: the signed (landed) config loads; a missing, unreadable or refused copy on main leaves the live
// copy as it is, never none; session ids stay the live copy's; board.private.json never comes into it.
import test from "node:test";
import assert from "node:assert/strict";
import { teamConfigSync, SESSION_KEYS } from "../collector/state.mjs";
import { checkConfig, fullConfig } from "../scripts/config.mjs";

const FILE = "board/board.config.json";
const SID = (n) => `local_${String(n).repeat(8)}-1111-2222-3333-444444444444`;
const base = { title: "Test Board", owner: "Sam", roster: ["Manager", "Builder", "Checker"], gate: { managerRole: "Manager" }, collector: { configInRepo: FILE, reviewPaths: null } };
const live = { ...base, rosterSessions: { Builder: SID(1) }, gate: { ...base.gate, managerSession: SID(2) } };
const sync = (main, liveObj = live) => teamConfigSync({ show: () => (main instanceof Error ? (() => { throw main; })() : typeof main === "string" ? main : JSON.stringify(main)), liveText: JSON.stringify(liveObj), file: FILE });

test("the config: configInRepo is a relative .json path in the team's repository, or empty (off)", () => {
  assert.equal(fullConfig({}).collector.configInRepo, "");
  assert.deepEqual(checkConfig({ collector: { configInRepo: FILE } }), []);
  for (const bad of ["/etc/x.json", "../x.json", "a/../x.json", "-x.json", "x.txt", "a//x.json", "./x.json", 5]) assert.match(checkConfig({ collector: { configInRepo: bad } }).join(), /configInRepo/, String(bad));
});

test("a change landed on main reaches the live copy; the same config changes nothing", () => {
  const landed = { ...base, title: "Renamed Board", skips: [] };
  const s = sync(landed);
  const out = JSON.parse(s.text);
  assert.deepEqual([out.title, out.skips], ["Renamed Board", []], "the landed change is live");
  assert.deepEqual(out.rosterSessions, live.rosterSessions, "with the live session ids");
  assert.match(s.line, /now matches board\/board\.config\.json on main/);
  assert.deepEqual(sync({ ...base }), { text: null, line: null }, "main equal to live (sessions aside): nothing written");
});

test("a hand edit of the live copy that never landed is undone by main's copy", () => {
  const edited = { ...live, title: "Edited By Hand" };
  assert.equal(JSON.parse(sync(base, edited).text).title, "Test Board", "the unreviewed edit goes");
});

test("the session ids stay the live copy's: a restart needs no landing", () => {
  const out = JSON.parse(sync({ ...base, rosterSessions: { Builder: SID(9) }, gate: { ...base.gate, managerSession: SID(8) } }).text ?? JSON.stringify(live));
  assert.deepEqual(out.rosterSessions, live.rosterSessions);
  assert.equal(out.gate.managerSession, SID(2));
  assert.deepEqual(SESSION_KEYS, ["rosterSessions"]);
  const none = { ...base };
  assert.deepEqual(sync({ ...base, rosterSessions: { Builder: SID(9) } }, none), { text: null, line: null }, "live has none: main's are not taken either");
});

test("never blanks the live copy: missing, unreadable, not an object or refused on main keeps it, and says why", () => {
  for (const [main, why] of [[new Error("no such path"), /no readable/], ["{not json", /no readable/], ["[1,2]", /not an object/], [{ ...base, roster: "Builder" }, /refused/]]) {
    const s = sync(main);
    assert.equal(s.text, null, String(why));
    assert.match(s.line, why);
    assert.match(s.line, /live copy is kept/);
  }
  assert.match(teamConfigSync({ show: () => JSON.stringify(base), liveText: "{oops", file: FILE }).line, /does not parse; not replaced/);
});

test("board.private.json and tokens never come into it: the file is the plain config, checked like any config", () => {
  assert.match(sync({ ...base, apiToken: "x" }).line, /refused/, "an unknown field is refused, so a secret cannot ride in");
});
