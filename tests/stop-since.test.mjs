// The Stop gate's read reaches back to the lead's last checked turn, not a whole day (#C316, the owner's choice A on
// #T928: the day's ~90 + ~136 messages cost ~5% of the lead's context a turn). A stop whose check passed records when
// that turn read (the earlier of its two reads, from the transcript's clock), per session, in <stateDir>/<board>/stop.json;
// the next turn's reads must reach back to it, less SLACK (an owner word under WAIT_MIN minutes old then, or written
// after the read on a clock a little behind). No record: the day, as before.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fullConfig } from "../scripts/config.mjs";
import { stopCheck, stopRun, lastPass, recordPass, sinceOf, SLACK } from "../gate/stop.mjs";
import { WAIT_MIN } from "../gate/owner-waits.mjs";

const URL_ = "https://claude.ai/" + "artifact/TestBoard01";
const config = fullConfig({ artifactUrl: URL_ });
const NOW = 1_800_000_000_000, MIN = 60e3, DAY = 864e5;
const msg = (thread, from, at) => ({ id: `m${at}-${from}`, thread, from, text: "x", at });
const Q = (who, since) => ({ action: "query", collection: "messages", query: { where: [["from", "==", who], ["at", ">", since]], limit: 1000 } });
const result = (docs) => `${docs.length} documents from collection "messages":\n${docs.map((d) => JSON.stringify({ id: d.id, data: d, version: 1 })).join("\n")}`;
let n = 0;
const read = (input, docs, at) => {
  const id = `r${++n}`;
  return [
    { type: "assistant", timestamp: at == null ? undefined : new Date(at).toISOString(), message: { content: [{ type: "tool_use", id, name: "ArtifactData", input: { url: URL_, ...input } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: result(docs) }] } },
  ];
};
const turn = (parts) => [
  { type: "custom-title", customTitle: "Manager" },
  { type: "user", message: { content: [{ type: "text", text: "status?" }] } },
  ...parts,
  { type: "assistant", message: { content: [{ type: "text", text: "Done." }] } },
];
const both = (since, at, owner = []) => [...read(Q("Owner", since), owner, at), ...read(Q("Manager", since), [], at == null ? at : at + 1000)];

test("SLACK covers an owner word too young at the last pass", () => {
  assert.ok(SLACK >= (WAIT_MIN + 5) * MIN);
  assert.equal(sinceOf(null, NOW), NOW - DAY, "no record: the day");
  assert.equal(sinceOf(NOW - 3 * 3600e3, NOW), NOW - 3 * 3600e3 - SLACK);
});

test("the reads must reach back to since: one that stops short is no read, and the refusal names since", () => {
  const since = NOW - 2 * 3600e3;
  assert.deepEqual(stopCheck(turn(both(since, NOW - MIN)), { config, now: NOW, since }), []);
  assert.deepEqual(stopCheck(turn(both(since - 5 * MIN, NOW - MIN)), { config, now: NOW, since }), [], "further back is fine");
  const errs = stopCheck(turn(both(since + 1, NOW - MIN)), { config, now: NOW, since });
  assert.match(errs.join(), /read Owner's and Manager's messages this turn/);
  assert.match(errs.join(), new RegExp(`at > ${since}\\b`));
  assert.match(stopCheck(turn(both(NOW - DAY + 1, NOW - MIN)), { config, now: NOW }).join(), /read Owner's/, "no since: the day, as before");
  // An owner word inside the window, unanswered, still refuses.
  assert.match(stopCheck(turn(both(since, NOW - MIN, [msg("t-a", "Owner", since + MIN)])), { config, now: NOW, since }).join(), /thread t-a has waited/);
});

test("Checker: a cut marker counts only on the board's own lines, never inside a message's text", () => {
  const since = NOW - 3600e3;
  for (const text of ["I'll send more documents tomorrow", "[2 more to check]", "next_cursor?"]) {
    const m = { ...msg("t-a", "Owner", NOW - 30 * MIN), text };
    const lead = { ...msg("t-a", "Manager", NOW - 20 * MIN), text: "ok" };
    assert.deepEqual(stopCheck(turn([...read(Q("Owner", since), [m], NOW - MIN), ...read(Q("Manager", since), [lead], NOW - MIN)]), { config, now: NOW, since }), [], text);
  }
  const ordered = `${result([])}\n[ordered queries return one page: these are the first 1000 by "at" — more may exist.]`;
  const r = turn([{ type: "assistant", timestamp: new Date(NOW - MIN).toISOString(), message: { content: [{ type: "tool_use", id: "o1", name: "ArtifactData", input: { url: URL_, ...Q("Owner", since) } }] } }, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "o1", content: ordered }] } }, ...read(Q("Manager", since), [], NOW - MIN)]);
  assert.match(stopCheck(r, { config, now: NOW, since }).join(), /read Owner's messages/, "an ordered page that says more may exist");
});

test("readAt: the earlier read's time when the check passes; none when it refuses or a read has no time", () => {
  const since = NOW - 3600e3;
  assert.equal(stopRun(turn(both(since, NOW - 9 * MIN)), { config, now: NOW, since }).readAt, NOW - 9 * MIN);
  assert.equal(stopRun(turn(both(since, NOW - 9 * MIN, [msg("t-a", "Owner", NOW - 20 * MIN)])), { config, now: NOW, since }).readAt, null, "refused");
  assert.equal(stopRun(turn(both(since, null)), { config, now: NOW, since }).readAt, null, "no time on the read");
  assert.equal(stopRun(turn([...read(Q("Owner", since), [], NOW - 2 * MIN), ...read(Q("Owner", since), [], NOW - 30 * MIN), ...read(Q("Manager", since), [], NOW - MIN)]), { config, now: NOW, since }).readAt, NOW - 30 * MIN, "the earliest of the reads");
  assert.equal(stopRun(turn([]), { config: fullConfig({ artifactUrl: URL_ }), now: NOW, env: { FLIGHT_BOARD_ROLE: "Builder" } }).readAt, null, "not the lead");
});

test("the record: per session, a number in the past, else none", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-stop-"));
  try {
    const path = join(dir, "b", "stop.json");
    assert.equal(lastPass(path, "s1", NOW), null, "no file");
    recordPass(path, "s1", NOW - 10 * MIN);
    recordPass(path, "s2", NOW - 20 * MIN);
    assert.equal(lastPass(path, "s1", NOW), NOW - 10 * MIN);
    assert.equal(lastPass(path, "s2", NOW), NOW - 20 * MIN);
    assert.equal(lastPass(path, "s3", NOW), null, "another session");
    assert.equal(lastPass(path, "s1", NOW - 11 * MIN), null, "a time ahead of the clock");
    assert.equal(lastPass(path, "__proto__", NOW), null);
    writeFileSync(path, JSON.stringify({ sessions: { s1: "1" } }));
    assert.equal(lastPass(path, "s1", NOW), null, "not a number");
    writeFileSync(path, "{nope");
    assert.equal(lastPass(path, "s1", NOW), null, "not JSON");
    recordPass(path, "s1", NOW - MIN);
    assert.equal(lastPass(path, "s1", NOW), NOW - MIN, "a broken file is replaced");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the hook: a pass records the turn's read, the next turn reads from there; a refusal records nothing; a forced stop records only a clean check", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-stop-"));
  try {
    const cfg = join(dir, "board.config.json"), state = join(dir, "state"), transcript = join(dir, "sess1.jsonl");
    writeFileSync(cfg, JSON.stringify({ artifactUrl: URL_, owner: "Owner", gate: { stateDir: state } }));
    const file = join(state, "TestBoard01", "stop.json");
    const run = (lines, active = false) => {
      writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      return spawnSync(process.execPath, [fileURLToPath(new URL("../gate/stop.mjs", import.meta.url)), "--config", cfg], { input: JSON.stringify({ transcript_path: transcript, stop_hook_active: active }), encoding: "utf8" });
    };
    const now = Date.now(), t1 = now - 60 * MIN;
    // No record: the day.
    assert.equal(run(turn(both(t1 - DAY, t1 + MIN, [msg("t-a", "Owner", t1)]))).status, 2, "an owner word waits: refused");
    assert.equal(existsSync(file), false, "a refusal records nothing");
    assert.equal(run(turn(both(now - DAY, t1))).status, 0);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).sessions.sess1, t1, "the pass records its read's time");
    // The next turn: from t1, less SLACK.
    const short = run(turn(both(t1, now - MIN)));
    assert.equal(short.status, 2, "a read from the last pass itself is short by SLACK");
    assert.match(short.stderr, new RegExp(`at > ${t1 - SLACK}\\b`));
    assert.equal(run(turn(both(t1 - SLACK, now - 2 * MIN))).status, 0);
    assert.equal(lastPass(file, "sess1", now), now - 2 * MIN);
    // A forced stop (stop_hook_active) passes; it records only when the check itself is clean.
    const t2 = now - 2 * MIN;
    assert.equal(run(turn(both(t2 - SLACK, now - MIN, [msg("t-b", "Owner", now - 10 * MIN)])), true).status, 0);
    assert.equal(lastPass(file, "sess1", now), t2, "a forced stop with an owner word waiting: no record");
    assert.equal(run(turn(both(t2 - SLACK, now - MIN)), true).status, 0);
    assert.equal(lastPass(file, "sess1", now), now - MIN, "a forced stop with a clean check: recorded");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
