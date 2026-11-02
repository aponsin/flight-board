// The lead's wake path (#C580, gate/wake.mjs): the owner's board message or answer starts a lead turn within about a
// minute, with no comment auto-reply. The page calls board_wake; the state Worker keeps a counter and a time, never text;
// the probe copies the counter to wake.json; the lead's Monitor runs scripts/wake-watch.mjs, one line per new wake; the
// lead's Stop hook asks for the watch while it isn't running.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import worker, { sha256hex, secretName, WAKE_TOOL, WAKE_RATE_MS, WAKE_WRITES_DEFAULT, TOOL } from "../worker/state-worker.mjs";
import { getWake } from "../collector/state.mjs";
import { parseWake, nextWakeFile, wakePending, wakeLine, watchAsk, wakePaths, ALIVE_MAX_MS } from "../gate/wake.mjs";
import { tick, otherWatchAlive } from "../scripts/wake-watch.mjs";
import { fullConfig } from "../scripts/config.mjs";
import { stopRun, wakeState } from "../gate/stop.mjs";

const T = 1_800_000_000_000, MIN = 60e3;
const TOKEN = "a".repeat(64), PATH = "b".repeat(32), BOARD = "TestBoard01";
async function envFor(extra = {}) {
  const kv = new Map();
  const env = { STATE: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } }, ...extra };
  env[await secretName(BOARD)] = JSON.stringify({ token: await sha256hex(TOKEN), path: await sha256hex(PATH) });
  return { env, kv };
}
const rpc = (msg, path = PATH) => new Request(`https://w.example/mcp/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg) });
const wakeCall = (env, args, now) => worker.fetch(rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "board_wake", arguments: args } }), env, {}, now).then((r) => r.json());
const getWakeReq = (token = TOKEN, board = BOARD) => new Request(`https://w.example/b/${board}/wake`, { headers: { authorization: `Bearer ${token}` } });

test("the Worker lists board_wake beside board_state: a write, one required kind, nothing else", async () => {
  const { env } = await envFor();
  const list = await worker.fetch(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }), env, {}, T).then((r) => r.json());
  assert.deepEqual(list.result.tools, [TOOL, WAKE_TOOL]);
  assert.equal(WAKE_TOOL.annotations.readOnlyHint, false);
  assert.deepEqual(WAKE_TOOL.inputSchema.required, ["kind"]);
  assert.equal(WAKE_TOOL.inputSchema.additionalProperties, false);
});

test("board_wake counts one wake, collapses a burst inside 10 s, and counts the next after it", async () => {
  const { env, kv } = await envFor();
  const a = await wakeCall(env, { kind: "message" }, T);
  assert.deepEqual(a.result.structuredContent, { seq: 1 });
  const b = await wakeCall(env, { kind: "answer" }, T + WAKE_RATE_MS - 1);
  assert.deepEqual(b.result.structuredContent, { seq: 1, collapsed: true }, "inside the window: the same wake, no write");
  assert.equal(JSON.parse([...kv.entries()].find(([k]) => k.startsWith("w:"))[1]).at, T, "the burst wrote nothing");
  const c = await wakeCall(env, { kind: "message" }, T + WAKE_RATE_MS);
  assert.deepEqual(c.result.structuredContent, { seq: 2 });
});

test("the Worker keeps no text: only seq, at, day and the writes counted", async () => {
  const { env, kv } = await envFor();
  await wakeCall(env, { kind: "message" }, T);
  const stored = JSON.parse([...kv.entries()].find(([k]) => k.startsWith("w:"))[1]);
  assert.deepEqual(Object.keys(stored).sort(), ["at", "day", "seq", "writes"]);
  assert.ok([...kv.keys()].find((k) => k.startsWith("w:BOARD_")), "under the secret's name, not the board id");
});

test("board_wake refuses a missing or odd kind, an extra argument and text, and writes nothing", async () => {
  const { env, kv } = await envFor();
  for (const args of [undefined, null, {}, { kind: "ping" }, { kind: "message", text: "hello" }, { kind: ["message"] }, [], "message"]) {
    const r = await wakeCall(env, args, T);
    assert.equal(r.result.isError, true, JSON.stringify(args));
  }
  assert.equal(kv.size, 0);
});

test("board_wake has a day's budget, and the next UTC day starts afresh", async () => {
  const { env } = await envFor({ WAKE_WRITES_PER_DAY: "2" });
  const day = Date.UTC(2027, 0, 15, 8);
  assert.equal((await wakeCall(env, { kind: "message" }, day)).result.structuredContent.seq, 1);
  assert.equal((await wakeCall(env, { kind: "message" }, day + 20e3)).result.structuredContent.seq, 2);
  const over = await wakeCall(env, { kind: "message" }, day + 40e3);
  assert.equal(over.result.isError, true);
  assert.equal(over.result.content[0].text, "wake budget used up today");
  assert.equal((await wakeCall(env, { kind: "message" }, Date.UTC(2027, 0, 16, 0, 0, 1))).result.structuredContent.seq, 3);
  assert.ok(WAKE_WRITES_DEFAULT >= 100);
});

test("GET /b/<board>/wake answers {seq, at} to the board's token only", async () => {
  const { env } = await envFor();
  assert.deepEqual(await worker.fetch(getWakeReq(), env, {}, T).then((r) => r.json()), { seq: 0, at: 0 }, "no wake yet");
  await wakeCall(env, { kind: "message" }, T + 5);
  assert.deepEqual(await worker.fetch(getWakeReq(), env, {}, T + 9).then((r) => r.json()), { seq: 1, at: T + 5 });
  assert.equal((await worker.fetch(getWakeReq("c".repeat(64)), env, {}, T)).status, 401);
  assert.equal((await worker.fetch(getWakeReq(TOKEN, "OtherBoard"), env, {}, T)).status, 404);
  assert.equal((await worker.fetch(new Request(`https://w.example/b/${BOARD}/wake`), env, {}, T)).status, 401);
  assert.equal((await worker.fetch(new Request(`https://w.example/b/${BOARD}/wake`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }), env, {}, T)).status, 404);
  assert.equal((await worker.fetch(new Request(`https://w.example/b/${BOARD}/wake?x=1`, { headers: { authorization: `Bearer ${TOKEN}` } }), env, {}, T)).status, 404);
});

test("the probe's wake read: the board's token in the header only; an answer that isn't a counter is none", async () => {
  const secrets = { url: "https://w.example", token: TOKEN };
  let seen = null;
  const ok = (body, status = 200) => async (url, init) => { seen = { url, init }; return { status, json: async () => body }; };
  const r = await getWake(ok({ seq: 3, at: T }), secrets, BOARD);
  assert.deepEqual(r, { wake: { seq: 3, at: T }, line: null });
  assert.equal(seen.url, `https://w.example/b/${BOARD}/wake`);
  assert.equal(seen.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(seen.init.redirect, "error");
  for (const body of [{ seq: -1, at: 0 }, { seq: "1", at: 0 }, { seq: 1.5, at: 0 }, null, [], { at: 5 }]) assert.equal((await getWake(ok(body), secrets, BOARD)).wake, null, JSON.stringify(body));
  const down = await getWake(ok({}, 404), secrets, BOARD);
  assert.deepEqual(down, { wake: null, line: "wake: the Worker answered 404" });
  const boom = await getWake(async () => { throw new Error("nope " + TOKEN); }, secrets, BOARD);
  assert.equal(boom.wake, null);
  assert.ok(!boom.line.includes(TOKEN));
});

test("wake.json follows the Worker's counter: written when it changes, not otherwise, a lower count taken as it comes", () => {
  assert.equal(nextWakeFile({ seq: 0, at: 0 }, null), '{"seq":0,"at":0}', "the first read makes the file: the wake path is on");
  assert.equal(nextWakeFile({ seq: 0, at: 0 }, { seq: 0, at: 0 }), null);
  assert.equal(nextWakeFile({ seq: 4, at: T }, { seq: 3, at: T - 1 }), `{"seq":4,"at":${T}}`);
  assert.equal(nextWakeFile({ seq: 4, at: T }, { seq: 4, at: T }), null);
  assert.equal(nextWakeFile({ seq: 1, at: T + 9 }, { seq: 4, at: T }), `{"seq":1,"at":${T + 9}}`, "a Worker restarted on a new namespace");
  assert.equal(nextWakeFile({ seq: "x", at: 1 }, null), null);
  assert.equal(nextWakeFile({ seq: 2, at: 1, extra: "text" }, null), '{"seq":2,"at":1}', "only the two numbers are kept");
  assert.deepEqual(parseWake('{"seq":2,"at":9,"x":1}'), { seq: 2, at: 9 });
  assert.equal(parseWake("{bad"), null);
});

const dirOf = () => mkdtempSync(join(tmpdir(), "fb-wake-"));

test("the watch prints one line per new wake, once, and stamps its heartbeat each look", () => {
  const dir = dirOf();
  try {
    const p = wakePaths(dir);
    assert.equal(tick(dir, T, 111), null, "no wake.json: nothing");
    assert.deepEqual(JSON.parse(readFileSync(p.alive, "utf8")), { at: T, pid: 111 });
    writeFileSync(p.wake, '{"seq":0,"at":0}');
    assert.equal(tick(dir, T + 5e3, 111), null, "the counter at 0 is no wake");
    writeFileSync(p.wake, `{"seq":1,"at":${T}}`);
    assert.equal(tick(dir, T + 10e3, 111), wakeLine({ seq: 1, at: T }));
    assert.equal(tick(dir, T + 15e3, 111), null, "once");
    assert.equal(tick(dir, T + 20e3, 222), null, "a second watch after it: nothing either");
    writeFileSync(p.wake, `{"seq":2,"at":${T + 60e3}}`);
    assert.match(tick(dir, T + 65e3, 111), /^WAKE #2: /);
    writeFileSync(p.wake, `{"seq":1,"at":${T + 90e3}}`);
    assert.match(tick(dir, T + 95e3, 111), /^WAKE #1: /, "a restarted count is still new");
    assert.ok(!/text|owner:/i.test(wakeLine({ seq: 2, at: T }).replace("the owner wrote on the board", "")), "no board text in the line");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a wake that came while the watch was off is printed when it starts; a seen one is not", () => {
  const dir = dirOf();
  try {
    const p = wakePaths(dir);
    writeFileSync(p.wake, `{"seq":7,"at":${T}}`);
    assert.match(tick(dir, T + MIN, 1), /^WAKE #7/);
    assert.equal(tick(dir, T + 2 * MIN, 1), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a pending wake is judged against what was seen: wakePending", () => {
  assert.equal(wakePending(null, null), false);
  assert.equal(wakePending({ seq: 0, at: 0 }, null), false);
  assert.equal(wakePending({ seq: 1, at: 5 }, null), true);
  assert.equal(wakePending({ seq: 1, at: 5 }, { seq: 1, at: 5 }), false);
  assert.equal(wakePending({ seq: 2, at: 9 }, { seq: 1, at: 5 }), true);
  assert.equal(wakePending({ seq: 1, at: 9 }, { seq: 3, at: 5 }), true);
});

test("another watch is alive only for a fresh heartbeat of another live process", () => {
  const dir = dirOf();
  try {
    const p = wakePaths(dir);
    assert.equal(otherWatchAlive(dir, T, process.pid), false, "no heartbeat");
    writeFileSync(p.alive, JSON.stringify({ at: T, pid: process.pid }));
    assert.equal(otherWatchAlive(dir, T, process.pid), false, "my own");
    writeFileSync(p.alive, JSON.stringify({ at: T, pid: process.ppid }));
    assert.equal(otherWatchAlive(dir, T + 5e3, process.pid), true, "another live process, fresh");
    assert.equal(otherWatchAlive(dir, T + ALIVE_MAX_MS + 1, process.pid), false, "stale");
    writeFileSync(p.alive, JSON.stringify({ at: T, pid: 4000000 }));
    assert.equal(otherWatchAlive(dir, T, process.pid), false, "a process that is gone");
    writeFileSync(p.alive, "{nope");
    assert.equal(otherWatchAlive(dir, T, process.pid), false, "unreadable");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the watch run as the Monitor runs it: prints a wake line, nothing else, and keeps a heartbeat", async () => {
  const home = dirOf();
  try {
    const cfgPath = join(home, "board.config.json");
    writeFileSync(cfgPath, JSON.stringify({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", gate: { stateDir: join(home, "state") } }));
    const dir = join(home, "state", "TestBoard01");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "wake.json"), `{"seq":3,"at":${Date.now()}}`);
    const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/wake-watch.mjs", import.meta.url)), "--config", cfgPath], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    for (let i = 0; i < 40 && !out.includes("\n"); i++) await new Promise((r) => setTimeout(r, 50));
    assert.match(out, /^WAKE #3: the owner wrote on the board/);
    assert.equal(out.trim().split("\n").length, 1);
    assert.ok(existsSync(join(dir, "wake-watch.alive.json")), "the heartbeat");
    const second = spawn(process.execPath, [fileURLToPath(new URL("../scripts/wake-watch.mjs", import.meta.url)), "--config", cfgPath], { stdio: ["ignore", "pipe", "pipe"] });
    let out2 = "";
    second.stdout.on("data", (d) => (out2 += d));
    await new Promise((r) => second.on("close", r));
    assert.match(out2, /another watch is already running/);
    child.kill();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// --- the lead's Stop hook ---

const URL_ = "https://claude.ai/" + "artifact/TestBoard01";
const config = fullConfig({ artifactUrl: URL_ });
const stopTurn = (title) => [
  { type: "custom-title", customTitle: title },
  { type: "user", timestamp: new Date(T - MIN).toISOString(), message: { content: [{ type: "text", text: "status?" }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "Done." }] } },
];
const cmd = "node /x/scripts/wake-watch.mjs --config /x/board.config.json";
const stop = (title, wake) => stopRun(stopTurn(title), { config, now: T, since: T - 864e5, view: { docs: { messages: [], waiting: [] }, at: T - 30 * MIN, atBy: {} }, wake }).errs;

test("the lead's Stop hook asks for the watch only while wake.json exists and the heartbeat is missing or old", () => {
  const ask = stop("Manager", { hasWake: true, aliveAt: null, command: cmd });
  assert.equal(ask.length, 1);
  assert.match(ask[0], /^Wake watch: .*Monitor, timeout_ms 1800000.*node \/x\/scripts\/wake-watch\.mjs --config \/x\/board\.config\.json/);
  assert.equal(stop("Manager", { hasWake: true, aliveAt: T - ALIVE_MAX_MS - 1, command: cmd }).length, 1, "a heartbeat gone stale");
  assert.equal(stop("Manager", { hasWake: true, aliveAt: T - 20e3, command: cmd }).length, 0, "running");
  assert.equal(stop("Manager", { hasWake: true, aliveAt: T + 60e3, command: cmd }).length, 1, "a heartbeat from the future is none");
  assert.equal(stop("Manager", { hasWake: false, aliveAt: null, command: cmd }).length, 0, "no wake.json: the probe doesn't poll, so no watch to ask for");
  assert.equal(stop("Manager", null).length, 0, "a caller that passes nothing checks as before");
  assert.equal(stop("Builder", { hasWake: true, aliveAt: null, command: cmd }).length, 0, "the lead's alone");
  assert.equal(watchAsk({ hasWake: false, aliveAt: null, now: T, command: cmd }), null);
});

test("wakeState reads the state folder: wake.json there, the heartbeat's time, and the command from this copy", () => {
  const home = dirOf();
  try {
    const cfg = fullConfig({ artifactUrl: URL_, gate: { stateDir: join(home, "state") } });
    const dir = join(home, "state", "TestBoard01");
    mkdirSync(dir, { recursive: true });
    const s0 = wakeState(cfg, "/c/board.config.json");
    assert.equal(s0.hasWake, false);
    assert.equal(s0.aliveAt, null);
    assert.match(s0.command, /^node \/.*\/scripts\/wake-watch\.mjs --config \/c\/board\.config\.json$/);
    writeFileSync(join(dir, "wake.json"), '{"seq":0,"at":0}');
    writeFileSync(join(dir, "wake-watch.alive.json"), JSON.stringify({ at: T, pid: 1 }));
    const s1 = wakeState(cfg, "/c/board.config.json");
    assert.equal(s1.hasWake, true);
    assert.equal(s1.aliveAt, T);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// --- the page ---

const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const wakeKind = new Function("OWNER", `${html.match(/function wakeKind\(ws\)\{[\s\S]*?return null\}/)[0]}; return wakeKind;`)("Owner");

test("the page wakes the lead for the owner's message or a real answer, and for nothing else", () => {
  const w = (path, data) => ({ op: "set", path, data });
  assert.equal(wakeKind([w("messages/m1-a", { thread: "t", from: "Owner", text: "can you check", at: T })]), "message");
  assert.equal(wakeKind([w("messages/m1-a", { thread: "t", from: "Manager", text: "done", at: T })]), null, "not the owner's");
  assert.equal(wakeKind([w("messages/m1-a", { thread: "t", from: "Owner", text: "Ack.", at: T, resolved: true, kind: "ack" })]), null, "an Ack or a close needs nothing");
  assert.equal(wakeKind([{ op: "update", path: "waiting/ask1", data: { response: { status: "chose", choice: "A", at: T } } }]), "answer");
  assert.equal(wakeKind([{ op: "update", path: "waiting/ask1", data: { response: { status: "help", note: "it broke", at: T } } }]), "answer");
  assert.equal(wakeKind([{ op: "update", path: "waiting/ask1", data: { response: { status: "done", at: T } } }]), null, "a bare Done");
  assert.equal(wakeKind([{ op: "update", path: "waiting/ask1", data: { response: { status: "ack", at: T } } }]), null, "a bare Ack");
  assert.equal(wakeKind([{ op: "update", path: "waiting/ask1", data: { response: { status: "done", note: "also fix X", at: T } } }]), "answer", "a Done with a note");
  assert.equal(wakeKind([w("pingThreads/x", { threadId: "t", at: T })]), null);
  assert.equal(wakeKind([w("ctxRequests/a", { at: T })]), null);
});

test("the page's wake call never reaches the write, never throws, and sends only the kind", () => {
  const fn = html.match(/function wakeLead\(ws\)\{[\s\S]*?\n/)[0] + html.match(/function wakeLead\(ws\)\{[\s\S]*?\n(.*\n)/)[1];
  assert.match(fn, /liveMcp\.callTool\(STATE_SERVER,WAKE_TOOL,\{kind\},\{cache:false\}\)/);
  assert.match(fn, /catch\(_\)\{\}/);
  assert.match(html, /async function applyWrites\(ws\)\{[^\n]*renderOwn\(\);wakeLead\(ws\)\}/, "after the writes are saved, not before");
});
