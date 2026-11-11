// #C892 (depends-on-product-live): a card that depends on a product card is released when that card's ship is on the product's origin/main.
// #C873 stayed blocked although #C862 was live: the card carried no repo field, no branch named it any more, so it was read from the team's
// own repository (nothing of it there) and had no state. Real git, one repository per scratch.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { cardState, cardStates } from "../collector/state.mjs";
import { dependsNotLive } from "../worker/board-rules.mjs";

const T0 = 1_790_000_000;
const NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI" } });
const SHIP = "^v(\\d+\\.\\d+\\.\\d+)\\b";
const LIVE = cfg.collector.livePhase;

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-dep-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const branch = (name, msg, t) => { g(["checkout", "-qb", name]); at = T0 + t; appendFileSync(join(work, `${name}.md`), "x\n"); g(["add", "-A"]); g(["commit", "-qm", msg]); g(["checkout", "-q", "main"]); };
  const onMain = (msg, t) => { at = T0 + t; g(["commit", "--allow-empty", "-qm", msg]); };
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["fetch", "-q", "--prune", "origin"]); };
  const tips = () => g(["for-each-ref", "refs/remotes/origin", "--format=%(refname:lstrip=3)%1f%(objectname)%1f%(committerdate:unix)%1f%(contents)%1e"]).split("\x1e")
    .map((r) => r.replace(/^\n/, "")).filter((r) => r.includes("\x1f")).map((r) => { const [b, sha, t, m] = r.split("\x1f"); return { branch: b, sha, at: Number(t) * 1000, message: m }; }).filter((h) => h.branch && h.branch !== "HEAD");
  const repo = (extra = {}) => ({ git: (args) => g(args), remote: "origin", main: "main", notes: NOTES, live: null, versionPattern: null, tips: tips(), ...extra });
  return { g, branch, onMain, sync, repo };
}
const dep = { id: "product-dep", num: 862, level: "Full", phase: "plan" };
const dependent = { id: "dependent-card", num: 873, depends_on: ["product-dep"] };
const waits = (state) => dependsNotLive(dependent, [dep, dependent], { "product-dep": { lit: [state.phase] } });

test("a ship commit on the product's origin/main that cites the card reads it live, and its dependent is released", () => {
  const team = scratch(), product = scratch();
  team.sync();
  product.onMain("v1.209.6: the product card #C862 shipped", 5); product.sync();
  const states = cardStates({ cards: [dep, dependent], config: cfg, repos: { "": team.repo(), product: product.repo({ versionPattern: SHIP }) }, now: (T0 + 99) * 1000 });
  assert.equal(states["product-dep"].phase, LIVE, "read from the product's main, not the team's");
  assert.equal(states["product-dep"].onMain, true);
  assert.equal(waits(states["product-dep"]), false, "the dependent is released");
});

test("a dependent stays blocked while the product card's commit is only on a branch", () => {
  const team = scratch(), product = scratch();
  team.sync();
  product.branch("product-dep", "#C862: the product card, not shipped", 5); product.sync();
  const states = cardStates({ cards: [dep, dependent], config: cfg, repos: { "": team.repo(), product: product.repo({ versionPattern: SHIP }) }, now: (T0 + 99) * 1000 });
  assert.notEqual(states["product-dep"].phase, LIVE);
  assert.equal(waits(states["product-dep"]), true, "still blocked");
});

test("work on main that is not a ship commit does not make the card live", () => {
  const product = scratch();
  product.onMain("#C862: a work commit, no version", 5); product.sync();
  const st = cardState(dep, product.repo({ versionPattern: SHIP }), cfg, (T0 + 99) * 1000);
  assert.equal(st.workSeen, true);
  assert.notEqual(st.phase, LIVE);
  assert.equal(waits(st), true);
});

test("the team's own repository keeps a card its own main carries, and a card nobody carries stays in the team's", () => {
  const team = scratch(), product = scratch();
  team.onMain("v1.0.1: the board card #C862 shipped here", 5); team.sync();
  product.onMain("v1.209.6: another card #C900", 6); product.sync();
  const repos = { "": team.repo({ versionPattern: SHIP }), product: product.repo({ versionPattern: SHIP }) };
  const both = cardStates({ cards: [dep], config: cfg, repos, now: (T0 + 99) * 1000 });
  assert.equal(both["product-dep"].phase, LIVE);
  const none = cardStates({ cards: [{ id: "nobody", num: 4000 }], config: cfg, repos: { "": team.repo(), product: product.repo({ versionPattern: SHIP }) }, now: (T0 + 99) * 1000 });
  assert.equal(none.nobody.workSeen, undefined);
  assert.notEqual(none.nobody.phase, LIVE);
});
