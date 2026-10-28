// A choice reaches the owner only with buttons (#C378, the owner in t-1793164285052): Manager posted "A (my pick): …
// B: …" in a thread message of kind "decision" with no options, so the thread showed no buttons. The gate refuses a new
// message of kind "decision" without at least two options {key, label}, and one whose text offers lettered choices
// unless it is that decision. Numbered lines stay free: an answer's "1) … 2)" is steps, not a choice.
import test from "node:test";
import assert from "node:assert/strict";
import { fullConfig } from "../scripts/config.mjs";
import { writeErrors } from "../gate/rules.mjs";

const config = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", owner: "Owner" });
const NOW = 1_800_000_123_457;
const lead = { role: "Manager", manager: true };
const say = (data) => writeErrors({ op: "set", collection: "messages", doc_id: "m1", data: { thread: "t-1793164285052", from: "Manager", at: NOW, ...data } }, { config, who: lead, now: NOW }).join(" | ");
const AB = [{ key: "A", label: "Ack on the Send line" }, { key: "B", label: "Keep the row" }];

test("tonight's message: kind decision, A/B in the text, no options: refused", () => {
  assert.match(say({ kind: "decision", text: "Where should Ack sit?\nA (my pick): on the Send line.\nB: keep the row." }), /a decision needs at least two options \{key, label\}/);
});

test("a decision message with two options passes; one option, or an option without a label, doesn't", () => {
  assert.equal(say({ kind: "decision", text: "Where should Ack sit?\nA (my pick): on the Send line.\nB: keep the row.", options: AB }), "");
  assert.match(say({ kind: "decision", text: "Pick", options: [AB[0]] }), /at least two options/);
  assert.match(say({ kind: "decision", text: "Pick", options: [AB[0], { key: "B" }] }), /each option needs key and label/);
});

test("lettered choices in any other message are refused: A) B), 'A:' and 'A (my pick)' lines, 'option A'", () => {
  for (const text of ["Two ways: A) the row, B) the Send line.", "A (my pick): the Send line\nB: the row", "A: the Send line\nB: the row", "I'd go with option B."]) {
    for (const kind of ["answer", "live", "building", undefined]) assert.match(say({ kind, text }), /offers choices/, `${kind}: ${text}`);
  }
});

test("plain words and numbered steps pass", () => {
  assert.equal(say({ kind: "answer", text: "Done: 1) push, 2) run the pack, 3) reopen the app." }), "");
  assert.equal(say({ kind: "live", text: "Live in v3.17. A note: Security verified it." }), "");
  assert.equal(say({ kind: "answer", text: "Plan B is off; Ack works now." }), "");
});
