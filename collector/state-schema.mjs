// What leaves the Studio for the board's state Worker (#C420, Security's data plan): an allowlist, checked at both ends.
// collector/state.mjs builds a state, checks it here and POSTs it; worker/state-worker.mjs checks every POST here again
// and its MCP tool, board_state, answers only pickState() of what it stored, never the stored text itself.
// Ids, enums, numbers and fixed strings only: no free text from a transcript, a session title or a commit message ever
// fits a field, and an error never quotes what it refused (a key it doesn't know is "a key that isn't in the plan").
//
//   { v: 1,
//     board:  { boardId, at, probe, pageVersion, lastWriteAt? },
//     cards:  { <card id>: { num, phase, headSha12, signed, onMain, ci, ciMin, liveVersion, at } },
//     agents: { <role>: { state, lastActivityAt, tool, card, since } } }

export const STATE_VERSION = 1;
// A POST's body at most (the Worker refuses a longer one before reading it).
export const MAX_BYTES = 65536;
export const MAX_CARDS = 200, MAX_AGENTS = 40, MAX_SIGNED = 10;

// The tool an agent last called, as a class: one of these names, "mcp" for any mcp__ tool, else "other".
export const TOOLS = ["Agent", "Artifact", "ArtifactComments", "ArtifactData", "AskUserQuestion", "Bash", "Edit", "Glob", "Grep", "Monitor", "NotebookEdit", "Read", "ScheduleWakeup", "SendMessage", "Skill", "TaskStop", "ToolSearch", "WebFetch", "WebSearch", "Workflow", "Write"];
export const toolClass = (name) => {
  const n = String(name ?? "");
  if (!n) return null;
  if (TOOLS.includes(n)) return n;
  return n.startsWith("mcp__") ? "mcp" : "other";
};
export const AGENT_STATES = ["working", "idle", "unknown"];
export const CI_STATES = ["none", "queued", "running", "passed", "failed", "cancelled"];

// The board's real shapes, no wider (Security): a card id is 1 to 5 lowercase words joined by "-", 40 characters at most
// (today's longest is 29); a role one word; a phase one lowercase word. None fits a sentence.
const BOARD_ID = /^[A-Za-z0-9-]{1,64}$/;
export const CARD_ID = /^[a-z0-9]{1,16}(?:-[a-z0-9]{1,16}){0,4}$/;
export const CARD_ID_MAX = 40;
export const ROLE = /^[A-Za-z][A-Za-z0-9]{1,23}$/;
const PHASE = /^[a-z]{2,16}$/;
const SHA12 = /^[0-9a-f]{12}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
// A time in ms: a whole number from 2020 to 2100.
const isTime = (v) => Number.isInteger(v) && v >= 1577836800000 && v <= 4102444800000;
const nullOr = (test) => (v) => v === null || test(v);
const re = (r) => (v) => typeof v === "string" && r.test(v);
const isId = (v) => re(CARD_ID)(v) && v.length <= CARD_ID_MAX;

// lastWriteAt (#C452): the board db's newest write the gate journaled, so the page can tell its own data is behind.
const BOARD = { boardId: re(BOARD_ID), at: isTime, probe: nullOr(re(SHA12)), pageVersion: nullOr(re(SHA12)), lastWriteAt: nullOr(isTime) };
// Keys a record may leave out (#C452's lastWriteAt: a reading from a probe before it still fits); one that is there is
// checked like any other.
const OPTIONAL = new Set(["lastWriteAt"]);
const CARD = {
  num: nullOr((v) => Number.isInteger(v) && v >= 1 && v <= 1e6),
  phase: nullOr(re(PHASE)),
  headSha12: nullOr(re(SHA12)),
  signed: (v) => Array.isArray(v) && v.length <= MAX_SIGNED && v.every(re(PHASE)) && new Set(v).size === v.length,
  onMain: (v) => typeof v === "boolean",
  ci: (v) => CI_STATES.includes(v),
  ciMin: nullOr((v) => Number.isInteger(v) && v >= 0 && v <= 10000),
  liveVersion: nullOr(re(VERSION)),
  at: isTime,
};
const AGENT = {
  state: (v) => AGENT_STATES.includes(v),
  lastActivityAt: nullOr(isTime),
  tool: nullOr((v) => TOOLS.includes(v) || v === "mcp" || v === "other"),
  card: nullOr(isId),
  since: nullOr(isTime),
};

// One record against its fields: exactly those keys, each value passing. The errors name only the schema's own words.
function fields(at, rec, spec, errs) {
  if (!plain(rec)) { errs.push(`${at}: not an object`); return; }
  for (const k of Object.keys(rec)) if (!Object.hasOwn(spec, k)) errs.push(`${at}: a key that isn't in the plan`);
  for (const [k, ok] of Object.entries(spec)) if (!Object.hasOwn(rec, k)) { if (!OPTIONAL.has(k)) errs.push(`${at}.${k}: missing`); } else if (!ok(rec[k])) errs.push(`${at}.${k}: not allowed`);
}

// The problems with a state, as fixed strings (a card id or a role only once it passed its pattern); [] when it fits.
export function stateErrors(s) {
  const errs = [];
  if (!plain(s)) return ["the state: not an object"];
  for (const k of Object.keys(s)) if (!["v", "board", "cards", "agents"].includes(k)) errs.push("the state: a key that isn't in the plan");
  if (s.v !== STATE_VERSION) errs.push("v: not 1");
  fields("board", s.board, BOARD, errs);
  for (const [name, max, keyOk, spec] of [["cards", MAX_CARDS, isId, CARD], ["agents", MAX_AGENTS, re(ROLE), AGENT]]) {
    const m = s[name];
    if (!plain(m)) { errs.push(`${name}: not an object`); continue; }
    const keys = Object.keys(m);
    if (keys.length > max) errs.push(`${name}: more than ${max}`);
    for (const k of keys.slice(0, max)) {
      if (!keyOk(k)) { errs.push(`${name}: a key that isn't an id`); continue; }
      fields(`${name}.${k}`, m[k], spec, errs);
    }
  }
  return errs;
}

// A reading the board counts (board-state-probe's follow-up): it fits, and is under LIVE_FRESH_MS old (at most a minute
// ahead of this clock). The Collector and the gate both read state.json through this; the page keeps a copy (liveOn).
export const LIVE_FRESH_MS = 3 * 60e3;
export const liveFresh = (s, now) => !stateErrors(s).length && now - s.board.at < LIVE_FRESH_MS && s.board.at - now <= 60e3;
// Building by the live state (#C449): the card's branch has a commit beyond main, or an agent is working on it. Its
// status is derived from this, never typed; the typed one counts only without a fresh reading. The page keeps a copy
// (liveBuilding); the gate refuses status "queued" on a card this says is building.
export function buildingNow(s, id) {
  if (!plain(s) || !plain(s.cards) || !plain(s.agents)) return false;
  const c = Object.hasOwn(s.cards, id) ? s.cards[id] : null;
  if (plain(c) && SHA12.test(c.headSha12 ?? "") && c.onMain === false) return true;
  return Object.values(s.agents).some((a) => plain(a) && a.state === "working" && a.card === id);
}
// The roles working on a card now, the lead aside (it reads every card; it builds none).
export function workersOn(s, id, lead) {
  if (!plain(s) || !plain(s.agents)) return [];
  return Object.keys(s.agents).filter((n) => n !== lead && plain(s.agents[n]) && s.agents[n].state === "working" && s.agents[n].card === id).sort();
}
// No typed field outranks the live state (#C449): the typed fields of a card's progress that a fresh reading
// contradicts, as [{ field, typed, live }] (live: what the board shows instead; null: the field is hidden). The page
// keeps a copy (typedClashes) to show the live value with a small "typed: …" note; the Collector tells the lead when one
// holds over 5 min (nudge 8). status: queued while building. phase: not the repository's. who: someone else is on it
// at or before build. waitingOn: a wait while building at or before build.
export function typedClashes(card, s, config) {
  if (!plain(card) || typeof card.id !== "string" || !plain(s) || !plain(s.cards)) return [];
  const id = card.id, out = [], order = (config.phases ?? []).map((p) => p[0]), build = order.indexOf(config.collector.buildPhase);
  const c = Object.hasOwn(s.cards, id) && plain(s.cards[id]) && SHA12.test(s.cards[id].headSha12 ?? "") && order.includes(s.cards[id].phase) ? s.cards[id] : null;
  const phase = c ? c.phase : card.phase, early = order.indexOf(phase) <= build, building = buildingNow(s, id);
  if (card.status === "queued" && building) out.push({ field: "status", typed: "queued", live: "building" });
  if (c && typeof card.phase === "string" && card.phase && card.phase !== c.phase) out.push({ field: "phase", typed: card.phase, live: c.phase });
  const on = workersOn(s, id, config.gate?.managerRole);
  if (early && typeof card.who === "string" && card.who && on.length && !on.includes(card.who)) out.push({ field: "who", typed: card.who, live: on[0] });
  if (early && building && typeof card.waitingOn === "string" && card.waitingOn.trim()) out.push({ field: "waitingOn", typed: card.waitingOn, live: null });
  return out;
}

// A fresh copy of a state that fits, built field by field from the schema (nothing else in the input is carried over),
// or null when it doesn't fit.
export function pickState(s) {
  if (stateErrors(s).length) return null;
  const take = (rec, spec) => Object.fromEntries(Object.keys(spec).filter((k) => Object.hasOwn(rec, k)).map((k) => [k, Array.isArray(rec[k]) ? [...rec[k]] : rec[k]]));
  const map = (m, spec) => Object.fromEntries(Object.keys(m).sort().map((k) => [k, take(m[k], spec)]));
  return { v: STATE_VERSION, board: take(s.board, BOARD), cards: map(s.cards, CARD), agents: map(s.agents, AGENT) };
}
