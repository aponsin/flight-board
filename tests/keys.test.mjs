import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

// A text box in a box with the given buttons, and a key press in it.
function press(key, { value = "hi", shift = false, meta = false, ctrl = false, composing = false, buttons = [{ sel: "[data-tsend]" }], inBox = true } = {}) {
  const found = (sel) => buttons.find((b) => sel.split(",").includes(b.sel)) ?? null;
  const box = { querySelector: (sel) => found(sel) };
  const target = { tagName: "TEXTAREA", value, closest: () => (inBox ? box : null) };
  return { key, target, shiftKey: shift, metaKey: meta, ctrlKey: ctrl, altKey: false, isComposing: composing, keyCode: 13 };
}

test("Enter sends like the chat app; Shift+Enter and ⌘/Ctrl+Enter add a line; nothing while composing or empty", () => {
  const { enterKey } = loadNames(["enterKey"]);
  const send = { sel: "[data-tsend]" };
  assert.equal(enterKey(press("Enter", { buttons: [send] })).button, send, "a thread reply: Send");
  const submit = { sel: "button[type=submit]" };
  assert.equal(enterKey(press("Enter", { buttons: [submit] })).button, submit, "a new thread: Send to Manager");
  const done = { sel: ".btns button.ok" };
  assert.equal(enterKey(press("Enter", { buttons: [done, { sel: ".btns button.help" }] })).button, done, "an ask: Done, never the help button");
  assert.equal(enterKey(press("Enter", { shift: true })), null, "Shift+Enter: the browser's own new line");
  assert.equal(enterKey(press("Enter", { meta: true })).act, "line");
  assert.equal(enterKey(press("Enter", { ctrl: true })).act, "line");
  assert.equal(enterKey(press("Enter", { composing: true })), null, "an input method composing");
  assert.equal(enterKey({ ...press("Enter"), keyCode: 229 }), null, "Safari's composing Enter (keyCode 229)");
  assert.equal(enterKey(press("Enter", { value: "  \n" })).act, "none", "an empty box sends nothing");
  assert.equal(enterKey(press("Enter", { buttons: [{ sel: "[data-tsend]", disabled: true }] })).act, "none", "a disabled button");
  assert.equal(enterKey(press("Enter", { buttons: [{ sel: ".btns button.opt" }] })).act, "none", "a decision with options has no main button");
  assert.equal(enterKey(press("a")), null);
  assert.equal(enterKey(press("Enter", { inBox: false })), null, "a text box outside the board's boxes");
  assert.equal(enterKey({ ...press("Enter"), target: { tagName: "INPUT", value: "x", closest: () => ({}) } }), null, "single-line inputs unchanged");
});

test("every box says how: Enter to send, the modifier for a new line", () => {
  const { keysHint } = loadNames(["keysHint"]);
  assert.equal(keysHint(), '<div class="keys">Enter to send · Ctrl+Enter for a new line</div>', "off a Mac");
});
