// The lead's morning clear (#C560, Director for the owner): a daily task resets Manager and picks it back up, so the
// lead starts each day fresh. Its prompt (keeper/MORNING.md) tells the pickup by scripts/pickup-watch.mjs, never by eye.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decide, LOW_START } from "../scripts/pickup-watch.mjs";

const doc = readFileSync(new URL("../keeper/MORNING.md", import.meta.url), "utf8");
const prompt = doc.match(/## Prompt\n\n```\n([\s\S]*?)\n```/)[1];
const step = (n) => prompt.match(new RegExp(`^${n}\\. ([\\s\\S]*?)(?=^\\d+\\. |(?![\\s\\S]))`, "m"))[1];

test("daily at 06:40 local, ahead of the card's 06:45 so a late start still leaves Manager fresh before 07:00", () => {
  assert.match(doc, /cron\n?`40 6 \* \* \*`/);
  assert.match(doc, /cron is the machine's local time/);
});

test("the cue and the pickup are the exact words, sent only to Manager, after it is idle", () => {
  assert.match(step(2), /title is exactly "Manager"/);
  assert.match(step(2), /Never message Director/);
  assert.match(step(3), /run_in_background: true, "sleep 60"; never a foreground sleep/);
  assert.match(step(3), /at most 15 waits\. Still working after that: send nothing/, "bounded: a busy lead isn't reset mid-turn");
  assert.match(step(5), /exactly "CONTEXT RESET" and nothing else/);
  assert.match(step(6), /send Manager exactly "\/pickup Manager" and nothing else, once/);
  assert.ok(prompt.indexOf("CONTEXT RESET") < prompt.indexOf("/pickup Manager"));
});

test("the pickup is the script's word, from readings taken after the cue (not idle-and-under-5,000 by eye)", () => {
  assert.match(step(6), /keep a list of readings, empty at first/);
  assert.match(step(6), /run exactly \(one Bash call, nothing around it\) node ~\/\.flight-board\/current\/scripts\/pickup-watch\.mjs '<the list as JSON>'/);
  assert.match(step(6), /"picked-up" or "give-up": send nothing more/);
  assert.doesNotMatch(prompt, /under 5,000/);
  assert.doesNotMatch(prompt, /under 25,000 tokens/, "the total never falls that low");
});

test("a Manager already under the script's low start is left alone (its reset turn would read as a pickup)", () => {
  assert.match(step(4), /only on a real reading: its context status is "ok" and the tokens of its "Messages" category are under 60,000/);
  assert.match(step(4), /it is fresh already; send nothing/);
  assert.equal(LOW_START, 60_000, "step 4's number is the script's LOW_START");
});

// Checker on ce13435f: an idle Manager whose process has stopped reports its context unavailable (no categories, read as
// 0), which would pass "under 60,000" and skip the reset every morning. No reading is not a fresh session.
test("a context that isn't 'ok' is no reading: the reset goes ahead, never skipped on a zero", () => {
  assert.match(step(4), /a category not listed counts as 0 only when the status is "ok"/);
  assert.match(step(4), /A status that isn't "ok" .* is no reading: reset anyway, never skip on it/);
  const skips = ({ status, messages }) => status === "ok" && messages < LOW_START;
  assert.equal(skips({ status: "ok", messages: 14_674 }), true, "a real small reading: fresh already");
  assert.equal(skips({ status: "ok", messages: 310_000 }), false, "a full lead: reset");
  assert.equal(skips({ status: "unavailable", messages: 0 }), false, "idle overnight, process stopped: reset anyway");
});

test("Manager records its own pickedAt, so the keeper's hourly step 4 doesn't pick it up again", () => {
  assert.match(step(7), /Set agents\.Manager\.pickedAt on the board's meta\/context to now \(milliseconds\)/);
  assert.doesNotMatch(prompt, /ArtifactData/, "the task never reads or writes the board");
});

test("it never clears a session or touches Remote Control; its Bash is two exact rules (Security)", () => {
  assert.match(prompt, /Never clear a session yourself, never touch Remote Control/);
  assert.doesNotMatch(prompt, /clear_session|set_remote_control/);
  assert.match(doc, /allow Bash for exactly the command `sleep 60` \(an exact rule\)/);
  assert.match(doc, /`Bash\(node ~\/\.flight-board\/current\/scripts\/pickup-watch\.mjs \*\)`, never Bash in\ngeneral/);
});

test("a dry run on a test role is the acceptance, then three live mornings", () => {
  assert.match(doc, /## Dry run \(the acceptance\)[\s\S]*"\/pickup Rehearsal" once[\s\S]*Remote Control is on again/);
  assert.match(doc, /three mornings in a row/);
});

// The task's steps 4-6 as a rule over one morning's readings (Messages tokens; state from list_sessions).
const morning = (before, after) => {
  if (before < LOW_START) return [];
  const sent = ["CONTEXT RESET"], readings = [];
  for (const r of after) {
    readings.push(r);
    const word = decide(readings);
    if (word === "send") { sent.push("/pickup Manager"); break; }
    if (word !== "wait") break;
  }
  return sent;
};

test("a full lead: one reset, one pickup, and its pickup turn doesn't draw a second", () => {
  const w = (tokens) => ({ state: "working", tokens }), i = (tokens) => ({ state: "idle", tokens });
  assert.deepEqual(morning(310_000, [w(310_000), w(312_000), i(0)]), ["CONTEXT RESET", "/pickup Manager"]);
  assert.deepEqual(morning(310_000, [w(311_000), i(0), w(9_000), i(0)]), ["CONTEXT RESET", "/pickup Manager"], "stops at the first send");
  assert.equal(decide([w(311_000), i(0), w(9_000), i(0)]), "picked-up", "the reading after the pickup turn: no second send");
  assert.deepEqual(morning(310_000, [w(311_000), w(2_000)]), ["CONTEXT RESET"], "Steward or someone picked it up first");
  assert.deepEqual(morning(310_000, Array(10).fill(w(311_000))), ["CONTEXT RESET"], "never cleared: gives up, the keeper's step 4 is the backstop");
});

test("a small lead is skipped: reset anyway, its reset turn reads as a pickup and it would sit cleared", () => {
  const w = (tokens) => ({ state: "working", tokens }), i = (tokens) => ({ state: "idle", tokens });
  assert.deepEqual(morning(40_000, [w(41_000), i(0)]), [], "step 4: fresh already");
  assert.equal(decide([w(41_000), i(0)]), "picked-up", "why: without step 4 no pickup would go out");
});
