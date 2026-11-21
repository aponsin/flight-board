// #C1400 (11-20, about 3:06 to 3:31 pm MT: the board had #C1383's DISPATCH item from 3:06 while #C1382's turn had ended with no watch running; the watch was armed at 3:31 and printed it then).
// The cause is the Stop hook's 10-minute gap between asks (DISPATCH_ASK_GAP_MS): a turn that ended inside the gap after an earlier ask was let go with no watch, and an item waiting for a watch
// is exactly the case the ask is for. The gap stays for a role with nothing waiting (a session that cannot run a background command is not stopped for ever); while the role has a level-1
// item its watch has not printed (`pending`, the watch's own test dispatchPending), the ask is made at every stop. A second stop in a row still passes (stop_hook_active, unchanged).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fullConfig } from "../scripts/config.mjs";
import { DISPATCH_FILE, dispatchSeenFile, dispatchPidFile } from "../gate/reset.mjs";
import { dispatchAsk, dispatchState, DISPATCH_ASK_GAP_MS } from "../gate/stop.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const roster = ["Manager", "Builder", "Checker"];
const base = { on: true, alive: false, askedAt: null, command: "node w.mjs --role Builder --once --pinned" };

test("inside the 10-minute gap the ask is held with nothing waiting, and made with a pending item", () => {
  const recent = NOW - 4 * MIN;
  assert.equal(dispatchAsk({ ...base, askedAt: recent }, NOW), null, "nothing waiting: the gap holds");
  assert.equal(dispatchAsk({ ...base, askedAt: recent, pending: false }, NOW), null);
  assert.match(dispatchAsk({ ...base, askedAt: recent, pending: true }, NOW), /^Dispatch watch: /, "work waiting: asked inside the gap");
  assert.match(dispatchAsk({ ...base, askedAt: NOW - 1000, pending: true }, NOW), /Arm it now/, "a second after the last ask too");
  assert.match(dispatchAsk({ ...base, askedAt: NOW - DISPATCH_ASK_GAP_MS - 1 }, NOW), /^Dispatch watch: /, "past the gap, as before");
});

test("a pending item changes nothing else: a running watch, or a board that does not dispatch, is never asked", () => {
  assert.equal(dispatchAsk({ ...base, alive: true, pending: true }, NOW), null);
  assert.equal(dispatchAsk({ ...base, on: false, pending: true }, NOW), null);
  assert.equal(dispatchAsk({ ...base, askedAt: NOW - MIN, pending: "yes" }, NOW), null, "only the boolean true lifts the gap");
});

test("dispatchState: pending is a level-1 item of this role the role's watch has not printed", () => {
  const home = mkdtempSync(join(tmpdir(), "stop-pending-"));
  try {
    const cfg = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", roster, gate: { stateDir: join(home, "state") } });
    const dir = join(home, "state", "TestBoard01");
    mkdirSync(dir, { recursive: true });
    const at = (role) => dispatchState(cfg, join(home, "board.config.json"), role, NOW);
    assert.equal(at("Builder").pending, false, "no dispatch file");
    writeFileSync(join(dir, DISPATCH_FILE), JSON.stringify({ at: NOW, items: [{ card: "menu", role: "Builder", level: 1, since: NOW - MIN }, { card: "late", role: "Checker", level: 2, since: NOW - MIN }] }));
    assert.equal(at("Builder").pending, true, "an item the watch has not printed");
    assert.equal(at("Checker").pending, true, "the role's own watch prints its level-2 items too (level >= 1, the watch's own test)");
    assert.equal(at("Manager").pending, false, "another role's");
    writeFileSync(join(dir, dispatchSeenFile("Builder")), JSON.stringify({ items: { menu: NOW - MIN } }));
    assert.equal(at("Builder").pending, false, "printed already (same since)");
    writeFileSync(join(dir, DISPATCH_FILE), JSON.stringify({ at: NOW, items: [{ card: "menu", role: "Builder", level: 1, since: NOW }] }));
    assert.equal(at("Builder").pending, true, "the same card with a new since is printed again");
    writeFileSync(join(dir, DISPATCH_FILE), "not json");
    assert.equal(at("Builder").pending, false, "an unreadable file is nothing waiting");
    writeFileSync(join(dir, dispatchPidFile("Builder")), JSON.stringify({ pid: process.pid, at: NOW - 5000 }));
    assert.equal(at("Builder").alive, true, "the beat of a live process (unchanged)");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
