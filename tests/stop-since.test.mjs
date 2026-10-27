// The Stop gate's window for owner words reaches back to the lead's last clean check, not a whole day (#C316, the owner's
// choice A on #T928), less SLACK (an owner word under WAIT_MIN minutes old then, or written after the view's listing on a
// clock a little behind). No record: the day, as before. The record is kept per key in <stateDir>/<board>/stop.json (since
// #C334 the key is the role: tests/stop-view.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastPass, recordPass, sinceOf, SLACK } from "../gate/stop.mjs";
import { WAIT_MIN } from "../gate/owner-waits.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3, DAY = 864e5;

test("SLACK covers an owner word too young at the last pass", () => {
  assert.ok(SLACK >= (WAIT_MIN + 5) * MIN);
  assert.equal(sinceOf(null, NOW), NOW - DAY, "no record: the day");
  assert.equal(sinceOf(NOW - 3 * 3600e3, NOW), NOW - 3 * 3600e3 - SLACK);
});

test("the record: per key, a number in the past, else none", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-stop-"));
  try {
    const path = join(dir, "b", "stop.json");
    assert.equal(lastPass(path, "Manager", NOW), null, "no file");
    recordPass(path, "Manager", NOW - 10 * MIN);
    recordPass(path, "s2", NOW - 20 * MIN);
    assert.equal(lastPass(path, "Manager", NOW), NOW - 10 * MIN);
    assert.equal(lastPass(path, "s2", NOW), NOW - 20 * MIN);
    assert.equal(lastPass(path, "s3", NOW), null, "another key");
    assert.equal(lastPass(path, "Manager", NOW - 11 * MIN), null, "a time ahead of the clock");
    assert.equal(lastPass(path, "__proto__", NOW), null);
    writeFileSync(path, JSON.stringify({ sessions: { Manager: "1" } }));
    assert.equal(lastPass(path, "Manager", NOW), null, "not a number");
    writeFileSync(path, "{nope");
    assert.equal(lastPass(path, "Manager", NOW), null, "not JSON");
    recordPass(path, "Manager", NOW - MIN);
    assert.equal(lastPass(path, "Manager", NOW), NOW - MIN, "a broken file is replaced");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
