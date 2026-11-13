// #C1022 (Security's pick B): the release tool records each tip it lands in refs/notes/landed, as an audit trail only. The gate does not read it,
// because agents running as the same Mac user can write that ref too (docs/DECISIONS.md). Tests: the steps write the note on the landed sha and
// push the ref; a failed note never fails a landing; the gate stays free of the landed ref; the decision is logged.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { landedNoteSteps, LANDED_REF } from "../scripts/board-release.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("the steps add a LANDED note on the landed sha in refs/notes/landed and push that ref to origin, from a real repository", () => {
  const root = mkdtempSync(join(tmpdir(), "landed-"));
  try {
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const g = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
    g(root, "init", "-q", "--bare", "origin.git");
    g(root, "clone", "-q", join(root, "origin.git"), "work");
    const work = join(root, "work");
    g(work, "commit", "-q", "--allow-empty", "-m", "c0");
    const sha = g(work, "rev-parse", "HEAD");
    const at = new Date("2026-11-13T08:00:00.000Z");
    const results = landedNoteSteps(sha, at).map((a) => { try { g(work, ...a); return true; } catch { return false; } });
    assert.deepEqual(results, [false, true, true], "the first fetch fails while origin has no landed notes; the note and the push go");
    assert.equal(g(join(root, "origin.git"), "notes", `--ref=${LANDED_REF}`, "show", sha), "LANDED 2026-11-13T08:00:00.000Z by scripts/board-release.mjs (audit only, #C1022)");
    // A second landing keeps the first one's note (the fetch takes origin's ref before adding).
    g(work, "commit", "-q", "--allow-empty", "-m", "c1");
    const sha2 = g(work, "rev-parse", "HEAD");
    for (const a of landedNoteSteps(sha2, at)) g(work, ...a);
    assert.match(g(join(root, "origin.git"), "notes", `--ref=${LANDED_REF}`, "show", sha), /^LANDED /);
    assert.match(g(join(root, "origin.git"), "notes", `--ref=${LANDED_REF}`, "show", sha2), /^LANDED /);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("must still refuse: no full sha or no valid time writes nothing", () => {
  for (const [s, t] of [["abc", new Date()], ["A".repeat(40), new Date()], ["a".repeat(40), "now"], ["a".repeat(40), new Date("x")]]) assert.throws(() => landedNoteSteps(s, t), /a full sha and a time/);
});

test("the release tool writes the note after the push and before the link, and a failed note never fails the landing", () => {
  const src = read("scripts/board-release.mjs");
  const push = src.indexOf('`${sha}:refs/heads/main`'), note = src.indexOf("landedNoteSteps(sha, new Date())"), link = src.indexOf('[join(self, "current.mjs"), sha');
  assert.ok(push > 0 && note > push && link > note, "push, then the note, then the link");
  assert.match(src, /if \(quiet\(a\) === null && n > 0\) \{ console\.log\(`landed note: not recorded/, "quiet, logged, no throw");
});

test("the gate does not trust the landed note, and the decision says why", () => {
  assert.doesNotMatch(read("scripts/self-deploy-gate.mjs"), /notes\/landed|LANDED/);
  const d = read("docs/DECISIONS.md");
  assert.match(d, /#C1022, Security's pick B/);
  assert.match(d, /audit trail only/);
  assert.match(d, /board deployed <sha>/);
});
