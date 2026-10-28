// What leaves the Studio for the board's state Worker (#C420, Security's data plan): an allowlist, checked at both ends.
// collector/state.mjs builds a state, checks it here and POSTs it; worker/state-worker.mjs checks every POST here again
// and its MCP tool, board_state, answers only pickState() of what it stored, never the stored text itself.
// Ids, enums, numbers and fixed strings only: no free text from a transcript, a session title or a commit message ever
// fits a field, and an error never quotes what it refused (a key it doesn't know is "a key that isn't in the plan").
//
//   { v: 1,
//     board:  { boardId, at, probe, pageVersion },
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

const BOARD = { boardId: re(BOARD_ID), at: isTime, probe: nullOr(re(SHA12)), pageVersion: nullOr(re(SHA12)) };
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
  for (const [k, ok] of Object.entries(spec)) if (!Object.hasOwn(rec, k)) errs.push(`${at}.${k}: missing`); else if (!ok(rec[k])) errs.push(`${at}.${k}: not allowed`);
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

// A fresh copy of a state that fits, built field by field from the schema (nothing else in the input is carried over),
// or null when it doesn't fit.
export function pickState(s) {
  if (stateErrors(s).length) return null;
  const take = (rec, spec) => Object.fromEntries(Object.keys(spec).map((k) => [k, Array.isArray(rec[k]) ? [...rec[k]] : rec[k]]));
  const map = (m, spec) => Object.fromEntries(Object.keys(m).sort().map((k) => [k, take(m[k], spec)]));
  return { v: STATE_VERSION, board: take(s.board, BOARD), cards: map(s.cards, CARD), agents: map(s.agents, AGENT) };
}
