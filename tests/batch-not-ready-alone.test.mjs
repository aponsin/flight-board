// #C1021: a card in a batch (a group the lead set) never goes READY alone. 11-12, group test g1-board-view: #C971 was built and #C969 (same batch) was not;
// no queued card DEPENDED on #C971, so stack-ready fired and #C971 went to review alone. Now stack-ready waits while another open card of the batch is not
// built, the dispatch counts such a card as a partner (the held card gets no review turn), and the queue file carries the batch. A card with no batch, and a card
// pulled out of its batch (the lead clears it), behave as before.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stackReady } from "../scripts/stack-ready.mjs";
import { dispatchRun, stackQueueFile, batchOf } from "../collector/store-dispatch.mjs";

// ---- stack-ready, with a canned git ----
const T_NOW = "2026-11-12T20:00:00.000Z", T_MS = Date.parse(T_NOW), SHA = "a".repeat(40);
function fakeGit(id = "card-a") {
  const calls = [];
  const run = (a) => {
    calls.push(a.join(" "));
    if (a[0] === "rev-parse" && a[1] === "--is-inside-work-tree") return "true\n";
    if (a[0] === "status") return "";
    if (a[0] === "symbolic-ref") return "build/x\n";
    if (a[0] === "log") return `${id}\n`;
    if (a[0] === "rev-parse") return `${SHA}\n`;
    return "";
  };
  return { run, calls, wroteNote: () => calls.some((c) => c.startsWith("notes ")) };
}
const queueOf = (cards) => ({ at: T_MS - 60e3, cards: cards.map((k) => ({ owner_role: "Boardsmith", repo: "", dependsOn: [], batch: "", started: false, ...k })) });
const ready = (queue, id) => { const g = fakeGit(id); const r = stackReady({ run: g.run, queue, now: () => T_NOW }); return { ...r, wroteNote: g.wroteNote() }; };

test("a card of a batch waits while another open card of the batch is not built, even though nothing depends on it", () => {
  const r = ready(queueOf([{ id: "card-a", batch: "g1" }, { id: "card-b", batch: "g1" }]), "card-a");
  assert.equal(r.signal, false); assert.equal(r.wroteNote, false);
  assert.match(r.line, /^STACK-READY OK: pushed build\/x at [0-9a-f]{12}, waiting for its group g1 \(card-b not built\): no signal$/);
  assert.deepEqual(r.queued, ["card-b"]);
});

test("the last card of the batch (every other member built) writes the signal", () => {
  const r = ready(queueOf([{ id: "card-a", batch: "g1", started: true }, { id: "card-b", batch: "g1" }, { id: "card-c", batch: "g1", started: true }]), "card-b");
  assert.equal(r.signal, true); assert.equal(r.wroteNote, true);
  assert.match(r.line, /, signal written$/);
});

test("cards without a batch behave as today; so does a card pulled out of its batch (the lead clears it)", () => {
  assert.equal(ready(queueOf([{ id: "card-a" }, { id: "card-b" }]), "card-a").signal, true, "no batch at all");
  assert.equal(ready(queueOf([{ id: "card-a", batch: "" }, { id: "card-b", batch: "g1" }]), "card-a").signal, true, "pulled out: its batch is empty, the others do not hold it");
  assert.equal(ready(queueOf([{ id: "card-a", batch: "g1" }, { id: "card-b", batch: "g2" }]), "card-a").signal, true, "another batch is no partner");
  assert.equal(ready(queueOf([{ id: "card-a", batch: "g1" }, { id: "card-b", batch: "g1", repo: "site-one" }]), "card-a").signal, true, "another repository is no partner");
});

test("a paused or blocked batch peer is no partner to wait for: the queue file marks it held and stack-ready skips it, as the dispatch does (Checker 2 F1)", () => {
  const view = { cards: [{ id: "card-a", owner_role: "Builder", batch: "g1" }, { id: "card-b", owner_role: "Builder", batch: "g1", paused: 1 }, { id: "card-c", owner_role: "Builder", batch: "g1", blocked_reason: "waits" }, { id: "card-d", owner_role: "Builder", batch: "g1" }], evidence: {} };
  const q = stackQueueFile(view, T_MS - 1000);
  assert.deepEqual(q.cards.map((k) => k.held), [false, true, true, false]);
  assert.equal(ready({ ...q, at: T_MS - 60e3 }, "card-a").signal, false, "card-d is a real peer and still holds card-a");
  const only = { ...q, at: T_MS - 60e3, cards: q.cards.filter((k) => k.id !== "card-d") };
  const r = ready(only, "card-a");
  assert.equal(r.signal, true, "only paused and blocked peers are left: the READY goes");
  assert.equal(ready(queueOf([{ id: "card-a", batch: "g1" }, { id: "card-b", batch: "g1", held: true }]), "card-a").signal, true);
  assert.equal(ready(queueOf([{ id: "card-a", batch: "g1" }, { id: "card-b", batch: "g1", held: false }]), "card-a").signal, false);
});

test("a batch wait never replaces the dependency wait: both are listed, the dependency first", () => {
  const r = ready(queueOf([{ id: "card-a", batch: "g1" }, { id: "card-b", dependsOn: ["card-a"] }, { id: "card-c", batch: "g1" }]), "card-a");
  assert.match(r.line, /more queued \(card-b\): no signal/);
  assert.equal(r.signal, false);
});

test("an old queue file or one without the batch word cannot make a card wait (no deadlock)", () => {
  const stale = queueOf([{ id: "card-a", batch: "g1" }, { id: "card-b", batch: "g1" }]); stale.at = T_MS - 20 * 60e3;
  assert.equal(ready(stale, "card-a").signal, true, "a stale file means no wait is possible");
  const old = { at: T_MS - 60e3, cards: [{ id: "card-a", owner_role: "Boardsmith", repo: "", dependsOn: [], started: false }, { id: "card-b", owner_role: "Boardsmith", repo: "", dependsOn: [], started: false }] };
  assert.equal(ready(old, "card-a").signal, true, "a file from before the batch word");
});

// ---- the queue file ----
test("the queue file carries each card's batch as a plain word, '' for none or an odd value", () => {
  const view = { cards: [{ id: "card-a", owner_role: "Builder", batch: "g1-board-view" }, { id: "card-b", owner_role: "Builder" }, { id: "card-c", owner_role: "Builder", batch: "bad batch!" }, { id: "card-d", owner_role: "Builder", batch: 7 }], evidence: {} };
  assert.deepEqual(stackQueueFile(view, 5).cards.map((k) => k.batch), ["g1-board-view", "", "", ""]);
  assert.equal(batchOf({ batch: "  g2 " }), "g2"); assert.equal(batchOf(null), "");
});

// ---- the dispatch ----
const NOW = 1_800_000_000_000, MIN = 60e3;
const ROSTER = ["Manager", "Boardsmith", "Builder", "Checker", "Security", "Release"], LEAD = "Manager";
const idle = { state: "idle", lastActivityAt: NOW - 2 * MIN, since: NOW - 2 * MIN };
const card = (id, extra = {}) => ({ id, num: Number(id.replace(/\D/g, "")) || null, owner_role: "Builder", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "", ...extra });
const world = ({ cards, ev = {} }) => ({
  cards, asks: [], stackSwitch: [{ repo: "board", stack: true, set_by: "default", set_at: 0 }],
  evidence: { agents: { readAt: NOW - 5_000, value: Object.fromEntries(ROSTER.map((r) => [r, idle])) }, ...Object.fromEntries(Object.entries(ev).map(([id, v]) => [`cards.${id}`, { readAt: NOW - 5_000, value: v }])) },
});
const who = (v) => dispatchRun(v, { dir: mkdtempSync(join(tmpdir(), "bnra-")), roster: ROSTER, lead: LEAD, now: NOW }).items.map((i) => `${i.card}:${i.role}:${i.step}`);
const heldEv = (n) => ({ lit: ["checker"], phase: "checker", headSha12: `${n}`.repeat(12), signed: [], onMain: false, stackHold: true });

test("a built card whose batch peer is not built is held: no review turn; the moment the peer is built the hold lifts", () => {
  const alone = world({ cards: [card("c1-base", { batch: "g1" }), card("c2-peer", { batch: "g1", owner_role: "Boardsmith" })], ev: { "c1-base": heldEv(1) } });
  assert.deepEqual(who(alone).filter((l) => l.startsWith("c1-base")), [], "no review for the built card while its peer has nothing pushed");
  const both = world({ cards: [card("c1-base", { batch: "g1" }), card("c2-peer", { batch: "g1", owner_role: "Boardsmith" })], ev: { "c1-base": heldEv(1), "c2-peer": { ...heldEv(2), stackHold: undefined } } });
  assert.ok(who(both).includes("c1-base:Checker:review"), "peer built: the card is reviewed");
});

test("without a batch (or pulled out of it) a lone built card is reviewed at once, as before", () => {
  const solo = world({ cards: [card("c1-base"), card("c2-other", { owner_role: "Boardsmith" })], ev: { "c1-base": heldEv(1) } });
  assert.ok(who(solo).includes("c1-base:Checker:review"));
  const pulled = world({ cards: [card("c1-base", { batch: "" }), card("c2-peer", { batch: "g1", owner_role: "Boardsmith" })], ev: { "c1-base": heldEv(1) } });
  assert.ok(who(pulled).includes("c1-base:Checker:review"));
  const otherBatch = world({ cards: [card("c1-base", { batch: "g1" }), card("c2-peer", { batch: "g2", owner_role: "Boardsmith" })], ev: { "c1-base": heldEv(1) } });
  assert.ok(who(otherBatch).includes("c1-base:Checker:review"));
  const otherRepo = world({ cards: [card("c1-base", { batch: "g1" }), card("c2-peer", { batch: "g1", owner_role: "Boardsmith", repo: "site-one" })], ev: { "c1-base": heldEv(1) } });
  assert.ok(who(otherRepo).includes("c1-base:Checker:review"), "a peer of another repository is no partner");
});

test("a finished, dropped or paused peer does not hold the batch", () => {
  for (const extra of [{ dropped: 1 }, { done_at: 5 }, { paused: 1 }]) {
    const v = world({ cards: [card("c1-base", { batch: "g1" }), card("c2-peer", { batch: "g1", owner_role: "Boardsmith", ...extra })], ev: { "c1-base": heldEv(1) } });
    assert.ok(who(v).includes("c1-base:Checker:review"), JSON.stringify(extra));
  }
});
