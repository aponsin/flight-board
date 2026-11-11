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
  assert.deepEqual(chip(b), { cls: "ok", text: "Manager listening" }, "#C606: the state alone, no times");
  const msg = (from, at, thread = "t1") => ({ id: `m${at}`, thread, from, text: "hi", at });
  b = page({ wakeAliveAt: now - 5e3, wakeSeenAt: now - MIN }, []);
  b.state.messages = [msg(owner(b), now - 2 * MIN)];
  assert.deepEqual(chip(b), { cls: "warn", text: `delivered your ${hh(now - 2 * MIN)} message · answer coming` });
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
  assert.equal(b.seenTick(a), '<div class="t-seen">delivered</div>');
  assert.equal(b.seenTick(c), `<div class="t-seen">delivered ${hh(now - MIN)}</div>`);
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
  assert.match(html, /\.mgr-chip\[hidden\]\{display:none\}/, "a hidden chip takes no room (Checker's nit)");
});

// #C609: "Board v3.45 · page c647307" under the title; each part only when it is real.
test("the version line: the pack name (or the installed code) and the page's commit; a part that isn't real is left out", () => {
  const b = loadNames(["boardVerText"]);
  assert.equal(b.boardVerText("v3.45", "c647307", "9db172c93fca"), "Board v3.45 · page c647307", "the stamped pack name wins");
  assert.equal(b.boardVerText("", "c647307", "9db172c93fca"), "Board 9db172c · page c647307", "no pack name: the installed code from the probe");
  assert.equal(b.boardVerText("", "c647307", null), "page c647307");
  assert.equal(b.boardVerText("v3.45", "", null), "Board v3.45");
  assert.equal(b.boardVerText("", "", null), "");
  assert.equal(b.boardVerText("<b>x</b>", "{{PAGE_COMMIT}}", "nonsense"), "", "an unfilled placeholder or odd text shows nothing");
});

// #C611: Today, 7 days, 30 days and Plan week on one row on a laptop (Plan week wrapped under the three), 2x2 on a phone.
test("the Time spent tiles: as many 110px+ columns as fit (four on a laptop, two by two narrow), long words break", () => {
  const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.match(html, /\.totals\{display:grid;grid-template-columns:repeat\(auto-fit,minmax\(110px,1fr\)\)/);
  assert.match(html, /\.tot\{[^}]*overflow-wrap:anywhere/, "BOARDSMITH never overflows a tile");
  assert.doesNotMatch(html, /\.totals\{[^}]*repeat\((3|4),/, "no fixed column count left");
});

test("the header's right block is left-aligned on a phone, where it wraps under the title", () => {
  const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.match(html, /@media \(max-width:600px\)\{\.hdr-right\{align-items:flex-start;text-align:left\}\}/);
});

// #C675 (it was #C618's: under the clock): the "Board vX" chip sits just right of the "Safe to restart" badge, in the left block.
test("the version chip is just right of the restart badge in the header's left block, not under the clock; it stays hidden when empty", () => {
  const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  const header = html.match(/<header>([\s\S]*?)<\/header>/)[1];
  const left = header.match(/<div class="hdr-left">([\s\S]*?)<\/div>\s*<div class="hdr-right">/)[1];
  const right = header.match(/<div class="hdr-right">([\s\S]*)<\/div>\s*$/)[1];
  assert.ok(!right.includes("boardver"), "not under the clock");
  const badge = left.indexOf('id="restartbadge"'), chip = left.indexOf('id="boardver"');
  assert.ok(badge >= 0 && chip > badge, "after the badge");
  assert.ok(left.indexOf("</div>", badge) < chip && left.slice(left.indexOf("</div>", badge), chip).match(/<div/g)?.length === 1, "the badge's own div closes, and the chip is the next thing in the same row");
  assert.match(left, /id="boardver"[^>]* hidden>/);
  assert.match(html, /\.hdr-badges\{display:flex;flex-wrap:wrap;align-items:center/, "one row, wrapping on a phone");
  assert.match(html, /\.boardver\[hidden\]\{display:none\}/, "a hidden line takes no room");
});

// #C675: the header stays put while the page scrolls, at phone and laptop size; what sticks below it starts at its height.
test("the header is sticky in the page's colour, and the strip below it sticks at the header's height", () => {
  const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  const rule = html.match(/\nheader\{([^}]*)\}/)[1];
  assert.match(rule, /position:sticky/);
  assert.match(rule, /top:0/);
  assert.match(rule, /background:var\(--bg\)/, "content scrolling under it is hidden");
  assert.match(rule, /z-index:7/, "above the strip (5)");
  assert.match(html, /\.v3strip\{position:sticky;top:var\(--hdr-h,0px\)/);
  assert.match(html, /style\.setProperty\("--hdr-h",\(getComputedStyle\(h\)\.position==="sticky"\?h\.offsetHeight:0\)\+"px"\)/, "the header's height is read, and again when it changes");
  assert.match(html, /new ResizeObserver\(set\)\.observe\(h\)/);
  // Sticky from 600px up only (Designer): under it the header scrolls away, the media rule comes after the header rule, and
  // --hdr-h reads 0 when the header is not sticky, so the strip and the scroll padding fall back to the top of the page.
  const at = html.indexOf("\nheader{"), phone = html.indexOf("@media (max-width:599px){header{position:static;border-bottom:0}}");
  assert.ok(phone > at && at > 0, "the phone rule follows the header rule, so it wins");
  assert.match(html, /getComputedStyle\(h\)\.position==="sticky"\?h\.offsetHeight:0/);
  assert.match(html, /window\.addEventListener\("resize",set\)/, "crossing 600px re-reads it");
  assert.match(html, /\nhtml\{scroll-padding-top:var\(--hdr-h,0px\)\}/, "a card or thread jump (scrollIntoView block:start) stops below the header, not behind it");
});

test("the build stamps the page's commit and the pack name into the header; only well-formed ones", async () => {
  const { buildPage } = await import("../scripts/build-page.mjs");
  const template = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  const config = JSON.parse(readFileSync(new URL("../board.config.example.json", import.meta.url), "utf8"));
  const html = buildPage(template, config, { commit: "c647307", pack: "v3.46" });
  assert.match(html, /id="boardver" data-pack="v3\.46" data-commit="c647307"/);
  const plain = buildPage(template, config);
  assert.match(plain, /id="boardver" data-pack="" data-commit=""/, "no stamp: empty, and the line stays hidden");
  assert.match(buildPage(template, config, { commit: '"><script>', pack: "v3.4; x" }), /data-pack="" data-commit=""/, "odd values are dropped");
});
