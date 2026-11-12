// What leaves the Studio for the board's state Worker (#C420, Security's data plan): an allowlist, checked at both ends.
// collector/state.mjs builds a state, checks it here and POSTs it; worker/state-worker.mjs checks every POST here again
// and its MCP tool, board_state, answers only pickState() of what it stored, never the stored text itself.
// Ids, enums, numbers and fixed strings only: no free text from a transcript, a session title or a commit message ever
// fits a field, and an error never quotes what it refused (a key it doesn't know is "a key that isn't in the plan").
//
//   { v: 1,
//     board:  { boardId, at, probe, pageVersion, lastWriteAt?, wakeAliveAt?, wakeSeenAt?, cardsCheckedAt?, evidenceAt?, derivedAt?, quietMin? },
//   derivedAt (#C711): when the Collector's set of derived/all last went through (the fence's marker); quietMin: the minutes of its
//   schedule (8 am to 8 pm Mountain time) since then, the page's chip going red past 75. Both optional: a probe before it leaves them out.
//     cards:  { <card id>: { num, phase, headSha12, signed, onMain, ci, ciMin, liveVersion, shipping?, seen?, branches?, at } },
//     agents: { <role>: { state, lastActivityAt, tool, card, since, by? } } }   by (#C633, optional): "title" when the role's
//             session was found by its title because the config holds no session id for it

export const STATE_VERSION = 1;
// A POST's body at most (the Worker refuses a longer one before reading it).
export const MAX_BYTES = 65536;
export const MAX_CARDS = 200, MAX_AGENTS = 40, MAX_SIGNED = 10, MAX_BRANCHES = 6;

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
const BOARD = { boardId: re(BOARD_ID), at: isTime, probe: nullOr(re(SHA12)), pageVersion: nullOr(re(SHA12)), lastWriteAt: nullOr(isTime), wakeAliveAt: nullOr(isTime), wakeSeenAt: nullOr(isTime), cardsCheckedAt: nullOr(isTime), evidenceAt: nullOr(isTime), derivedAt: nullOr(isTime), quietMin: nullOr((v) => Number.isInteger(v) && v >= 0 && v <= 100000) };
// Keys a record may leave out (#C452's lastWriteAt: a reading from a probe before it still fits); one that is there is
// checked like any other. #C590: wakeAliveAt is the wake watch's heartbeat time, wakeSeenAt the last wake it handled:
// times only, for the page's "Manager listening" chip.
// #C617: a card's shipping flag (a GitHub run titled "vX: <branch>@<sha>" is running for its tip); a probe from before it
// leaves it out, and a state with it still fits.
// #C620: seen is the phases the repository shows evidence of (a commit, a CI run, a sign-off, main, a deploy); optional too.
// #C621: branches is one record per branch tip of a card that has two or more (name: the branch's last path segment, as a card
// id would be; the rest as the card's own fields, read from that tip alone), so a page draws one row per branch and never
// lights two phases in one row. The card's own fields stay those of its newest tip; a probe before it leaves branches out.
const OPTIONAL = new Set(["lastWriteAt", "wakeAliveAt", "wakeSeenAt", "cardsCheckedAt", "evidenceAt", "derivedAt", "quietMin", "shipping", "asOf", "seen", "by", "branches", "readyAt", "firm", "waitingFor", "workSeen", "shippedAt", "reviews", "findings", "weekTotal", "stack", "stackHold", "behindMain", "headSha", "headBranch", "repoFull", "noInstall", "packed", "installed"]);
// #C591: cardsCheckedAt is the last time every repository was read fresh; the chip goes red 5 minutes after it.
const CARD = {
  num: nullOr((v) => Number.isInteger(v) && v >= 1 && v <= 1e6),
  phase: nullOr(re(PHASE)),
  headSha12: nullOr(re(SHA12)),
  // #C895: what a DISPATCH line names so a reader can find the commit without asking: the head's full sha, the branch it is on (main for a
  // card read from main) and the repository (owner/name). Optional: a probe from before them still fits.
  headSha: re(/^[0-9a-f]{40}$/),
  headBranch: (v) => typeof v === "string" && /^[A-Za-z0-9._\/-]{1,100}$/.test(v) && !v.startsWith("-"),
  repoFull: re(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/),
  signed: (v) => Array.isArray(v) && v.length <= MAX_SIGNED && v.every(re(PHASE)) && new Set(v).size === v.length,
  onMain: (v) => typeof v === "boolean",
  ci: (v) => CI_STATES.includes(v),
  ciMin: nullOr((v) => Number.isInteger(v) && v >= 0 && v <= 10000),
  liveVersion: nullOr(re(VERSION)),
  shipping: (v) => typeof v === "boolean",
  seen: (v) => Array.isArray(v) && v.length <= MAX_SIGNED + 4 && v.every(re(PHASE)) && new Set(v).size === v.length,
  // #C731 B4b: the readings the old page's ETA and review lines need. readyAt: the READY commit's time; firm: false when the
  // evidence is only a head with no trailer or sign-off yet (never written as true); waitingFor: the reviews still unsigned on
  // the READY commit, in phase order. Optional: a probe from before them still fits.
  readyAt: isTime,
  firm: (v) => v === false,
  waitingFor: (v) => Array.isArray(v) && v.length >= 1 && v.length <= MAX_SIGNED && v.every(re(PHASE)) && new Set(v).size === v.length,
  // #C852: the reviews whose note on the READY commit starts "FINDINGS" (sent back, not signed). Only ever on a tip still in review.
  findings: (v) => Array.isArray(v) && v.length >= 1 && v.length <= MAX_SIGNED && v.every(re(PHASE)) && new Set(v).size === v.length,
  // #C854: a tip waiting at ship that does not continue main (only ever true): it goes back to its builder to re-cut.
  behindMain: (v) => v === true,
  // #C882: a landing that changed no deployed or pinned file (only docs and tests) needs no install: the card reads Live. Only ever true.
  noInstall: (v) => v === true,
  // #C1020: a board card on main whose landing a deploy pair holds (packed), and whose pair's deploy ran (installed). Only ever true; read from the
  // pair folder's files and git, never from words.
  packed: (v) => v === true,
  installed: (v) => v === true,
  // #C731 B4b slice 3: workSeen (only ever true: a commit on main cites the card, so a build start is not "no work seen"),
  // shippedAt (when a ship commit on main naming the card landed), reviews ({ phase: ms }: when each signed review was signed,
  // from the notes ref's history). Optional.
  workSeen: (v) => v === true,
  shippedAt: isTime,
  reviews: (v) => plain(v) && Object.keys(v).length >= 1 && Object.keys(v).length <= MAX_SIGNED && Object.entries(v).every(([p, t]) => PHASE.test(p) && isTime(t)),
  branches: (v) => Array.isArray(v) && v.length >= 2 && v.length <= MAX_BRANCHES,
  // #C859 slice 2: where the card stands in its repository's stack, read from git (collector/stack.mjs): { tip, size } for a card under the
  // stack tip (a stack of two or more), or { outside: true } for a card not cut from it. Only for a repository whose stack switch is on.
  // branch (optional) is the stack's branch: the builder's wake names it, an outsider is told which tip to cut from.
  stack: (v) => plain(v) && Object.keys(v).every((k) => ["tip", "tipSha", "size", "branch", "outside"].includes(k))
    && (v.tipSha === undefined || (/^[0-9a-f]{40}$/.test(String(v.tipSha)) && v.outside === undefined && String(v.tipSha).startsWith(String(v.tip))))
    && (v.branch === undefined || (typeof v.branch === "string" && /^[A-Za-z0-9._\/-]{1,100}$/.test(v.branch) && !v.branch.startsWith("-")))
    && ((v.outside === true && v.tip === undefined && v.size === undefined) || (v.outside === undefined && SHA12.test(v.tip) && Number.isInteger(v.size) && v.size >= 2 && v.size <= MAX_CARDS)),
  // #C914: true only: the card is pushed, in a stack-mode repository, and no stack-ready signal covers its head. The probe's fact; the dispatch
  // decides from it whether a card with a declared stack partner waits. The page never reads it.
  stackHold: (v) => v === true,
  at: isTime,
};
const { num: _n, at: _a, branches: _b, stack: _s, stackHold: _h, ...BRANCH_FIELDS } = CARD;
const BRANCH = { name: isId, ...BRANCH_FIELDS };
const AGENT = {
  state: (v) => AGENT_STATES.includes(v),
  lastActivityAt: nullOr(isTime),
  tool: nullOr((v) => TOOLS.includes(v) || v === "mcp" || v === "other"),
  card: nullOr(isId),
  since: nullOr(isTime),
  by: (v) => v === "title",
};

// The probe's own readings, numbers and enums only (#C592, #C593, #C595); a state from a probe before them still fits.
//   ctx:   { <role>: { pct, tokens, at, over } }     each role's context from its transcript's usage fields; over: past resetAt
//   stuck: { <role>: { kind, card, since } }          a role stuck on one step, or waiting on the owner (kind: step | user)
//   usage: { at, asOf?, weekPct, pace, level, top: [{ src, pct }] }   pace in hundredths (130 = 1.3x); src a role, "scheduled" or "other";
//          asOf (#C623, optional): when the spend script last ran, the time the numbers are of (at is the probe's clock)
//          weekTotal (#C842, optional): the week's weighted total from the spend script, a whole number; shown when weekPct is null (not calibrated)
//   ship (#C679, optional): { version, ci, at } a ship candidate branch (collector.candidatePattern, "build/ship-v1.2.3") is pushed and not
//          on main yet: version its number or null, ci its CI run (none | queued | running | passed), at the branch tip's time.
//          The page's "Safe to restart" badge is never green while it is there. A probe before it leaves the key out.
//   releases (#C731 B4b, optional): { "x.y.z": { testsMin, deployMin } } the newest versions' CI times from the release log on main
//          (collector.releaseTimes), minutes as numbers, at most MAX_RELEASES versions; the page's ETA box reads them.
//   closedPacks (#C1034, optional): { <card id>: { packed: true, installed?: true } } board cards done in the last 14 days whose landing a
//          deploy pair holds (installed: that pair ran), from the pair folder and git only, at most MAX_CARDS. Only the page's Pack and
//          Install tiles read it; no card's status, phase or note is in it.
export const EXTRA_KEYS = ["ctx", "stuck", "usage", "ship", "releases", "closedPacks"];
const CLOSED_PACK = { packed: (v) => v === true, installed: (v) => v === true };
export const MAX_RELEASES = 100;
const RELEASE = { testsMin: (v) => Number.isFinite(v) && v >= 0 && v <= 100000, deployMin: (v) => Number.isFinite(v) && v >= 0 && v <= 100000 };
export const SHIP_CI = ["none", "queued", "running", "passed"];
export const STUCK_KINDS = ["step", "user"], USAGE_LEVELS = ["ok", "amber", "red"], MAX_TOP = 5;
const whole = (lo, hi) => (v) => Number.isInteger(v) && v >= lo && v <= hi;
const CTX = { pct: whole(0, 100), tokens: nullOr(whole(0, 5e6)), at: isTime, over: (v) => typeof v === "boolean" };
const STUCK = { kind: (v) => STUCK_KINDS.includes(v), card: nullOr(isId), since: isTime };
const USAGE = { at: isTime, asOf: isTime, weekTotal: whole(0, 1e12), weekPct: nullOr(whole(0, 1000)), pace: nullOr(whole(0, 10000)), level: (v) => USAGE_LEVELS.includes(v), top: (v) => Array.isArray(v) && v.length <= MAX_TOP };
const USAGE_TOP = { src: re(ROLE), pct: whole(0, 100) };
const SHIP = { version: nullOr(re(VERSION)), ci: (v) => SHIP_CI.includes(v), at: isTime };

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
  for (const k of Object.keys(s)) if (!["v", "board", "cards", "agents", ...EXTRA_KEYS].includes(k)) errs.push("the state: a key that isn't in the plan");
  if (s.v !== STATE_VERSION) errs.push("v: not 1");
  fields("board", s.board, BOARD, errs);
  for (const [name, spec] of [["ctx", CTX], ["stuck", STUCK]]) {
    if (!Object.hasOwn(s, name)) continue;
    if (!plain(s[name])) { errs.push(`${name}: not an object`); continue; }
    const keys = Object.keys(s[name]);
    if (keys.length > MAX_AGENTS) errs.push(`${name}: more than ${MAX_AGENTS}`);
    for (const k of keys.slice(0, MAX_AGENTS)) {
      if (!re(ROLE)(k)) { errs.push(`${name}: a key that isn't a role`); continue; }
      fields(`${name}.${k}`, s[name][k], spec, errs);
    }
  }
  if (Object.hasOwn(s, "ship")) fields("ship", s.ship, SHIP, errs);
  if (Object.hasOwn(s, "releases")) {
    if (!plain(s.releases)) errs.push("releases: not an object");
    else {
      const keys = Object.keys(s.releases);
      if (keys.length > MAX_RELEASES) errs.push(`releases: more than ${MAX_RELEASES}`);
      for (const k of keys.slice(0, MAX_RELEASES)) { if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(k)) { errs.push("releases: a key that isn't a version"); continue; } fields(`releases.${k}`, s.releases[k], RELEASE, errs); }
    }
  }
  if (Object.hasOwn(s, "closedPacks")) {
    if (!plain(s.closedPacks)) errs.push("closedPacks: not an object");
    else {
      const keys = Object.keys(s.closedPacks);
      if (keys.length > MAX_CARDS) errs.push(`closedPacks: more than ${MAX_CARDS}`);
      for (const k of keys.slice(0, MAX_CARDS)) {
        if (!isId(k)) { errs.push("closedPacks: a key that isn't an id"); continue; }
        fields(`closedPacks.${k}`, s.closedPacks[k], CLOSED_PACK, errs);
        if (plain(s.closedPacks[k]) && s.closedPacks[k].packed !== true) errs.push(`closedPacks.${k}.packed: missing`);
      }
    }
  }
  if (Object.hasOwn(s, "usage")) {
    fields("usage", s.usage, USAGE, errs);
    const top = plain(s.usage) && Array.isArray(s.usage.top) ? s.usage.top : [];
    top.forEach((t, k) => fields(`usage.top.${k}`, t, USAGE_TOP, errs));
  }
  for (const [name, max, keyOk, spec] of [["cards", MAX_CARDS, isId, CARD], ["agents", MAX_AGENTS, re(ROLE), AGENT]]) {
    const m = s[name];
    if (!plain(m)) { errs.push(`${name}: not an object`); continue; }
    const keys = Object.keys(m);
    if (keys.length > max) errs.push(`${name}: more than ${max}`);
    for (const k of keys.slice(0, max)) {
      if (!keyOk(k)) { errs.push(`${name}: a key that isn't an id`); continue; }
      fields(`${name}.${k}`, m[k], spec, errs);
      if (name === "cards" && plain(m[k]) && Array.isArray(m[k].branches)) {
        m[k].branches.slice(0, MAX_BRANCHES).forEach((b, n) => fields(`cards.${k}.branches.${n}`, b, BRANCH, errs));
        if (new Set(m[k].branches.map((b) => b?.name)).size !== m[k].branches.length) errs.push(`cards.${k}.branches: a name twice`);
      }
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
// A card's reading in a fresh live state (#C567): { phase, headSha12, onMain } when the state lists it with a head and a
// phase the config names, else null. The gate takes it over the Collector's last export for "done": the export is only
// as new as its run (an hour at most), the state's reading under LIVE_FRESH_MS.
export function liveCard(s, id, config) {
  if (!plain(s) || !plain(s.cards) || !Object.hasOwn(s.cards, id)) return null;
  const c = s.cards[id];
  if (!plain(c) || !SHA12.test(c.headSha12 ?? "") || !(config.phases ?? []).some((p) => p[0] === c.phase)) return null;
  return { phase: c.phase, headSha12: c.headSha12, onMain: c.onMain === true };
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
  const take = (rec, spec) => Object.fromEntries(Object.keys(spec).filter((k) => Object.hasOwn(rec, k)).map((k) => [k, Array.isArray(rec[k]) ? [...rec[k]] : plain(rec[k]) ? { ...rec[k] } : rec[k]]));
  const map = (m, spec) => Object.fromEntries(Object.keys(m).sort().map((k) => [k, take(m[k], spec)]));
  const cards = map(s.cards, CARD);
  for (const [k, c] of Object.entries(cards)) if (Array.isArray(c.branches)) c.branches = s.cards[k].branches.map((b) => take(b, BRANCH));
  const out = { v: STATE_VERSION, board: take(s.board, BOARD), cards, agents: map(s.agents, AGENT) };
  if (Object.hasOwn(s, "ctx")) out.ctx = map(s.ctx, CTX);
  if (Object.hasOwn(s, "stuck")) out.stuck = map(s.stuck, STUCK);
  if (Object.hasOwn(s, "ship")) out.ship = take(s.ship, SHIP);
  if (Object.hasOwn(s, "releases")) out.releases = Object.fromEntries(Object.keys(s.releases).sort().map((k) => [k, take(s.releases[k], RELEASE)]));
  if (Object.hasOwn(s, "usage")) out.usage = { ...take(s.usage, USAGE), top: s.usage.top.map((t) => take(t, USAGE_TOP)) };
  if (Object.hasOwn(s, "closedPacks")) out.closedPacks = map(s.closedPacks, CLOSED_PACK);
  return out;
}
