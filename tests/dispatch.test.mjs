// Dispatch is mechanical (#C631): the probe finds an active card whose owner has sat idle with nothing to wait for and writes
// dispatch.json; the owner's own background watch (wake-watch --role <Role> --once) blocks until then, prints one DISPATCH line
// and exits, which wakes the session; 30 minutes on, the lead's watch prints one DISPATCH-LATE line. The owner's Stop hook asks
// to arm the watch only when none is running. No model decides at any step.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fullConfig } from "../scripts/config.mjs";
import { dispatchItems, dispatchPending, dispatchSeen, dispatchLine, dispatchLateLine, dispatchWatchAlive, DISPATCH_FILE, DISPATCH_IDLE_MS, DISPATCH_LATE_MS, dispatchPidFile } from "../gate/reset.mjs";
import { tick, roleTick } from "../scripts/wake-watch.mjs";
import { stopRun, dispatchAsk, dispatchState, DISPATCH_ASK_GAP_MS } from "../gate/stop.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const roster = ["Manager", "Builder", "Checker"];
const card = (id, extra = {}) => ({ id, status: "active", who: "Builder", phase: "build", ...extra });
const idle = (min) => ({ state: "idle", lastActivityAt: NOW - min * MIN, since: NOW - min * MIN, tool: null, card: null });
const run = (cards, agents, extra = {}) => dispatchItems({ cards, agents, roster, lead: "Manager", now: NOW, ...extra });

test("an active card whose owner has been idle 15 minutes is dispatched at level 1", () => {
  assert.deepEqual(run([card("menu")], { Builder: idle(16) }).items, [{ card: "menu", role: "Builder", level: 1, since: NOW }]);
  assert.deepEqual(run([card("menu")], { Builder: idle(14) }).items, [], "idle under 15 minutes");
  assert.equal(DISPATCH_IDLE_MS, 15 * MIN);
});

test("nothing is dispatched for a working owner, a card with something to wait for, the lead, a queued card or a role off the roster", () => {
  const agents = { Builder: idle(40), Manager: idle(40), Ghost: idle(40) };
  assert.deepEqual(run([card("a")], { Builder: { ...idle(40), state: "working" } }).items, [], "working");
  assert.deepEqual(run([card("a")], agents, { asked: new Set(["a"]) }).items, [], "an open ask on the card");
  assert.deepEqual(run([card("a", { waitingOn: "Checker (review)" })], agents).items, [], "waiting on someone else");
  assert.equal(run([card("a", { waitingOn: "Builder: the install" })], agents).items.length, 1, "naming the owner itself holds nothing back");
  assert.deepEqual(run([card("a", { who: "Manager" })], agents).items, [], "the lead is woken by DISPATCH-LATE only");
  assert.deepEqual(run([card("a", { status: "queued" })], agents).items, [], "queued");
  assert.deepEqual(run([card("a", { who: "Ghost" })], agents).items, [], "not on the roster");
  assert.deepEqual(run([card("a")], {}).items, [], "no reading of the owner's session");
});

test("level 2 when it still holds 30 minutes on; a pair that stops holding starts again at level 1", () => {
  const first = run([card("a")], { Builder: idle(20) });
  const later = dispatchItems({ cards: [card("a")], agents: { Builder: idle(50) }, roster, lead: "Manager", now: NOW + 31 * MIN, before: first.state });
  assert.deepEqual(later.items, [{ card: "a", role: "Builder", level: 2, since: NOW }]);
  assert.equal(DISPATCH_LATE_MS, 30 * MIN);
  const working = dispatchItems({ cards: [card("a")], agents: { Builder: { ...idle(1), state: "working" } }, roster, lead: "Manager", now: NOW + 5 * MIN, before: first.state });
  assert.deepEqual(working.state, { items: {} }, "forgotten");
  const again = dispatchItems({ cards: [card("a")], agents: { Builder: idle(30) }, roster, lead: "Manager", now: NOW + 40 * MIN, before: working.state });
  assert.deepEqual(again.items, [{ card: "a", role: "Builder", level: 1, since: NOW + 40 * MIN }]);
});

test("the owner's watch prints one DISPATCH line per spell and keeps a pid beat; the lead's prints DISPATCH-LATE once", () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-"));
  try {
    const put = (items) => writeFileSync(join(dir, DISPATCH_FILE), JSON.stringify({ at: NOW, items }));
    put([]);
    assert.equal(roleTick(dir, "Builder", NOW, 4242), null);
    assert.equal(JSON.parse(readFileSync(join(dir, dispatchPidFile("Builder")), "utf8")).pid, 4242, "the beat");
    put([{ card: "menu", role: "Builder", level: 1, since: NOW }, { card: "other", role: "Checker", level: 1, since: NOW }]);
    assert.equal(roleTick(dir, "Builder", NOW + MIN), dispatchLine({ card: "menu", role: "Builder" }), "only its own role's card");
    assert.equal(roleTick(dir, "Builder", NOW + 2 * MIN), null, "once per spell");
    put([{ card: "menu", role: "Builder", level: 1, since: NOW + 50 * MIN }]);
    assert.match(roleTick(dir, "Builder", NOW + 51 * MIN), /^DISPATCH menu: it waits on you \(Builder\)/, "a new spell");
    // the lead's watch
    put([{ card: "menu", role: "Builder", level: 1, since: NOW }, { card: "late", role: "Checker", level: 2, since: NOW }]);
    assert.equal(tick(dir, NOW + 40 * MIN, 1, roster), dispatchLateLine({ card: "late", role: "Checker", since: NOW }));
    assert.equal(tick(dir, NOW + 41 * MIN, 1, roster), null, "once");
    assert.match(dispatchLateLine({ card: "late", role: "Checker", since: NOW }), /^DISPATCH-LATE late: Checker was woken at \d\d:\d\d UTC and nothing has moved in 30 minutes/);
    assert.deepEqual(dispatchPending({ items: [{ card: "x", role: "R", level: 1, since: 1 }] }, dispatchSeen(null, [{ card: "x", since: 1 }]), { level: 1 }), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the watch counts as running only with a live process and a recent beat", () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-alive-"));
  try {
    const f = join(dir, "p.json"), ok = () => {}, gone = () => { throw Object.assign(new Error("no"), { code: "ESRCH" }); };
    writeFileSync(f, JSON.stringify({ pid: 99, at: NOW - 30e3 }));
    assert.equal(dispatchWatchAlive(f, NOW, ok), true);
    assert.equal(dispatchWatchAlive(f, NOW, gone), false, "the process is gone");
    assert.equal(dispatchWatchAlive(f, NOW + 2 * MIN, ok), false, "the beat is old");
    assert.equal(dispatchWatchAlive(join(dir, "none.json"), NOW, ok), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the owner's Stop hook asks to arm the watch only when the probe dispatches, none runs and it did not ask lately; the lead is unaffected", () => {
  const config = fullConfig({ roster, gate: { managerRole: "Manager" } });
  const state = { on: true, alive: false, askedAt: null, command: "node /x/wake-watch.mjs --config /c.json --role 'Builder' --once" };
  const ask = (dispatch, role = "Builder") => stopRun([], { config, env: { FLIGHT_BOARD_ROLE: role }, now: NOW, dispatch });
  assert.match(ask(state).errs[0], /^Dispatch watch: .*run_in_background true and no timeout.*--role 'Builder' --once/);
  assert.equal(ask(state).dispatchAsked, true);
  assert.deepEqual(ask({ ...state, alive: true }).errs, [], "a watch is running");
  assert.deepEqual(ask({ ...state, on: false }).errs, [], "the probe does not dispatch");
  assert.deepEqual(ask({ ...state, askedAt: NOW - 5 * MIN }).errs, [], "asked five minutes ago");
  assert.equal(ask({ ...state, askedAt: NOW - DISPATCH_ASK_GAP_MS - 1 }).errs.length, 1, "asked long ago: again");
  assert.deepEqual(ask(state, "Ghost").errs, [], "a role off the roster");
  assert.equal(dispatchAsk({ ...state, on: false }, NOW), null);
});

test("the owner's watch as an owner runs it: blocks, prints the DISPATCH line, removes its pid file and exits", async () => {
  const home = mkdtempSync(join(tmpdir(), "dispatch-run-"));
  try {
    const cfgPath = join(home, "board.config.json");
    writeFileSync(cfgPath, JSON.stringify({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", roster, gate: { stateDir: join(home, "state") } }));
    const dir = join(home, "state", "TestBoard01");
    mkdirSync(dir, { recursive: true });
    const script = fileURLToPath(new URL("../scripts/wake-watch.mjs", import.meta.url));
    const bad = spawn(process.execPath, [script, "--config", cfgPath, "--role", "Manager", "--once"], { stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(await new Promise((r) => bad.on("close", r)), 1, "the lead has no owner's watch");
    const child = spawn(process.execPath, [script, "--config", cfgPath, "--role", "Builder", "--once"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    for (let i = 0; i < 40 && !existsSync(join(dir, dispatchPidFile("Builder"))); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(join(dir, dispatchPidFile("Builder"))), "blocking, with its beat");
    assert.equal(out, "", "nothing to print yet");
    writeFileSync(join(dir, DISPATCH_FILE), JSON.stringify({ at: Date.now(), items: [{ card: "menu", role: "Builder", level: 1, since: Date.now() }] }));
    await new Promise((r) => child.on("close", r));
    assert.match(out, /^DISPATCH menu: it waits on you \(Builder\)/);
    assert.equal(existsSync(join(dir, dispatchPidFile("Builder"))), false, "its pid file goes with it");
    // the state the hook reads
    const cfg = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", roster, gate: { stateDir: join(home, "state") } });
    const s = dispatchState(cfg, "/c d/it's.json", "Builder", Date.now());
    assert.deepEqual([s.on, s.alive, s.askedAt], [true, false, null]);
    assert.ok(s.command.endsWith(` --config '/c d/it'\\''s.json' --role 'Builder' --once`), "a space and a quote stay one word");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
