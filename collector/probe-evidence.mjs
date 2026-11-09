// The new probe's evidence and usage jobs against the board store (#C719). The readings themselves (git, GitHub, sessions,
// the usage script) are collector/state.mjs's pure functions, run by its own CLI with --no-post --no-derive, which leaves the
// state it built in <stateDir>/<board id>/state.json. This module only maps that state to the store's evidence keys and posts
// them as the probe, so the readings are computed in one place and the store gets nothing typed or copied.
//   evidence job (60 s): cards.<id> {lit:[phase], ...the card's reading}, agents, ctx, board
//   usage job (300 s):   usage
// A key whose reading is missing is not written (the store then shows it as unknown/silent, never as a guess).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runChild, startRun, JOBS } from "./probe-run.mjs";
import { loadEnv, accessHeaders, FETCH_TIMEOUT_MS } from "./probe-board.mjs";
import { prepareStoreState } from "./store-cards.mjs";

const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const CARD_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;

// The writes of one job, from a built state. `track` is not sent: the store checks a phase against its own track list only
// when the probe names one.
export function evidenceWrites(state, job) {
  if (!plain(state)) return [];
  if (job === "usage") return plain(state.usage) ? [{ key: "usage", value: state.usage }] : [];
  const out = [];
  for (const [id, c] of Object.entries(plain(state.cards) ? state.cards : {})) {
    if (!CARD_KEY.test(id) || !plain(c) || typeof c.phase !== "string") continue; // no phase read: the card stays as the store has it
    out.push({ key: `cards.${id}`, value: { lit: [c.phase], ...c } });
  }
  if (plain(state.agents)) out.push({ key: "agents", value: state.agents });
  if (plain(state.ctx)) out.push({ key: "ctx", value: state.ctx });
  if (plain(state.board)) out.push({ key: "board", value: state.board });
  return out;
}

const post = (fetchImpl, base, headers, body) => fetchImpl(`${base}/api/probe/evidence`, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

// Posts every write; a refusal (422) of one key is logged and the rest still go, any other failure stops the run.
export async function postWrites(writes, { base, headers, fetchImpl = fetch, log = () => {} }) {
  let written = 0, refused = 0;
  for (const w of writes) {
    const r = await post(fetchImpl, base, headers, w);
    if (r.ok) { written++; continue; }
    if (r.status === 422) { refused++; let why = ""; try { why = JSON.stringify((await r.json())?.refusal ?? "").slice(0, 120); } catch { /* none */ } log(`${w.key} refused ${why}`); continue; }
    throw new Error(`evidence write ${w.key} answered ${r.status}`);
  }
  return { written, refused };
}

export const stateArgs = (configPath) => [join(import.meta.dirname, "state.mjs"), "--config", configPath, "--no-post", "--no-derive"];

// "Live now": the product's own /version.json, on the host of the board config's liveUrl, read by the probe each evidence run.
// The store stamps the read time itself, so a reading that stops coming turns stale in 3 minutes and is never shown as live.
// Anything unreadable or not shaped like a version writes nothing (the chip then says unknown or stale, never a guess).
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]{1,40})?$/;
export async function liveWrite(configText, { fetchImpl = fetch, log = () => {} } = {}) {
  // The liveUrl sits where state.mjs reads it: collector.liveUrl in the board config.
  let url;
  try { const u = new URL("/version.json", JSON.parse(configText)?.collector?.liveUrl); if (u.protocol !== "https:") throw new Error("not https"); url = u; } catch { log("live: the board config has no usable https collector.liveUrl"); return null; }
  try {
    const r = await fetchImpl(url.href, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) { log(`live ${url.host} answered ${r.status}`); return null; }
    const v = (await r.json())?.version;
    if (typeof v !== "string" || !VERSION.test(v)) { log("live reading has no version"); return null; }
    return { key: "live", value: { version: `v${v}` } };
  } catch (e) { log(`live ${url.host} unreadable: ${String(e.message).slice(0, 80)}`); return null; }
}

// One run: build the state, read it, post the job's keys.
// With privateDir, the cards come from the store (collector/store-cards.mjs), not from the old board's mirror, and the state is
// built and left in that private directory; without it, the job reads the old location as before.
export async function evidenceJob({ job, base, headers, configPath, stateFile, privateDir, prepare = prepareStoreState, fetchImpl = fetch, liveFetch = fetch, build = (args, ms) => runChild(process.execPath, args, { timeoutMs: ms }), read = (p) => readFileSync(p, "utf8"), log = () => {} }) {
  const origConfig = configPath;
  if (privateDir) ({ configPath, stateFile } = await prepare({ privateDir, stateFile, configPath, base, headers, fetchImpl, log }));
  await build(stateArgs(configPath), (JOBS[job].limitSec - 15) * 1000);
  const state = JSON.parse(read(stateFile));
  const writes = evidenceWrites(state, job);
  log(`${writes.length} key(s) to write`);
  const done = await postWrites(writes, { base, headers, fetchImpl, log });
  if (job !== "evidence") return done;
  // Live last, so a product site that answers slowly (or not at all) can never hold up the evidence above.
  let cfg = null;
  try { cfg = read(origConfig); } catch { log("live: the board config could not be read"); }
  const live = cfg && await liveWrite(cfg, { fetchImpl: liveFetch, log });
  if (live) { const l = await postWrites([live], { base, headers, fetchImpl, log }); return { written: done.written + l.written, refused: done.refused + l.refused }; }
  return done;
}

// node probe-evidence.mjs --job evidence|usage --env <file> --config <board config> --state <state.json> [--base <url>] [--private-dir <dir>]
export async function main(argv, { exit = (c) => process.exit(c) } = {}) {
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const job = get("--job");
  if (!["evidence", "usage"].includes(job)) { console.error(`unknown job ${job}`); return exit(64); }
  const cfg = loadEnv(get("--env"));
  const base = get("--base") ?? cfg.BOARD_BASE_URL;
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(base ?? "")) { console.error("no board address: pass --base or set BOARD_BASE_URL"); return exit(64); }
  if (!get("--config") || !get("--state")) { console.error("pass --config and --state"); return exit(64); }
  const run = startRun(job);
  try {
    await run.step(`${job} readings`, () => evidenceJob({ job, base, headers: accessHeaders(cfg), configPath: get("--config"), stateFile: get("--state"), privateDir: get("--private-dir"), log: run.log }));
    return exit(run.finish(0));
  } catch (e) {
    run.log(`failed: ${String(e.message).slice(0, 200)}`);
    return exit(run.finish(1));
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
