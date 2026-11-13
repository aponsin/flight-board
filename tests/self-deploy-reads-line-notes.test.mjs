// #C1045: the self-deploy gate accepts a group landed with each role's line note on its tip (#C1032), as the release tool landed it, from one shared
// set of functions in the pinned gate file. Must still refuse: an unsigned commit in the range outside every line; a line from a base before the
// Worker's BUILD_SHA; a line over a merge commit or more than GROUP_MAX commits; one role's line never signs for the other role.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import * as gate from "../scripts/self-deploy-gate.mjs";
import * as release from "../scripts/board-release.mjs";

function repo(n) {
  const dir = mkdtempSync(join(tmpdir(), "gate-lines-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  git("init", "-q", "-b", "main");
  const c = [];
  for (let i = 0; i < n; i++) { git("commit", "-q", "--allow-empty", "-m", `c${i}`); c.push(git("rev-parse", "HEAD")); }
  const note = (who, sha, text) => git("notes", `--ref=${who}`, "add", "-f", "-m", text, sha);
  const quiet = (a) => { try { return execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { return null; } };
  const verdict = (commit, current) => {
    const descends = quiet(["merge-base", "--is-ancestor", current, commit]) !== null;
    const { notes, range } = gate.gatherFacts({ commit, current, descends, quiet });
    return gate.gateVerdict({ commit, tip: commit, notes, current, descends, skipInstall: true, range });
  };
  return { c, git, note, verdict, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("one copy: the release tool's line-note rules are the gate's own functions", () => {
  assert.equal(release.roleLineBase, gate.roleLineBase);
  assert.equal(release.ROLE_WORD, gate.ROLE_WORD);
  assert.equal(release.GROUP_MAX, gate.GROUP_MAX);
  assert.equal(release.lineSign, gate.lineBase);
  const src = readFileSync(new URL("../scripts/board-release.mjs", import.meta.url), "utf8");
  assert.match(src, /roleUnsigned\(\{ role, list, notes, covered: range \}\)/, "groupCoverage counts through the shared roleUnsigned");
  assert.doesNotMatch(src, /self-deploy will refuse until signed per commit/, "the old warning is gone");
});

test("a group landing with only the tip's line notes deploys, each role on its own base", () => {
  const h = repo(5);
  try {
    const [c0, c1, , , c4] = h.c;
    // Worker at c0; the group is c1..c4 with no notes of their own. Checker's line from c0, Security's from c0 too.
    h.note("checker", c4, `PASS Full, line from ${c0}`); h.note("security", c4, `SECURE line from ${c0}`);
    const v = h.verdict(c4, c0);
    assert.equal(v.ok, true, v.refusals.join("\n"));
    // The roles need not name the same base: c1 signed per commit by both, Security's line from c1.
    h.note("checker", c1, "PASS Full"); h.note("security", c1, "SECURE");
    h.note("security", c4, `SECURE line from ${c1}`);
    const w = h.verdict(c4, c0);
    assert.equal(w.ok, true, w.refusals.join("\n"));
  } finally { h.done(); }
});

test("must still refuse: an unsigned commit in the range that no line covers, and one role's line never signs for the other", () => {
  const h = repo(5);
  try {
    const [c0, c1, c2, , c4] = h.c;
    // Lines from c2: c1 and c2 are outside them and unsigned.
    h.note("checker", c4, `PASS line from ${c2}`); h.note("security", c4, `SECURE line from ${c2}`);
    let v = h.verdict(c4, c0);
    assert.equal(v.ok, false);
    assert.match(v.refusals.join(), new RegExp(`no SECURE and PASS: ${c2.slice(0, 12)}, ${c1.slice(0, 12)}`));
    // Checker's line from c0 covers c1..c4 for Checker only; Security's from c2 leaves c1, c2 without SECURE.
    h.note("checker", c4, `PASS line from ${c0}`);
    v = h.verdict(c4, c0);
    assert.equal(v.ok, false);
    assert.match(v.refusals.join(), new RegExp(c1.slice(0, 12)));
    // A commit's own FINDINGS from Checker is covered only by Checker's line over it.
    h.note("security", c4, `SECURE line from ${c0}`);
    h.note("checker", c2, "FINDINGS Full: F1");
    assert.equal(h.verdict(c4, c0).ok, true, "Checker's line over c2 covers its own FINDINGS");
    h.note("checker", c4, `PASS line from ${c2}`); h.note("checker", c1, "PASS"); // Checker's line no longer reaches c2
    v = h.verdict(c4, c0);
    assert.equal(v.ok, false);
    assert.match(v.refusals.join(), new RegExp(c2.slice(0, 12)));
  } finally { h.done(); }
});

test("must still refuse: a line from before the Worker's BUILD_SHA, over a merge commit, or over more than GROUP_MAX commits covers nothing", () => {
  const h = repo(4);
  try {
    const [c0, c1, , c3] = h.c;
    h.note("checker", c3, `PASS line from ${c0}`); h.note("security", c3, `SECURE line from ${c0}`);
    assert.equal(h.verdict(c3, c1).ok, false, "base c0 is before the Worker at c1");
    // A merge inside the line.
    h.git("checkout", "-q", "-b", "side", c1);
    h.git("commit", "-q", "--allow-empty", "-m", "side");
    h.git("checkout", "-q", "main");
    h.git("merge", "-q", "--no-ff", "-m", "merge", "side");
    const m = h.git("rev-parse", "HEAD");
    h.note("checker", m, `PASS line from ${c1}`); h.note("security", m, `SECURE line from ${c1}`);
    const v = h.verdict(m, c1);
    assert.equal(v.ok, false, "a line over a merge covers nothing");
  } finally { h.done(); }
  const big = repo(gate.GROUP_MAX + 2);
  try {
    const c0 = big.c[0], tip = big.c.at(-1);
    big.note("checker", tip, `PASS line from ${c0}`); big.note("security", tip, `SECURE line from ${c0}`);
    assert.equal(big.verdict(tip, c0).ok, false, `${gate.GROUP_MAX + 1} commits under one line`);
    const base = big.c[1];
    big.note("checker", tip, `PASS line from ${base}`); big.note("security", tip, `SECURE line from ${base}`);
    big.note("checker", base, "PASS"); big.note("security", base, "SECURE");
    const ok = big.verdict(tip, c0);
    assert.equal(ok.ok, true, `exactly GROUP_MAX is fine: ${ok.refusals.join()}`);
  } finally { big.done(); }
});

test("gateVerdict per role: covered { checker } alone leaves the commit without SECURE; covered true still means both", () => {
  const A = "a".repeat(40), B = "b".repeat(40), signed = { checker: "PASS", security: "SECURE" };
  const facts = (range) => ({ commit: A, tip: A, notes: signed, current: B, descends: true, skipInstall: true, range });
  assert.equal(gate.gateVerdict(facts([{ sha: "1".repeat(40), covered: { checker: true, security: false }, notes: {} }, { sha: A, notes: signed }])).ok, false);
  assert.equal(gate.gateVerdict(facts([{ sha: "1".repeat(40), covered: { checker: true, security: false }, notes: { security: "SECURE" } }, { sha: A, notes: signed }])).ok, true);
  assert.equal(gate.gateVerdict(facts([{ sha: "1".repeat(40), covered: true, notes: {} }, { sha: A, notes: signed }])).ok, true);
});
