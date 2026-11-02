// #C590: the probe carries the wake watch's heartbeat and last handled wake (times only); the page's Manager chip and the
// "seen" ticks under the owner's messages read them.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNames } from "./harness.mjs";
import { wakeTimes, buildState } from "../collector/state.mjs";
import { stateErrors, pickState } from "../collector/state-schema.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const hh = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

test("wakeTimes: the two times from the watch's files; odd, future or missing ones are none; nothing else is read", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-"));
  assert.deepEqual(wakeTimes(dir, NOW), { wakeAlive: null, wakeSeen: null });
  writeFileSync(join(dir, "wake-watch.alive.json"), JSON.stringify({ at: NOW - 5e3, pid: 7, secret: "x" }));
  writeFileSync(join(dir, "wake-seen.json"), JSON.stringify({ seq: 3, at: NOW - 4 * MIN }));
  assert.deepEqual(wakeTimes(dir, NOW), { wakeAlive: NOW - 5e3, wakeSeen: NOW - 4 * MIN });
  writeFileSync(join(dir, "wake-seen.json"), JSON.stringify({ seq: 3, at: NOW + 10 * MIN }));
  writeFileSync(join(dir, "wake-watch.alive.json"), "not json");
  assert.deepEqual(wakeTimes(dir, NOW), { wakeAlive: null, wakeSeen: null });
  rmSync(join(dir, "wake-seen.json"));
  writeFileSync(join(dir, "real.json"), JSON.stringify({ at: NOW }));
  symlinkSync(join(dir, "real.json"), join(dir, "wake-seen.json"));
  assert.equal(wakeTimes(dir, NOW).wakeSeen, null, "a link is not read");
});

test("the state carries the two times and no more; a bad time doesn't fit", () => {
  const s = buildState({ id: "flight-board", now: NOW, probe: "a".repeat(12), pageVersion: null, cards: {}, agents: {}, wakeAlive: NOW - 1e3, wakeSeen: NOW - 2 * MIN });
  assert.equal(s.board.wakeAliveAt, NOW - 1e3);
  assert.equal(s.board.wakeSeenAt, NOW - 2 * MIN);
  const none = buildState({ id: "flight-board", now: NOW, probe: null, pageVersion: null, cards: {}, agents: {} });
  assert.equal(none.board.wakeAliveAt, null);
  const old = structuredClone(s); delete old.board.wakeAliveAt; delete old.board.wakeSeenAt;
  assert.deepEqual(stateErrors(old), [], "a probe from before this still fits");
  const bad = structuredClone(s); bad.board.wakeSeenAt = "10:00 tell them";
  assert.ok(stateErrors(bad).length);
  assert.equal(pickState(bad), null);
});

function page(board, messages) {
  const b = loadNames(["managerChip", "seenTick", "OWNER", "set:(p)=>{probe=p}"]);
  b.state.messages = messages;
  b.set(board === null ? null : { v: 1, board: { at: Date.now(), ...board }, cards: {}, agents: {} });
  return b;
}
const owner = (b) => b.OWNER;
const chip = (b) => JSON.parse(JSON.stringify(b.managerChip(Date.now())));

test("the chip: green caught up, amber for a seen unanswered message, red when the heartbeat is stale or none, hidden on an older probe", () => {
  const now = Date.now();
  let b = page({ wakeAliveAt: now - 5e3, wakeSeenAt: now - 10 * MIN }, []);
  assert.deepEqual(chip(b), { cls: "ok", text: `Manager listening · caught up ${hh(now - 5e3)}` });
  const msg = (from, at, thread = "t1") => ({ id: `m${at}`, thread, from, text: "hi", at });
  b = page({ wakeAliveAt: now - 5e3, wakeSeenAt: now - MIN }, []);
  b.state.messages = [msg(owner(b), now - 2 * MIN)];
  assert.deepEqual(chip(b), { cls: "warn", text: `seen your ${hh(now - 2 * MIN)} message · answer coming` });
  b.state.messages.push(msg("Manager", now - 30e3));
  assert.equal(b.managerChip(now).cls, "ok", "answered");
  b.state.messages = [msg(owner(b), now - 30e3)];
  assert.deepEqual(chip(b), { cls: "ok", text: "Manager listening" }, "written after the last wake it handled: not seen yet");
  b = page({ wakeAliveAt: now - 10 * MIN, wakeSeenAt: null }, []);
  assert.deepEqual(chip(b), { cls: "bad", text: `Manager not listening since ${hh(now - 10 * MIN)} · say wake up the team` });
  b = page({ wakeAliveAt: null, wakeSeenAt: null }, []);
  assert.equal(b.managerChip(now).text, "Manager not listening · say wake up the team");
  assert.equal(page({}, []).managerChip(now), null, "a probe from before #C590 carries neither key");
  assert.equal(page(null, []).managerChip(now), null);
});

test("a 'seen' tick under the owner's messages the watch has handled: the time on the newest one only", () => {
  const now = Date.now();
  const b = page({ wakeAliveAt: now, wakeSeenAt: now - MIN }, []);
  const m = (from, at) => ({ id: `m${at}`, thread: "t1", from, text: "hi", at });
  b.state.messages = [m(owner(b), now - 5 * MIN), m(owner(b), now - 2 * MIN), m(owner(b), now - 10e3), m("Manager", now - 4 * MIN)];
  const [a, c, late, mgr] = b.state.messages;
  assert.equal(b.seenTick(a), '<div class="t-seen">seen</div>');
  assert.equal(b.seenTick(c), `<div class="t-seen">seen ${hh(now - MIN)}</div>`);
  assert.equal(b.seenTick(late), "", "after the last wake it handled");
  assert.equal(b.seenTick(mgr), "", "only the owner's");
});

// #C606: the chip sits at the header's top right (first in the right block, above the clock), not inline after the stamp.
test("the Manager chip is in the header's right block above the clock, and that block wraps below the title on a phone", () => {
  const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  const header = html.match(/<header>([\s\S]*?)<\/header>/)[1];
  const right = header.match(/<div class="hdr-right">([\s\S]*)<\/div>\s*$/)[1];
  assert.ok(right.indexOf('id="mgrchip"') >= 0 && right.indexOf('id="mgrchip"') < right.indexOf('class="clock"'), "chip first in the right block");
  const clock = header.match(/<div class="clock">([\s\S]*?)<\/div>/)[1];
  assert.ok(!clock.includes("mgrchip"), "not inline after the stamp");
  assert.match(html, /header\{[^}]*flex-wrap:wrap/, "the header wraps");
  assert.match(html, /\.hdr-right\{[^}]*max-width:100%/, "the block never outgrows the phone");
});
