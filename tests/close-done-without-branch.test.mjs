// #C902 (prevention, 2026-11-10: #C884's result was a file with no branch; the store kept reading it "at build" and waking Designer, and
// the only close was dropped, which says "not done"). card_update { done: true, done_evidence } closes such a card as done.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, updateCard, postMessage, readView } from "../worker/board-store.mjs";
import { cardWriteRefusal } from "../worker/board-rules.mjs";
import { initiativeDoc } from "../worker/compat-view.mjs";
import { dispatchInput } from "../collector/store-dispatch.mjs";

const T = 1_800_000_000_000;
const card = async (db, id, extra = {}) => { const r = await createCard(db, T, "Manager", { id, title: id, owner_role: "Designer", ...extra }); assert.equal(r.ok, true, JSON.stringify(r)); };
const row = (db, id) => db.prepare("SELECT * FROM cards WHERE id = ?").bind(id).first();

test("done with evidence closes the card: done_at and done_evidence are kept, and the view says done", async () => {
  const db = makeDb(); await card(db, "review");
  for (const [id, ev] of [["review", "~/Documents/Team/review-c884.md"]]) {
    const r = await updateCard(db, T + 5, "Designer", { id, done: true, done_evidence: ev });
    assert.equal(r.ok, true, JSON.stringify(r));
    const c = await row(db, id);
    assert.equal(c.done_at, T + 5); assert.equal(c.done_evidence, ev);
    const doc = initiativeDoc(c, null);
    assert.equal(doc.status, "done"); assert.equal(doc.doneAt, T + 5); assert.equal(doc.doneEvidence, ev);
  }
});

test("Still allowed: an absolute path, an https link and a thread message on the board are each evidence", async () => {
  const db = makeDb(); await card(db, "a"); await card(db, "b"); await card(db, "c");
  const m = await postMessage(db, T + 1, "owner", { thread_id: "c", body: "Looks good" });
  assert.equal(m.ok, true, JSON.stringify(m));
  for (const [id, ev] of [["a", "/tmp/out/report.md"], ["b", "https://example.com/report"], ["c", m.id]]) {
    assert.equal((await updateCard(db, T + 2, "Designer", { id, done: true, done_evidence: ev })).ok, true, ev);
  }
});

test("done without evidence, with a bad one, or a message the board does not have, is refused and the card stays open", async () => {
  const db = makeDb(); await card(db, "x");
  for (const [fields, rule] of [
    [{ done: true }, "done-needs-evidence"],
    [{ done: true, done_evidence: "" }, "done-needs-evidence"],
    [{ done: true, done_evidence: "it is finished" }, "done-needs-evidence"],
    [{ done: true, done_evidence: "http://example.com/x" }, "done-needs-evidence"],
    [{ done: true, done_evidence: "m-1800000000000-deadbeef" }, "done-needs-evidence"],
    [{ done: false, done_evidence: "/tmp/x" }, "card-done"],
    [{ done_evidence: "/tmp/x" }, "card-done"],
    [{ done: true, done_evidence: "/tmp/x", dropped: true }, "card-done"],
  ]) {
    const r = await updateCard(db, T + 3, "Designer", { id: "x", ...fields });
    assert.equal(r.ok, false, JSON.stringify(fields)); assert.equal(r.refused.rule, rule, JSON.stringify(fields));
  }
  assert.equal((await row(db, "x")).done_at, null);
});

test("a done card is not closed twice, a dropped card is not made done, and a new card cannot start done", async () => {
  const db = makeDb(); await card(db, "d"); await card(db, "gone");
  assert.equal((await updateCard(db, T + 1, "Designer", { id: "d", done: true, done_evidence: "/tmp/a" })).ok, true);
  assert.equal((await updateCard(db, T + 2, "Designer", { id: "d", done: true, done_evidence: "/tmp/b" })).refused.rule, "card-done");
  assert.equal((await row(db, "d")).done_evidence, "/tmp/a", "the first evidence stays");
  assert.equal((await updateCard(db, T + 1, "Manager", { id: "gone", dropped: true })).ok, true);
  assert.equal((await updateCard(db, T + 2, "Designer", { id: "gone", done: true, done_evidence: "/tmp/a" })).refused.rule, "card-done");
  const n = await createCard(db, T, "Manager", { id: "born-done", title: "t", done: true, done_evidence: "/tmp/a" });
  assert.equal(n.ok, false); assert.equal(n.refused.rule, "card-done");
});

test("the probe stops dispatching a done card", async () => {
  const db = makeDb(); await card(db, "review"); await card(db, "next");
  assert.equal((await updateCard(db, T + 1, "Designer", { id: "review", done: true, done_evidence: "/tmp/r.md" })).ok, true);
  const view = await readView(db, T + 2);
  const now = T + 10_000;
  const input = dispatchInput({ ...view, evidence: { ...(view.evidence ?? {}), agents: { value: { Designer: { state: "idle", since: T } }, readAt: now } } }, now);
  assert.ok(input, "the view can say who is idle");
  const ids = input.cards.map((c) => c.id);
  assert.ok(!ids.includes("review"), "the done card is not dispatched");
  assert.ok(ids.includes("next"), "Still allowed: the open card still is");
  const cards = view.cards;
  assert.equal(cards.find((c) => c.id === "review").done_at, T + 1);
});

test("the pure rule: done_evidence alone, or done false, is refused before the store is asked", () => {
  assert.equal(cardWriteRefusal({ id: "x", done_evidence: "/tmp/a" }, null).rule, "card-done");
  assert.equal(cardWriteRefusal({ id: "x", done: true, done_evidence: "/tmp/a" }, null), null);
});
