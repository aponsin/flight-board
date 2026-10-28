// The board's state without a model (#C420): what leaves the Studio is exactly the allowlist (collector/state-schema.mjs),
// checked at both ends; the Worker takes a POST only with the board's token and answers its MCP tool only from the
// schema; the probe sends ids, enums, numbers and times, never transcript text; the owner's install pins the launchd job
// and keeps its secrets 0600 in a 0700 folder. Security's conditions A to E, one test or more each.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, readFileSync, statSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { stateErrors, pickState, toolClass, MAX_BYTES } from "../collector/state-schema.mjs";
import { cardIn, activity, agentStates, appSessions, lastEntries, readTail, readSecrets, buildState, phaseOf, headsFor as headsForProbe, cardState, postState, ciReader, WORKING_QUIET_MS } from "../collector/state.mjs";
import { derivePhase, headsFor } from "../collector/derive.mjs";
import worker, { sha256hex, secretName, RATE_MS, TOOL, WRITES_DEFAULT } from "../worker/state-worker.mjs";
import { pinnedSha, makeSecrets, workerSecret, secretName as installSecretName, plist, wranglerToml, WRANGLER, WRANGLER_VERSION, secretsStep, Stop, stopLine, stepCommand } from "../scripts/state-install.mjs";
import { pageMcpErrors, PAGE_MCP, verdict } from "../scripts/board-release.mjs";
import { loadNames } from "./harness.mjs";

// A release the tool would take, but for what a test changes.
const releaseGood = { forward: true, notes: { checker: "PASS", security: "SECURE" }, pinned: "a".repeat(40), changed: [], owned: [], capabilities: [] };

const T = Date.UTC(2026, 9, 28, 22, 0);
const good = () => ({
  v: 1,
  board: { boardId: "TestBoard42xyz", at: T, probe: "ec6b4ed97e39", pageVersion: "842a30f31c16" },
  cards: { "board-state-probe": { num: 420, phase: "build", headSha12: "a1b2c3d4e5f6", signed: [], onMain: false, ci: "running", ciMin: 3, liveVersion: null, at: T } },
  agents: { Checker: { state: "working", lastActivityAt: T, tool: "Bash", card: "board-state-probe", since: T - 6e5 } },
});
const tmp = (p = "fb-state-") => mkdtempSync(join(tmpdir(), p));

// --- The allowlist ---------------------------------------------------------------------------------------------

test("the schema: a state in the plan fits, and pickState gives back exactly its fields", () => {
  assert.deepEqual(stateErrors(good()), []);
  assert.deepEqual(pickState(good()), good());
});

test("the schema: an unknown key anywhere is refused, and the error never quotes it", () => {
  const cases = [
    (s) => { s.note = "x"; }, (s) => { s.board.title = "x"; },
    (s) => { s.cards["board-state-probe"].evidence = "x"; }, (s) => { s.agents.Checker.lastText = "x"; },
  ];
  for (const f of cases) {
    const s = good(); f(s);
    const e = stateErrors(s);
    assert.ok(e.length, JSON.stringify(s));
    assert.ok(e.every((m) => !/note|title|evidence|lastText/.test(m)), e.join("; "));
    assert.equal(pickState(s), null);
  }
});

test("the schema: free text never fits a field (a customer's name, a pasted secret), and isn't echoed", () => {
  const secret = "pasted-SECRETSECRET";
  const cases = [
    (s) => { s.agents.Checker.tool = `Alice Martin ${secret}`; }, (s) => { s.agents.Checker.card = `call Alice ${secret}`; },
    (s) => { s.cards["board-state-probe"].phase = `ship to Alice ${secret}`; }, (s) => { s.cards["board-state-probe"].signed = [secret]; },
    (s) => { s.cards["board-state-probe"].liveVersion = `1.2.3 ${secret}`; }, (s) => { s.board.pageVersion = secret; },
    (s) => { s.agents[`Alice ${secret}`] = s.agents.Checker; }, (s) => { s.cards[`alice ${secret}`] = s.cards["board-state-probe"]; },
    (s) => { s.agents.Checker.state = secret; }, (s) => { s.cards["board-state-probe"].ci = secret; },
    (s) => { s.cards["board-state-probe"].num = 1.5; }, (s) => { s.agents.Checker.since = "yesterday"; },
  ];
  for (const f of cases) {
    const s = good(); f(s);
    const e = stateErrors(s);
    assert.ok(e.length, JSON.stringify(s));
    assert.ok(!e.join(" ").includes("SECRET") && !e.join(" ").includes("Alice"), e.join("; "));
  }
});

test("the schema: a tool's name leaves only as its class", () => {
  assert.equal(toolClass("Bash"), "Bash");
  assert.equal(toolClass("mcp__e001fd4d__send_message"), "mcp");
  assert.equal(toolClass("SomethingNew"), "other");
  assert.equal(toolClass(""), null);
});

// --- The Worker ----------------------------------------------------------------------------------------------

const TOKEN = "a".repeat(64), PATH = "b".repeat(32), BOARD = "TestBoard42xyz";
async function envFor() {
  const kv = new Map();
  const env = { STATE: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } } };
  env[await secretName(BOARD)] = JSON.stringify({ token: await sha256hex(TOKEN), path: await sha256hex(PATH) });
  return { env, kv };
}
const post = (body, { token = TOKEN, board = BOARD, type = "application/json" } = {}) => new Request(`https://w.example/b/${board}/state`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": type }, body: typeof body === "string" ? body : JSON.stringify(body) });
const rpc = (msg, path = PATH, method = "POST") => new Request(`https://w.example/mcp/${path}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? JSON.stringify(msg) : undefined });
const call = (env, now = T) => worker.fetch(rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "board_state", arguments: {} } }), env, {}, now).then((r) => r.json());

test("the Worker: the board's token POSTs a state; board_state answers it, rebuilt from the schema", async () => {
  const { env, kv } = await envFor();
  assert.equal((await worker.fetch(post(good()), env, {}, T)).status, 204);
  assert.equal(kv.size, 1);
  assert.ok([...kv.keys()][0].startsWith("b:BOARD_"), "stored under the secret's name, not the board id");
  const r = await call(env);
  assert.deepEqual(r.result.structuredContent, good());
  assert.deepEqual(JSON.parse(r.result.content[0].text), good());
});

test("the Worker: a forged token is a 401; another board, or none, a bare 404", async () => {
  const { env } = await envFor();
  const forged = await worker.fetch(post(good(), { token: "c".repeat(64) }), env, {}, T);
  assert.equal(forged.status, 401);
  assert.equal(await forged.text(), "");
  assert.equal((await worker.fetch(post(good(), { token: "not hex" }), env, {}, T)).status, 401);
  assert.equal((await worker.fetch(post({ ...good(), board: { ...good().board, boardId: "other" } }, { board: "other" }), env, {}, T)).status, 404);
});

test("the Worker: an unknown key, free text, another board's state or a non-JSON body is a 400 that quotes nothing", async () => {
  const { env } = await envFor();
  const s = good(); s.agents.Checker.lastText = "Alice Martin, 06 12 34 56 78";
  const r = await worker.fetch(post(s), env, {}, T);
  assert.equal(r.status, 400);
  assert.doesNotMatch(await r.text(), /Alice|lastText|06 12/);
  const other = good(); other.board.boardId = "someone-else";
  assert.equal((await worker.fetch(post(other), env, {}, T)).status, 400);
  assert.equal((await worker.fetch(post("{not json"), env, {}, T)).status, 400);
  assert.equal((await worker.fetch(post(good(), { type: "text/plain" }), env, {}, T)).status, 415);
});

test("the Worker: over 64 KB is a 413; one POST per 30 s per board (429), the latest kept", async () => {
  const { env, kv } = await envFor();
  assert.equal((await worker.fetch(post("x".repeat(MAX_BYTES + 1)), env, {}, T)).status, 413);
  assert.equal((await worker.fetch(post(good()), env, {}, T)).status, 204);
  const later = good(); later.board.at = T + 1000; later.agents.Checker.state = "idle";
  const r = await worker.fetch(post(later), env, {}, T + RATE_MS - 1);
  assert.equal(r.status, 429);
  assert.equal(JSON.parse([...kv.values()][0]).state.board.at, T);
  assert.equal((await worker.fetch(post(later), env, {}, T + RATE_MS)).status, 204);
  assert.equal(JSON.parse([...kv.values()][0]).state.board.at, T + 1000);
});

test("the Worker spends the account's KV writes only on a change the page shows, a 15-min heartbeat, and its daily budget", async () => {
  const { env, kv } = await envFor();
  let puts = 0;
  const put = env.STATE.put;
  env.STATE.put = async (k, v) => { puts++; return put(k, v); };
  const at = (min, f = () => {}) => { const s = good(); s.board.at = T + min * 60e3; s.cards["board-state-probe"].at = s.board.at; s.agents.Checker.lastActivityAt = s.board.at; f(s); return s; };
  const send = (min, f) => worker.fetch(post(at(min, f)), env, {}, T + min * 60e3).then((r) => r.status);
  assert.equal(await send(0), 204);
  assert.equal(puts, 1);
  // Times and ticking CI minutes alone are no change: a 204 that writes nothing.
  assert.equal(await send(1, (s) => { s.cards["board-state-probe"].ciMin = 4; }), 204);
  assert.equal(puts, 1);
  assert.equal(JSON.parse([...kv.values()][0]).state.board.at, T);
  // A card moving, or an agent's turn ending, is.
  assert.equal(await send(2, (s) => { s.cards["board-state-probe"].phase = "checker"; }), 204);
  assert.equal(await send(3, (s) => { s.cards["board-state-probe"].phase = "checker"; s.agents.Checker.state = "idle"; }), 204);
  assert.equal(puts, 3);
  // Nothing changed for 15 min: the heartbeat writes once.
  const same = (s) => { s.cards["board-state-probe"].phase = "checker"; s.agents.Checker.state = "idle"; };
  assert.equal(await send(17, same), 204);
  assert.equal(puts, 3);
  assert.equal(await send(18, same), 204);
  assert.equal(puts, 4);
  // The budget: WRITES_PER_DAY, then 429s until the UTC day turns, with nothing written.
  env.WRITES_PER_DAY = "4";
  assert.equal(await send(20, (s) => { s.agents.Checker.state = "working"; }), 429);
  assert.equal(puts, 4);
  const next = Date.UTC(2026, 9, 29, 0, 1);
  const s = good(); s.board.at = next;
  assert.equal((await worker.fetch(post(s), env, {}, next)).status, 204);
  assert.equal(JSON.parse([...kv.values()][0]).writes, 1);
});

test("the Worker: the MCP tool answers only from the schema, whatever was stored", async () => {
  const { env, kv } = await envFor();
  await worker.fetch(post(good()), env, {}, T);
  const key = [...kv.keys()][0];
  const tampered = JSON.parse(kv.get(key));
  tampered.state.agents.Checker.lastText = "Alice Martin";
  kv.set(key, JSON.stringify(tampered));
  const r = await call(env);
  assert.equal(r.result.isError, true);
  assert.equal(r.result.content[0].text, "no state yet");
  assert.doesNotMatch(JSON.stringify(r), /Alice/);
  kv.set(key, "not json");
  assert.equal((await call(env)).result.content[0].text, "no state yet");
});

test("the Worker: a wrong MCP path, or any other route, is a bare 404; the right path takes POST only", async () => {
  const { env } = await envFor();
  for (const req of [rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "c".repeat(32)), rpc({}, "short"), new Request("https://w.example/"), new Request(`https://w.example/b/${BOARD}/state`), new Request(`https://w.example/mcp/${PATH}?x=1`, { method: "POST", body: "{}" })]) {
    const r = await worker.fetch(req, env, {}, T);
    assert.equal(r.status, 404, req.url);
    assert.equal(await r.text(), "");
    assert.equal(r.headers.get("access-control-allow-origin"), null, "no CORS");
  }
  assert.equal((await worker.fetch(rpc(null, PATH, "GET"), env, {}, T)).status, 405);
});

test("the Worker: initialize, tools/list (board_state, read-only, no arguments), ping, and fixed errors", async () => {
  const { env } = await envFor();
  const go = async (msg) => (await worker.fetch(rpc(msg), env, {}, T)).json();
  const init = await go({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal((await worker.fetch(rpc({ jsonrpc: "2.0", method: "notifications/initialized" }), env, {}, T)).status, 202);
  const list = await go({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(list.result.tools, [TOOL]);
  assert.equal(TOOL.annotations.readOnlyHint, true);
  assert.deepEqual((await go({ jsonrpc: "2.0", id: 3, method: "ping" })).result, {});
  assert.equal((await go({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "write_state" } })).error.message, "unknown tool");
  assert.equal((await go({ jsonrpc: "2.0", id: 5, method: "resources/list" })).error.code, -32601);
  assert.equal((await call(env)).result.content[0].text, "no state yet", "nothing posted yet");
});

// --- The probe -------------------------------------------------------------------------------------------------

const ids = new Set(["board-state-probe", "ship-resume"]), nums = new Map([[420, "board-state-probe"], [405, "ship-resume"]]);
const entry = (type, content, at, extra = {}) => ({ type, timestamp: new Date(at).toISOString(), message: { role: type, content, ...extra } });

test("the probe: the card a session is on is an exact board id or a #C number of a card on the board; only the id leaves", () => {
  const e = [entry("user", "please look at #C405 for Alice Martin", T), entry("assistant", [{ type: "text", text: "on board-state-probe now" }], T + 1)];
  assert.equal(cardIn(e, ids, nums), "board-state-probe", "the newest entry wins");
  assert.equal(cardIn(e.slice(0, 1), ids, nums), "ship-resume");
  assert.equal(cardIn([entry("user", "#C999 and board-state-probes and xboard-state-probe", T)], ids, nums), null, "no card, no near miss");
  assert.equal(cardIn([entry("user", "board-state-probe then #C405", T)], ids, nums), "ship-resume", "the last name in an entry");
});

test("the probe: working mid-turn, idle at a turn's end or after a quiet quarter hour; the tool as its class; since", () => {
  const prompt = entry("user", "go", T), use = entry("assistant", [{ type: "tool_use", name: "mcp__x__send", input: {} }], T + 1000, { stop_reason: "tool_use" });
  const result = entry("user", [{ type: "tool_result", content: "secret Alice" }], T + 2000), done = entry("assistant", [{ type: "text", text: "done" }], T + 3000, { stop_reason: "end_turn" });
  assert.deepEqual(activity([prompt, use, result], { mtimeMs: T + 2000, now: T + 5000, ids, nums }), { state: "working", tool: "mcp", card: null, since: T });
  assert.deepEqual(activity([prompt, use, result, done], { mtimeMs: T + 3000, now: T + 5000, ids, nums }), { state: "idle", tool: "mcp", card: null, since: T + 3000 });
  assert.equal(activity([prompt, use], { mtimeMs: T, now: T + WORKING_QUIET_MS + 1, ids, nums }).state, "idle");
  assert.deepEqual(activity([], { mtimeMs: T, now: T, ids, nums }), { state: "unknown", tool: null, card: null, since: null });
});

// A home folder with the app's session files and transcripts, for agentStates and appSessions.
function studio() {
  const homeDir = tmp(), root = join(homeDir, "sessions"), org = join(root, "000fe95f-e41f-4a52-af27-c6c82d3c3ba8", "1c304a7d-9ad7-4bc6-910d-2eadc1439655");
  mkdirSync(org, { recursive: true });
  const cwd = "/Users/x/Code/teamrepo", proj = join(homeDir, ".claude", "projects", "-Users-x-Code-teamrepo");
  mkdirSync(proj, { recursive: true });
  const session = (n, title, entries, extra = {}) => {
    const cli = `00000000-0000-4000-8000-00000000000${n}`;
    writeFileSync(join(org, `local_00000000-0000-4000-8000-00000000000${n}.json`), JSON.stringify({ sessionId: `local_${n}`, cliSessionId: cli, cwd, title, lastActivityAt: T - n, isArchived: false, lastTurnReport: "Alice Martin's site", postTurnSummary: { text: "sk-ant-api03-XYZ" }, ...extra }));
    writeFileSync(join(proj, `${cli}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    utimesSync(join(proj, `${cli}.jsonl`), new Date(T), new Date(T));
  };
  return { homeDir, root, session };
}

test("the probe: each roster role's newest open session, read to ids and enums; titles, summaries and text stay home", () => {
  const { homeDir, root, session } = studio();
  const leak = "Alice Martin 06 12 34 56 78 sk-ant-api03-XYZ";
  session(1, "Checker", [entry("user", `review #C420 for ${leak}`, T - 60e3), entry("assistant", [{ type: "tool_use", name: "Bash", input: { command: leak } }], T - 30e3, { stop_reason: "tool_use" })]);
  session(2, "Checker", [entry("user", "old", T - 9e6)], { isArchived: true });
  session(3, "Ops: Alice's leads", [entry("user", leak, T)]);
  session(4, "Builder", [entry("assistant", [{ type: "text", text: leak }], T - 5e3, { stop_reason: "end_turn" })]);
  const sessions = appSessions(root);
  assert.ok(sessions.every((s) => Object.keys(s).sort().join() === "at,cwd,title,transcript"), "nothing else of a session file is kept");
  const agents = agentStates({ roles: ["Checker", "Builder", "Release"], sessions, homeDir, now: T, ids, nums });
  assert.deepEqual(agents, {
    Checker: { state: "working", lastActivityAt: T - 1, tool: "Bash", card: "board-state-probe", since: T - 60e3 },
    Builder: { state: "idle", lastActivityAt: T - 4, tool: null, card: null, since: T - 5e3 },
  });
  const s = buildState({ id: BOARD, now: T, probe: "e".repeat(40), pageVersion: null, cards: {}, agents });
  assert.doesNotMatch(JSON.stringify(s), /Alice|06 12|sk-ant|Ops/);
});

test("the probe: a transcript that is a link out of the projects folder, or a fifo, is not read", () => {
  const { homeDir, root, session } = studio();
  session(1, "Checker", [entry("user", "#C420", T)]);
  const proj = join(homeDir, ".claude", "projects", "-Users-x-Code-teamrepo"), cli = "00000000-0000-4000-8000-000000000001";
  const elsewhere = join(tmp(), "t.jsonl");
  writeFileSync(elsewhere, JSON.stringify(entry("user", "#C405", T)) + "\n");
  execFileSync("rm", [join(proj, `${cli}.jsonl`)]);
  symlinkSync(elsewhere, join(proj, `${cli}.jsonl`));
  assert.equal(agentStates({ roles: ["Checker"], sessions: appSessions(root), homeDir, now: T, ids, nums }).Checker.state, "unknown");
  const fifo = join(tmp(), "f");
  execFileSync("mkfifo", [fifo]);
  assert.equal(readTail(fifo, 1024), null);
});

test("the probe: only a transcript's last 20 entries count, and a line cut by the tail is dropped", () => {
  const many = Array.from({ length: 30 }, (_, k) => JSON.stringify(entry("user", k === 0 ? "#C420" : `x${k}`, T + k)));
  assert.equal(lastEntries({ text: many.join("\n"), whole: true }).length, 20);
  assert.equal(cardIn(lastEntries({ text: many.join("\n"), whole: true }), ids, nums), null, "#C420 was 30 entries back");
  assert.equal(lastEntries({ text: "{\"type\":\"user\"," + "\n" + many[1], whole: false }).length, 1);
});

test("the probe's phase rule is collector/derive.mjs's: the same phase on every case", () => {
  const config = { phases: [["plan"], ["build"], ["test"], ["language"], ["checker"], ["security"], ["ship"], ["live"]], skips: [{ phase: "security", unlessLevel: "Full" }, { phase: "language", whenFalse: "customerText" }], collector: { notes: { checker: "r1", language: "r2", security: "r3" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main" } };
  const heads = [null, { branch: "c", sha: "a".repeat(40), message: "x" }, { branch: "c", sha: "a".repeat(40), message: "x\n\nBoard-Id: c" }];
  let n = 0;
  for (const card of [{ id: "c", level: "Full" }, { id: "c", level: "Quick", customerText: false }, { id: "c", skip: ["checker"] }])
    for (const head of heads) for (const signed of [[], ["checker"], ["checker", "language"], ["checker", "language", "security"]]) for (const onMain of [false, true]) for (const deployed of [false, true]) {
      const facts = { head, signed: new Set(signed), onMain, deployed: onMain && deployed };
      assert.equal(phaseOf(card, facts, config), derivePhase(card, facts, config).phase, JSON.stringify({ card, head, signed, onMain, deployed }));
      n++;
    }
  assert.equal(n, 144);
  const hs = [{ branch: "a/c", sha: "1", at: 2, message: "" }, { branch: "x", sha: "2", at: 3, message: "Board-Id: c" }, { branch: "a/c", sha: "3", at: 1, message: "" }, { branch: "y", sha: "4", at: 9, message: "" }];
  assert.deepEqual(headsForProbe("c", hs), headsFor("c", hs));
});

test("the probe: a card on a scratch repository: its tip, sign-offs, main, CI; one not in a repository stays as declared", () => {
  const dir = tmp(), git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q", "-b", "main"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  git(["commit", "-q", "--allow-empty", "-m", "base"]);
  git(["switch", "-q", "-c", "board-state-probe"]); git(["commit", "-q", "--allow-empty", "-m", "work\n\nBoard-Id: board-state-probe"]);
  const sha = git(["rev-parse", "HEAD"]).trim();
  git(["notes", "--ref=refs/notes/checker", "add", "-m", "PASS", sha]);
  git(["update-ref", "refs/remotes/origin/main", "main"]); git(["update-ref", "refs/remotes/origin/board-state-probe", sha]);
  const config = { phases: [["plan"], ["build"], ["checker"], ["security"], ["ship"], ["live"]], skips: [{ phase: "security", unlessLevel: "Full" }], collector: { notes: { checker: "x", security: "y" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } };
  const gh = (args) => { assert.deepEqual(args.slice(0, 4), ["run", "list", "--commit", sha]); return JSON.stringify([{ status: "in_progress", conclusion: "", createdAt: new Date(T - 4 * 60e3).toISOString(), updatedAt: "" }]); };
  const repo = { git, gh, remote: "origin", main: "main", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, tips: [{ branch: "board-state-probe", sha, at: T, message: "work\n\nBoard-Id: board-state-probe" }, { branch: "main", sha: "x", at: T, message: "" }], live: null, versionPattern: null };
  const card = { id: "board-state-probe", num: 420, level: "Full", phase: "plan" };
  assert.deepEqual(cardState(card, repo, config, T), { num: 420, phase: "security", headSha12: sha.slice(0, 12), signed: ["checker"], onMain: false, ci: "running", ciMin: 4, liveVersion: null, at: T });
  assert.deepEqual(cardState({ ...card, phase: "Whatever Alice said" }, null, config, T).phase, null, "a declared phase not in the config leaves as nothing");
});

test("the probe's secrets: read only from a 0700 folder of this user's holding a 0600 file; never a link", () => {
  const dir = join(tmp(), "state-secrets");
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, "secrets.json"), JSON.stringify({ url: "https://w.example", token: TOKEN, path: PATH }), { mode: 0o600 });
  assert.deepEqual(readSecrets(dir), { url: "https://w.example", token: TOKEN });
  chmodSync(join(dir, "secrets.json"), 0o644);
  assert.equal(readSecrets(dir), null);
  chmodSync(join(dir, "secrets.json"), 0o600); chmodSync(dir, 0o755);
  assert.equal(readSecrets(dir), null);
  chmodSync(dir, 0o700);
  const link = join(tmp(), "state-secrets");
  symlinkSync(dir, link);
  assert.equal(readSecrets(link), null);
  writeFileSync(join(dir, "secrets.json"), JSON.stringify({ url: "http://w.example", token: TOKEN }), { mode: 0o600 });
  assert.equal(readSecrets(dir), null, "https only");
});

test("the probe's POST: the token in the header only; its line never holds it", async () => {
  let seen;
  const line = await postState(async (url, opt) => { seen = { url, opt }; return { status: 204 }; }, { url: "https://w.example", token: TOKEN }, BOARD, good());
  assert.equal(line, "state: posted");
  assert.equal(seen.url, `https://w.example/b/${BOARD}/state`);
  assert.equal(seen.opt.redirect, "error");
  assert.equal(seen.opt.headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(!seen.opt.body.includes(TOKEN));
  const refused = await postState(async () => ({ status: 401 }), { url: "https://w.example", token: TOKEN }, BOARD, good());
  assert.ok(!refused.includes(TOKEN) && /401/.test(refused));
  assert.ok(!(await postState(async () => { throw new Error(TOKEN); }, { url: "https://w.example", token: TOKEN }, BOARD, good())).includes(TOKEN));
});

// --- The owner's install ---------------------------------------------------------------------------------------

test("the install: it runs only from <install root>/<signed sha>, never a checkout or a link", () => {
  const root = tmp(), sha = "e".repeat(40), copy = join(root, sha);
  mkdirSync(copy);
  assert.equal(pinnedSha(copy, root), sha);
  assert.throws(() => pinnedSha(new URL("..", import.meta.url).pathname.replace(/\/$/, ""), root), /pinned copy/);
  const other = join(tmp(), sha);
  mkdirSync(other);
  assert.throws(() => pinnedSha(other, root), /not the one/);
});

test("the install: the launchd job runs the pinned copy's state.mjs every minute, and holds no secret", () => {
  const p = plist({ id: BOARD, node: "/opt/homebrew/bin/node", script: `/Users/x/.flight-board/install/${"e".repeat(40)}/collector/state.mjs`, config: "/Users/x/Team/board.config.json", log: "/Users/x/.flight-board/b/state.log" });
  assert.match(p, new RegExp(`<string>/Users/x/.flight-board/install/${"e".repeat(40)}/collector/state.mjs</string>`));
  assert.match(p, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
  assert.doesNotMatch(p, /token|secret|mcp\//i);
  for (const script of ["/Users/x/.flight-board/current/collector/state.mjs", "/Users/x/Code/flight-board/collector/state.mjs", `/Users/x/.flight-board/install/${"e".repeat(39)}/collector/state.mjs`])
    assert.throws(() => plist({ id: BOARD, node: "n", script, config: "c", log: "l" }), /pinned/);
  assert.throws(() => plist({ id: "a<b", node: "n", script: `/i/install/${"e".repeat(40)}/collector/state.mjs`, config: "c", log: "l" }), /board id/);
});

test("the install: secrets made 0600 in a 0700 folder, kept on a re-run, new on --rotate; the Worker gets hashes it accepts", async () => {
  const dir = join(tmp(), "state-secrets");
  let k = 0;
  const bytes = (n) => Buffer.alloc(n, ++k);
  const first = makeSecrets(dir, "https://w.example", { bytes });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, "secrets.json")).mode & 0o777, 0o600);
  assert.deepEqual(readSecrets(dir), { url: "https://w.example", token: first.token });
  assert.equal(first.made, true);
  const again = makeSecrets(dir, "https://w.example", { bytes });
  assert.deepEqual([again.token, again.path, again.made], [first.token, first.path, false]);
  const rotated = makeSecrets(dir, "https://w.example", { bytes, rotate: true });
  assert.notEqual(rotated.token, first.token);
  assert.notEqual(rotated.path, first.path);
  assert.throws(() => makeSecrets(dir, "http://w.example/x"), /https/);
  // The install's secret, as the Worker reads it: the new token posts, the old one is a 401; the new path answers, the old a 404.
  const kv = new Map(), env = { STATE: { get: async (x) => kv.get(x) ?? null, put: async (x, v) => { kv.set(x, v); } } };
  assert.equal(installSecretName(BOARD), await secretName(BOARD));
  env[installSecretName(BOARD)] = workerSecret(rotated.token, rotated.path);
  assert.doesNotMatch(env[installSecretName(BOARD)], new RegExp(rotated.token));
  assert.equal((await worker.fetch(post(good(), { token: rotated.token }), env, {}, T)).status, 204);
  assert.equal((await worker.fetch(post(good(), { token: first.token }), env, {}, T + RATE_MS)).status, 401);
  assert.equal((await worker.fetch(rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, rotated.path), env, {}, T)).status, 200);
  assert.equal((await worker.fetch(rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, first.path), env, {}, T)).status, 404);
});

// The secrets step with wrangler, the clipboard and Return faked (#C426).
function secretsRig({ deployed = true, putFails = false, toml = true } = {}) {
  const base = tmp(), calls = [], clip = [], lines = [];
  const file = join(base, "wrangler.toml");
  if (toml) writeFileSync(file, "name = \"flight-board-state\"\n");
  const run = (args, opts) => {
    calls.push({ args, opts });
    if (args[0] === "deployments" && !deployed) throw new Error("This Worker does not exist on your account");
    if (args[0] === "secret" && putFails) throw new Error("wrangler: authentication error");
  };
  const o = { id: BOARD, dir: join(base, "state-secrets"), toml: file, url: "https://w.example", env: {}, run, copy: (t) => clip.push(t), ask: async () => lines.push("<Return>"), log: (l) => lines.push(l), cmd: stepCommand("/Users/x/.flight-board/install/" + "e".repeat(40), "/Users/x/Team/board.config.json") };
  return { o, calls, clip, lines, made: () => existsSync(join(o.dir, "secrets.json")) };
}

test("the install's secrets step: no Worker deployed is a plain stop naming the deploy step, before anything is made", async () => {
  const r = secretsRig({ deployed: false });
  const e = await secretsStep(r.o).then(() => null, (x) => x);
  assert.ok(e instanceof Stop);
  assert.match(stopLine(e), /^state: STOPPED: wrangler finds no deployed Worker "flight-board-state".*nothing was made\. Next: node \/Users\/x\/\.flight-board\/install\/e{40}\/scripts\/state-install\.mjs deploy --config \/Users\/x\/Team\/board\.config\.json$/);
  assert.equal(r.made(), false);
  assert.deepEqual(r.calls.map((c) => c.args[0]), ["deployments"], "no secret put");
  assert.deepEqual(r.clip, []);
  const none = secretsRig({ toml: false });
  assert.match(stopLine(await secretsStep(none.o).catch((x) => x)), /no wrangler config.*Next: node .*state-install\.mjs worker --config .* --kv /);
  assert.deepEqual(none.calls, []);
  const bad = secretsRig();
  assert.match(stopLine(await secretsStep({ ...bad.o, url: "http://w.example/x" }).catch((x) => x)), /--url.*Next: .* secrets --config .* --url /);
  assert.equal(bad.made(), false);
});

test("the install's secrets step: wrangler's questions are never hidden; the deploy check can't read an answer from a pipe", async () => {
  const r = secretsRig();
  await secretsStep(r.o);
  const [check, put] = r.calls;
  assert.deepEqual(check.args, ["deployments", "list", "--config", r.o.toml]);
  assert.equal(check.opts.stdio[0], "ignore");
  assert.deepEqual(put.args.slice(0, 2), ["secret", "put"]);
  assert.deepEqual(put.opts.stdio, ["pipe", "inherit", "inherit"], "wrangler's output (a question included) is on the terminal");
  assert.equal(r.calls.length, 2);
});

test("the install's secrets step: a failed secret put names the re-run (without --rotate: the new token is kept)", async () => {
  const r = secretsRig({ putFails: true });
  const line = stopLine(await secretsStep({ ...r.o, rotate: true }).catch((x) => x));
  assert.match(line, /did not take the Worker's secret.*the new token is kept.*Next: node .*state-install\.mjs secrets --config \S+ --url https:\/\/w\.example$/);
  assert.doesNotMatch(line, /--rotate/);
  assert.deepEqual(r.clip, []);
});

test("the install's secrets step: on the Mac's own terminal the URL goes to the clipboard, cleared on Return, and is never printed", async () => {
  const r = secretsRig();
  await secretsStep(r.o);
  const { path } = JSON.parse(readFileSync(join(r.o.dir, "secrets.json"), "utf8"));
  assert.deepEqual(r.clip, [`https://w.example/mcp/${path}`, ""]);
  assert.ok(!r.lines.join("\n").includes(path));
  assert.ok(r.lines.indexOf("<Return>") < r.lines.findIndex((l) => /clipboard cleared/.test(l)));
  assert.match(r.lines.at(-1), /^state: next: node .*state-install\.mjs launchd --config /);
});

test("the install's secrets step: over SSH it stops before anything, and offers --show; --show prints the URL once, with the warning", async () => {
  for (const env of [{ SSH_CONNECTION: "10.0.0.2 52000 10.0.0.1 22" }, { SSH_TTY: "/dev/ttys004" }]) {
    const r = secretsRig();
    const line = stopLine(await secretsStep({ ...r.o, env, rotate: true }).catch((x) => x));
    assert.match(line, /over SSH.*Mac's clipboard.*Next: node .*state-install\.mjs secrets --config \S+ --url https:\/\/w\.example --rotate --show$/);
    assert.deepEqual([r.calls, r.clip, r.made()], [[], [], false]);
  }
  const r = secretsRig();
  await secretsStep({ ...r.o, env: { SSH_TTY: "/dev/ttys004" }, show: true });
  const { path } = JSON.parse(readFileSync(join(r.o.dir, "secrets.json"), "utf8"));
  assert.deepEqual(r.clip, [], "pbcopy never runs with --show");
  assert.equal(r.lines.filter((l) => l.includes(path)).length, 1, "printed once");
  const at = r.lines.findIndex((l) => l.includes(path));
  assert.match(r.lines[at - 1], /don't screenshot it or paste it anywhere but claude\.ai's connector/);
  assert.match(r.lines.join("\n"), /<Return>\nstate: done; clear this terminal's scrollback/);
  // Security's LOW: --show on the Mac's own terminal is refused before anything, and names the command without it.
  const local = secretsRig();
  const line = stopLine(await secretsStep({ ...local.o, show: true, rotate: true }).catch((x) => x));
  assert.match(line, /--show is only for a terminal on the Mac over SSH.*Next: node .*state-install\.mjs secrets --config \S+ --url https:\/\/w\.example --rotate$/);
  assert.deepEqual([local.calls, local.clip, local.made()], [[], [], false]);
});

test("the install: a STOPPED line from the script itself names the next step (run from a checkout here)", () => {
  const cfg = join(tmp(), "board.config.json");
  writeFileSync(cfg, "{not json");
  const run = (args) => { try { execFileSync(process.execPath, [new URL("../scripts/state-install.mjs", import.meta.url).pathname, ...args], { stdio: ["ignore", "pipe", "pipe"] }); return ""; } catch (e) { return String(e.stderr); } };
  assert.match(run(["secrets", "--config", cfg]), /^state: STOPPED: --config: .*\. Next: the same command with --config /);
  assert.match(run(["secrets"]), /^state: STOPPED: --config: .*\. Next: /);
});

test("the install: the Worker's own config: its name, one workers.dev address, no route, no preview, its KV namespace only (Security's same-account conditions)", () => {
  const t = wranglerToml({ main: "/i/install/e/worker/state-worker.mjs", kv: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6" });
  assert.match(t, /^name = "flight-board-state"$/m);
  assert.match(t, /^workers_dev = true$/m);
  assert.match(t, /^preview_urls = false$/m);
  assert.match(t, /binding = "STATE"\nid = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6"/);
  assert.match(t, /^WRITES_PER_DAY = "2000"$/m);
  assert.doesNotMatch(t, /route|zone|account_id|services|d1_databases|r2_buckets|durable_objects|queues/);
  assert.equal(t.match(/\[\[/g).length, 1, "one binding block: its own KV namespace");
  assert.match(wranglerToml({ main: "m", kv: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6", account: "f".repeat(32), writes: 2000 }), /^account_id = "f{32}"$[\s\S]*^WRITES_PER_DAY = "2000"$/m);
  assert.throws(() => wranglerToml({ main: "m", kv: "x\"\n[vars]" }), /32 hex/);
  assert.throws(() => wranglerToml({ main: "m", kv: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6", account: "not-an-id" }), /--account/);
  assert.throws(() => wranglerToml({ main: "m", kv: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6", writes: Number("x") }), /--writes/);
});

test("the probe asks gh at most 10 times a run, and never again for a finished run", () => {
  let calls = 0;
  const gh = (args) => { calls++; return JSON.stringify([{ status: args[3].startsWith("a") ? "completed" : "in_progress", conclusion: "success", createdAt: new Date(T - 60e3).toISOString(), updatedAt: new Date(T).toISOString() }]); };
  const cache = {};
  const read = ciReader(gh, T, cache);
  const shas = Array.from({ length: 15 }, (_, k) => (k % 2 ? "a" : "b") + String(k).padStart(39, "0"));
  const out = shas.map(read);
  assert.equal(calls, 10);
  assert.deepEqual(out.slice(10), Array(5).fill({ ci: "none", ciMin: null }));
  assert.deepEqual(Object.keys(cache).sort(), shas.slice(0, 10).filter((s) => s.startsWith("a")).sort(), "only finished runs are kept");
  const again = ciReader(gh, T, cache);
  shas.filter((s) => s.startsWith("a")).slice(0, 5).forEach(again);
  assert.equal(calls, 10, "a cached run costs no call");
});

test("Security: a bad cache entry gives only {ci, ciMin}, or is asked again; it never overrides a card's fields or stops the run", () => {
  const sha = "c".repeat(40);
  for (const bad of [{ ci: "passed", ciMin: 2, phase: "live", onMain: true, signed: ["x"] }, { ci: "<b>", ciMin: 1 }, { ci: "passed", ciMin: -3 }, "passed", null]) {
    let calls = 0;
    const gh = () => { calls++; return JSON.stringify([{ status: "completed", conclusion: "failure", createdAt: new Date(T - 120e3).toISOString(), updatedAt: new Date(T).toISOString() }]); };
    const r = ciReader(gh, T, { [sha]: bad })(sha);
    assert.deepEqual(Object.keys(r).sort(), ["ci", "ciMin"]);
    if (bad?.ci === "passed" && bad.ciMin === 2) assert.deepEqual([r, calls], [{ ci: "passed", ciMin: 2 }, 0]);
    else assert.deepEqual([r, calls], [{ ci: "failed", ciMin: 2 }, 1], JSON.stringify(bad));
  }
  const config = { phases: [["build"], ["ship"], ["live"]], skips: [], collector: { notes: {}, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } };
  const head = { branch: "c", sha, at: T, message: "x" };
  const repo = { git: () => { throw new Error("no"); }, ci: () => ({ ci: "passed", ciMin: 1, phase: "live", onMain: true, at: 0 }), remote: "origin", main: "main", notes: {}, tips: [head], live: null, versionPattern: null };
  const s = cardState({ id: "c", num: 1 }, repo, config, T);
  assert.deepEqual([s.phase, s.onMain, s.at, s.ci], ["build", false, T, "passed"]);
});

// --- The page --------------------------------------------------------------------------------------------------

const page = () => loadNames(["probeHtml", "probeFits", "probeEvent", "renderProbe"]);

test("the page: who is working on what, since when, and each card's stage; every value escaped or dropped", () => {
  const b = page(), s = good();
  s.agents.Builder = { state: "idle", lastActivityAt: T, tool: null, card: "board-state-probe", since: T - 6e4 };
  s.agents.Admin = { state: "idle", lastActivityAt: T, tool: null, card: null, since: T - 9e5 };
  s.agents.Designer = { state: "unknown", lastActivityAt: null, tool: null, card: null, since: null };
  s.agents.Release = { state: "working", lastActivityAt: T, tool: "Edit", card: null, since: T - 6e4 };
  const raw = b.probeHtml(s, T), h = raw.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
  // Designer: " · " between the parts; working first (alphabetical), then one Idle line and one Not seen line.
  assert.match(h, /Checker\s*working on #C420 · Bash · since \d\d:\d\d/);
  assert.match(h, /Release\s*working · Edit · since \d\d:\d\d/);
  assert.match(h, /Idle: Admin \(\d\d:\d\d[^)]*\), Builder \(\d\d:\d\d[^,]*, last #C420\)/);
  assert.match(h, /Not seen: Designer/);
  assert.ok(h.indexOf("Checker") < h.indexOf("Release") && h.indexOf("Release") < h.indexOf("Idle:") && h.indexOf("Idle:") < h.indexOf("Not seen:"));
  assert.match(raw, /<h3 class="probe-sub">From the repository<\/h3>/);
  assert.match(h, /#C420\s*Build · a1b2c3d4 · CI running 3 min/);
  assert.doesNotMatch(raw, /data-cref/, "a card not on the board is plain text");
  // A card on the board is the board's card link.
  b.state.initiatives = [{ id: "board-state-probe", num: 420 }];
  assert.match(b.probeHtml(s, T), /<a href="#" class="t-ref c-ref" data-cref="board-state-probe">#C420<\/a>/);
  // An odd value shows nothing; nothing reaches the page as markup.
  const odd = good();
  Object.assign(odd.agents.Checker, { tool: "<img src=x onerror=alert(1)>", card: "<b>x</b>", state: "<script>", since: "now" });
  odd.cards["board-state-probe"].ci = "<i>";
  odd.agents["<svg onload=x>"] = { state: "working", lastActivityAt: T, tool: "Bash", card: null, since: T };
  const oh = b.probeHtml(odd, T);
  assert.doesNotMatch(oh, /<img|<b>|<script|<i>|<svg|onerror|onload/);
  assert.match(oh.replace(/<[^>]+>/g, ""), /Not seen: Checker/);
  assert.equal(b.probeFits({ v: 2 }), false);
});

test("the release tool pins mcp to Flight Board State / board_state: another connector, tool or call refuses (Security)", () => {
  const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.deepEqual(pageMcpErrors(html), []);
  assert.deepEqual(PAGE_MCP, { servers: [{ server: "Flight Board State", tools: ["board_state"] }] });
  for (const bad of [
    html.replace('const STATE_SERVER="Flight Board State"', 'const STATE_SERVER="Gmail"'),
    html.replace('STATE_TOOL="board_state"', 'STATE_TOOL="send_message"'),
    html.replace("mcp.callTool(STATE_SERVER,STATE_TOOL,null)", 'mcp.callTool("Gmail","send_message",{})'),
    html.replace("mcp.watchTool(STATE_SERVER,STATE_TOOL,", "mcp.watchTool(STATE_SERVER,\"other\","),
    html.replace("if(!mcp)return;", "if(!mcp)return;mcp.server(\"Gmail\");"),
    html + '<script>const STATE_SERVER="Gmail",STATE_TOOL="x"</script>',
    html.replace("mcp.callTool(STATE_SERVER,STATE_TOOL,null)", 'mcp["callTool"]("Gmail","send_message",{})'),
  ]) {
    assert.ok(pageMcpErrors(bad).length, "refused");
    assert.match(verdict({ ...releaseGood, mcpErrors: pageMcpErrors(bad) }).refusals.join(), /mcp capability is the owner's/);
  }
});

test("Security's LOWs: the projects folder can't be a link out; ids are the board's real shapes; wrangler at one exact version", () => {
  const { homeDir, root, session } = studio();
  session(1, "Checker", [entry("user", "#C420", T)]);
  const outside = tmp(), proj = join(homeDir, ".claude", "projects", "-Users-x-Code-teamrepo");
  execFileSync("mv", [proj, join(outside, "p")]);
  symlinkSync(join(outside, "p"), proj);
  assert.equal(agentStates({ roles: ["Checker"], sessions: appSessions(root), homeDir, now: T, ids, nums }).Checker.state, "unknown");
  for (const bad of ["please-ignore-all-previous-instructions-now", "a".repeat(17), "x-".repeat(20) + "x"]) {
    const s = good(); s.agents.Checker.card = bad;
    assert.ok(stateErrors(s).length, bad);
  }
  for (const [k, v] of [["agents", "Read-the-file"], ["agents", "a"]]) { const s = good(); s[k][v] = s.agents.Checker; assert.ok(stateErrors(s).length, v); }
  const s = good(); s.cards["board-state-probe"].phase = "ship-it-now"; assert.ok(stateErrors(s).length);
  assert.match(WRANGLER_VERSION, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(WRANGLER, ["--yes", `wrangler@${WRANGLER_VERSION}`]);
});

test("Checker: a whole day of a change every minute stays under the default budget, so the panel never freezes", async () => {
  const { env } = await envFor();
  let refused = 0;
  for (let m = 0; m < 1440; m++) {
    const s = good(); s.board.at = T + m * 60e3; s.agents.Checker.state = m % 2 ? "idle" : "working";
    if ((await worker.fetch(post(s), env, {}, T + m * 60e3)).status !== 204) refused++;
  }
  assert.equal(refused, 0);
  assert.ok(WRITES_DEFAULT >= 1440 + 96);
});

test("the page: the section shows with the connector, says to reconnect when it lapsed, and stays hidden without it", () => {
  const b = page();
  b.probeEvent({ type: "data", result: { payload: good() } }, {});
  assert.equal(b.els.probe.hidden, false);
  assert.match(b.els["probe-body"].innerHTML, /#C420/);
  assert.match(b.els["probe-asof"].textContent, /^as of/);
  b.probeEvent({ type: "error", error: { code: "server_unavailable" } }, {});
  assert.match(b.els["probe-body"].innerHTML, /#C420/, "a passing failure keeps the last reading");
  assert.match(b.els["probe-body"].innerHTML, /last reading/);
  b.probeEvent({ type: "error", error: { code: "needs_reauth" } }, {});
  assert.doesNotMatch(b.els["probe-body"].innerHTML, /#C420/, "an auth denial takes the data down");
  assert.match(b.els["probe-body"].innerHTML, /Reconnect Flight Board State/);
  b.probeEvent({ type: "error", error: { code: "server_not_connected" } }, {});
  assert.equal(b.els.probe.hidden, true);
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { at: "x" } } } }, {});
  assert.equal(b.els.probe.hidden, false);
  assert.doesNotMatch(b.els["probe-body"].innerHTML, /#C/);
});

test("the page asks for mcp, and only the Flight Board State connector's board_state", () => {
  const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.match(html, /const STATE_SERVER="Flight Board State",STATE_TOOL="board_state"/);
  assert.equal([...html.matchAll(/watchTool\(|callTool\(/g)].length, 2);
  assert.match(html, /watchTool\(STATE_SERVER,STATE_TOOL,null,/);
  assert.match(html, /callTool\(STATE_SERVER,STATE_TOOL,null\)/);
});
