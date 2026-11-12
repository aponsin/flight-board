// #C1032: one sign for a group, and no tip-only gap. Release used to read only the tip's own notes, so a stack's lower commits could go out unsigned; and a
// group of 3 to 5 cards needed 3 to 5 sign-offs each. Now every commit of origin/main..tip needs, per role (Checker's PASS, Security's SECURE), a note of its
// own or that role's "line from <40-hex base>" note on the tip. Real temporary repositories; fictional names. Security's rules, one test each.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupCoverage, groupFacts, roleLineBase, verdict, GROUP_MAX } from "../scripts/board-release.mjs";

// A repository: main at M0 then M, a line c1..cN on M. note(role, sha, text) writes in a test notes ref; cov(tip) is what release computes.
function world(n = 3) {
  const dir = mkdtempSync(join(tmpdir(), "grp-"));
  const g = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  g("init", "-q", "-b", "main");
  const commit = (m) => { g("commit", "-q", "--allow-empty", "-m", m); return g("rev-parse", "HEAD"); };
  const M0 = commit("m0"), M = commit("m"), c = [];
  g("checkout", "-q", "-b", "line");
  for (let i = 1; i <= n; i++) c.push(commit(`c${i}`));
  const quiet = (a) => { try { return g(...a); } catch { return null; } };
  const note = (role, sha, text) => g("notes", `--ref=t-${role}`, "add", "-f", "-m", text, sha);
  const cov = (tip = c[c.length - 1], main = M) => groupCoverage(groupFacts({ quiet, git: (a) => g(...a), main, tip, noteRef: (r) => `t-${r}` }));
  return { g, commit, M0, M, c, note, cov, quiet };
}
const sign = (w, shas, roles = ["checker", "security"]) => shas.forEach((s) => { if (roles.includes("checker")) w.note("checker", s, "PASS Quick"); if (roles.includes("security")) w.note("security", s, "SECURE"); });
const lineNote = (w, base, tip = w.c[w.c.length - 1], roles = ["checker", "security"]) => { if (roles.includes("checker")) w.note("checker", tip, `PASS Full line from ${base}`); if (roles.includes("security")) w.note("security", tip, `SECURE line from ${base}`); };
const short = (s) => s.slice(0, 12);

test("every commit signed by its own notes: covered, no line note used", () => {
  const w = world(); sign(w, w.c);
  assert.deepEqual(w.cov(), { refusals: [], usedLine: [] });
});

test("the tip-only gap is closed: a signed tip over unsigned middle commits is refused, naming each uncovered commit, per role", () => {
  const w = world(); sign(w, [w.c[2]]);
  const r = w.cov();
  assert.equal(r.refusals.length, 2);
  for (const who of ["Checker", "Security"]) assert.ok(r.refusals.some((x) => x.includes(`no ${who === "Checker" ? "PASS" : "SECURE"} from ${who}`) && x.includes(short(w.c[0])) && x.includes(short(w.c[1])) && !x.includes(short(w.c[2]))), who + ": " + r.refusals.join(" | "));
  const one = world(); sign(one, [one.c[0], one.c[2]], ["checker"]); sign(one, one.c, ["security"]);
  assert.match(one.cov().refusals.join(), /a commit has no PASS from Checker.*/); assert.ok(one.cov().refusals.join().includes(short(one.c[1])));
});

test("a line note on the tip, from each role, covers base..tip: one sign for the group", () => {
  const w = world(); lineNote(w, w.M);
  assert.deepEqual(w.cov(), { refusals: [], usedLine: ["checker", "security"] });
  assert.equal(roleLineBase("checker", `PASS Full line from ${w.M}`), w.M);
});

test("mixed coverage passes either way: Checker per commit with Security by a line note, and the other way round; a role's own note on the lines' commits is fine", () => {
  const w = world(); sign(w, w.c, ["checker"]); w.note("security", w.c[2], `SECURE line from ${w.M}`);
  assert.deepEqual(w.cov(), { refusals: [], usedLine: ["security"] });
  const x = world(); sign(x, x.c, ["security"]); x.note("checker", x.c[2], `PASS line from ${x.M}`);
  assert.deepEqual(x.cov(), { refusals: [], usedLine: ["checker"] });
  const y = world(); lineNote(y, y.M); y.note("checker", y.c[0], "PASS Quick");
  assert.deepEqual(y.cov(), { refusals: [], usedLine: ["checker", "security"] }, "a lower commit with its own PASS under the line note is still fine");
  const z = world(); z.note("checker", z.c[2], `PASS line from ${z.c[0]}`);
  assert.match(z.cov().refusals.join("\n"), /Checker line note.*does not count: it is not an ancestor of origin\/main/, "a base on the line itself is not where the line left main");
});

test("refuse (h): the wrong role's word: a PASS line in the security ref, or a SECURE line in the checker ref, covers nothing", () => {
  const w = world(); w.note("checker", w.c[2], `PASS line from ${w.M}`); w.note("security", w.c[2], `PASS line from ${w.M}`);
  const r = w.cov().refusals.join("\n");
  assert.match(r, /Security note that is not SECURE/); assert.ok(r.includes(short(w.c[0])), "the lower commits are uncovered for Security");
  const y = world(); y.note("checker", y.c[2], `SECURE line from ${y.M}`); y.note("security", y.c[2], `SECURE line from ${y.M}`);
  assert.match(y.cov().refusals.join("\n"), /Checker note that is not PASS/);
});

test("refuse (b): the tip moved after the note: a line note on an older commit does not cover a newer tip", () => {
  const w = world(); lineNote(w, w.M);
  const newer = w.commit("c4");
  const r = w.cov(newer).refusals.join("\n");
  assert.ok(r.includes(short(newer)), r);
  assert.equal(w.cov(newer).refusals.length, 2, "one refusal per role");
});

test("refuse (c): a base that is not an ancestor of origin/main, or not of the tip", () => {
  const w = world(); const side = (() => { w.g("checkout", "-q", "-b", "side", w.M); const s = w.commit("side"); w.g("checkout", "-q", "line"); return s; })();
  lineNote(w, side); // side is on neither main nor the line
  const r = w.cov().refusals.join("\n");
  assert.match(r, /Checker line note.*does not count: it is not an ancestor of origin\/main/);
  assert.match(r, /Security line note.*does not count/);
  const v = world(); v.g("checkout", "-q", "main"); const ahead = v.commit("main moves"); v.g("checkout", "-q", "line");
  lineNote(v, ahead); // an ancestor of (a moved) main, not of the tip
  assert.match(v.cov(v.c[2], ahead).refusals.join("\n"), /not an ancestor of the tip/);
});

test("refuse (d): a base before where the tip's line left origin/main covers none of main's own commits", () => {
  const w = world(); lineNote(w, w.M0);
  assert.match(w.cov().refusals.join("\n"), /before the point where the tip's line left origin\/main/);
});

test("refuse (e): more than GROUP_MAX commits under one line note", () => {
  const w = world(GROUP_MAX + 1); lineNote(w, w.M);
  assert.match(w.cov().refusals.join("\n"), new RegExp(`covers ${GROUP_MAX + 1} commits: a group is at most ${GROUP_MAX}`));
  const ok = world(GROUP_MAX); lineNote(ok, ok.M);
  assert.deepEqual(ok.cov().refusals, [], "exactly GROUP_MAX is fine");
});

test("refuse (f): a merge commit inside the range: groups are linear", () => {
  const w = world(1); w.g("checkout", "-q", "-b", "side", w.M); const s = w.commit("side"); w.g("checkout", "-q", "line");
  w.g("merge", "-q", "--no-ff", "-m", "merge", "side"); const tip = w.commit("after merge");
  lineNote(w, w.M, tip);
  assert.match(w.cov(tip).refusals.join("\n"), /merge commit: groups are linear/);
  assert.ok(s);
});

test("refuse (g), per role (#C934): a commit's own non-word note (RISKS/FINDINGS/STOP/withdrawn) is covered only by that same role's valid line note", () => {
  for (const bad of ["RISKS one", "FINDINGS two", "STOP", "withdrawn: do not release"]) {
    // Same role's line note over it: covered, and the line note counts as used.
    const w = world(); lineNote(w, w.M); w.note("security", w.c[1], bad);
    assert.deepEqual(w.cov(), { refusals: [], usedLine: ["checker", "security"] }, bad);
    // Only the other role's line note on the tip: refused, named.
    const x = world(); lineNote(x, x.M, x.c[2], ["checker"]); sign(x, x.c, ["security"]); x.note("security", x.c[1], bad);
    const r = x.cov().refusals.join("\n");
    assert.ok(r.includes(`${short(x.c[1])} has a Security note that is not SECURE: "${bad.slice(0, 40)}`), bad + " :: " + r);
  }
  const w = world(); w.note("checker", w.c[0], "FINDINGS x"); sign(w, w.c, ["security"]); w.note("checker", w.c[1], "PASS"); w.note("checker", w.c[2], "PASS");
  assert.match(w.cov().refusals.join("\n"), /has a Checker note that is not PASS/, "no line note at all");
  // A FINDINGS on a commit the line note does not reach: the base counts only from where the line left main, and a base on the line itself does not count.
  const y = world(); lineNote(y, y.c[0]); y.note("checker", y.c[0], "FINDINGS x");
  assert.match(y.cov().refusals.join("\n"), /has a Checker note that is not PASS/);
});

test("groupFacts: a failed rev-list is an error, not a group of the tip alone; an empty range still falls back to the tip", () => {
  const w = world(); const tip = w.c[2];
  const boom = (a) => { throw new Error("rev-list failed"); };
  assert.throws(() => groupFacts({ quiet: w.quiet, git: boom, main: w.M, tip, noteRef: (r) => `t-${r}` }), /rev-list failed/);
  sign(w, [tip]);
  assert.deepEqual(groupCoverage(groupFacts({ quiet: w.quiet, git: (a) => w.g(...a), main: tip, tip, noteRef: (r) => `t-${r}` })), { refusals: [], usedLine: [] });
});

test("a base that is not 40 hex, or a note whose first line only mentions a base later, is no line note", () => {
  for (const text of [`PASS line from ${"a".repeat(12)}`, `PASS\nline from ${"0".repeat(40)}`, `PASS Full, see the line from ${"x".repeat(40)}`]) assert.equal(roleLineBase("checker", text), null, text);
  const w = world(); w.note("checker", w.c[2], "PASS line from abc123"); w.note("security", w.c[2], "SECURE");
  assert.match(w.cov().refusals.join("\n"), /no PASS from Checker.*/);
});

test("the verdict takes the coverage in place of the tip-only note check; without it the older check stands", () => {
  const good = { forward: true, notes: { security: "SECURE", checker: "PASS" }, pinned: "a".repeat(40), changed: ["page/board.template.html"], owned: [], settingsChanged: false, stepsChanged: false, promptChanged: false, capabilities: ["db"] };
  assert.equal(verdict(good).ok, true);
  assert.equal(verdict({ ...good, coverage: { refusals: [], usedLine: [] } }).ok, true);
  const v = verdict({ ...good, coverage: { refusals: ["3 commits have no PASS from Checker, by a note of its own or a line note on the tip: aaa"], usedLine: [] } });
  assert.equal(v.ok, false); assert.match(v.refusals.join(), /3 commits have no PASS/);
  assert.equal(verdict({ ...good, notes: {}, coverage: { refusals: [], usedLine: [] } }).ok, true, "the coverage, not the tip's own notes, decides");
  assert.equal(verdict({ ...good, notes: {} }).ok, false, "no coverage: the tip's notes are read as before");
});
