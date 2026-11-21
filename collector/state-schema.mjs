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
//             session was found by its title because the config holds no session id for it; "spawn" (#C970) when it is not on the roster at all
//             but is an open session the lead started whose title is a roster role name plus optional digits ("Checker 2" is Checker2)

export const STATE_VERSION = 1;
// #C864 step 2a: the file the old fence marked a Collector publish in (collector/export.mjs keeps its own copy: it imports nothing;
// tests/live-probe-imports.test.mjs holds the two equal). The probe reads it for the "Collector has not published" chip.
export const PUBLISHED_FILE = "derived-published.json";
// #C999: the store's cards as the evidence job leaves them for the probe ({ at, cards: { <id>: <card> } }), in the probe's own folder.
export const STORE_CARDS_FILE = "store-cards.json";
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
// #C1395: "none" is only "no run exists on the commit"; "backoff" and "capped" are a call not made (GitHub's back-off, the call limit) and "unread" a call that failed (never "failed": that is the run's own result).
export const CI_STATES = ["none", "backoff", "capped", "unread", "queued", "running", "passed", "failed", "cancelled"];

// The board's real shapes, no wider (Security): a card id is 1 to 5 lowercase words joined by "-", 40 characters at most
// (today's longest is 29); a role one word; a phase one lowercase word. None fits a sentence.
const BOARD_ID = /^[A-Za-z0-9-]{1,64}$/;
export const CARD_ID = /^[a-z0-9]{1,16}(?:-[a-z0-9]{1,16}){0,4}$/;
export const CARD_ID_MAX = 40;
// #C1117: a role name may hold single spaces between words or digits ("Checker 2"), as the roster and the store's rules already name it: 2 to 24 characters in all.
export const ROLE = /^(?=.{2,24}$)[A-Za-z][A-Za-z0-9]*(?: [A-Za-z0-9]+)*$/;
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
const OPTIONAL = new Set(["lastWriteAt", "wakeAliveAt", "wakeSeenAt", "cardsCheckedAt", "evidenceAt", "derivedAt", "quietMin", "shipping", "asOf", "seen", "by", "branches", "readyAt", "headAt", "firm", "waitingFor", "partsMissing", "workSeen", "shippedAt", "reviews", "findings", "issueCounts", "issueBase", "tipIssues", "customerText", "weekTotal", "stack", "stackHold", "builtWaiting", "rcOff", "behindMain", "wipHead", "trailerMisplaced", "headSha", "headBranch", "repoFull", "noInstall", "packed", "installed", "pack", "restart", "ledger", "quiet", "stale", "staleSince", "unread"]);
// #C1387: the sources a card's reading can fail to read (a git or GitHub call that failed, which is not the answer "no"). A new source is one word added here (and to UNKNOWN_BY in worker/reading.mjs
// when the phase rests on it); #C1395 adds notes, install, pair (each a source a phase rests on: the Worker reads them as unknown) and ci (a flag: the card's own ci word and the ship tile say it).
export const UNREAD_SOURCES = ["main", "deploy", "version", "stack", "start", "behind", "notes", "install", "pair", "ci"];
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
  // #C1396: the head commit's time, whatever the phase (readyAt is absent at build); the Worker's stuck rule reads it.
  headAt: isTime,
  firm: (v) => v === false,
  waitingFor: (v) => Array.isArray(v) && v.length >= 1 && v.length <= MAX_SIGNED && v.every(re(PHASE)) && new Set(v).size === v.length,
  // #C890: the commits cited in the card's next_note (7 to 40 hex characters, as the note wrote them) that are not on the repository's main; the card is not read as live while any is.
  partsMissing: (v) => Array.isArray(v) && v.length >= 1 && v.length <= 10 && v.every((s) => typeof s === "string" && /^[0-9a-f]{7,40}$/.test(s)) && new Set(v).size === v.length,
  // #C852: the reviews whose note on the READY commit starts "FINDINGS" (sent back, not signed). Only ever on a tip still in review.
  findings: (v) => Array.isArray(v) && v.length >= 1 && v.length <= MAX_SIGNED && v.every(re(PHASE)) && new Set(v).size === v.length,
  // #C1114: the findings the reviews put on the branch's commits, by kind (collector/findings-count.mjs); the Worker raises the card's counters to these.
  issueCounts: (v) => plain(v) && Object.keys(v).length >= 1 && Object.entries(v).every(([k, n]) => ["bugs", "security", "language", "design"].includes(k) && Number.isInteger(n) && n >= 1 && n <= 99),
  // #C1397: the merge-base of main and the tip (the start of the range issueCounts was counted over); when it changes the Worker sets the card's counters to the new range's counts instead of only raising them.
  issueBase: re(/^[0-9a-f]{40}$/),
  // #C1406: the OPEN findings on the card's current tip alone (its notes and the covering tip's), by kind; {} when there are none. The Worker sets the card's four review counters to these on every reading
  // (a per-tip record: a note that later reads PASS, or a new tip with no findings, takes the count down), where issueCounts above sums every commit of the branch.
  tipIssues: (v) => plain(v) && Object.entries(v).every(([k, n]) => ["bugs", "security", "language", "design"].includes(k) && Number.isInteger(n) && n >= 1 && n <= 99),
  // #C1110: the branch touches the repository's customer-text paths (only ever true); the Worker sets the card's customer_text and never clears it.
  customerText: (v) => v === true,
  // #C854: a tip waiting at ship that does not continue main (only ever true): it goes back to its builder to re-cut.
  behindMain: (v) => v === true,
  // #C1377: this card's repository could not be read fresh this run (only ever true), and the time it last was (staleSince, optional); the page greys the card and says "no fresh reading since ...".
  stale: (v) => v === true,
  staleSince: isTime,
  // #C1387: the sources this card's reading could not read this run (a failed call is never "no"); the Worker reads the ones the phase rests on as `unknown`. Only present when not empty.
  unread: (v) => Array.isArray(v) && v.length >= 1 && v.length <= UNREAD_SOURCES.length && v.every((s) => UNREAD_SOURCES.includes(s)) && new Set(v).size === v.length,
  trailerMisplaced: (v) => v === true, // #C1239: the tip names the card in a Board-Id line git does not read as a trailer
  wipHead: (v) => v === true, // #C1139: the newest commit says WIP: no review turn
  // #C882: a landing that changed no deployed or pinned file (only docs and tests) needs no install: the card reads Live. Only ever true.
  noInstall: (v) => v === true,
  // #C1020: a board card on main whose landing a deploy pair holds (packed), and whose pair's deploy ran (installed). Only ever true; read from the
  // pair folder's files and git, never from words.
  packed: (v) => v === true,
  installed: (v) => v === true,
  // #C1309: the number of the oldest pair that holds the landing (the pack it first rode in), 1 to 999999; the page names it on the Install tile.
  pack: (v) => Number.isInteger(v) && v >= 1 && v < 1e6,
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
  builtWaiting: (v) => v === true,
  at: isTime,
};
const { num: _n, at: _a, branches: _b, stack: _s, stackHold: _h, builtWaiting: _bw, ...BRANCH_FIELDS } = CARD;
const BRANCH = { name: isId, ...BRANCH_FIELDS };
const AGENT = {
  state: (v) => AGENT_STATES.includes(v),
  lastActivityAt: nullOr(isTime),
  tool: nullOr((v) => TOOLS.includes(v) || v === "mcp" || v === "other"),
  card: nullOr(isId),
  since: nullOr(isTime),
  by: (v) => v === "title" || v === "spawn",
  // #C1122: true only: the role's session has its Remote Control switch turned off (the app's session file says so). Left out otherwise.
  rcOff: (v) => v === true,
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
//   watch (#C1005 part c, optional): what the old stuck-agent watchdog task told Manager, as numbers and words from the schema only, written only on the run
//          that has something: { at, restart?: true, ledger?: { prompts: [{ role, tool, n }], others }, quiet?: { since, days, running } }.
//          restart: the app restarted (every session the probe knew is gone); ledger: the permission prompts and other notifications the prompt ledger
//          gained since the last run, counted by role and tool (never a command or a message); quiet: the ledger had no line for a day while `running`
//          agents worked (since: the newest line's time, null for none; days: whole days). The store turns them into stall wakes for Manager.
export const EXTRA_KEYS = ["ctx", "stuck", "usage", "ship", "releases", "watch"];
export const MAX_WATCH_PROMPTS = 12;
const WATCH = { at: isTime, restart: (v) => v === true, ledger: (v) => plain(v), quiet: (v) => plain(v) };
const WATCH_LEDGER = { prompts: (v) => Array.isArray(v) && v.length <= MAX_WATCH_PROMPTS, others: (v) => Number.isInteger(v) && v >= 0 && v <= 1e6 };
const WATCH_PROMPT = { role: re(ROLE), tool: re(/^[A-Za-z][A-Za-z0-9_.:-]{0,47}$/), n: (v) => Number.isInteger(v) && v >= 1 && v <= 1e6 };
const WATCH_QUIET = { since: nullOr(isTime), days: nullOr((v) => Number.isInteger(v) && v >= 0 && v <= 36500), running: (v) => Number.isInteger(v) && v >= 1 && v <= 1000 };
export const MAX_RELEASES = 100;
const RELEASE = { testsMin: (v) => Number.isFinite(v) && v >= 0 && v <= 100000, deployMin: (v) => Number.isFinite(v) && v >= 0 && v <= 100000 };
export const SHIP_CI = ["none", "backoff", "capped", "unread", "queued", "running", "passed"]; // #C1395: the three reasons no run shows, beside "no run exists"
export const STUCK_KINDS = ["step", "user"], USAGE_LEVELS = ["ok", "amber", "red"], MAX_TOP = 5;
const whole = (lo, hi) => (v) => Number.isInteger(v) && v >= lo && v <= hi;
const CTX = { pct: whole(0, 100), tokens: nullOr(whole(0, 5e6)), at: isTime, over: (v) => typeof v === "boolean" };
const STUCK = { kind: (v) => STUCK_KINDS.includes(v), card: nullOr(isId), since: isTime };
const USAGE = { at: isTime, asOf: isTime, weekTotal: whole(0, 1e12), weekPct: nullOr(whole(0, 1000)), pace: nullOr(whole(0, 10000)), level: (v) => USAGE_LEVELS.includes(v), top: (v) => Array.isArray(v) && v.length <= MAX_TOP };
// A usage source stays ONE word (a role without a space, "scheduled" or "other"): free text must not become a key or a label (#C1117 widened ROLE, not this).
const USAGE_TOP = { src: re(/^[A-Za-z][A-Za-z0-9]{1,23}$/), pct: whole(0, 100) };
// #C1377: stale (only ever true) and staleSince mark a candidate read from a repository that was not read fresh this run, as a card's reading is marked.
const SHIP = { version: nullOr(re(VERSION)), ci: (v) => SHIP_CI.includes(v), at: isTime, stale: (v) => v === true, staleSince: isTime };

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
  if (Object.hasOwn(s, "watch")) {
    fields("watch", s.watch, WATCH, errs);
    if (plain(s.watch)) {
      if (!Object.hasOwn(s.watch, "at")) errs.push("watch.at: missing");
      if (plain(s.watch.ledger)) {
        fields("watch.ledger", s.watch.ledger, WATCH_LEDGER, errs);
        (Array.isArray(s.watch.ledger.prompts) ? s.watch.ledger.prompts.slice(0, MAX_WATCH_PROMPTS) : []).forEach((p, n) => fields(`watch.ledger.prompts.${n}`, p, WATCH_PROMPT, errs));
      }
      if (plain(s.watch.quiet)) fields("watch.quiet", s.watch.quiet, WATCH_QUIET, errs);
    }
  }
  if (Object.hasOwn(s, "releases")) {
    if (!plain(s.releases)) errs.push("releases: not an object");
    else {
      const keys = Object.keys(s.releases);
      if (keys.length > MAX_RELEASES) errs.push(`releases: more than ${MAX_RELEASES}`);
      for (const k of keys.slice(0, MAX_RELEASES)) { if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(k)) { errs.push("releases: a key that isn't a version"); continue; } fields(`releases.${k}`, s.releases[k], RELEASE, errs); }
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
  if (Object.hasOwn(s, "watch")) {
    out.watch = take(s.watch, WATCH);
    if (plain(s.watch.ledger)) out.watch.ledger = { prompts: s.watch.ledger.prompts.map((p) => take(p, WATCH_PROMPT)), others: s.watch.ledger.others };
    if (plain(s.watch.quiet)) out.watch.quiet = take(s.watch.quiet, WATCH_QUIET);
  }
  if (Object.hasOwn(s, "releases")) out.releases = Object.fromEntries(Object.keys(s.releases).sort().map((k) => [k, take(s.releases[k], RELEASE)]));
  if (Object.hasOwn(s, "usage")) out.usage = { ...take(s.usage, USAGE), top: s.usage.top.map((t) => take(t, USAGE_TOP)) };
  return out;
}
