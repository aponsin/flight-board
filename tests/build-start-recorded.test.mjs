// #C903: the board records a build start when the dispatch wakes the builder, so build time is real. A store-era card's history used to begin at
// "checker" (the probe sees a card only once it is pushed), so the build medians came from old imported cards.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { createCard, recordBuildStart, writeEvidence } from "../worker/board-store.mjs";
import { dispatchJob, buildStarts } from "../collector/probe-board.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const rows = async (db, id) => (await db.prepare("SELECT phase, kind, at, who, source, wait FROM phase_history WHERE card_id = ? ORDER BY at, id").bind(id).all()).results;
const fresh = async (card = {}) => { const db = makeDb(); await createCard(db, NOW, "Manager", { id: "a-card", title: "A card", owner_role: "Builder", ...card }); return db; };
const lit = (phase) => ({ lit: [phase], phase, headSha12: "abcdefabcdef" });

test("the dispatch's build start writes one build/start row for the card's owner; a second wake adds nothing", async () => {
  const db = await fresh();
  assert.deepEqual(await recordBuildStart(db, NOW + MIN, "a-card"), { ok: true, recorded: true });
  assert.deepEqual(await rows(db, "a-card"), [{ phase: "build", kind: "start", at: NOW + MIN, who: "Builder", source: "evidence", wait: null }]);
  assert.deepEqual(await recordBuildStart(db, NOW + 2 * MIN, "a-card"), { ok: true, recorded: false, why: "has-history" });
  assert.deepEqual(await recordBuildStart(db, NOW + 3 * MIN, "a-card"), { ok: true, recorded: false, why: "has-history" });
  assert.equal((await rows(db, "a-card")).length, 1, "a second and a third wake do not duplicate it");
});

test("the first push confirms it: the evidence write closes the build and starts the next phase at the push, so build time is the gap", async () => {
  const db = await fresh();
  await recordBuildStart(db, NOW + MIN, "a-card");
  assert.equal((await writeEvidence(db, NOW + 41 * MIN, "probe", "cards.a-card", lit("checker"), "product")).ok, true);
  const h = await rows(db, "a-card");
  assert.deepEqual(h.map((r) => `${r.phase} ${r.kind} ${(r.at - NOW) / MIN}`), ["build start 1", "build end 41", "checker start 41"]);
  assert.equal(h[1].who, "Builder", "the build's end carries the builder who started it");
  assert.equal(h.filter((r) => r.phase === "build" && r.kind === "start").length, 1);
});

test("a card the probe has already seen, one with history of its own and a dropped card get no build start; an unknown card is refused by name", async () => {
  const db = await fresh();
  await writeEvidence(db, NOW + MIN, "probe", "cards.a-card", lit("checker"), "product");
  assert.deepEqual(await recordBuildStart(db, NOW + 2 * MIN, "a-card"), { ok: true, recorded: false, why: "has-history" });
  // Lit with no history row yet (the evidence is there, the rows are not): still left to the evidence.
  const db2 = await fresh();
  await db2.prepare("INSERT INTO evidence (key, value, read_at) VALUES ('cards.a-card', ?, ?)").bind(JSON.stringify(lit("checker")), NOW).run();
  assert.deepEqual(await recordBuildStart(db2, NOW, "a-card"), { ok: true, recorded: false, why: "lit" });
  assert.equal((await rows(db2, "a-card")).length, 0);
  // A wait step (the step tool) is not the card's work history: the build start still goes in.
  const db3 = await fresh();
  await db3.prepare("INSERT INTO phase_history (card_id, phase, kind, at, who, source, wait) VALUES ('a-card', 'build', 'start', ?, 'Builder', 'tool', 'busy')").bind(NOW).run();
  assert.equal((await recordBuildStart(db3, NOW + MIN, "a-card")).recorded, true);
  const db4 = await fresh();
  await db4.prepare("UPDATE cards SET dropped = 1 WHERE id = 'a-card'").run();
  assert.deepEqual(await recordBuildStart(db4, NOW, "a-card"), { ok: true, recorded: false, why: "dropped" });
  assert.equal((await rows(db4, "a-card")).length, 0);
  const no = await recordBuildStart(db4, NOW, "nobody");
  assert.equal(no.ok, false);
  assert.equal(no.refused.rule, "build-start-card-unknown");
  const bad = await recordBuildStart(db4, NOW, "Bad Id");
  assert.equal(bad.ok, false);
  assert.equal(bad.refused.rule, "card-id");
});

test("POST /api/probe/build-start is the probe's alone", async () => {
  const env = { DB: await fresh() };
  const WHO = { owner: { who: "owner", role: "owner" }, manager: { who: "Manager", role: "agent" }, probe: { who: "probe", role: "probe" } };
  const post = (as, body) => worker.fetch(new Request("https://board.test/api/probe/build-start", { method: "POST", headers: { "content-type": "application/json", "x-as": as }, body: JSON.stringify(body) }), env, null, NOW, async (req) => WHO[req.headers.get("x-as")] ?? null);
  assert.equal((await post("owner", { id: "a-card" })).status, 403);
  assert.equal((await post("manager", { id: "a-card" })).status, 403);
  assert.equal((await rows(env.DB, "a-card")).length, 0, "a refused caller writes nothing");
  assert.equal((await post("probe", { id: "nobody" })).status, 422);
  const ok = await post("probe", { id: "a-card" });
  assert.equal(ok.status, 200);
  assert.equal((await rows(env.DB, "a-card")).length, 1);
  assert.equal((await post("probe", { id: "a-card" })).status, 200);
  assert.equal((await rows(env.DB, "a-card")).length, 1);
});

// The dispatch job: a view with Builder idle 20 minutes and cards in different states.
const view = (cards, evidence = {}) => ({
  cards: cards.map((c) => ({ owner_role: "Builder", waiting_on: null, paused: 0, dropped: 0, ...c })),
  asks: [],
  evidence: { agents: { readAt: NOW - 1000, value: { Builder: { state: "idle", lastActivityAt: NOW - 20 * MIN, since: NOW - 20 * MIN, card: null }, Manager: { state: "idle", lastActivityAt: NOW - 20 * MIN, since: NOW - 20 * MIN, card: null } } }, ...evidence },
});
const jobWith = async (v, { failPost = false } = {}) => {
  const calls = [], log = [];
  const fetchImpl = async (url, o) => {
    calls.push([url.replace("https://board.test", ""), o.method, o.body ? JSON.parse(o.body) : null]);
    if (url.endsWith("/api/view")) return { ok: true, status: 200, json: async () => v };
    if (failPost) throw new Error("down");
    return { ok: true, status: 200 };
  };
  const { mkdtempSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const r = await dispatchJob({ base: "https://board.test", headers: {}, fetchImpl, dir: mkdtempSync(join(tmpdir(), "bs-")), roster: ["Manager", "Builder"], lead: "Manager", now: () => NOW, log: (l) => log.push(l) });
  return { r, calls, log };
};

test("the dispatch job posts a build start for a card it wakes its builder for with nothing pushed, and for no other turn", async () => {
  const v = view([{ id: "unpushed", num: 1 }, { id: "at-review", num: 2 }, { id: "sent-back", num: 3 }],
    { "cards.at-review": { readAt: NOW, value: lit("checker") }, "cards.sent-back": { readAt: NOW, value: { ...lit("checker"), findings: ["checker"] } } });
  const { r, calls } = await jobWith(v);
  const posts = calls.filter(([u]) => u.endsWith("/api/probe/build-start"));
  assert.deepEqual(posts.map((p) => p[2]), [{ id: "unpushed" }], "not the card at review, nor the rework (it has a sha)");
  assert.ok(r.items.some((i) => i.card === "unpushed" && i.step === "build"), "the dispatch did wake the builder for it");
  assert.ok(r.items.some((i) => i.card === "sent-back" && i.step === "rework"), "and for the rework, which is not a build start");
  assert.deepEqual(buildStarts([{ card: "a", phase: "build", step: "build" }, { card: "a", phase: "build", step: "build" }, { card: "b", phase: "build", step: "rework", sha: "abcdefabcdef" }, { card: "c", phase: "build", step: "outside" }, { card: "d", phase: "checker", step: "review", sha: "abcdefabcdef" }, null]), ["a"], "once per card, only the plain build step");
});

test("a failed or refused post is logged and the dispatch still writes its files", async () => {
  const { r, log } = await jobWith(view([{ id: "unpushed", num: 1 }]), { failPost: true });
  assert.equal(r.wrote, true);
  assert.ok(log.some((l) => /build start for unpushed not posted: down/.test(l)), log.join(" | "));
});

test("a view the dispatch cannot use (stale agents) posts no build start", async () => {
  const v = view([{ id: "unpushed", num: 1 }]);
  v.evidence.agents.readAt = NOW - 10 * MIN;
  const { calls } = await jobWith(v);
  assert.deepEqual(calls.map(([u]) => u), ["/api/view"]);
});
