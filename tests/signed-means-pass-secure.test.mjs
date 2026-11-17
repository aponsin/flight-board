// #C1163 (Manager's audit 11-17): "signed" and "Security wanted" mean what the landing job needs, everywhere on the board.
// (1) a note signs a commit only when its first line starts with the role's word (PASS, SECURE): the probe, the landing job, the re-cut tool, the release tool and the self-deploy gate
//     read it through collector/signoff.mjs, and sign-note refuses any other first word; (2) a card of the board's own repository always wants Security, in the dispatch, the probe and
//     the level the page shows.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isSignoff, isFindings, noteLineOk, securityAlways, wantsSecurity, BOARD_WORDS, SIGNOFF_WORD } from "../collector/signoff.mjs";
import { BOARD_REPO_WORDS } from "../collector/pairs.mjs";
import { cardState } from "../collector/state.mjs";
import { signed as landSigned } from "../scripts/board-land.mjs";
import { signed as recutSigned } from "../scripts/board-recut.mjs";
import { ROLE_WORD } from "../scripts/self-deploy-gate.mjs";
import { signNote } from "../scripts/sign-note.mjs";
import { shownLevel } from "../worker/compat-view.mjs";
import { dispatchRun } from "../collector/store-dispatch.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("isSignoff: the role's word at the start of the first line signs; any other first word, a lower-case word, a longer word or another role's word does not", () => {
  for (const [role, good] of [["checker", ["PASS", "PASS (Quick) at abc", "  PASS\nsigned-by: Checker 2"]], ["security", ["SECURE", "SECURE (Full)\nsigned-by: Security"]]]) for (const n of good) assert.equal(isSignoff(n, role), true, `${role}: ${n}`);
  for (const n of ["HOLD", "STOP", "FINDINGS: F1", "pass", "PASSED", "looks fine", "", null, undefined, "\nPASS", "SECURE"]) assert.equal(isSignoff(n, "checker"), false, `checker: ${JSON.stringify(n)}`);
  for (const n of ["HOLD", "PASS", "secure", "SECUREd", "FINDINGS"]) assert.equal(isSignoff(n, "security"), false, `security: ${n}`);
  assert.equal(isSignoff("looks fine", "linguist"), true, "a role with no word keeps the older rule: any note that is not FINDINGS");
  assert.equal(isSignoff("FINDINGS", "linguist"), false);
  assert.equal(isFindings(" FINDINGS: x"), true);
  assert.equal(isFindings("PASS"), false);
});

test("the landing job, the re-cut tool and the self-deploy gate read 'signed' the same way", () => {
  const notes = (checker, security) => ({ checker, security });
  for (const [c, s, want] of [["PASS", "SECURE", true], ["PASS (Quick)", "SECURE (Full)", true], ["HOLD", "SECURE", false], ["PASS", "STOP", false], ["PASS", "PASS", false], ["pass", "secure", false], ["FINDINGS", "SECURE", false], [undefined, "SECURE", false]]) {
    assert.equal(landSigned(notes(c, s)), want, `land ${c}/${s}`);
    assert.equal(recutSigned(notes(c, s)), want, `recut ${c}/${s}`);
    assert.equal(isSignoff(c, "checker") && isSignoff(s, "security"), want, `signoff ${c}/${s}`);
  }
  assert.equal(ROLE_WORD.checker.re, SIGNOFF_WORD.checker);
  assert.equal(ROLE_WORD.security.re, SIGNOFF_WORD.security);
});

// A script that reads the sign-off word on its own can drift from the others again: none may.
test("no script or collector file keeps its own PASS or SECURE first-word regex (collector/signoff.mjs is the one place)", () => {
  const offenders = [];
  for (const dir of ["scripts", "collector", "worker", "gate"]) for (const f of readdirSync(join(ROOT, dir)).filter((x) => x.endsWith(".mjs"))) {
    if (dir === "collector" && f === "signoff.mjs") continue;
    const text = readFileSync(join(ROOT, dir, f), "utf8");
    if (/\/\^(?:\\s\*)?(?:PASS|SECURE)\\b\//.test(text)) offenders.push(`${dir}/${f}`);
  }
  assert.deepEqual(offenders, []);
});

test("sign-note refuses a first line that does not start with the role's word, FINDINGS or STOP, before any git call; the words it allows pass the line check", () => {
  const never = () => { throw new Error("git was called"); };
  const sha = "a".repeat(40);
  const refuse = (role, line) => assert.throws(() => signNote({ run: never, role, sha, signer: "Checker 2", line }), (e) => !/git was called/.test(e.message) && /starts with/.test(e.message), `${role}: ${line}`);
  refuse("checker", "HOLD until the suite is green");
  refuse("checker", "looks fine");
  refuse("checker", "pass");
  refuse("checker", "SECURE");
  refuse("security", "PASS");
  refuse("security", "secure (Full)");
  // an allowed line gets past the line check and reaches git (the stand-in throws there)
  for (const [role, line] of [["checker", "PASS (Quick) at abc"], ["security", "SECURE (Full)"], ["checker", "FINDINGS: F1 ..."], ["security", "STOP: hold"]]) {
    assert.throws(() => signNote({ run: never, role, sha, signer: "Checker 2", line }), (e) => /git was called|not a commit/.test(e.message) || e.message === "git was called", `${role}: ${line}`);
  }
  assert.equal(noteLineOk("checker", "PASS"), true);
  assert.equal(noteLineOk("checker", "SECURE"), false);
});

// ---- the probe: real git ----
const cfg = (skips = []) => ({ phases: [["plan"], ["build"], ["test"], ["checker"], ["security"], ["ship"], ["live"]], skips, collector: { notes: { checker: "x", security: "y" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } });
function read(card, { checker = null, security = null, config = cfg() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fb-sig-")), git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.email", "t@t"); git("config", "user.name", "t"); git("config", "gc.auto", "0");
  git("commit", "-q", "--allow-empty", "-m", "base"); const main = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", main);
  mkdirSync(join(dir, "docs"), { recursive: true }); writeFileSync(join(dir, "docs/a.md"), "a\n"); git("add", "-A");
  const message = "Real work (#C1163)\n\nBoard-Id: a-card";
  git("commit", "-q", "-m", message); const sha = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/build/a-card", sha);
  if (checker) git("notes", "--ref=refs/notes/checker", "add", "-m", checker, sha);
  if (security) git("notes", "--ref=refs/notes/security", "add", "-m", security, sha);
  const T = Date.now();
  const tips = [{ branch: "build/a-card", sha, at: T, message }, { branch: "main", sha: main, at: T - 1000, message: "base" }];
  return cardState({ id: "a-card", num: 1163, level: "Quick", phase: "plan", ...card }, { git: (args) => git(...args), remote: "origin", main: "main", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, tips, live: null, versionPattern: null }, config, T);
}

test("the probe: a note signs only with its first word; HOLD and STOP are no sign-off and no finding; FINDINGS is a finding", () => {
  assert.deepEqual(read({}, { checker: "PASS (Quick)", security: "SECURE" }).signed, ["checker", "security"]);
  const hold = read({}, { checker: "HOLD until the suite is green", security: "STOP" });
  assert.deepEqual(hold.signed, [], "HOLD and STOP sign nothing");
  assert.equal(Object.hasOwn(hold, "findings"), false, "and are no findings either");
  assert.equal(hold.phase, "checker", "the card still waits for Checker");
  const found = read({}, { checker: "FINDINGS: F1 ..." });
  assert.deepEqual(found.findings, ["checker"]);
  assert.deepEqual(found.signed, []);
});

test("the probe: a Quick board card with Security skipped by the level still waits for Security after Checker's PASS; the same card of another repository, or with no repo word, does not", () => {
  const config = cfg([{ phase: "security", unlessLevel: "Full" }]);
  const board = read({ repo: "flight-board" }, { checker: "PASS", config });
  assert.equal(board.phase, "security", "the board card waits for Security");
  assert.deepEqual(board.waitingFor, ["security"]);
  const other = read({ repo: "site-one" }, { checker: "PASS", config });
  assert.equal(other.phase, "ship", "another repository's Quick card keeps the typed rule");
  const none = read({}, { checker: "PASS", config });
  assert.equal(none.phase, "ship", "a card with no repo word keeps the typed rule");
  assert.equal(read({ repo: "flight-board" }, { checker: "PASS", security: "SECURE", config }).phase, "ship", "signed by both: ship");
  assert.equal(read({ repo: "board" }, { checker: "PASS", config }).phase, "security", "the word board is the board's repository too");
});

test("securityAlways, wantsSecurity and shownLevel agree: board cards always, Full cards, a raised or signed Security review; the two repo-word lists are the same", () => {
  assert.deepEqual([...BOARD_WORDS].sort(), [...BOARD_REPO_WORDS].sort());
  assert.equal(securityAlways("flight-board"), true);
  assert.equal(securityAlways("board"), true);
  for (const w of ["", null, undefined, "site-one", "Flight-Board"]) assert.equal(securityAlways(w), false, String(w));
  const table = [
    [{ review_level: "Quick", repo: "flight-board" }, {}, true],
    [{ review_level: "Quick", repo: "site-one" }, {}, false],
    [{ review_level: "Quick", repo: "" }, {}, false],
    [{ review_level: "Full", repo: "site-one" }, {}, true],
    [{ review_level: "Quick", repo: "site-one" }, { waitingFor: ["security"] }, true],
    [{ review_level: "Quick", repo: "site-one" }, { signed: ["checker", "security"] }, true],
    [{ review_level: "Quick", repo: "site-one" }, { signed: ["checker"] }, false],
  ];
  for (const [card, ev, want] of table) {
    assert.equal(wantsSecurity({ ...card, ...ev }), want, JSON.stringify([card, ev]));
    assert.equal(shownLevel(card.review_level, ev, card.repo) === "Full", card.review_level === "Full" || want, `shownLevel ${JSON.stringify([card, ev])}`);
  }
  assert.equal(shownLevel("Quick", { reviews: { security: 1 } }, null), "Full", "a signed-review time still counts");
  assert.equal(shownLevel("Quick", undefined), "Quick", "the old two-argument call");
});

// ---- the dispatch ----
const NOW = 1_800_000_000_000, MIN = 60e3;
const ROSTER = ["Manager", "Boardsmith", "Checker", "Security", "Release"], LEAD = "Manager";
const idle = { state: "idle", lastActivityAt: NOW - 2 * MIN, since: NOW - 2 * MIN };
const card = (id, extra = {}) => ({ id, num: Number(id.replace(/\D/g, "")) || null, owner_role: "Boardsmith", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "", ...extra });
const world = (cards, ev) => ({ cards, asks: [], stackSwitch: [{ repo: "board", stack: false, set_by: "default", set_at: 0 }], evidence: { agents: { readAt: NOW - 5_000, value: Object.fromEntries(ROSTER.map((r) => [r, idle])) }, ...Object.fromEntries(Object.entries(ev).map(([id, v]) => [`cards.${id}`, { readAt: NOW - 5_000, value: v }])) } });
const who = (v) => dispatchRun(v, { dir: mkdtempSync(join(tmpdir(), "sig-")), roster: ROSTER, lead: LEAD, now: NOW }).items.map((i) => `${i.card}:${i.role}:${i.step}`).sort();
const pushed = { lit: ["checker"], phase: "checker", headSha12: "1".repeat(12), signed: [], onMain: false };

test("the dispatch: a Quick card of the board's repository wakes Security beside Checker; a Quick card of another repository, or with no repo word, wakes Checker alone", () => {
  assert.deepEqual(who(world([card("c1-base", { repo: "flight-board" })], { "c1-base": pushed })), ["c1-base:Checker:review", "c1-base:Security:review"]);
  assert.deepEqual(who(world([card("c1-base", { repo: "site-one" })], { "c1-base": pushed })), ["c1-base:Checker:review"]);
  assert.deepEqual(who(world([card("c1-base")], { "c1-base": pushed })), ["c1-base:Checker:review"]);
  assert.deepEqual(who(world([card("c1-base", { repo: "flight-board" })], { "c1-base": { ...pushed, signed: ["checker", "security"] } })).filter((x) => /Security/.test(x)), [], "signed Security is not woken again");
});
