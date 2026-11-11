// #C855 (principle 8, the owner's part is exact): an Action step that names the exact text the owner must type, paste or say is refused unless the
// text is in the step's cmd (the Copy box). A step that names none passes. Cases are taken from the board's real Action asks (Checker's probe of
// 415 asks, 1,428 steps: 52 named a text, 168 more were false positives of the first rule).
import test from "node:test";
import assert from "node:assert/strict";
import { askRefusal, stepsRefusal, typedWithoutCmd } from "../worker/board-rules.mjs";

const NOW = 1_800_000_000_000;
const action = (steps) => ({ type: "Action", title: "t", asked_by: "Manager", steps, expect: "it works" });

test('"type: X" with no cmd is refused; the same step with cmd X passes; a step with nothing to type passes', () => {
  assert.equal(askRefusal(action([{ text: "type: yes" }]), NOW)?.rule, "step-types-without-cmd");
  assert.equal(askRefusal(action([{ text: "type: yes", cmd: "yes" }]), NOW), null);
  assert.equal(askRefusal(action([{ text: "Open the Terminal" }, "Look at the board", { text: "Run the line", cmd: "node x.mjs" }]), NOW), null);
});

test("the real targets are refused without the text in the cmd, and pass with it", () => {
  for (const text of ["Type: go, ship 1.87.0", "Paste: <link>", 'Say "go ahead" to the agent', "In the session, type: ship it", "Done. Then paste: the line below", "Open Settings (type: Secret)"]) {
    assert.equal(askRefusal(action([{ text }]), NOW)?.rule, "step-types-without-cmd", text);
    assert.equal(askRefusal(action([text]), NOW)?.rule, "step-types-without-cmd", `${text} (a plain string step)`);
  }
  assert.equal(askRefusal(action([{ text: "Type: go, ship 1.87.0", cmd: "go, ship 1.87.0" }]), NOW), null);
  assert.equal(askRefusal(action([{ text: 'Say "go ahead" to the agent', cmd: "go ahead" }]), NOW), null);
  assert.equal(askRefusal(action([{ text: "Type: yes.", cmd: "yes" }]), NOW), null, "the full stop is the sentence's");
});

test("the cmd must hold the text the step names: another text, a blank cmd and no cmd are all refused", () => {
  assert.equal(askRefusal(action([{ text: "type: yes", cmd: "no" }]), NOW)?.rule, "step-types-without-cmd");
  assert.equal(askRefusal(action([{ text: "type: yes", cmd: "   " }]), NOW)?.rule, "step-types-without-cmd");
});

test("the false positives of the first rule pass: no text named, expected output, the owner's own words, a field to fill", () => {
  for (const text of [
    "paste what it printed here", "Paste what it prints here, if it fails", "paste the output back to me",
    "It should say 'Couldn't fetch'", "You should see it say: done", "it may say 'Couldn't fetch' (#T292)", "the page will say \"Saved\"",
    "Type a short answer", "Type her answer in the box", "Add the variable, type Secret", "Say hello to the team",
    "Check the typeface and the pasted line and an essay", "Open Settings > Privacy",
  ]) {
    assert.equal(typedWithoutCmd(text), false, text);
    assert.equal(askRefusal(action([text]), NOW), null, text);
  }
});

test("only an Action is held to it: a Later's steps are not (the old board's imported asks carry such steps)", () => {
  assert.equal(stepsRefusal([{ text: "type: x" }]), null);
  assert.equal(stepsRefusal([{ text: "type: x" }], { needCmd: true })?.rule, "step-types-without-cmd");
  const later = { type: "Later", title: "t", asked_by: "Manager", text: "x", eta_at: NOW + 3600e3, steps: [{ text: "type: x" }] };
  assert.equal(askRefusal(later, NOW), null);
});
