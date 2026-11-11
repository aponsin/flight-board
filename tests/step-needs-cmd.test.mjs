// #C855 (principle 8, the owner's part is exact): an Action step that tells the owner to type, paste or say something is refused unless the
// exact text is in the step's cmd (the Copy box). A step with nothing to type passes.
import test from "node:test";
import assert from "node:assert/strict";
import { askRefusal, stepsRefusal, typedWithoutCmd } from "../worker/board-rules.mjs";

const NOW = 1_800_000_000_000;
const action = (steps) => ({ type: "Action", title: "t", asked_by: "Manager", steps, expect: "it works" });

test('"type: X" with no cmd is refused; the same step with cmd X passes; a step with nothing to type passes', () => {
  const refused = askRefusal(action([{ text: "type: yes" }]), NOW);
  assert.equal(refused.rule, "step-types-without-cmd");
  assert.equal(askRefusal(action([{ text: "type: yes", cmd: "yes" }]), NOW), null);
  assert.equal(askRefusal(action([{ text: "Open the Terminal" }, "Look at the board", { text: "Run the line", cmd: "node x.mjs" }]), NOW), null);
});

test("a plain string step, paste and say, and the quoted form are held to the same rule", () => {
  for (const step of ["type: yes", "Paste: the line below", 'Say "go ahead" to the agent', "Type yes in the window", { text: "paste it in the chat" }]) {
    assert.equal(askRefusal(action([step]), NOW)?.rule, "step-types-without-cmd", JSON.stringify(step));
  }
  assert.equal(askRefusal(action([{ text: 'Say "go ahead" to the agent', cmd: "go ahead" }]), NOW), null);
  assert.equal(askRefusal(action([{ text: "Paste: node x.mjs --once", cmd: "node x.mjs --once" }]), NOW), null);
});

test("the cmd must hold the text the step names; an empty cmd is no cmd", () => {
  assert.equal(askRefusal(action([{ text: "type: yes", cmd: "no" }]), NOW)?.rule, "step-types-without-cmd", "another text");
  assert.equal(askRefusal(action([{ text: "type: yes", cmd: "   " }]), NOW)?.rule, "step-types-without-cmd", "blank");
  assert.equal(askRefusal(action([{ text: "Type: yes.", cmd: "yes" }]), NOW), null, "the full stop is the sentence's");
  assert.equal(askRefusal(action([{ text: "paste the next line", cmd: "echo hi" }]), NOW), null, "no text named: a cmd is enough");
});

test("a word that merely contains type, paste or say is not a step to type; only an Action is held to it", () => {
  assert.equal(typedWithoutCmd("Check the typeface and the pasted line and an essay"), false);
  assert.equal(typedWithoutCmd({ text: "Open Settings > Privacy" }), false);
  assert.equal(stepsRefusal([{ text: "type: x" }]), null, "a Later's steps are not held to it (the old board's asks carry such steps)");
  assert.equal(stepsRefusal([{ text: "type: x" }], { needCmd: true })?.rule, "step-types-without-cmd");
  const later = { type: "Later", title: "t", asked_by: "Manager", text: "x", eta_at: NOW + 3600e3, steps: [{ text: "type: x" }] };
  assert.equal(askRefusal(later, NOW), null);
});
