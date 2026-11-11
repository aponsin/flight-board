// The owners' dispatch from the store (#C821). The old state job (collector/state.mjs) writes <stateDir>/<board>/dispatch.json from
// the old board's documents; scripts/wake-watch.mjs --role <Role> --once reads that file and prints one DISPATCH line to wake an idle
// owner whose active card waits on them. When the old Collector stops that file goes stale and no owner is woken. This job writes the
// same two files (dispatch.json, dispatch-state.json) from the store's view, with the same rule (gate/reset.mjs dispatchItems: an
// active card, its owner idle for 15 minutes, nothing to wait for), so the watch, the Stop hook and the pinned hooks stay as they are.
// The lead's own WAKE is not here: the ask job's headless send into Manager's session already covers it (probe-board.mjs askJob).
// Tokens stay with the launchd job: an agent's watch only reads local files, never the board's credentials.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DISPATCH_FILE, DISPATCH_STATE_FILE, dispatchItems } from "../gate/reset.mjs";

// The agents' reading (evidence.agents) is written by the evidence job every minute; older than this it says nothing about who is idle.
export const AGENTS_FRESH_MS = 5 * 60e3;
// A dispatch.json another writer (the old state job) made this recently is left alone: two writers would each reset the other's `since`.
export const FOREIGN_WRITER_MS = 5 * 60e3;

const CARD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

// #C850 (dispatch by phase): whose turn it is on a card, and for what, from the card's evidence. The lanes are whoForPhase's
// (worker/board-rules.mjs PHASE_LANES; a test pins that they are the same). [{ role, phase, step, sha?, signed? }]:
//   no phase or build        the owner builds and pushes (the push is the READY)
//   language, design         the lane's agent reviews the pushed commit
//   checker, security        the lane's agent reviews; with review level Full, Security too while its note is missing
//   ship, not on main        Release lands it (the notes on that exact commit, a clean dry run, the owner's standing go)
//   ship, on main, repo word the owner builds the deploy pair (the board's own repository: landed, not deployed)
//   live, or on main with no repo word: nobody (the lead closes it)
export const PHASE_LANES = { language: "Linguist", design: "Designer", checker: "Checker", security: "Security", ship: "Release" };
const ROLE_OF_NOTE = { language: "Linguist", design: "Designer", checker: "Checker", security: "Security" };
export function turnsOf(card, e) {
  const phase = e?.phase ?? e?.lit?.[0];
  const sha = typeof e?.headSha12 === "string" && /^[0-9a-f]{12}$/.test(e.headSha12) ? e.headSha12 : undefined;
  const signed = (Array.isArray(e?.signed) ? e.signed : []).filter((s) => typeof s === "string" && Object.hasOwn(ROLE_OF_NOTE, s));
  const signedBy = signed.map((s) => ROLE_OF_NOTE[s]);
  const owner = { role: card.owner_role, phase: "build", step: "build" };
  if (typeof phase !== "string" || phase === "plan" || phase === "build") return [owner];
  if (phase === "ship") {
    if (e.onMain === true) return typeof card.repo === "string" && card.repo !== "" ? [{ role: card.owner_role, phase: "ship", step: "pair", sha, signed: signedBy }] : [];
    return [{ role: PHASE_LANES.ship, phase: "ship", step: "land", sha, signed: signedBy }];
  }
  if (!Object.hasOwn(PHASE_LANES, phase)) return [owner];
  const out = [];
  if (!signed.includes(phase)) out.push({ role: PHASE_LANES[phase], phase, step: "review", sha, signed: signedBy });
  if (phase === "checker" && card.review_level === "Full" && !signed.includes("security")) out.push({ role: "Security", phase, step: "review", sha, signed: signedBy });
  return out;
}

// The store's view -> { cards, agents, asked } in the shapes dispatchItems reads, or null when the view cannot say who is idle.
export function dispatchInput(view, now) {
  const ev = view?.evidence ?? {};
  const agents = ev.agents?.value;
  const readAt = ev.agents?.readAt;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) return null;
  if (!Number.isFinite(readAt) || now - readAt > AGENTS_FRESH_MS || readAt > now + 5_000) return null;
  const cards = [];
  const all = Array.isArray(view?.cards) ? view.cards : [];
  const phaseOf = (id) => { const e = ev[`cards.${id}`]?.value; return e?.phase ?? e?.lit?.[0]; };
  // #C845: a card waits for the cards it depends on (depends_on, a JSON list of ids) until each is live. A dependency the board doesn't
  // have, or one that was dropped, holds nothing (as the gate's dependsOnErrors reads it).
  const open = new Map(all.filter((k) => k && typeof k.id === "string" && !k.dropped).map((k) => [k.id, k]));
  const waitsOn = (c) => {
    let list = c.depends_on;
    if (typeof list === "string") { try { list = JSON.parse(list); } catch { return []; } }
    return Array.isArray(list) ? list.filter((d) => typeof d === "string" && d !== c.id && open.has(d) && phaseOf(d) !== "live") : [];
  };
  for (const c of all) {
    if (!c || typeof c.id !== "string" || !CARD_ID.test(c.id) || typeof c.owner_role !== "string") continue;
    if (waitsOn(c).length) continue;
    // Active: not paused, not dropped, not blocked (a blocked card is "blocked" on the old shape and the store's stall rule skips it), and
    // not already live (a live card waits for the lead to close it, not for its owner). The phase is read as compat-view reads it.
    if (c.paused || c.dropped || c.blocked_reason) continue;
    const e = ev[`cards.${c.id}`]?.value;
    if ((e?.phase ?? e?.lit?.[0]) === "live") continue;
    // #C850: a hold with an end (a card the lead put on hold) is skipped; the stall rule brings it back when the hold ends.
    if (c.hold_end) continue;
    cards.push({ id: c.id, who: c.owner_role, status: "active", num: Number.isInteger(c.num) ? c.num : null, waitingOn: typeof c.waiting_on === "string" ? c.waiting_on : null, turns: turnsOf(c, e) });
  }
  // A card with an open ask is waiting for the owner or the lead, not for its agent. Open = not closed and not answered, as on the old
  // board (!done && !response): a withdrawn approval has its answer cleared and waits for the owner's Approve again, so it is still open.
  const asked = new Set();
  for (const a of Array.isArray(view?.asks) ? view.asks : []) if (a && typeof a.card_id === "string" && a.closed_at == null && a.answered_at == null) asked.add(a.card_id);
  return { cards, agents, asked };
}

const readJson = (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
const writeAtomic = (path, text) => { const tmp = `${path}.${process.pid}.part`; writeFileSync(tmp, text, { mode: 0o600 }); renameSync(tmp, path); };

// One run over a view. Returns { wrote, why?, items }. `dir` is <stateDir>/<board>.
export function dispatchRun(view, { dir, roster, lead, now = Date.now(), log = () => {} }) {
  const input = dispatchInput(view, now);
  if (!input) { log("dispatch: the store's agent reading is missing or older than 5 minutes; nothing written"); return { wrote: false, why: "agents-stale", items: [] }; }
  const file = readJson(join(dir, DISPATCH_FILE));
  if (file && file.source !== "store" && Number.isFinite(file.at) && now - file.at < FOREIGN_WRITER_MS) {
    log("dispatch: the old state job still writes dispatch.json; nothing written");
    return { wrote: false, why: "foreign-writer", items: [] };
  }
  const state = readJson(join(dir, DISPATCH_STATE_FILE));
  mkdirSync(dir, { recursive: true, mode: 0o700 }); // the board's state folder may not exist yet when the old state job never ran here
  const r = dispatchItems({ cards: input.cards, agents: input.agents, asked: input.asked, roster, lead, now, before: state });
  writeAtomic(join(dir, DISPATCH_FILE), JSON.stringify({ at: now, source: "store", items: r.items }));
  writeAtomic(join(dir, DISPATCH_STATE_FILE), JSON.stringify(r.state));
  log(`dispatch: ${r.items.length} item(s)`);
  return { wrote: true, items: r.items };
}
