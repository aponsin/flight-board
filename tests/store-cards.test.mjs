import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirrorCard, storeCards, syncMirror, privateConfig, seedUsage, prepareStoreState } from "../collector/store-cards.mjs";
import { evidenceJob } from "../collector/probe-evidence.mjs";
import { phaseOf, repoOf } from "../collector/state.mjs";

const card = (o = {}) => ({ id: "card-a", num: 5, title: "A card", summary: "words", size: "S", review_level: "Quick", owner_role: "Builder", next_note: null, next_note_at: null, waiting_on: null, paused: 0, dropped: 0, rework_reason: null, created_at: 10, updated_at: 20, ...o });
const view = (cards) => async () => ({ ok: true, status: 200, json: async () => ({ cards }) });
const tmp = () => mkdtempSync(join(tmpdir(), "store-cards-"));

test("a store card becomes the mirror's initiative: the flags give the status, a missing field is left out, nothing is invented", () => {
  assert.deepEqual(mirrorCard(card()), { name: "A card", summary: "words", who: "Builder", size: "S", level: "Quick", num: 5, createdAt: 10, updatedAt: 20, status: "active" });
  assert.equal(mirrorCard(card({ paused: 1 })).status, "paused");
  assert.equal(mirrorCard(card({ dropped: 1, paused: 1 })).status, "dropped");
  const d = mirrorCard(card({ next_note: "n", next_note_at: 7, waiting_on: "the owner", rework_reason: "rework" }));
  assert.deepEqual([d.nextNote, d.nextNoteAt, d.waitingOn, d.phaseReason], ["n", 7, "the owner", "rework"]);
  assert.equal("phase" in mirrorCard(card()), false, "the store has no typed phase; the evidence decides");
});

test("storeCards asks the store's own address, with the probe's headers, and refuses to follow a redirect (the headers stay on that host)", async () => {
  let asked;
  const headers = { "cf-access-client-id": "id-x" };
  await storeCards({ base: "https://x.test", headers, fetchImpl: async (u, o) => { asked = [u, o.redirect, o.headers]; return { ok: true, json: async () => ({ cards: [] }) }; } });
  assert.deepEqual(asked, ["https://x.test/api/view", "error", headers]);
});

test("storeCards: the view's cards with a plain id; a failed or odd answer throws", async () => {
  assert.deepEqual((await storeCards({ base: "https://x.test", headers: {}, fetchImpl: view([card(), card({ id: "Bad Id" })]) })).map((c) => c.id), ["card-a"]);
  await assert.rejects(storeCards({ base: "https://x.test", headers: {}, fetchImpl: async () => ({ ok: false, status: 503 }) }), /answered 503/);
  await assert.rejects(storeCards({ base: "https://x.test", headers: {}, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), /no cards/);
});

test("syncMirror writes one file per card, drops the files of cards the store no longer has, and stamps the read", () => {
  const dir = tmp();
  assert.deepEqual(syncMirror({ cards: [card(), card({ id: "card-b", num: 6 })], dir, boardId: "B1", now: 99 }), { written: 2, removed: 0 });
  assert.deepEqual(syncMirror({ cards: [card()], dir, boardId: "B1", now: 100 }), { written: 1, removed: 1 });
  assert.deepEqual(readdirSync(join(dir, "B1", "mirror", "initiatives")), ["card-a.json"]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "B1", "mirror", "_at.json"), "utf8")), { at: 100 });
});

test("the private config moves only gate.stateDir; the usage history is seeded once and never overwritten", () => {
  assert.deepEqual(privateConfig({ gate: { a: 1, stateDir: "~/x" }, collector: { b: 2 } }, "/p"), { gate: { a: 1, stateDir: "/p" }, collector: { b: 2 } });
  const from = tmp(), to = join(tmp(), "t");
  writeFileSync(join(from, "usage.json"), "OLD");
  assert.equal(seedUsage({ from, to }), 1);
  writeFileSync(join(to, "usage.json"), "NEWER");
  assert.equal(seedUsage({ from, to }), 0);
  assert.equal(readFileSync(join(to, "usage.json"), "utf8"), "NEWER");
});

test("prepareStoreState: the private mirror, config and state path, from the old state path's board id", async () => {
  const priv = tmp(), real = join(tmp(), "AbCdEf123456");
  mkdirSync(real);
  const cfg = join(real, "board.config.json");
  writeFileSync(cfg, JSON.stringify({ gate: { stateDir: "~/.flight-board" }, collector: { liveUrl: "https://live.test/" } }));
  const r = await prepareStoreState({ privateDir: priv, stateFile: join(real, "state.json"), configPath: cfg, base: "https://x.test", headers: {}, fetchImpl: view([card()]) });
  assert.equal(r.stateFile, join(priv, "AbCdEf123456", "state.json"));
  assert.equal(JSON.parse(readFileSync(r.configPath, "utf8")).gate.stateDir, priv);
  assert.equal(existsSync(join(priv, "AbCdEf123456", "mirror", "initiatives", "card-a.json")), true);
  await assert.rejects(prepareStoreState({ privateDir: priv, stateFile: "/x/y/state.json", configPath: cfg, base: "https://x.test", headers: {}, fetchImpl: view([]) }), /no board id/);
});

test("the evidence job with a private dir builds the state from the store's cards, not from the given paths", async () => {
  let args; const posted = [];
  const r = await evidenceJob({ job: "evidence", base: "https://x.test", headers: {}, configPath: "/real.json", stateFile: "/real/state.json", privateDir: "/priv",
    prepare: async () => ({ configPath: "/priv/B/config.json", stateFile: "/priv/B/state.json" }),
    build: async (a) => { args = a; }, read: (p) => (p === "/priv/B/state.json" ? JSON.stringify({ cards: { "card-a": { phase: "build" } } }) : "{}"),
    fetchImpl: async (_u, o) => { posted.push(JSON.parse(o.body).key); return { ok: true, status: 200 }; } });
  assert.equal(args[args.indexOf("--config") + 1], "/priv/B/config.json");
  assert.deepEqual(posted, ["cards.card-a", "run.evidence"]);
  assert.equal(r.written, 2);
});

// Checker on v7: the review skips read customerText, lookChange and skip off the card; a store card must carry them.
const reviewConfig = { phases: [["plan"], ["build"], ["test"], ["language"], ["design"], ["checker"], ["security"], ["ship"], ["live"]],
  skips: [{ phase: "security", unlessLevel: "Full" }, { phase: "language", whenFalse: "customerText" }, { phase: "design", unlessTrue: "lookChange" }],
  collector: { notes: { checker: "a", language: "b", design: "c", security: "d" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } };
const phaseFor = (row, signed) => phaseOf({ ...mirrorCard(card({ review_level: "Full", ...row })), id: "card-a" }, { head: { branch: "x/card-a", sha: "1", at: 1, message: "Board-Id: card-a" }, signed: new Set(signed), onMain: false, deployed: false }, reviewConfig);

test("a store card reaches the same review phase as the old card: customer_text 0 skips the language review, look_change 1 keeps the design review, NULL is 'not said'", () => {
  assert.equal(phaseFor({ customer_text: 0 }, ["checker"]), "security", "customerText false: no language review");
  assert.equal(phaseFor({ customer_text: null }, ["checker"]), "language", "not said: the language review runs, as on an old card without the flag");
  assert.equal(phaseFor({ look_change: 1 }, ["checker", "language"]), "design", "lookChange true: the design review runs");
  assert.equal(phaseFor({ look_change: null }, ["checker", "language"]), "security", "not said: no design review");
  assert.equal(phaseFor({ look_change: 0 }, ["checker", "language"]), "security");
  assert.equal(phaseFor({ skip: JSON.stringify(["security"]) }, ["checker", "language"]), "ship", "an explicit skip list is read");
  assert.equal(phaseFor({ skip: "not json" }, ["checker", "language"]), "security", "a damaged skip list is ignored, not guessed");
});

test("mirrorCard carries repo, batch and bump, and repoOf then sends a c-numbered board card to its own repository, not by an id prefix (#C735)", () => {
  const d = { ...mirrorCard(card({ id: "c728-parity", repo: "flight-board", batch: "b1", bump: "minor" })), id: "c728-parity" };
  assert.deepEqual([d.repo, d.batch, d.bump], ["flight-board", "b1", "minor"]);
  const config = { collector: { repos: [{ name: "flight-board", idPrefixes: ["board-"] }] } };
  assert.equal(repoOf(d, config)?.name, "flight-board", "the card's own repo word decides");
  assert.equal(repoOf({ ...d, repo: undefined }, config), null, "without the word the same id reads the team's repository (the defect)");
  const e = mirrorCard(card());
  assert.equal("repo" in e || "batch" in e || "bump" in e, false, "not said stays out");
});

test("mirrorCard carries the three words only when they are said", () => {
  const d = mirrorCard(card({ customer_text: 1, look_change: 0, skip: '["design"]' }));
  assert.deepEqual([d.customerText, d.lookChange, d.skip], [true, false, ["design"]]);
  const e = mirrorCard(card());
  assert.equal("customerText" in e || "lookChange" in e || "skip" in e, false);
});
