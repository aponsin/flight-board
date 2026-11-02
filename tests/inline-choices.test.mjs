// A choice for the owner in thread text is a decision with buttons (#C378). #C585: the lead's "A: Reviewer reviews it now …
// B: hold it until the pause lifts. I'd pick A." went out as text, because the "A:" and "B:" were on one line and the
// check read lines that open with a letter. An "A:" and a "B:" each opening a clause now count, line or no line.
import test from "node:test";
import assert from "node:assert/strict";
import { fullConfig } from "../scripts/config.mjs";
import { offersLetteredChoices, checkWrites } from "../gate/rules.mjs";

const config = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", owner: "Owner" });
const NOW = 1_800_000_123_457;
const lead = { role: "Manager", manager: true };

test("two clauses opening A: and B: are a choice, on one line or several", () => {
  assert.equal(offersLetteredChoices("A: Reviewer reviews it now, while the pause holds. B: hold it until the pause lifts. I'd pick A."), true);
  assert.equal(offersLetteredChoices("Two ways. A: ship today B: wait a day"), true);
  assert.equal(offersLetteredChoices("A (my pick): ship today\nB: wait"), true);
  assert.equal(offersLetteredChoices("Options:\nA: one\nB: two"), true);
  assert.equal(offersLetteredChoices("A) one B) two"), true, "as before");
});

test("ordinary text stays free", () => {
  assert.equal(offersLetteredChoices("Build A: done. It is live."), false, "no B");
  assert.equal(offersLetteredChoices("E: the file F: the folder"), false, "log lines that aren't A and B");
  assert.equal(offersLetteredChoices("The data: A, B and C are set. Note: all fine."), false, "a colon that isn't after a lone letter");
  assert.equal(offersLetteredChoices("Plan: do X, then Y. Fix (a) later."), false);
  assert.equal(offersLetteredChoices("The option I recommend is to wait."), false);
  assert.equal(offersLetteredChoices("1: first step 2: second step"), false, "numbered steps stay free in an answer");
});

test("the gate refuses the lead's message with the inline form, and takes it as a decision with options", () => {
  const w = (data) => ({ op: "set", collection: "messages", doc_id: "m-1", data: { thread: "t-a", from: "Manager", at: NOW, ...data } });
  const call = (x) => checkWrites([x], { config, who: lead, now: NOW, state: {}, mirror: null, seen: null }).errors.join(" | ");
  const text = "A: Reviewer reviews it now, while the pause holds. B: hold it until the pause lifts. I'd pick A.";
  assert.match(call(w({ text })), /text offers choices .* make it kind "decision" with options/);
  assert.doesNotMatch(call(w({ text, kind: "decision", options: [{ key: "A", label: "Review now" }, { key: "B", label: "Hold" }] })), /offers choices/);
});
