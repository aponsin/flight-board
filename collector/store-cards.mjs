// The evidence job's cards come from the STORE (#C719), not from the old board's mirror. collector/state.mjs reads its card list
// from <stateDir>/<board id>/store-cards.json (#C999). So the probe keeps a private state directory of its own, writes the store's
// cards there, and points a copy of the board config at it (gate.stateDir). The old board's files are never read or written.
// Everything here is plain functions and one fetch; no secrets are written.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, copyFileSync, existsSync, renameSync, chmodSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { FETCH_TIMEOUT_MS } from "./probe-board.mjs";
import { STORE_CARDS_FILE } from "./state-schema.mjs";
import { BOARD_ID } from "../scripts/config.mjs";
import { isBoardRepo } from "./pairs.mjs";

const CARD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const num = (v) => (Number.isFinite(v) ? v : undefined);
const str = (v) => (typeof v === "string" && v !== "" ? v : undefined);
const skipList = (v) => { try { const a = typeof v === "string" ? JSON.parse(v) : v; return Array.isArray(a) && a.every((p) => typeof p === "string") ? a : undefined; } catch { return undefined; } };

// A store card as the mirror's initiative document (the shape the old board kept and state.mjs reads). Nothing is invented: a
// field the store does not have is left out, and the status is only what the store's flags say.
export function mirrorCard(c) {
  const d = {
    name: str(c.title), summary: str(c.summary), who: str(c.owner_role), size: str(c.size), level: str(c.review_level),
    num: num(c.num), nextNote: str(c.next_note), nextNoteAt: num(c.next_note_at), waitingOn: str(c.waiting_on), phaseReason: str(c.rework_reason),
    createdAt: num(c.created_at), updatedAt: num(c.updated_at),
    // #C1034 (Checker 2 F1 on 4d8c7adc): when the card was closed, from the store's own done_at. state.mjs closedPacks reads only
    // board cards closed in the last 14 days; without it every done card was out of the window and stayed unlit.
    doneAt: num(c.done_at),
    status: c.dropped ? "dropped" : c.done_at ? "done" : c.paused ? "paused" : "active", // #C902
    // The words the review skips read (state.mjs reviewsFor): customerText false skips the language review, lookChange true is
    // what keeps the design review, skip names phases to leave out. Not said (null) stays out, as on an old card without them.
    customerText: c.customer_text === 1 ? true : c.customer_text === 0 ? false : undefined,
    lookChange: c.look_change === 1 ? true : c.look_change === 0 ? false : undefined,
    skip: skipList(c.skip),
    // #C735: the repository a card lives in (state.mjs repoOf reads card.repo before any id prefix: a c-numbered board card has no
    // listed prefix, so without this word it read the team's repository and its notes), and the batch and bump the ETA reads.
    repo: str(c.repo), batch: str(c.batch), bump: str(c.bump),
  };
  return Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined));
}

// The store's open cards, from its own typed read as the probe.
export async function storeCards(opts) { return (await storeRead(opts)).cards; }
// The cards and the stack switch of one read of the view. The switch rows are { repo, stack: true|false } ("board": the team's own repository, "" in the
// probe's repository map); a view from before the switch has none, which reads as off.
export async function storeRead({ base, headers, fetchImpl = fetch }) {
  const r = await fetchImpl(`${base}/api/view`, { headers, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`view answered ${r.status}`);
  const v = await r.json();
  if (!Array.isArray(v?.cards)) throw new Error("view has no cards");
  return { cards: v.cards.filter((c) => c && CARD_ID.test(String(c.id))), stackSwitch: Array.isArray(v.stackSwitch) ? v.stackSwitch : [] };
}

// #C859 slice 3: the repositories (by the probe's names: "" is the team's own) whose stack switch is on.
// #C1295: per repository. The board's row switches the team's own repository (""); the product's row switches every OTHER repository the board config lists
// (collector.repos, `productRepos`: their names), so a product group is read from git as a stack, with its review notes covering every member. A product row that
// is on while the config lists no other repository changes nothing here (the probe has no checkout of it to read).
// #C1303 (the bug in #C1295: on the live config the product switch could never read a product stack): the probe's "" is the clone at collector.repoPath. When the config LISTS the
// board's own repository in collector.repos, the board is the listed one and "" is the team's other repository, the product's clone: so the product's row switches "" as well as every
// other listed repository. A config that does not list the board's repository (the board's own clone is `repoPath`, the single-repository shape) reads exactly as #C1295 had it.
// Checker 2's F1 on #C1303: the same fact moves the BOARD's row too. When the board's repository is listed, `repos` keys it by its listed name (state.mjs repos[name]) and "" is the product,
// so the board's row switches that listed name (`boardRepos`, boardRepoNames), never "". In the single-repository shape the board's row is still "".
export const STACKS_FILE = "stacks.json";
export function stacksOn(stackSwitch, productRepos = [], boardRepos = [""]) {
  const on = (row) => (Array.isArray(stackSwitch) ? stackSwitch : []).some((s) => s && s.repo === row && (s.stack === true || s.stack === 1));
  const ok = (list) => list.filter((n) => typeof n === "string" && n.length <= 40);
  const names = [...(on("board") ? ok(boardRepos) : []), ...(on("product") ? ok(productRepos) : [])];
  return [...new Set(names)];
}
// The probe's names for the board's own checkout: its listed name(s) as written in collector.repos when the board's repository is listed, else "" (the team's own clone, repoPath).
export function boardRepoNames(rawConfig) {
  const listed = (Array.isArray(rawConfig?.collector?.repos) ? rawConfig.collector.repos : []).map((r) => r?.name).filter((n) => typeof n === "string" && n !== "");
  const mine = listed.filter((n) => isBoardRepo(n));
  return mine.length ? mine : [""];
}
// The probe's names for the product's checkouts, from a parsed board config: every listed repository that is not the board's own, and "" (the team's own clone) too when the board's
// own repository is itself listed, because then "" is the product.
export function productRepoNames(rawConfig) {
  const listed = (Array.isArray(rawConfig?.collector?.repos) ? rawConfig.collector.repos : []).map((r) => r?.name).filter((n) => typeof n === "string" && n !== "");
  const others = listed.filter((n) => !isBoardRepo(n));
  return listed.some((n) => isBoardRepo(n)) ? ["", ...others] : others;
}

// #C900 (the board half of #C860): the product's stack switch, for the product's own release tool. The probe writes a fixed file, whole, on every
// evidence run: { at: <ms of its store read>, product: true|false } from the store's product row (stackSwitch repo "product"), to a temporary name
// and renamed, mode 600. The path is fixed (~/.flight-board/stack-switch.json), so the product never needs the board's private id. A missing
// file, a missing key or a stale "at" is OFF on the product's side, so the two halves can land in either order.
export function productSwitchOn(stackSwitch) {
  return (Array.isArray(stackSwitch) ? stackSwitch : []).some((s) => s && s.repo === "product" && (s.stack === true || s.stack === 1));
}
export function writeProductSwitch({ file, at, product }) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ at, product: product === true }), { mode: 0o600 });
  chmodSync(tmp, 0o600); // a leftover temporary file from a crash keeps its old mode under writeFileSync's mode argument
  renameSync(tmp, file);
}

// #C999: the store's cards, as one file the probe reads (<dir>/<id>/store-cards.json: { at, cards: { <card id>: <card> } }), written whole
// under a temporary name and renamed into place. `at` is the time of this read. Nothing under an old board's mirror/ is written or read.
export function writeStoreCards({ cards, dir, boardId, now }) {
  const file = join(dir, boardId, STORE_CARDS_FILE), tmp = `${file}.tmp`;
  mkdirSync(join(dir, boardId), { recursive: true });
  let before = new Set();
  try { before = new Set(Object.keys(JSON.parse(readFileSync(file, "utf8")).cards ?? {})); } catch { /* the first run */ }
  const out = {};
  for (const c of cards) out[c.id] = mirrorCard(c);
  writeFileSync(tmp, JSON.stringify({ at: now, cards: out }), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return { written: Object.keys(out).length, removed: [...before].filter((id) => !(id in out)).length };
}

// A copy of the board config with its state directory moved to the private one; nothing else in it changes.
export function privateConfig(raw, dir) {
  return { ...raw, gate: { ...(raw?.gate ?? {}), stateDir: dir } };
}

// Everything the evidence job needs before it builds the state from the store's cards: the mirror, the private config, the
// seeded usage history. Returns where to point state.mjs (--config) and where it leaves its state.json.
// `stateFile` is the old location (<dir>/<board id>/state.json); only its board id and its usage history are used.
export async function prepareStoreState({ privateDir, stateFile, configPath, base, headers, fetchImpl = fetch, now = Date.now(), readText = (p) => readFileSync(p, "utf8"), log = () => {}, switchFile = null }) {
  const boardId = basename(dirname(stateFile));
  if (!BOARD_ID.test(boardId)) throw new Error("the state path has no board id");
  const { cards, stackSwitch } = await storeRead({ base, headers, fetchImpl });
  const m = writeStoreCards({ cards, dir: privateDir, boardId, now });
  // state.mjs reads it (readStacks); written whole under a temporary name, as the mirror's files are.
  const sf = join(privateDir, boardId, STACKS_FILE);
  let productRepos = [], boardRepos = [""];
  try { const raw = JSON.parse(readText(configPath)); productRepos = productRepoNames(raw); boardRepos = boardRepoNames(raw); } catch { /* an unreadable config: the board's own switch alone, as before */ }
  writeFileSync(`${sf}.tmp`, JSON.stringify({ at: now, stacks: stacksOn(stackSwitch, productRepos, boardRepos) }), { mode: 0o600 });
  renameSync(`${sf}.tmp`, sf);
  // #C900: the product's switch, to the fixed file the product's release tool reads. A failed write never stops the evidence run.
  if (switchFile) { try { writeProductSwitch({ file: switchFile, at: now, product: productSwitchOn(stackSwitch) }); } catch (e) { log(`stack-switch.json not written: ${e?.code ?? e?.message ?? e}`); } }
  const seeded = seedUsage({ from: dirname(stateFile), to: join(privateDir, boardId) });
  const cfgPath = join(privateDir, boardId, "config.json");
  writeFileSync(cfgPath, JSON.stringify(privateConfig(JSON.parse(readText(configPath)), privateDir)), { mode: 0o600 });
  log(`store cards: ${m.written} written, ${m.removed} removed${seeded ? `, ${seeded} usage file(s) seeded` : ""}`);
  return { configPath: cfgPath, stateFile: join(privateDir, boardId, "state.json"), cards };
}

// The first time only: the usage history the old state job keeps is copied over, so the usage tile does not start from nothing.
export function seedUsage({ from, to }) {
  mkdirSync(to, { recursive: true });
  let copied = 0;
  for (const f of ["usage.json", "usage-plan.json"]) if (existsSync(join(from, f)) && !existsSync(join(to, f))) { copyFileSync(join(from, f), join(to, f)); copied++; }
  return copied;
}
