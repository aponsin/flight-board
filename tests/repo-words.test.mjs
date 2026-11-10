// The probe fills in a card's repo word from git (#C742): which cards it names, and that the store never changes a word already set.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { createCard, fillCardRepo } from "../worker/board-store.mjs";
import { idsOf, boardIdsFromGit, repoWordsToFill, fillRepoWords } from "../collector/repo-words.mjs";
import { evidenceJob } from "../collector/probe-evidence.mjs";

const NOW = Date.now();
const REPOS = [{ name: "flight-board", path: "/x/board", mainBranch: "main" }];

test("Board-Id lines are read from the whole message, a trailer block or not", () => {
  assert.deepEqual([...idsOf("s\n\nBoard-Id: c1-a\n\nCo-Authored-By: x\nBoard-Id: C2\n see Board-Id: c3-b")], ["c1-a"]);
});

test("ids come from the configured remote and main branch, and from the tips of its build/ branches", () => {
  const calls = [];
  const git = (args) => { calls.push(args.join(" ")); if (args[0] === "log" && args[1] === "up/trunk") return "Board-Id: on-main\n"; if (args[0] === "for-each-ref") return "refs/remotes/up/build/b1\n"; return "Board-Id: not-landed\n"; };
  assert.deepEqual([...boardIdsFromGit(git, { remote: "up", main: "trunk" })].sort(), ["not-landed", "on-main"]);
  assert.ok(calls.some((c) => c.includes("refs/remotes/up/build/")));
});

test("a card with no repo word whose id a repository holds work for gets that repository's name", () => {
  const cards = [{ id: "a", repo: null }, { id: "b" }, { id: "c", repo: "" }, { id: "team-card", repo: null }];
  const out = repoWordsToFill(cards, REPOS, () => new Set(["a", "b", "c"]));
  assert.deepEqual(out, [{ id: "a", repo: "flight-board" }, { id: "b", repo: "flight-board" }, { id: "c", repo: "flight-board" }]);
});

test("a repo word already set is never offered for change, whatever git says", () => {
  const out = repoWordsToFill([{ id: "a", repo: "other-repo" }, { id: "b", repo: "flight-board" }], REPOS, () => new Set(["a", "b"]));
  assert.deepEqual(out, []);
});

test("a card two repositories claim is left alone; a repository git cannot read, or with a bad name, is skipped", () => {
  const two = [{ name: "one", path: "/1" }, { name: "two", path: "/2" }];
  assert.deepEqual(repoWordsToFill([{ id: "a" }], two, () => new Set(["a"])), []);
  assert.deepEqual(repoWordsToFill([{ id: "a" }], two, (r) => (r.name === "one" ? null : new Set(["a"]))), [{ id: "a", repo: "two" }]);
  assert.deepEqual(repoWordsToFill([{ id: "a" }], [{ name: "Bad Name", path: "/1" }, null, "x"], () => new Set(["a"])), []);
  assert.deepEqual(repoWordsToFill([{ id: "a" }], undefined, () => new Set(["a"])), []);
});

test("real git: a commit on origin/main with the id, above the co-author line, gives the card its repo word", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-"));
  const g = (...a) => execFileSync("git", ["-C", dir, "-c", "user.email=t@e.x", "-c", "user.name=t", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  g("init", "-q", "-b", "main"); writeFileSync(join(dir, "f"), "1"); g("add", "f");
  g("commit", "-q", "-m", "change\n\nBoard-Id: real-card\n\nCo-Authored-By: someone");
  g("update-ref", "refs/remotes/origin/main", "HEAD");
  const posts = [];
  const n = await fillRepoWords({ cards: [{ id: "real-card" }, { id: "other" }], repos: [{ name: "flight-board", path: dir }], base: "https://b.example", headers: {}, fetchImpl: async (u, o) => { posts.push([u, JSON.parse(o.body)]); return { ok: true, status: 200 }; } });
  assert.equal(n, 1);
  assert.deepEqual(posts, [["https://b.example/api/probe/card-repo", { id: "real-card", repo: "flight-board" }]]);
});

test("a refused or failing post is logged and the next card still goes; nothing throws", async () => {
  const log = [], seen = [];
  const fetchImpl = async (u, o) => { const b = JSON.parse(o.body); seen.push(b.id); if (b.id === "a") return { ok: false, status: 422 }; if (b.id === "b") throw new Error("down"); return { ok: true, status: 200 }; };
  const n = await fillRepoWords({ cards: [{ id: "a" }, { id: "b" }, { id: "c" }], repos: REPOS, base: "https://b.example", headers: {}, fetchImpl, log: (l) => log.push(l), gitIn: () => () => "Board-Id: a\nBoard-Id: b\nBoard-Id: c\n" });
  assert.deepEqual(seen, ["a", "b"], "a throw ends this run's fills, it does not escape");
  assert.equal(n, 0);
  assert.ok(log.some((l) => /card a answered 422|for a answered 422/.test(l)));
  assert.ok(log.some((l) => /repo words failed: down/.test(l)));
});

test("the store takes a repo word only for a card that has none, and never changes one", async () => {
  const db = makeDb();
  await createCard(db, NOW, "Manager", { id: "c-one", title: "One" });
  await createCard(db, NOW, "Manager", { id: "c-two", title: "Two", repo: "kept-repo" });
  const before = await db.prepare("SELECT updated_at FROM cards WHERE id = 'c-one'").first();
  assert.deepEqual(await fillCardRepo(db, NOW + 5, "c-one", "flight-board"), { ok: true, set: true, repo: "flight-board" });
  assert.deepEqual(await fillCardRepo(db, NOW + 6, "c-one", "another"), { ok: true, set: false, repo: "flight-board" });
  assert.deepEqual(await fillCardRepo(db, NOW + 7, "c-two", "flight-board"), { ok: true, set: false, repo: "kept-repo" });
  assert.equal((await db.prepare("SELECT repo FROM cards WHERE id = 'c-one'").first()).repo, "flight-board");
  assert.equal((await db.prepare("SELECT repo FROM cards WHERE id = 'c-two'").first()).repo, "kept-repo");
  assert.equal((await db.prepare("SELECT updated_at FROM cards WHERE id = 'c-one'").first()).updated_at, before.updated_at, "only the repo word changes");
});

test("a bad id, a bad word or an unknown card is refused and written down", async () => {
  const db = makeDb();
  await createCard(db, NOW, "Manager", { id: "c-one", title: "One" });
  for (const [id, repo, rule] of [["Bad Id", "flight-board", "card-id"], ["c-one", "Flight Board", "card-repo"], ["c-one", "", "card-repo"], ["c-one", 5, "card-repo"], ["nobody", "flight-board", "card-unknown"]]) {
    const r = await fillCardRepo(db, NOW, id, repo);
    assert.equal(r.ok, false); assert.equal(r.refused.rule, rule, `${id} ${repo}`);
  }
  assert.equal((await db.prepare("SELECT repo FROM cards WHERE id = 'c-one'").first()).repo, null);
});

test("POST /api/probe/card-repo is the probe's alone", async () => {
  const env = { DB: makeDb() };
  await createCard(env.DB, NOW, "Manager", { id: "c-one", title: "One" });
  const WHO = { owner: { who: "owner", role: "owner" }, manager: { who: "Manager", role: "agent" }, probe: { who: "probe", role: "probe" } };
  const post = (as, body) => worker.fetch(new Request("https://board.test/api/probe/card-repo", { method: "POST", headers: { "content-type": "application/json", "x-as": as }, body: JSON.stringify(body) }), env, null, NOW, async (req) => WHO[req.headers.get("x-as")] ?? null);
  assert.equal((await post("owner", { id: "c-one", repo: "flight-board" })).status, 403);
  assert.equal((await post("manager", { id: "c-one", repo: "flight-board" })).status, 403);
  assert.equal((await post("probe", { id: "c-one", repo: "Bad Word" })).status, 422);
  const ok = await post("probe", { id: "c-one", repo: "flight-board" });
  assert.equal(ok.status, 200);
  assert.equal((await env.DB.prepare("SELECT repo FROM cards WHERE id = 'c-one'").first()).repo, "flight-board");
});

test("the evidence job fills the repo words of the store's cards from the configured repositories, after the cards are read and before anything is built", async () => {
  const order = [], posts = [];
  const read = (p) => { if (p === "/c") return JSON.stringify({ collector: { repos: REPOS } }); if (p === "/s/state.json") return JSON.stringify({}); throw new Error("none"); };
  await evidenceJob({
    job: "evidence", base: "https://b.example", headers: {}, configPath: "/c", stateFile: "/s/state.json", privateDir: "/p", ghCheck: () => true,
    prepare: async () => { order.push("prepare"); return { configPath: "/pc", stateFile: "/s/state.json", cards: [{ id: "a", repo: null }, { id: "b", repo: "kept" }] }; },
    deployRead: async () => ({ worker: "", tree: "" }), build: async () => { order.push("build"); }, read, liveFetch: async () => ({ ok: false, status: 500 }),
    fetchImpl: async (u, o) => { if (u.endsWith("/api/probe/card-repo")) { order.push("fill"); posts.push(JSON.parse(o.body)); } return { ok: true, status: 200 }; },
    repoWords: { gitIn: () => () => "Board-Id: a\nBoard-Id: b\n" },
  });
  assert.deepEqual(posts, [{ id: "a", repo: "flight-board" }], "b already has a word and is left alone");
  assert.deepEqual(order.slice(0, 3), ["prepare", "fill", "build"]);
});
