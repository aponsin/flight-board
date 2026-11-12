// The new probe's jobs against the board store (#C719): `ask` (every 20 s) and `live` (read the product's /version.json). Each
// is a short run under startRun's two limits; every network call has an abort timeout and every child its own kill timeout.
// Secrets come from the env file and are never logged. The evidence and usage jobs (git, GitHub, sessions) are separate.
import { readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { runChild, startRun, JOBS } from "./probe-run.mjs";
import { dispatchRun, writeStackQueue, writeOpenAsks, writeLandHolds } from "./store-dispatch.mjs";
import { checkConfig, fullConfig, boardId } from "../scripts/config.mjs";
import { home } from "../gate/gate.mjs";

export const SEND_TIMEOUT_MS = 25_000;  // inside the ask job's 30 s limit
export const FETCH_TIMEOUT_MS = 8_000;

export function loadEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
export const accessHeaders = (env) => ({ "cf-access-client-id": env.BOARD_SERVICE_TOKEN_ID, "cf-access-client-secret": env.BOARD_SERVICE_TOKEN_SECRET, "content-type": "application/json" });

// The headless send that starts a turn in Manager's open session (brief "Spike result"): the line is a count and a batch id.
export const sendArgs = (line) => [
  "-p", `Use SendMessage to send the session named 'Manager' exactly this text: ${line}. Then reply with exactly what the tool returned.`,
  "--model", "haiku", "--allowedTools", "SendMessage,ListAgents",
];
// A launchd job runs with PATH=/usr/bin:/bin:/usr/sbin:/sbin, where `claude` is not found (#C721: the first live wake failed with
// "send exit 1" in 6 ms). So the job passes claude's FULL path, and the child gets a PATH that holds claude's own folder (a
// launcher script may need the tools beside it) ahead of the standard ones.
export const sendEnv = (claudePath, env = process.env) => ({ ...env, PATH: [dirname(claudePath), ...String(env.PATH ?? "").split(":"), "/usr/local/bin", "/usr/bin", "/bin"].filter((p, i, a) => p && a.indexOf(p) === i).join(":") });
// A test run never starts the real claude (#C721: a test's "1 for Manager, batch b-1" reached Manager's live session). Under
// `node --test` (NODE_TEST_CONTEXT is set) the send only runs a claude that sits in the temp folder, i.e. a fake the test made.
export const blockedInTests = (claudePath, env = process.env) => !!env.NODE_TEST_CONTEXT && !String(claudePath).startsWith(tmpdir());
export async function realSend(line, { claudePath = "claude", cwd, env = process.env } = {}) {
  if (blockedInTests(claudePath)) return { exit: 125, text: "blocked: a test run never starts the real claude" };
  try {
    const r = await runChild(claudePath, sendArgs(line), { timeoutMs: SEND_TIMEOUT_MS, cwd, env: isAbsolute(claudePath) ? sendEnv(claudePath, env) : env });
    return { exit: 0, text: r.stdout + r.stderr };
  } catch (e) {
    // killed at the timeout (124, as timeout(1)) or exited non-zero: the exit code and the CLI's own words go to the store
    return { exit: /killed after/.test(e.message) ? 124 : Number.isInteger(e.code) ? e.code : 1, text: `${e.stderr ?? ""}${e.stdout ?? ""}${e.message}` };
  }
}

const post = (fetchImpl, base, headers, path, body) => fetchImpl(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body ?? {}), redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

// One ask: heartbeat + "anything for Manager?". If the store says send, run the send and report its exit code and text.
export async function askJob({ base, headers, fetchImpl = fetch, send = realSend, log = () => {} }) {
  const r = await post(fetchImpl, base, headers, "/api/probe/wake");
  if (!r.ok) throw new Error(`wake ask answered ${r.status}`);
  const a = await r.json();
  if (a.status?.state === "red") log(`row 4 red: ${a.status.reason}`);
  if (a.tellOwner) log(`TELL OWNER once: ${a.status.reason}: ${a.status.fix}`);
  if (!a.send) return { sent: false, tellOwner: !!a.tellOwner, status: a.status };
  log(`send batch ${a.batchId}`);
  const s = await send(a.line);
  log(`send exit ${s.exit}`);
  const rr = await post(fetchImpl, base, headers, "/api/probe/wake-result", { batchId: a.batchId, exit: s.exit, text: s.text });
  if (!rr.ok) throw new Error(`wake-result answered ${rr.status}`);
  return { sent: true, exit: s.exit, tellOwner: !!a.tellOwner, status: a.status };
}

// Live now: the product's own /version.json {version, commit, builtAt}. A 404 is "unknown" (nothing written); anything else
// that is not a well-formed reading is not written either, so a typed or copied version can never get in.
export async function liveJob({ base, headers, productUrl, fetchImpl = fetch, log = () => {} }) {
  const r = await fetchImpl(`${productUrl}/version.json`, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (r.status === 404) { log("version.json: 404, live version unknown"); return { written: false, unknown: true }; }
  if (!r.ok) throw new Error(`version.json answered ${r.status}`);
  const v = await r.json();
  const ok = v && typeof v.version === "string" && /^[A-Za-z0-9._+-]{1,64}$/.test(v.version) && typeof v.commit === "string" && /^[0-9a-f]{7,40}$/.test(v.commit) && typeof v.builtAt === "string" && Number.isFinite(Date.parse(v.builtAt));
  if (!ok) { log("version.json: not the expected shape"); return { written: false, malformed: true }; }
  const w = await post(fetchImpl, base, headers, "/api/probe/evidence", { key: "live", value: { version: v.version, commit: v.commit, builtAt: v.builtAt } });
  if (!w.ok) throw new Error(`evidence write answered ${w.status}`);
  return { written: true, version: v.version };
}

// The owners' dispatch (#C821): read the store's view, write dispatch.json and dispatch-state.json for the role watches. `dir` is
// <stateDir>/<board>; roster and lead come from the team's board.config.json.
export async function dispatchJob({ base, headers, fetchImpl = fetch, dir, roster, lead, now = Date.now, log = () => {} }) {
  const r = await fetchImpl(`${base}/api/view`, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`view answered ${r.status}`);
  const view = await r.json();
  const run = dispatchRun(view, { dir, roster, lead, now: now(), log });
  // #C914: the queue file the builder's stack-ready command reads (ids only). A failed write never stops the dispatch.
  try { writeStackQueue(view, { dir, now: now() }); } catch (e) { log(`dispatch: stack-queue.json not written: ${e?.message ?? e}`); }
  // #C957: the open asks' numbers, for the Stop hook's red-ask check. A failed write never stops the dispatch.
  try { writeOpenAsks(view, { dir, now: now() }); } catch (e) { log(`dispatch: open-asks.json not written: ${e?.message ?? e}`); }
  // #C967: which cards are held, for the landing job. A failed write never stops the dispatch (the job then lands nothing: the file goes stale).
  try { writeLandHolds(view, { dir, now: now() }); } catch (e) { log(`dispatch: land-holds.json not written: ${e?.message ?? e}`); }
  // #C903: a builder woken for a card with nothing pushed starts that card's build. The Worker writes it once (a card with any history is
  // left alone), so the item repeating on every run adds nothing; a failed post is logged and never stops the dispatch.
  for (const card of buildStarts(run.items)) {
    try {
      const w = await post(fetchImpl, base, headers, "/api/probe/build-start", { id: card });
      if (!w.ok) log(`dispatch: build start for ${card} answered ${w.status}`);
    } catch (e) { log(`dispatch: build start for ${card} not posted: ${e?.message ?? e}`); }
  }
  return run;
}
// The cards whose builder the dispatch wakes to build from nothing: step build, no sha (a rework has a sha, an outside card another step).
export const buildStarts = (items) => [...new Set((Array.isArray(items) ? items : []).filter((i) => i && i.step === "build" && i.phase === "build" && !i.sha && typeof i.card === "string").map((i) => i.card))];

// The CLI entry: node probe-board.mjs --job ask|live|dispatch --env <file> [--product <url>] [--base <url>] [--config <board.config.json>]
export async function main(argv, { env = process.env, exit = (c) => process.exit(c), fetchImpl = fetch } = {}) {
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const job = get("--job");
  if (!JOBS[job] || !["ask", "live", "dispatch"].includes(job)) { console.error(`unknown job ${job}`); return exit(64); }
  const cfg = loadEnv(get("--env"));
  // The board's address is configuration (an argument, or BOARD_BASE_URL in the env file), never written into the code.
  const base = get("--base") ?? cfg.BOARD_BASE_URL;
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(base ?? "")) { console.error("no board address: pass --base or set BOARD_BASE_URL"); return exit(64); }
  // claude's full path for the wake send (a launchd job has no PATH to find it); when given it must be absolute.
  const claudePath = get("--claude") ?? "claude";
  if (get("--claude") !== undefined && !isAbsolute(claudePath)) { console.error("--claude must be a full path"); return exit(64); }
  // The dispatch job needs the team's config for the state folder, the roster and the lead (the same file the watches read).
  let team = null;
  if (job === "dispatch") {
    try {
      const raw = JSON.parse(readFileSync(get("--config"), "utf8"));
      if (checkConfig(raw).length) throw new Error("bad config");
      const full = fullConfig(raw), id = boardId(full);
      if (!id) throw new Error("no board link");
      team = { dir: `${home(full.gate.stateDir)}/${id}`, roster: full.roster, lead: full.gate.managerRole };
    } catch { console.error("dispatch: pass --config <board.config.json> (a usable team config)"); return exit(64); }
  }
  const run = startRun(job);
  const headers = accessHeaders(cfg);
  try {
    if (job === "dispatch") await run.step("write the dispatch files", () => dispatchJob({ base, headers, fetchImpl, ...team, log: run.log }));
    else if (job === "ask") await run.step("ask the store", () => askJob({ base, headers, fetchImpl, log: run.log, send: (l) => realSend(l, { claudePath, cwd: get("--send-cwd") }) }));
    else await run.step("read version.json", () => liveJob({ base, headers, productUrl: get("--product"), log: run.log }));
    return exit(run.finish(0));
  } catch (e) {
    run.log(`failed: ${String(e.message).slice(0, 200)}`);
    return exit(run.finish(1));
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
