// #C1021: a card in a batch (a group the lead set) never goes READY alone. 11-12, group test g1-board-view: #C971 was built and #C969 (same batch) was not;
// no queued card DEPENDED on #C971, so stack-ready fired and #C971 went to review alone. Now stack-ready waits while another open card of the batch is not
// built, and the queue file carries the batch. (#C1066: a pushed card of a stack-mode repository gets no review turn until a stack-ready signal covers it, so the
// dispatch no longer counts a batch peer as a "partner"; the probe lifts the hold for the whole batch once one member's head is signalled.) A card with no batch, and a card
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
  // the signal note only: a card told to wait writes a waiting note (#C1066, refs/notes/stack-ready-waiting), which is no signal
  return { run, calls, wroteNote: () => calls.some((c) => c.startsWith("notes --ref=refs/notes/stack-ready add")), wroteWaiting: () => calls.some((c) => c.startsWith("notes --ref=refs/notes/stack-ready-waiting add")) };
}
// #C1391: each row carries the card's stage (stack-ready waits for every other counted member to be built); a started row is built here unless it says otherwise.
const queueOf = (cards) => ({ at: T_MS - 60e3, cards: cards.map((k) => ({ owner_role: "Boardsmith", repo: "", dependsOn: [], batch: "", started: false, stage: k.started ? "built" : "unbuilt", ...k })) });
const ready = (queue, id) => { const g = fakeGit(id); const r = stackReady({ run: g.run, queue, now: () => T_NOW }); return { ...r, wroteNote: g.wroteNote(), wroteWaiting: g.wroteWaiting() }; };

test("a card of a batch waits while another open card of the batch is not built, even though nothing depends on it", () => {
  const r = ready(queueOf([{ id: "card-a", batch: "g1" }, { id: "card-b", batch: "g1" }]), "card-a");
  assert.equal(r.signal, false); assert.equal(r.wroteNote, false); assert.equal(r.wroteWaiting, true, "a card told to wait leaves a waiting note on its head (#C1066)");
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
  assert.equal(ready(queueOf([{ id: "card-a", batch: "g1", repo: "flight-board" }, { id: "card-b", batch: "g1", repo: "site-one" }]), "card-a").signal, true, "another repository (both words known) is no partner");
  assert.equal(ready(queueOf([{ id: "card-a", batch: "g1", repo: "" }, { id: "card-b", batch: "g1", repo: "site-one" }]), "card-a").signal, false, "a card with no repository word yet counts: it fails closed (#C1391)");
});

// #C1391 (option A, the owner's pick on #T2255) REPLACES the old test "a paused or blocked batch peer is no partner to wait for" (Checker 2 F1 of #C1021): a paused or blocked card counts, so
// it holds the READY like any member that is not built; the lead pulls it out of the group to send the others on. A paused member that is built does not hold it.
test("a paused or blocked batch peer holds the READY until it is built; pulled out of the batch, it holds nothing", () => {
  const view = { cards: [{ id: "card-a", owner_role: "Builder", batch: "g1" }, { id: "card-b", owner_role: "Builder", batch: "g1", paused: 1 }, { id: "card-c", owner_role: "Builder", batch: "g1", blocked_reason: "waits" }], evidence: {} };
  const q = stackQueueFile(view, T_MS - 1000);
  assert.deepEqual(q.cards.map((k) => k.stage), ["unbuilt", "unbuilt", "unbuilt"]);
  assert.equal(ready({ ...q, at: T_MS - 60e3 }, "card-a").signal, false, "a paused and a blocked peer, neither built: no READY");
  const pushed = { cards: view.cards, evidence: Object.fromEntries(["card-b", "card-c"].map((id) => [`cards.${id}`, { value: { lit: ["checker"], phase: "checker", headSha12: "b".repeat(12), signed: [], onMain: false } }])) };
  const built = stackQueueFile(pushed, T_MS - 1000);
  assert.equal(ready({ ...built, at: T_MS - 60e3 }, "card-a").signal, true, "paused and blocked but built: the READY goes");
  const pulled = { ...q, at: T_MS - 60e3, cards: q.cards.map((k) => (k.id === "card-a" ? k : { ...k, batch: "" })) };
  assert.equal(ready(pulled, "card-a").signal, true, "the lead pulled them out of the batch");
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

// #C1066: the batch wait is stack-ready's alone (above): it writes no signal while a peer is not built, and the dispatch reads only the probe's fact, stackHold
// (pushed, no signal covers the tip): such a card is Building whoever its peers are, and the moment a signal covers it the probe clears stackHold and it is reviewed.
test("a built card no signal covers has no review turn, whatever its batch peers are; with the signal on it (no stackHold) it is reviewed", () => {
  const peers = [
    ["a peer not built", { batch: "g1" }, { batch: "g1", owner_role: "Boardsmith" }],
    ["no batch", {}, { owner_role: "Boardsmith" }],
    ["pulled out of its batch", { batch: "" }, { batch: "g1", owner_role: "Boardsmith" }],
    ["another batch", { batch: "g1" }, { batch: "g2", owner_role: "Boardsmith" }],
    ["a peer of another repository", { batch: "g1" }, { batch: "g1", owner_role: "Boardsmith", repo: "site-one" }],
    ["a dropped peer", { batch: "g1" }, { batch: "g1", owner_role: "Boardsmith", dropped: 1 }],
    ["a finished peer", { batch: "g1" }, { batch: "g1", owner_role: "Boardsmith", done_at: 5 }],
    ["a paused peer", { batch: "g1" }, { batch: "g1", owner_role: "Boardsmith", paused: 1 }],
  ];
  for (const [name, a, b] of peers) {
    const noSignal = world({ cards: [card("c1-base", a), card("c2-peer", b)], ev: { "c1-base": heldEv(1) } });
    assert.ok(!who(noSignal).includes("c1-base:Checker:review"), `${name}: no signal, no review`);
    const signalled = world({ cards: [card("c1-base", a), card("c2-peer", b)], ev: { "c1-base": { ...heldEv(1), stackHold: undefined } } });
    assert.ok(who(signalled).includes("c1-base:Checker:review"), `${name}: the signal covers it, so it is reviewed`);
  }
});
