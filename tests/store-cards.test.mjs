import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirrorCard, storeCards, syncMirror, privateConfig, seedUsage, prepareStoreState } from "../collector/store-cards.mjs";
import { evidenceJob } from "../collector/probe-evidence.mjs";

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
  assert.deepEqual(posted, ["cards.card-a"]);
  assert.equal(r.written, 1);
});
