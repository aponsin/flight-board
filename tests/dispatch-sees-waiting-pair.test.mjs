// #C1013, second case (Builder, 11-12 ~3:15 am MT): a landed card of the product repository (a repo word that is not the board's, #C994) was sent "build the deploy pair".
// Pairs are for the board's own repository; a product deploy comes from Release's ship.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { turnsOf, dispatchInput, BOARD_REPO_WORDS } from "../collector/store-dispatch.mjs";
import { dispatchJob } from "../collector/probe-board.mjs";
import { waitingPair, descends, pairCoversFor } from "../collector/pair-wait.mjs";
import { checkConfig, fullConfig } from "../scripts/config.mjs";

const SHA = "e0582383ef48" + "a".repeat(28);
const ev = (o = {}) => ({ phase: "ship", headSha12: SHA.slice(0, 12), headSha: SHA, headBranch: "main", repoFull: "aponsin/flight-board", signed: ["checker", "security"], onMain: true, ...o });
const card = (repo) => ({ id: "c-x", num: 1013, owner_role: "Builder", repo });

test("a landed card of the board's repository (either repo word the board uses) gets the pair turn", () => {
  for (const repo of ["flight-board", "board"]) {
    const t = turnsOf(card(repo), ev());
    assert.deepEqual(t.map((x) => [x.role, x.step]), [["Builder", "pair"]], repo);
  }
});

test("a landed card of a product repository gets no pair turn, whatever its signatures", () => {
  for (const repo of ["shopsite", "acme", "acme/shop-site"]) {
    assert.deepEqual(turnsOf(card(repo), ev({ repoFull: "acme/shop-site", headSha: SHA })), [], repo);
  }
});

test("a card with no repo word keeps its old reading: no pair turn", () => {
  for (const repo of [null, undefined, ""]) assert.deepEqual(turnsOf(card(repo), ev()), [], String(repo));
});

test("the board's repo words are exactly flight-board and board", () => {
  assert.deepEqual([...BOARD_REPO_WORDS].sort(), ["board", "flight-board"]);
});

// ---- the first case: a built pair that waits for install covers the card it descends from ----
const pairFile = (dir, n, sha) => writeFileSync(join(dir, `board-store-deploy-pc${n}.mjs`), `// pair ${n}\nconst SIGNED = "${sha}";\n`);
const done = (dir, n, sha) => writeFileSync(join(dir, `board-store-deploy-pc${n}.done`), `${sha}\n`);
const S1 = "1".repeat(40), S2 = "2".repeat(40), S3 = "3".repeat(40);

test("waitingPair: the newest pair when it has not run; none when it ran, has no pin, or the folder is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "pw-"));
  assert.equal(waitingPair(dir), null, "an empty folder");
  assert.equal(waitingPair(join(dir, "nope")), null, "no folder");
  assert.equal(waitingPair(""), null); assert.equal(waitingPair(undefined), null);
  pairFile(dir, 42, S1); done(dir, 42, S1);
  assert.equal(waitingPair(dir), null, "the newest ran");
  pairFile(dir, 43, S2);
  assert.deepEqual(waitingPair(dir), { n: 43, sha: S2 }, "a newer pair that has not run waits");
  writeFileSync(join(dir, "board-store-deploy-pc43.done"), `${S3}\n`);
  assert.deepEqual(waitingPair(dir), { n: 43, sha: S2 }, "a marker holding another sha is no deploy");
  done(dir, 43, S2);
  assert.equal(waitingPair(dir), null, "now it ran");
  writeFileSync(join(dir, "board-store-deploy-pc44.mjs"), "// no pin\n");
  assert.equal(waitingPair(dir), null, "a deploy file with no pin is no pair");
  pairFile(dir, 9, S3);
  assert.equal(waitingPair(dir), null, "a lower number does not count as the newest (44 has no pin)");
});

test("descends: the landing is the pin or an ancestor of it, on a real repository; anything it cannot answer is no", () => {
  const dir = mkdtempSync(join(tmpdir(), "pw-git-")), git = (...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=none", ...a], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  const commit = (m) => { writeFileSync(join(dir, "f"), m); git("add", "f"); git("commit", "-q", "-m", m); return git("rev-parse", "HEAD"); };
  const a = commit("a"), b = commit("b"), c = commit("c");
  git("checkout", "-q", "-b", "side", a); const d = commit("d");
  const run = (args) => { try { execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" }); return { status: 0 }; } catch (e) { return { status: e.status }; } };
  assert.equal(descends(run, a, c), true, "an ancestor");
  assert.equal(descends(run, b, c), true);
  assert.equal(descends(run, c, c), true, "the pin itself");
  assert.equal(descends(run, c, a), false, "a commit after the pin");
  assert.equal(descends(run, d, c), false, "a commit not on the pin's line");
  for (const bad of [undefined, "", "abc", "g".repeat(40), "-x"]) assert.equal(descends(run, bad, c), false, String(bad));
  assert.equal(descends(() => { throw new Error("no git"); }, a, c), false, "git failing is no");
  // pairCoversFor, end to end: the folder's waiting pair pinned at c
  const pairs = mkdtempSync(join(tmpdir(), "pw-pairs-"));
  assert.equal(pairCoversFor({ folder: "", repoPath: dir }), null, "no folder set: skip nothing");
  assert.equal(pairCoversFor({ folder: pairs, repoPath: dir }), null, "no pair waits: skip nothing");
  pairFile(pairs, 5, c);
  const covers = pairCoversFor({ folder: pairs, repoPath: dir });
  assert.equal(covers(a), true); assert.equal(covers(d), false);
  assert.equal(pairCoversFor({ folder: pairs, repoPath: "" }), null, "no repository to ask: skip nothing");
});

test("a card the waiting pair covers gets no pair turn; one it does not cover, or any card with no pair waiting, still does", () => {
  const board = { id: "c-x", num: 987, owner_role: "Builder", repo: "board" };
  const covering = (sha) => sha === SHA;
  assert.deepEqual(turnsOf(board, ev(), { pairCovers: covering }), [], "covered: no build turn");
  assert.deepEqual(turnsOf(board, ev({ headSha: "f".repeat(40), headSha12: "f".repeat(12) }), { pairCovers: covering }).map((t) => t.step), ["pair"], "landed after the pin: still told to build");
  assert.deepEqual(turnsOf(board, ev(), { pairCovers: () => false }).map((t) => t.step), ["pair"], "a pair below the landing");
  assert.deepEqual(turnsOf(board, ev()).map((t) => t.step), ["pair"], "no pair waiting (no function): today's behaviour");
  assert.deepEqual(turnsOf(board, ev({ headSha: undefined }), { pairCovers: () => true }).map((t) => t.step), ["pair"], "no full sha to ask about: not skipped");
  assert.deepEqual(turnsOf(board, ev(), { pairCovers: () => { return "yes"; } }).map((t) => t.step), ["pair"], "only a true answer skips");
});

test("dispatchInput passes the covering function down: a landed board card in the view loses its pair turn only when the pair covers it", () => {
  const now = 1_700_000_000_000;
  const view = { evidence: { agents: { value: { Builder: { state: "idle", since: now - 60e3 } }, readAt: now - 1000 }, "cards.landed-card": { value: ev() } }, cards: [{ id: "landed-card", num: 1013, owner_role: "Builder", repo: "board" }] };
  const stepsOf = (opts) => (dispatchInput(view, now, opts)?.cards ?? []).flatMap((k) => k.turns.map((t) => t.step));
  assert.deepEqual(stepsOf({}), ["pair"], "no covering function: the pair turn");
  assert.deepEqual(stepsOf({ pairCovers: () => false }), ["pair"]);
  assert.deepEqual(stepsOf({ pairCovers: (sha) => sha === SHA }), [], "covered: the card has no turn");
});

test("the dispatch job, from the folder and the repository: the written dispatch.json has no pair line for a covered card, and has one with no folder set", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pw-job-repo-")), git = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=none", ...a], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "f"), "1"); git("add", "f"); git("commit", "-q", "-m", "one"); const landing = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "f"), "2"); git("add", "f"); git("commit", "-q", "-m", "two"); const pin = git("rev-parse", "HEAD");
  const pairs = mkdtempSync(join(tmpdir(), "pw-job-pairs-")); pairFile(pairs, 7, pin);
  const now = Date.now();
  const view = { evidence: { agents: { value: { Builder: { state: "idle", since: now - 120e3 } }, readAt: now - 1000 }, "cards.landed-card": { value: ev({ headSha: landing, headSha12: landing.slice(0, 12) }) } }, cards: [{ id: "landed-card", num: 1013, owner_role: "Builder", repo: "board" }] };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => view });
  const itemsFor = async (extra) => { const dir = mkdtempSync(join(tmpdir(), "pw-job-dir-")); const r = await dispatchJob({ base: "https://x.example", headers: {}, fetchImpl, dir, roster: ["Builder"], lead: "Manager", ...extra }); return r.items.map((i) => i.step); };
  assert.deepEqual(await itemsFor({ pairFolder: pairs, repoPath: repo }), [], "the waiting pair covers the landing");
  assert.deepEqual(await itemsFor({ pairFolder: "", repoPath: repo }), ["pair"], "no folder set: today's behaviour");
});

test("collector.pairFolder is an absolute folder (or ~/…), empty for none, and has no default", () => {
  assert.equal(fullConfig({}).collector.pairFolder, "");
  for (const ok of ["", "/Users/o/Documents/Packs", "~/Documents/Packs"]) assert.deepEqual(checkConfig({ collector: { pairFolder: ok } }), [], ok);
  for (const bad of ["relative/dir", "/a/../b", "/a/./b", "-x", 5, "/a\nb"]) assert.ok(checkConfig({ collector: { pairFolder: bad } }).some((m) => /pairFolder/.test(m)), String(bad));
});
