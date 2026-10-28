// The keeper wakes every session it resets (#C379, Director for the owner): the 05:12Z wave of 2026-10-28 reset the
// lead with the others, nobody sent the pickups, and the reset sessions sat idle with Remote Control off. The keeper's
// prompt (keeper/TASK.md) now picks its own wave back up in the same run, the lead last, Director never cued.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const doc = readFileSync(new URL("../keeper/TASK.md", import.meta.url), "utf8");
const prompt = doc.match(/## Prompt\n\n```\n([\s\S]*?)\n```/)[1];
const step = (n) => prompt.match(new RegExp(`^${n}\\. ([\\s\\S]*?)(?=^\\d+\\. |(?![\\s\\S]))`, "m"))[1];

test("the run that cues a reset waits for it and sends the pickup itself", () => {
  assert.match(step(6), /in this run/);
  assert.match(step(6), /run_in_background: true/, "a background sleep: a foreground one is refused");
  assert.match(step(6), /idle and whose Messages are under 5,000 tokens has reset: send it exactly "\/pickup <Title>"/);
  assert.match(step(6), /at most 8 waits/, "bounded: a reset that never comes doesn't hold the run");
  assert.match(step(6), /"not reset"/);
});

test("the lead is never in the wave: cued last, after the wave is picked up, and picked up the same way", () => {
  assert.match(step(5), /except Manager/);
  assert.match(step(7), /^Manager last, and only after the wave/);
  assert.match(step(7), /report \(step 8\) first, then exactly "CONTEXT RESET"/, "the cue is the last message it gets");
  assert.match(step(7), /"\/pickup Manager"/);
  assert.ok(prompt.indexOf("7. Manager last") > prompt.indexOf("6. Pick the wave back up"));
});

test("Director is never measured, cued or messaged, so never reset in a wave with the lead", () => {
  assert.match(step(2), /Never measure, cue or message Director/);
  assert.doesNotMatch(step(2), /title is one of:[^.]*Director/);
});

test("a reset is told by the Messages category, never the total (Checker on a307d81: ~88k of overhead in a cleared session)", () => {
  assert.match(step(3), /"Messages" category \(none listed counts as 0\)/);
  assert.match(step(4), /idle \(not working\) and whose Messages are under 5,000 tokens/);
  assert.doesNotMatch(prompt, /under 25,000 tokens/, "the total never falls that low");
});

// #C399 (the owner's 600k in #T1038): the limit is the config's resetAt, filled in where the lead saves the prompt.
test("the reset limit is the config's resetAt ({{RESET_AT}}), or 80% of a 200k window; the lead's the same; no number left", () => {
  assert.match(step(5), /\{\{RESET_AT\}\} tokens or more \(or 80% of a 200k window\)/);
  assert.match(step(7), /at \{\{RESET_AT\}\} tokens or more/);
  assert.doesNotMatch(prompt, /\d00,000 tokens/, "no limit written into the prompt itself");
  assert.match(doc, /`\{\{RESET_AT\}\}` \(board\.config\.json's `resetAt`/);
});

test("the task may run only the exact command 'sleep 120' (Security on a307d81)", () => {
  assert.match(doc, /allow Bash for exactly the command `sleep 120` \(an exact rule\), never Bash in general/);
});

test("the report names what was picked up and what didn't reset, and asks for #C374's save count", () => {
  assert.match(step(8), /\| pickup sent: <Title>, … \(or none\) \| not reset: <Title>, … \(or none\) \|/);
  assert.match(step(8), /for each reset sent, set saved with savedTokens and savedPct/);
});

test("the keeper still never clears a session or touches Remote Control", () => {
  assert.match(prompt, /Never clear a session yourself, never touch Remote Control/);
  assert.doesNotMatch(prompt, /clear_session|set_remote_control/);
});

test("a dry run on a test role is the acceptance, before the live task changes", () => {
  assert.match(doc, /## Dry run \(the acceptance\)[\s\S]*"\/pickup Rehearsal"[\s\S]*Remote Control is on again/);
});
