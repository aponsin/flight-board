// The new probe's jobs against the board store (#C719): `ask` (every 20 s) and `live` (read the product's /version.json). Each
// is a short run under startRun's two limits; every network call has an abort timeout and every child its own kill timeout.
// Secrets come from the env file and are never logged. The evidence and usage jobs (git, GitHub, sessions) are separate.
import { readFileSync } from "node:fs";
import { runChild, startRun, JOBS } from "./probe-run.mjs";

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
export async function realSend(line, { claudePath = "claude", cwd } = {}) {
  try {
    const r = await runChild(claudePath, sendArgs(line), { timeoutMs: SEND_TIMEOUT_MS, cwd });
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

// The CLI entry: node probe-board.mjs --job ask|live --env <file> [--product <url>] [--base <url>]
export async function main(argv, { env = process.env, exit = (c) => process.exit(c) } = {}) {
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const job = get("--job");
  if (!JOBS[job] || !["ask", "live"].includes(job)) { console.error(`unknown job ${job}`); return exit(64); }
  const cfg = loadEnv(get("--env"));
  // The board's address is configuration (an argument, or BOARD_BASE_URL in the env file), never written into the code.
  const base = get("--base") ?? cfg.BOARD_BASE_URL;
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(base ?? "")) { console.error("no board address: pass --base or set BOARD_BASE_URL"); return exit(64); }
  const run = startRun(job);
  const headers = accessHeaders(cfg);
  try {
    if (job === "ask") await run.step("ask the store", () => askJob({ base, headers, log: run.log, send: (l) => realSend(l, { cwd: get("--send-cwd") }) }));
    else await run.step("read version.json", () => liveJob({ base, headers, productUrl: get("--product"), log: run.log }));
    return exit(run.finish(0));
  } catch (e) {
    run.log(`failed: ${String(e.message).slice(0, 200)}`);
    return exit(run.finish(1));
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
