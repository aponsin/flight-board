// Scheduled-task prompts that message the lead carry no session id (#C634): the Collector's prompt named the retired lead,
// its fence refused the send, and it was mute. The lead is the config's gate.managerSession; these prompts say so. The check
// reads the installed prompts when they are there (a machine without them has nothing to check).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The tasks whose prompts message the lead: the Collector's, and the ones that say so by name (watchdog, keeper, reminder).
// Their folders are found by those words, so no team name is written in the repository.
const TASKS = join(homedir(), ".claude", "scheduled-tasks");
const LEAD_PROMPTS = existsSync(TASKS) ? readdirSync(TASKS).filter((n) => n === "board-collector" || /(?:watchdog|context-keeper|remind-)/.test(n)) : ["board-collector"];
const SESSION_ID = /local_[0-9a-f]{8}\b/;

export const idLines = (text) => text.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => SESSION_ID.test(l));

test("the checker finds a session id on a line, and nothing in a prompt that names the config key", () => {
  assert.deepEqual(idLines("a\nsession id local_049a77c5-2ab6-4377-bc6b-c3765a7d768d\nb").map(([n]) => n), [2]);
  assert.deepEqual(idLines("session_id the lead session's id from the config's gate.managerSession"), []);
});

for (const name of LEAD_PROMPTS) {
  const file = join(homedir(), ".claude", "scheduled-tasks", name, "SKILL.md");
  test(`${name}: the installed prompt names no session id`, { skip: !existsSync(file) && "not installed here" }, () => {
    assert.deepEqual(idLines(readFileSync(file, "utf8")), [], `${file} names a session id: say "the lead session from gate.managerSession"`);
  });
}

test("the Collector's prompt says to message the lead from gate.managerSession", { skip: !existsSync(join(homedir(), ".claude", "scheduled-tasks", "board-collector", "SKILL.md")) && "not installed here" }, () => {
  const text = readFileSync(join(homedir(), ".claude", "scheduled-tasks", "board-collector", "SKILL.md"), "utf8");
  assert.ok(text.includes("gate.managerSession"));
});
