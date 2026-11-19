// A Decision Manager posts with ask(related_thread) into the thread of a card still in flight drew no option buttons on the page (11-17: the thread of the pricing card, then
// another card's): threadState read "building" before it read the Decision, and the buttons are drawn only for a "decision" state. A Decision as Manager's last word is
// the owner's to pick wherever the thread is drawn; every other state is as before.
import test from "node:test";
import assert from "node:assert/strict";
import { createCard, askFromTool } from "../worker/board-store.mjs";
import { readThreads, applyThreads } from "../worker/compat-threads.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { loadNames } from "./harness.mjs";

const NOW = 1_800_000_000_000;
const buttons = (html) => [...html.matchAll(/data-topt="([^"]*)"[^>]*data-choice="([^"]*)"/g)].map((m) => `${m[1]}:${m[2]}`);

// The whole path: the store posts the decision, the view reads the thread's rows back, the page draws the thread.
async function posted(options) {
  const db = makeDb();
  assert.equal((await createCard(db, NOW, "Manager", { id: "card-a", title: "A card" })).ok, true);
  await db.prepare("INSERT INTO threads (id, num, title, created_at) VALUES ('t-100', 900, 'Pricing', ?)").bind(NOW - 600_000).run();
  await db.prepare("INSERT INTO messages (id, thread_id, author, body, created_at) VALUES ('m-own', 't-100', 'owner', 'what about the wording?', ?)").bind(NOW - 600_000).run();
  const r = await askFromTool(db, NOW, "Manager", { type: "Decision", title: "Which words?", asked_by: "Manager", question: "Pick one.", options, recommended: options[0], related_thread: "t-100" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const collections = applyThreads({}, { threads: await readThreads(db), asks: [] });
  return collections;
}
const page = (collections, initiatives) => {
  const b = loadNames(["threadHtml", "threadState", "threadOptions", "threadCard", "threadCards"]);
  b.state.messages = collections.messages; b.state.threads = collections.threads; b.state.initiatives = initiatives;
  return b;
};
const card = (status, extra = {}) => ({ id: "card-a", name: "A card", status, thread: "t-100", ...extra });

test("a Decision posted by ask(related_thread) draws its buttons: on a thread with no card, and on the thread of a card in flight", async () => {
  const collections = await posted(["A: Link only", "B: Link and note"]);
  for (const [label, initiatives] of [["no card", []], ["a card in flight", [card("active")]], ["a card waiting on the owner", [card("waiting")]], ["a card done", [card("done")]]]) {
    const b = page(collections, initiatives);
    assert.equal(b.threadState("t-100"), "decision", label);
    assert.deepEqual(buttons(b.threadHtml("t-100", "ask", { decide: true })), ["t-100:A", "t-100:B"], label);
    assert.deepEqual(buttons(b.threadHtml("t-100", "card", { acts: true })), ["t-100:A", "t-100:B"], `${label} (acts)`);
  }
});

test("must still allow: a card's thread whose last word is a plain note is still building, with no buttons; the owner's pick ends the Decision and his question is the last word; a Decision with no options is no decision", async () => {
  const collections = await posted(["Yes", "No"]);
  const note = { id: "m-note", thread: "t-100", from: "Manager", text: "On it", at: NOW + 1000 };
  const withNote = page({ ...collections, messages: [...collections.messages, note] }, [card("active")]);
  assert.equal(withNote.threadState("t-100"), "building");
  // #C1284: the thread still reads building, but an unanswered decision stays pinned with its buttons until the owner picks (a plain note after it no longer hides them).
  assert.deepEqual(buttons(withNote.threadHtml("t-100", "ask", { decide: true })), ["t-100:A", "t-100:B"]);
  const picked = { id: "m-pick", thread: "t-100", from: "Owner", text: "Chose A: Yes", at: NOW + 2000 };
  const answered = page({ ...collections, messages: [...collections.messages, picked] }, [card("active")]);
  assert.notEqual(answered.threadState("t-100"), "decision", "once the owner has picked, the Decision is answered");
  assert.deepEqual(buttons(answered.threadHtml("t-100", "ask", { decide: true })), []);
  const asked = { id: "m-q", thread: "t-100", from: "Owner", text: "which one do you mean?", at: NOW + 3000 };
  const question = page({ ...collections, messages: [...collections.messages, asked] }, [card("active")]);
  assert.equal(question.threadState("t-100"), "question", "the owner's open question is the last word");
  // #C1284: his own question under the decision (#T2132: "where is the A button?") no longer takes the buttons away; only a pick does.
  assert.deepEqual(buttons(question.threadHtml("t-100", "ask", { decide: true })), ["t-100:A", "t-100:B"]);
  const bare = page({ ...collections, messages: collections.messages.map((m) => (m.kind === "decision" ? { ...m, options: [] } : m)) }, [card("active")]);
  assert.equal(bare.threadState("t-100"), "building");
});
