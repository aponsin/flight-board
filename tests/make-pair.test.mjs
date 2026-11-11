// #C856: scripts/make-pair.mjs writes the whole deploy pair (deploy, tree, steps) for a sha on origin main, with the hash-checked lines and
// what changed since the last pair. Real git: a bare origin and a clone.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { makeAll, groupPaths, lastPair } from "../scripts/make-pair.mjs";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "fb-pair-"));
  const bare = join(dir, "origin.git"), work = join(dir, "work"), out = join(dir, "out");
  mkdirSync(out);
  const g = (...a) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...a], { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g("remote", "add", "origin", bare);
  const commit = (subject, files) => { for (const [f, t] of Object.entries(files)) { mkdirSync(join(work, f, ".."), { recursive: true }); writeFileSync(join(work, f), t); } g("add", "-A"); g("commit", "-qm", subject); return g("rev-parse", "HEAD"); };
  return { g, work, out, commit };
}
const sha256 = (t) => createHash("sha256").update(t).digest("hex");

test("the three files are written and the hashes in the steps file are the files' own", () => {
  const { g, work, out, commit } = repo();
  const a = commit("base (#C100)", { "worker/a.mjs": "1\n" });
  g("push", "-q", "origin", "main");
  const r = makeAll({ repo: work, sha: a, n: 1, out });
  assert.equal(r.ok, true, r.why);
  // #C924: board-deploy.mjs, the one command for lines 1 and 2, is copied in beside them.
  assert.deepEqual(readdirSync(out).sort(), ["board-deploy.mjs", "board-store-deploy-pc1.mjs", "board-store-pc1-steps.md", "board-store-tree-pc1.mjs"]);
  const steps = readFileSync(join(out, "board-store-pc1-steps.md"), "utf8");
  for (const f of ["board-store-deploy-pc1.mjs", "board-store-tree-pc1.mjs"]) {
    const h = sha256(readFileSync(join(out, f), "utf8"));
    assert.equal(r.files[f], h);
    assert.ok(steps.includes(`shasum -a 256 ${out}/${f} | cut -c1-64)" = ${h} ]`), `${f}: the check line holds the file's hash`);
    assert.ok(steps.includes(`node ${out}/${f}`));
  }
  assert.match(steps, new RegExp(`Pinned to flight-board main ${a}`));
  assert.match(readFileSync(join(out, "board-store-deploy-pc1.mjs"), "utf8"), new RegExp(`const SIGNED = "${a}"`));
  assert.match(readFileSync(join(out, "board-store-tree-pc1.mjs"), "utf8"), new RegExp(`const NEW = "${a}"`));
  assert.equal(r.files["board-store-pc1-steps.md"], sha256(steps));
});

test("a sha that is not on origin main is refused and nothing is written", () => {
  const { g, work, out, commit } = repo();
  commit("base", { "f": "0\n" });
  g("push", "-q", "origin", "main");
  g("switch", "-q", "-c", "build/x");
  const onBranch = commit("on a branch (#C101)", { "f": "1\n" });
  g("push", "-q", "origin", "build/x");
  const local = commit("local only", { "f": "2\n" });
  for (const [sha, why] of [[onBranch, /is not on origin main/], [local, /is not on origin main/], ["abc123", /full 40-hex/], ["f".repeat(40), /is not in the repository/]]) {
    const r = makeAll({ repo: work, sha, n: 1, out });
    assert.equal(r.ok, false);
    assert.match(r.why, why);
    assert.deepEqual(readdirSync(out), [], "nothing written");
  }
  assert.equal(makeAll({ repo: work, sha: onBranch, n: 0, out }).ok, false, "n from 1");
  assert.equal(makeAll({ repo: work, sha: onBranch, n: 1.5, out }).ok, false);
});

test("the steps file lists what changed since the last pair: commits, paths by kind, a migration, the Worker-first order", () => {
  const { g, work, out, commit } = repo();
  const a = commit("first (#C100)", { "worker/a.mjs": "1\n" });
  g("push", "-q", "origin", "main");
  assert.equal(makeAll({ repo: work, sha: a, n: 1, out }).ok, true);
  assert.deepEqual(lastPair(out, 2), { n: 1, sha: a });
  assert.equal(lastPair(out, 1), null, "none before the first");
  commit("worker and probe (#C200)", { "worker/a.mjs": "2\n", "collector/p.mjs": "x\n" });
  commit("a migration and a test (#C201)", { "worker/migrations/0020_x.sql": "select 1;\n", "tests/t.mjs": "t\n" });
  const b = g("rev-parse", "HEAD");
  g("push", "-q", "origin", "main");
  const r = makeAll({ repo: work, sha: b, n: 2, out });
  assert.equal(r.ok, true, r.why);
  const steps = readFileSync(join(out, "board-store-pc2-steps.md"), "utf8");
  assert.match(steps, new RegExp(`Changed since ${a.slice(0, 8)} \\(pc1\\):`));
  assert.match(steps, /- worker and probe \(#C200\)/);
  assert.match(steps, /- a migration and a test \(#C201\)/);
  assert.match(steps, /- Worker code: worker\/a\.mjs/);
  assert.match(steps, /- database migration: worker\/migrations\/0020_x\.sql/);
  assert.match(steps, /- probe and gate code: collector\/p\.mjs/);
  assert.match(steps, /- tests: tests\/t\.mjs/);
  assert.match(steps, /# pc2: #C200, #C201 at /);
  assert.match(steps, /deploy it first \(line 1\), then the tree/);
  assert.match(steps, /A new secret cannot be seen from the diff/);
  assert.match(steps, /A database migration is part of this deploy/);
  assert.match(readFileSync(join(out, "board-store-deploy-pc2.mjs"), "utf8"), new RegExp(`const SIGNED = "${b}"`));
});

test("no Worker change and no migration say so; an older commit than the last pair is refused (forward only)", () => {
  const { g, work, out, commit } = repo();
  const a = commit("first (#C100)", { "f": "1\n" });
  const b = commit("docs only (#C101)", { "docs/x.md": "d\n" });
  g("push", "-q", "origin", "main");
  assert.equal(makeAll({ repo: work, sha: b, n: 5, out }).ok, true);
  assert.equal(makeAll({ repo: work, sha: a, n: 6, out }).ok, false, "pc5 pins b; a is behind it");
  assert.match(makeAll({ repo: work, sha: a, n: 6, out }).why, /goes? forward only|forward only/);
  const c = commit("more docs (#C102)", { "docs/y.md": "d\n" });
  g("push", "-q", "origin", "main");
  assert.equal(makeAll({ repo: work, sha: c, n: 6, out }).ok, true);
  const steps = readFileSync(join(out, "board-store-pc6-steps.md"), "utf8");
  assert.match(steps, /No Worker code changes/);
  assert.doesNotMatch(steps, /new secret/, "no Worker change: no sentence about a secret pointing at lines that are not there");
  assert.match(steps, /No database migration/);
  assert.match(steps, /- docs: docs\/y\.md/);
});

test("a long commit subject is listed whole, never cut mid-sentence", () => {
  const long = "A long subject " + "word ".repeat(80) + "end of the sentence (#C300)";
  const { g, work, out, commit } = repo();
  const a = commit("first", { "f": "1\n" });
  g("push", "-q", "origin", "main");
  assert.equal(makeAll({ repo: work, sha: a, n: 1, out }).ok, true);
  const b = commit(long, { "docs/z.md": "z\n" });
  g("push", "-q", "origin", "main");
  assert.equal(makeAll({ repo: work, sha: b, n: 2, out }).ok, true);
  assert.ok(readFileSync(join(out, "board-store-pc2-steps.md"), "utf8").includes(`- ${long.replace(/\s+/g, " ")}`));
});

test("paths are grouped by kind, and a wrangler config is flagged apart from Worker code", () => {
  const g = Object.fromEntries(groupPaths(["worker/board-store.mjs", "worker/migrations/0001.sql", "worker/wrangler.board.toml", "page/index.html", "gate/stop.mjs", "hooks/h.py", "README.md", "odd/file"]));
  assert.deepEqual(g["Worker code"], ["worker/board-store.mjs"]);
  assert.deepEqual(g["database migration"], ["worker/migrations/0001.sql"]);
  assert.deepEqual(g["Worker config (check for a new binding or secret)"], ["worker/wrangler.board.toml"]);
  assert.deepEqual(g["page"], ["page/index.html"]);
  assert.deepEqual(g["other"], ["odd/file"]);
});
