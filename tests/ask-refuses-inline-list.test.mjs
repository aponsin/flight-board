// #C965: the owner on #T1779 (11-11 ~8:15 pm MT): "Multiples points, and not numbered list ?" Manager packed four changes as "(1) … (2) … (3) … (4)"
// in one question. An ask, or an agent's post in a thread the owner reads, with 3 or more inline markers in one paragraph is refused. Must still
// allow: a proper numbered list ("1." at each line start), a single "(1)" mention, option lines "A: …" / "B: …".
import test from "node:test";
import assert from "node:assert/strict";
import { inlineListIn, inlineListRefusal, askRefusal } from "../worker/board-rules.mjs";
import { createCard, postMessage } from "../worker/board-store.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";

const NOW = 1_800_000_000_000, DAY = 86_400_000;
const PACKED = "Coming: (1) the guide's prompts, (2) a safer install command, (3) the old gate retired and (4) the board link.";

test("inlineListIn: 3 or more inline markers in one paragraph are found; a list, a mention or two, and code spans are not", () => {
  assert.equal(inlineListIn(PACKED), "(1) (2) (3) (4)");
  assert.equal(inlineListIn("Do 1) this, 2) that and 3) the other."), "1) 2) 3)");
  for (const text of [
    "1. the guide's prompts\n2. a safer install\n3. the old gate retired", // a proper numbered list
    "(1) the prompts\n(2) the install\n(3) the gate", // markers at their line starts: a list
    "As in step (1) of the guide, run it.", // a single mention
    "Pick (1) or (2).", // two
    "A: ship tonight\nB: ship tomorrow\nC: wait", // option lines
    "Run `f(1) g(2) h(3)` as written.", // a code span
    "First (1) and (2).\n\nThen (3) alone.", // split across paragraphs
    "#C1) #C2) #C3) are ids, 3:1) 4:2) 5:3) are ratios", // not markers
    // Checker's LOW F1 on a79f093: the three above end "(2)." or sit in f(1), so they never reached the rule they name. These do.
    "Run `step (1) then (2) then (3) done` as written.", // a code span
    "Pick (1) or (2) now.", // two
    "First (1) and (2) here.\n\nThen (3) alone.", // split across paragraphs
    "", null,
  ]) assert.equal(inlineListIn(text), null, String(text));
  // Their twins without the exemption are found, so each case above rests on its own rule.
  assert.equal(inlineListIn("Run step (1) then (2) then (3) done as written."), "(1) (2) (3)", "no code span");
  assert.equal(inlineListIn("Pick (1) or (2) or (3) now."), "(1) (2) (3)", "three");
  assert.equal(inlineListIn("First (1) and (2) here.\nThen (3) alone."), "(1) (2) (3)", "one paragraph");
  const r = inlineListRefusal(["fine", PACKED]);
  assert.equal(r.rule, "one-point-per-line");
  assert.match(r.detail, /one numbered line per point/);
});

test("askRefusal: a packed list in what the owner reads is refused; his Copy boxes and an import are not", () => {
  const later = (extra) => ({ type: "Later", title: "Coming soon", asked_by: "Manager", text: "after the run", eta_at: NOW + DAY, ...extra });
  assert.equal(askRefusal(later({ text: PACKED }), NOW)?.rule, "one-point-per-line");
  assert.equal(askRefusal(later({ text: "1. the prompts\n2. the install\n3. the gate" }), NOW), null, "a numbered list");
  assert.equal(askRefusal(later({ text: PACKED }), null), null, "an import keeps the old words");
  assert.equal(askRefusal({ type: "Terminal", title: "Run", asked_by: "Manager", commands: ["echo (1) (2) (3)"] }, NOW), null, "Terminal commands are pasted");
  const decision = { type: "Decision", title: "Which?", asked_by: "Manager", question: PACKED, options: ["A: all four", "B: the first two"], recommended: "A: all four" };
  assert.equal(askRefusal(decision, NOW)?.rule, "one-point-per-line");
  assert.equal(askRefusal({ ...decision, question: "Which changes go first?" }, NOW), null, "option lines A: and B: pass");
});

test("postMessage: an agent's packed list in a thread the owner reads is refused; agent-only threads and the owner pass", async () => {
  const db = makeDb();
  assert.equal((await createCard(db, NOW, "Manager", { id: "card-a", title: "A card" })).ok, true);
  assert.equal((await postMessage(db, NOW, "Builder", { thread_id: "card-a", body: PACKED })).ok, true, "a card thread only agents wrote in");
  await db.prepare("INSERT INTO threads (id, num, title, created_at) VALUES (?, ?, ?, ?)").bind("t-700", 700, "Anything for me?", NOW).run();
  assert.equal((await postMessage(db, NOW + 1, "Manager", { thread_id: "t-700", body: PACKED })).refused?.rule, "one-point-per-line");
  assert.equal((await postMessage(db, NOW + 2, "Manager", { thread_id: "t-700", body: "Coming:\n1. the prompts\n2. the install\n3. the gate" })).ok, true);
  assert.equal((await postMessage(db, NOW + 3, "owner", { thread_id: "t-700", body: PACKED })).ok, true, "the owner's own words pass");
});
