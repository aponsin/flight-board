// Choices need buttons (#C227): a waiting item whose text offers lettered or numbered choices is a decision with options.
import test from "node:test";
import assert from "node:assert/strict";
import { fullConfig } from "../scripts/config.mjs";
import { checkWrites, offersChoices } from "../gate/rules.mjs";

const URL_ = "https://claude.ai/" + "artifact/TestBoard01";
const config = fullConfig({ artifactUrl: URL_ });
const now = Date.now() - 1234;
const lead = { role: "Manager", manager: true };
const errors = (w, mirror = null) => checkWrites([w], { config, who: lead, now, state: {}, mirror }).errors;
const CHOICE = "offers choices";
const has = (errs) => assert.ok(errs.some((e) => e.includes(CHOICE)), `"${CHOICE}" in: ${errs.join(" | ")}`);
const lacks = (errs) => assert.ok(!errs.some((e) => e.includes(CHOICE)), `no "${CHOICE}" in: ${errs.join(" | ")}`);
const two = [{ key: "A", label: "one" }, { key: "B", label: "two" }];
const set = (data) => ({ op: "set", collection: "waiting", doc_id: "w", data: { since: now, done: false, ...data } });

test("offersChoices: two lettered or numbered marks, or 'option A'; one mark, prose and plain parentheses are not", () => {
  for (const yes of ["A) keep it\nB) move it", "Pick a) or b)", "(A) this (B) that", "1) now 2) later", "Go with option B?", "OPTION 2 is cheaper", "[a) x] [c) y]"]) assert.equal(offersChoices(yes), true, yes);
  for (const no of ["", null, "Paste prompt v12 (the file).", "A) only one", "Step 1) run it", "Options are on the card", "optional A", "plan B", "x) and x) again", "e.g. a)b)"]) assert.equal(offersChoices(no), false, String(no));
});

test("a new answer, action or any kind but decision with choices in its text, question or title is refused", () => {
  has(errors(set({ kind: "answer", text: "Two ways:\nA) keep\nB) move", question: "q" })));
  has(errors(set({ kind: "answer", text: "x", question: "1) now or 2) tomorrow?" })));
  has(errors(set({ kind: "action", title: "Option A or option B", text: "x", steps: ["Look"] })));
  has(errors(set({ kind: "later", text: "A) one B) two" })));
  has(errors(set({ text: "A) one B) two" })), "no kind at all");
  const e = errors(set({ kind: "answer", text: "A) keep B) move", question: "q" }));
  assert.ok(e.some((m) => /kind "decision" with options, a button each/.test(m)), "says what to do");
});

test("a decision with options may list its choices; plain asks pass", () => {
  lacks(errors(set({ kind: "decision", text: "A) keep it, B) move it", options: two })));
  lacks(errors(set({ kind: "answer", text: "Done: it shipped in 1.2.0.", question: "q" })));
  lacks(errors(set({ kind: "action", text: "Run step 1) then tell me", steps: ["Look"] })));
});

test("updates: naming the kind is checked at once; without it, against the mirror's kind; str_replace too", () => {
  has(errors({ op: "update", collection: "waiting", doc_id: "w", data: { kind: "answer", text: "A) x B) y" } }));
  lacks(errors({ op: "update", collection: "waiting", doc_id: "w", data: { kind: "decision", text: "A) x B) y", options: two } }));
  const mirror = (kind) => ({ docs: { waiting: [{ id: "w", kind, text: "old" }] } });
  has(errors({ op: "update", collection: "waiting", doc_id: "w", data: { text: "A) x B) y" } }, mirror("answer")));
  lacks(errors({ op: "update", collection: "waiting", doc_id: "w", data: { text: "A) x B) y" } }, mirror("decision")));
  has(errors({ op: "str_replace", collection: "waiting", doc_id: "w", data: { text: "1) x 2) y" } }, mirror("action")));
  lacks(errors({ op: "update", collection: "waiting", doc_id: "w", data: { done: true } }, mirror("answer")), "closing an old item");
  lacks(errors({ op: "update", collection: "waiting", doc_id: "w", data: { text: "A) x B) y" } }), "no mirror: no kind to check against");
});
