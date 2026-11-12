// #C974 (Manager's A, 11-11 ~11 pm MT): the team's config lives in the team's repository (collector.configInRepo) and is changed by a branch,
// signed and landed like code; each minute the probe makes the live copy take main's rules. #C897's reviewPaths went live before review and
// skipped a Language review. Security on 795328c: F1, main changes only the rule fields (RULE_FIELDS); paths, addresses, scripts, notes refs
// and session ids stay the live copy's. F2, a change is taken only when the commit that last changed the file on main carries SECURE.
// Must still allow, as tests: a signed rule change loads; a missing, unreadable or refused copy on main leaves the live copy as it is, never
// none; a restart's session ids need no landing; board.private.json never comes into it.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { teamConfigSync, syncLiveConfig, RULE_FIELDS } from "../collector/state.mjs";
import { checkConfig, fullConfig, DEFAULTS } from "../scripts/config.mjs";

const FILE = "board/board.config.json";
const SHA = "a".repeat(40);
const SID = (n) => `local_${String(n).repeat(8)}-1111-2222-3333-444444444444`;
const base = { title: "Test Board", owner: "Sam", roster: ["Manager", "Builder", "Checker"], gate: { managerRole: "Manager", stateDir: "~/.flight-board" }, collector: { configInRepo: FILE, reviewPaths: null, repoPath: "~/team", outDir: "~/out", notes: { security: "refs/notes/security" } } };
const live = { ...base, rosterSessions: { Builder: SID(1) }, gate: { ...base.gate, managerSession: SID(2) } };
const SECURE = "SECURE #C1 aaaaaaa (Security): fine";
const sync = (main, liveObj = live, note = SECURE, last = SHA) => teamConfigSync({
  show: () => (main instanceof Error ? (() => { throw main; })() : typeof main === "string" ? main : JSON.stringify(main)),
  liveText: JSON.stringify(liveObj), file: FILE,
  lastChange: () => (last instanceof Error ? (() => { throw last; })() : last),
  securityNote: (sha) => (sha === SHA ? note : null),
});

test("the config: configInRepo is a relative .json path in the team's repository, or empty (off)", () => {
  assert.equal(fullConfig({}).collector.configInRepo, "");
  assert.deepEqual(checkConfig({ collector: { configInRepo: FILE } }), []);
  for (const bad of ["/etc/x.json", "../x.json", "a/../x.json", "-x.json", "x.txt", "a//x.json", "./x.json", 5]) assert.match(checkConfig({ collector: { configInRepo: bad } }).join(), /configInRepo/, String(bad));
});

test("a signed rule change landed on main reaches the live copy; the same rules change nothing", () => {
  const landed = { ...base, title: "Renamed Board", skips: [], collector: { ...base.collector, reviewPaths: { security: ["worker/**"] } } };
  const s = sync(landed);
  const out = JSON.parse(s.text);
  assert.deepEqual([out.title, out.skips, out.collector.reviewPaths], ["Renamed Board", [], { security: ["worker/**"] }], "the landed rules are live");
  assert.deepEqual(out.rosterSessions, live.rosterSessions, "with the live session ids");
  assert.equal(out.gate.managerSession, SID(2));
  assert.match(s.line, /takes the rules in board\/board\.config\.json on main \(aaaaaaa, SECURE\)/);
  assert.deepEqual(sync({ ...base }), { text: null, line: null }, "main equal to live (sessions aside): nothing written");
  const dropped = { ...base }; delete dropped.owner;
  assert.equal("owner" in JSON.parse(sync(dropped).text), false, "a rule removed on main goes from the live copy");
});

test("a hand edit of a rule in the live copy that never landed is undone by main's copy", () => {
  const edited = { ...live, title: "Edited By Hand" };
  assert.equal(JSON.parse(sync(base, edited).text).title, "Test Board", "the unreviewed edit goes");
});

test("F1: main never changes a path, address, script, notes ref or session id; they stay the live copy's", () => {
  const pinnedTop = { artifactUrl: "https://claude.ai/artifact/evil", storeUrl: "https://evil.example.com/", artifactSlug: "00000000-0000-0000-0000-000000000000", rosterSessions: { Builder: SID(9) } };
  const pinnedGate = { stateDir: "/tmp/evil", managerSession: SID(8) };
  const pinnedCollector = { repoPath: "/tmp/evil", outDir: "/tmp/evil-out", repos: [{ name: "x", path: "/tmp/evil", installedLink: "/tmp/evil-link", notes: { security: "refs/notes/security" } }], usageScript: "/tmp/evil.py", usageScriptSha256: "b".repeat(64), notes: { security: "refs/notes/checker" }, remote: "evil", mainBranch: "dev", configInRepo: "evil.json", liveUrl: "https://evil.example.com", refresh: { repos: ["/tmp/evil"] }, keeper: { skill: "~/.claude/scheduled-tasks/evil/SKILL.md", prompt: "~/evil-prompt.txt", promptSha256: "c".repeat(64) } };
  const main = { ...base, ...pinnedTop, gate: { ...base.gate, ...pinnedGate }, collector: { ...base.collector, ...pinnedCollector } };
  assert.deepEqual(checkConfig(main), [], "the hostile copy is a valid config, so only the allowlist stops it");
  assert.deepEqual(sync(main), { text: null, line: null }, "nothing taken: the live copy is unchanged");
  const out = JSON.parse(sync({ ...main, title: "Renamed Board" }).text);
  assert.equal(out.title, "Renamed Board", "the rule beside them is taken");
  for (const k of Object.keys(pinnedTop)) assert.deepEqual(out[k], live[k], k);
  for (const k of Object.keys(pinnedGate)) assert.deepEqual(out.gate[k], live.gate[k], `gate.${k}`);
  for (const k of Object.keys(pinnedCollector)) assert.deepEqual(out.collector[k], live.collector[k], `collector.${k}`);
});

test("F1: the allowlist names only real fields and none of the owner's live values", () => {
  for (const k of RULE_FIELDS.top) assert.ok(k in DEFAULTS, k);
  for (const sec of ["gate", "collector"]) for (const k of RULE_FIELDS[sec]) assert.ok(k in DEFAULTS[sec], `${sec}.${k}`);
  const owners = ["artifactUrl", "storeUrl", "artifactSlug", "rosterSessions", "gate", "collector", "managerSession", "stateDir", "repoPath", "outDir", "repos", "remote", "mainBranch", "notes", "liveUrl", "usageScript", "usageScriptSha256", "configInRepo", "refresh", "keeper"];
  for (const sec of ["gate", "collector"]) for (const k of owners) assert.equal(RULE_FIELDS[sec].includes(k), false, `${sec}.${k}`);
  for (const k of ["artifactUrl", "storeUrl", "artifactSlug", "rosterSessions", "gate", "collector"]) assert.equal(RULE_FIELDS.top.includes(k), false, k);
});

test("F2: a change is taken only when the commit that last changed the file on main carries SECURE", () => {
  const landed = { ...base, skips: [{ phase: "security", unlessLevel: "XL" }] };
  for (const [note, why] of [[null, "no note"], ["FINDINGS F1 ...", "FINDINGS"], ["LGTM", "another word"], ["  secure", "lower case"], ["NOT SECURE", "not at the start"]]) {
    const s = sync(landed, live, note);
    assert.equal(s.text, null, why);
    assert.match(s.line, /last changed on main in aaaaaaa, which carries no SECURE note; the live copy is kept/, why);
  }
  for (const last of ["", "not-a-sha", new Error("git failed")]) assert.match(sync(landed, live, SECURE, last).line, /no commit on main found/, String(last));
  assert.ok(sync(landed, live, "\nSECURE #C2 aaaaaaa").text, "a SECURE note (leading space aside) lets it through");
  assert.deepEqual(sync({ ...base }, live, null), { text: null, line: null }, "no change to take: no note needed and nothing said");
});

test("the session ids stay the live copy's: a restart needs no landing", () => {
  const none = { ...base };
  assert.deepEqual(sync({ ...base, rosterSessions: { Builder: SID(9) } }, none), { text: null, line: null }, "live has none: main's are not taken either");
});

test("never blanks the live copy: missing, unreadable, not an object or refused on main keeps it, and says why", () => {
  for (const [main, why] of [[new Error("no such path"), /no readable/], ["{not json", /no readable/], ["[1,2]", /not an object/], [{ ...base, roster: "Builder" }, /refused/], [{ ...base, gate: "x" }, /refused/]]) {
    const s = sync(main);
    assert.equal(s.text, null, String(why));
    assert.match(s.line, why);
    assert.match(s.line, /live copy is kept/);
  }
  assert.match(teamConfigSync({ show: () => JSON.stringify(base), liveText: "{oops", file: FILE }).line, /does not parse; not replaced/);
  assert.match(teamConfigSync({ show: () => JSON.stringify(base), liveText: "[]", file: FILE }).line, /not an object; not replaced/);
});

// Checker's F2 on 804d6ff: main's copy and the live copy each pass alone, but the merge does not. Without the check on the merge, the probe
// would write a config its next run refuses at load, and the board would go dark.
test("never blanks: a merge that fails the config check (main drops a role the live session ids still name) keeps the live copy", () => {
  const liveTwo = { ...base, roster: ["Manager", "Builder", "Checker"], rosterSessions: { Builder: SID(1), Checker: SID(3) }, gate: { ...base.gate, managerSession: SID(2) } };
  const mainOne = { ...base, roster: ["Manager", "Builder"] };
  assert.deepEqual(checkConfig(liveTwo), [], "the live copy passes alone");
  assert.deepEqual(checkConfig(mainOne), [], "main's copy passes alone");
  const s = sync(mainOne, liveTwo);
  assert.equal(s.text, null);
  assert.match(s.line, /refused \(rosterSessions\.Checker.*\); the live copy is kept/);
});

// Checker's F1 on 804d6ff: the git half (syncLiveConfig, which the probe's main block calls) on a real repository.
test("on a real repository: a change whose own commit has no SECURE is never taken, even under a SECURE newer commit; a SECURE change is written to the live file", () => {
  const d = mkdtempSync(join(tmpdir(), "cfg-sync-")), repo = join(d, "repo"), livePath = join(d, "board.config.json");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(d, "none"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
  writeFileSync(env.GIT_CONFIG_GLOBAL, "");
  const git = (args) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  mkdirSync(join(repo, "board"), { recursive: true });
  git(["init", "-q", "-b", "main"]);
  const put = (obj, msg, other = null) => {
    if (obj) writeFileSync(join(repo, FILE), JSON.stringify(obj, null, 2));
    if (other) writeFileSync(join(repo, other), msg);
    git(["add", "-A"]); git(["commit", "-q", "-m", msg]); return git(["rev-parse", "HEAD"]);
  };
  const secure = (sha) => git(["notes", "--ref=refs/notes/security", "add", "-f", "-m", "SECURE test", sha]);
  const run = () => syncLiveConfig({ git, tip: "main", file: FILE, notesRef: "refs/notes/security", livePath });
  writeFileSync(livePath, JSON.stringify(live));
  const first = put(base, "the config lands"); secure(first);
  assert.equal(run(), null, "main equals live: nothing to do");
  // Case 1: commit A changes the rule with no note; commit B, SECURE, does not touch the file.
  const A = put({ ...base, title: "From A" }, "A: an unsigned change");
  const B = put(null, "B: something else", "other.txt"); secure(B);
  const one = run();
  assert.match(one, new RegExp(`last changed on main in ${A.slice(0, 7)}, which carries no SECURE note; the live copy is kept`));
  assert.deepEqual(JSON.parse(readFileSync(livePath, "utf8")), live, "the live file is unchanged");
  // Case 2: A gets its SECURE: the rule is taken and written, the session ids kept.
  secure(A);
  assert.match(run(), new RegExp(`takes the rules in board/board\\.config\\.json on main \\(${A.slice(0, 7)}, SECURE\\)`));
  const now = JSON.parse(readFileSync(livePath, "utf8"));
  assert.equal(now.title, "From A");
  assert.deepEqual([now.rosterSessions, now.gate.managerSession], [live.rosterSessions, live.gate.managerSession]);
  // No notes ref configured: nothing is ever signed, so nothing new is taken.
  put({ ...base, title: "From C" }, "C");
  assert.match(syncLiveConfig({ git, tip: "main", file: FILE, notesRef: undefined, livePath }), /carries no SECURE note/);
  assert.match(syncLiveConfig({ git, tip: "main", file: FILE, notesRef: "refs/notes/security", livePath: join(d, "missing.json") }), /^config: not synced \(ENOENT\)/, "a missing live file is a line, not a crash");
});

test("board.private.json and tokens never come into it: the file is the plain config, checked like any config", () => {
  assert.match(sync({ ...base, apiToken: "x" }).line, /refused/, "an unknown field is refused, so a secret cannot ride in");
});
