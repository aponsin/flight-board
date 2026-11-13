// board.config.json: everything particular to one team. The page, the gate, the collector and the nudges read it; nothing
// team-specific lives in this repository. checkConfig returns the problems, one line each; an empty list means it is good.
// #C897: a review path pattern (collector/review-paths.mjs reads it): a path relative to the repository, with * (any characters but /) and
// ** (any characters, / too). Kept here, with no import of a repository file, because pinned copies hold this file alone.
import { homedir } from "node:os";
// A config path with a leading ~ made absolute (#C864 step 2a: it lived in gate/gate.mjs, which the live probe should not import).
export const home = (p) => String(p).replace(/^~(?=\/|$)/, homedir());
export const REVIEW_PATTERN = /^[A-Za-z0-9_.*][A-Za-z0-9_.*\/-]{0,199}$/, MAX_REVIEW_PATTERNS = 200;
export function reviewPathsErrors(v, phaseKeys, at = "reviewPaths") {
  if (v === undefined || v === null) return [];
  if (typeof v !== "object" || Array.isArray(v)) return [`${at}: { phase: [path patterns] }`];
  const out = [];
  for (const [p, list] of Object.entries(v)) {
    if (!phaseKeys.includes(p)) out.push(`${at}.${p}: not one of the review phases`);
    if (!Array.isArray(list) || list.length > MAX_REVIEW_PATTERNS || !list.every((s) => typeof s === "string" && REVIEW_PATTERN.test(s) && !s.split("/").includes(".."))) out.push(`${at}.${p}: a list of up to ${MAX_REVIEW_PATTERNS} path patterns (letters, digits, . _ - / and *)`);
  }
  return out;
}
export const DEFAULTS = {
  title: "Flight Board",
  owner: "Owner",
  // #C1054: the board's id, the name of its state folder and what the gate matches a write against. Empty: the id in artifactUrl
  // (the old artifact board's link, optional now that the store is the board). Set it before artifactUrl is ever cleared.
  boardId: "",
  artifactUrl: "",
  // #C825: the board's address on the store (a plain https address, e.g. https://board.example.com/): the pointer hooks/manager-compact-board.py
  // gives Manager after a compaction. Empty: the hook says the link is not in its reach and asks the owner to paste it once.
  storeUrl: "",
  // The artifact's UUID (#C652): the claude-artifacts server's tools take it (or a whole link) as the slug, so the gate knows a
  // call on the board by it as well as by the id in artifactUrl. Empty: only calls naming the id or the link are the board's.
  artifactSlug: "",
  // An agent's context, in tokens, past which it is cued to reset (#C399, the owner's 600k in #T1038): the red-ask hook
  // reads it from this file, and the context keeper's prompt is filled with it ({{RESET_AT}}), so a new limit is a
  // config change, never a re-sign.
  resetAt: 400000,
  // #C672: a role's context window in tokens, when it is not the default 1,000,000 (Manager's 350,000, set by its
  // CLAUDE_CODE_AUTO_COMPACT_WINDOW). The red-ask hook (which asks the agent to write its memory tile), the probe and the Collector
  // work every role's percentage against this one number, so a tile never flips between two windows. { Role: tokens }.
  contextWindows: {},
  phases: [["plan", "Plan"], ["build", "Build"], ["test", "Test"], ["language", "Language"], ["checker", "Checker"], ["security", "Security"], ["ship", "Ship"], ["live", "Live"]],
  roster: ["Manager", "Builder", "Checker", "Security", "Release"],
  order: ["Manager", "Builder", "Checker", "Security", "Release"],
  // Each roster role's session id (#C633): the Collector finds a role's agent by it, never by the newest session with the
  // role's title. A role with no id here is found by title and the tile says so.
  rosterSessions: {},
  skips: [{ phase: "security", unlessLevel: "Full" }, { phase: "language", whenFalse: "customerText" }],
  boardStart: "",
  // The agent whose pull requests the owner approves from the board (#C554): its name, as the panel and its note say it.
  prAgent: "The agent",
  usageNote: "Runner and automation minutes come from the job-run times the scheduler reports.",
  runnerLabel: "Runners",
  automationLabel: "Automation",
  // The write gate (gate/): the lead role, item ids that are passing agent states (never items), the words that make a
  // reply a verdict, where the gate keeps its state and the board's mirror, and how old a mirror may be.
  // cardOwners: names besides the roster that may own a card (the owner's own cards); the gate refuses any other `who` (#C633).
  gate: { managerRole: "Manager", managerSession: "", cardOwners: [], keeperRole: "Context keeper", reviewerRole: "Reviewer", releaseRole: "Release", transientPrefixes: [], verdictWords: ["shipped", "is live", "decided", "go ahead"], stateDir: "~/.flight-board", mirrorMaxAgeMin: 75, requireUpdatedAt: false },
  // The collector (collector/): the team's repository and how its work shows there. notes: each review phase and the git
  // notes ref its sign-off is written to. deployWorkflow: the CI workflow whose successful run on the main branch means
  // live. lanePhases: the phases where one owner holds one card at a time (reviews and shipping queue). versionPattern: how a main-branch commit's subject names the version it shipped (first group). shippedPattern:
  // how such a subject names each branch it shipped and its commit (groups: branch, sha), for branches deleted since.
  // candidatePattern: the name of a ship run's own branch, which exists only while the run is on and whose commits name
  // what it ships (shippedPattern); empty for none. releaseTimes: the release log in the repository, read on main for each
  // version's CI times (#C397, collector/facts.mjs releaseTimes); empty for none. usageScript: the spend-by-source script
  // the probe runs once a day for the usage tile (#C595), only if its sha256 is usageScriptSha256; usageQuota: the plan's week in that script's weighted tokens, and
  // usageResetAt: any one weekly reset (UTC), set once; the probe works week % and pace from them. liveUrl: the live site the board's "Live now" reads (https, or empty for none); liveTag: how its page names the
  // build it serves (groups: version, commit). contextRoles: the roles whose memory tiles the collector reads from the app,
  // each from the session titled exactly as the role (collector/context.mjs); empty for none. repos: other repositories
  // whose cards the collector reads (#C278): [{ name, path (a clone of its own), mainBranch, remote, notes: {phase: ref},
  // idPrefixes (card ids it holds; a card's own repo field wins), installedLink (the link whose commit is what's installed) }].
  collector: { contextRoles: [], repos: [], reviewPaths: null, repoPath: "", outDir: "", remote: "origin", mainBranch: "main", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", deployWorkflow: "", lanePhases: ["build", "test"], versionPattern: "^v(\\d+\\.\\d+\\.\\d+)\\b", shippedPattern: "", candidatePattern: "", releaseTimes: "docs/RELEASE-TIMES.md", liveUrl: "", usageScript: "", promptLedger: "", usageScriptSha256: "", usageQuota: 0, usageResetAt: "", quotaCeilingPct: 90, configInRepo: "", pairFolder: "", liveTag: "<meta name=\"generator\" content=\"[^\"]*?v?(\\d+\\.\\d+\\.\\d+) ([0-9a-f]{7,40})\"",
    // Runs on demand (collector/refresh.mjs): the checkouts whose origin/main moving means a ship (local refs, no fetch), the
    // scheduled task the lead is told to run, the quiet minutes after a run (or an ask) and how long a run may take.
    // off: true retires the on-demand run (#C641): the Stop hook never asks the lead to start the collector.
    refresh: { repos: [], taskId: "board-collector", debounceMin: 10, flightMin: 15, off: false },
    // The context keeper's saved prompt against the one the owner's install shipped (#C407, collector/keeper.mjs): the
    // scheduled task's SKILL.md, the prompt file the owner pastes, and that prompt's sha256 (trimmed). Empty: off.
    // watchdog (#C411): the keeper's watchdog check, { script, state, alert }, or null for none (keeper/TASK.md {{WATCHDOG}}).
    keeper: { skill: "", prompt: "", promptSha256: "", watchdog: null } },
  // The nudges (collector/nudges.mjs): minutes the owner may wait for an answer; how far past its size's median a step may
  // run (etaHours: the median hours a step takes, by card size); how old a memory reading may get; how long a card may
  // stay unchanged unless its status is one of parked; and the quiet minutes before a nudge is sent again.
  nudges: { ownerWaitMin: 15, stepFactor: 1.5, etaHours: { XS: 1, S: 1.5, M: 3.5, L: 6 }, ctxMaxHours: 2, staleHours: 24, parked: ["paused"], quietMin: 120, deafMin: 30, shipTimesMin: 15 },
  // Mechanical traffic (gate/traffic.mjs): status-only messages the gate sends to the board's log instead of the lead,
  // each class a name and a pattern the whole message must match (case aside). An empty list turns it off. A ship is not
  // one: the lead acts on it at once (Manager, #C335).
  traffic: { mechanical: [
    { name: "picked-up", pattern: String.raw`picked up [A-Za-z0-9_-]{1,60}\.?` },
    { name: "step-logged", pattern: String.raw`(?:board )?steps? logged\.?` },
    { name: "tile-updated", pattern: String.raw`(?:memory )?tile updated\.?` },
    { name: "finished", pattern: String.raw`finished #?[A-Za-z0-9-]{1,80}\.?` },
  ] },
  // The repository badge on each card (#C648): the names live here, never in the repository's own files. platform: the name
  // shown for a card about the team's main repository; board: the name for a card about the board itself; builders: the
  // roles that build the board, whose cards (owned now, or with a build step by one of them) are the board's.
  repos: { platform: "Platform", board: "Flight-Board", builders: [] },
  // The values a card's typed fields may hold (#C662, gate/card-rules.mjs): the gate refuses a write outside them and the probe
  // writes a red line for a card already outside them. phase and who come from phases and the roster, so only these are listed.
  // wait and kind: no card carries either (a wait lives on a step), so their lists are empty.
  cardFields: { status: ["queued", "active", "paused", "parked", "stuck", "done", "dropped"], size: ["XS", "S", "M", "L", "XL"], level: ["Quick", "Full", "None"], wait: [], kind: [] },
  // The owner's decisions (gate rules 1 and 11, #C344): a decision is a look decision, needing a picture per option, when
  // its text or title names one of lookWords (a whole word, a plural too), or its card's lane (its who, or whoever built
  // it) is one of visualLanes (the team's roles: none by default). offBoard: wording that sends the owner off the board
  // (to a session's chat), refused in any ask.
  decisions: {
    lookWords: ["mock-up", "mockup", "screenshot", "layout", "band", "icon", "colour", "color", "font", "spacing", "px", "hero", "banner", "logo", "photo", "button", "text size"],
    visualLanes: [],
    offBoard: ["Manager chat", "in chat", "see chat", "in the chat"],
  },
  // Extra folders scripts/put-file.mjs may take a file from (#C1056), beside the folder that holds this config: up to 5 absolute paths, "~/" for the home folder.
  // None by default. Never a repository checkout (it holds source and settings): a stored file is readable by every agent and person past Access.
  fileRoots: [],
};

const KEYS = Object.keys(DEFAULTS);
const KEY = /^[a-z][a-z0-9-]{0,30}$/;
const NAME = /^[^<>{}\n]{1,60}$/;

export function checkConfig(c) {
  const out = [];
  if (!c || typeof c !== "object" || Array.isArray(c)) return ["the config must be a JSON object"];
  for (const k of Object.keys(c)) if (!KEYS.includes(k)) out.push(`unknown field "${k}" (known: ${KEYS.join(", ")})`);
  for (const k of ["title", "owner"]) if (c[k] !== undefined && !(typeof c[k] === "string" && NAME.test(c[k]))) out.push(`${k}: 1 to 60 characters, no < > { } or line breaks`);
  if (c.artifactSlug !== undefined && c.artifactSlug !== "" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(c.artifactSlug))) out.push("artifactSlug: the artifact's UUID in lower case, or empty");
  if (c.boardId !== undefined && c.boardId !== "" && !BOARD_ID.test(String(c.boardId))) out.push("boardId: 1 to 80 letters, digits or -, or empty");
  if (c.artifactUrl !== undefined && c.artifactUrl !== "" &&!/^https:\/\/claude\.ai\/(code\/)?artifact\/[A-Za-z0-9-]+$/.test(String(c.artifactUrl))) out.push("artifactUrl: a claude.ai artifact link, or empty");
  // The same shape the compact hook accepts (hooks/manager-compact-board.py): https, a host, an optional port and a trailing slash, no path or query.
  if (c.storeUrl !== undefined && c.storeUrl !== "" && !/^https:\/\/[A-Za-z0-9.-]{1,200}(:[0-9]{1,5})?\/?$/.test(String(c.storeUrl))) out.push("storeUrl: a plain https address (host, optional port, no path), or empty");
  if (c.resetAt !== undefined && !(Number.isInteger(c.resetAt) && c.resetAt >= 100000 && c.resetAt <= 2000000)) out.push("resetAt: whole tokens, 100,000 to 2,000,000");
  if (c.contextWindows !== undefined) {
    const w = c.contextWindows, ok = w && typeof w === "object" && !Array.isArray(w) && Object.keys(w).length <= 40 && Object.entries(w).every(([r, t]) => /^[A-Za-z0-9_-]{1,60}$/.test(r) && Number.isInteger(t) && t >= 100000 && t <= 2000000);
    if (!ok) out.push("contextWindows: { Role: whole tokens, 100,000 to 2,000,000 } for up to 40 roles (letters, digits, _ and -)");
  }
  if (c.phases !== undefined) {
    if (!Array.isArray(c.phases) || c.phases.length < 2) out.push("phases: at least two [key, label] pairs");
    else {
      c.phases.forEach((p, n) => { if (!Array.isArray(p) || p.length !== 2 || !KEY.test(p[0]) || !NAME.test(p[1])) out.push(`phases[${n}]: [key, label], key in lower case letters, digits and -`); });
      const keys = c.phases.map((p) => p?.[0]);
      if (new Set(keys).size !== keys.length) out.push("phases: each key once");
    }
  }
  for (const k of ["roster", "order"]) if (c[k] !== undefined && !(Array.isArray(c[k]) && c[k].every((r) => typeof r === "string" && NAME.test(r)))) out.push(`${k}: a list of role names`);
  if (c.rosterSessions !== undefined) {
    const rs = c.rosterSessions;
    if (!rs || typeof rs !== "object" || Array.isArray(rs)) out.push("rosterSessions: { role: session id }");
    else for (const [role, sid] of Object.entries(rs)) {
      if (!(c.roster ?? DEFAULTS.roster).includes(role)) out.push(`rosterSessions.${role}: not a roster role`);
      if (!(typeof sid === "string" && /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sid))) out.push(`rosterSessions.${role}: a session id (local_ and a UUID)`);
    }
  }
  const phaseKeys = (c.phases ?? DEFAULTS.phases).map((p) => p?.[0]);
  if (c.skips !== undefined) {
    if (!Array.isArray(c.skips)) out.push("skips: a list");
    else c.skips.forEach((s, n) => {
      if (!s || !phaseKeys.includes(s.phase)) out.push(`skips[${n}].phase: one of the phases`);
      if (!s || [s.unlessLevel, s.whenFalse, s.unlessTrue].filter((v) => v !== undefined).length !== 1) out.push(`skips[${n}]: exactly one of unlessLevel, whenFalse or unlessTrue`);
      if (s && s.unlessTrue !== undefined && !(typeof s.unlessTrue === "string" && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(s.unlessTrue))) out.push(`skips[${n}].unlessTrue: a card field name`);
    });
  }
  if (c.boardStart !== undefined && c.boardStart !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(String(c.boardStart))) out.push("boardStart: YYYY-MM-DD, or empty");
  if (c.prAgent !== undefined && !(typeof c.prAgent === "string" && c.prAgent.trim() && c.prAgent.length <= 40 && !/[<>{}\n]/.test(c.prAgent))) out.push("prAgent: a name, at most 40 characters");
  for (const k of ["usageNote", "runnerLabel", "automationLabel"]) if (c[k] !== undefined && !(typeof c[k] === "string" && c[k].length <= 300 && !/[<>{}]/.test(c[k]))) out.push(`${k}: plain text, at most 300 characters`);
  if (c.gate !== undefined) {
    const g = c.gate;
    if (!g || typeof g !== "object" || Array.isArray(g)) out.push("gate: an object");
    else {
      for (const k of Object.keys(g)) if (!Object.hasOwn(DEFAULTS.gate, k)) out.push(`gate: unknown field "${k}" (known: ${Object.keys(DEFAULTS.gate).join(", ")})`);
      if (g.managerRole !== undefined && !(typeof g.managerRole === "string" && NAME.test(g.managerRole))) out.push("gate.managerRole: a role name");
      // The lead's session id (#C586): the one place it is written. The Collector's fence sends only to it, and the Collector's
      // task and the reminders read it from here, so a new lead session is one config change, not four edited files.
      if (g.managerSession !== undefined && !(typeof g.managerSession === "string" && /^(?:local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/.test(g.managerSession))) out.push("gate.managerSession: a session id (local_ and a UUID), or empty");
      if (g.keeperRole !== undefined && !(typeof g.keeperRole === "string" && NAME.test(g.keeperRole))) out.push("gate.keeperRole: a role name");
      for (const k of ["reviewerRole", "releaseRole"]) if (g[k] !== undefined && !(typeof g[k] === "string" && NAME.test(g[k]))) out.push(`gate.${k}: a role name`);
      if (g.cardOwners !== undefined && !(Array.isArray(g.cardOwners) && g.cardOwners.every((w) => typeof w === "string" && NAME.test(w)))) out.push("gate.cardOwners: a list of names");
      for (const k of ["transientPrefixes", "verdictWords"]) if (g[k] !== undefined && !(Array.isArray(g[k]) && g[k].every((w) => typeof w === "string" && w.trim().length >= 2 && w.length <= 60))) out.push(`gate.${k}: a list of short strings`);
      if (g.stateDir !== undefined && !(typeof g.stateDir === "string" && g.stateDir.length > 0)) out.push("gate.stateDir: a folder path");
      if (g.mirrorMaxAgeMin !== undefined && !(Number.isInteger(g.mirrorMaxAgeMin) && g.mirrorMaxAgeMin > 0)) out.push("gate.mirrorMaxAgeMin: whole minutes");
      if (g.requireUpdatedAt !== undefined && typeof g.requireUpdatedAt !== "boolean") out.push("gate.requireUpdatedAt: true or false");
    }
  }
  if (c.collector !== undefined) {
    const k = c.collector, phaseKeys2 = (c.phases ?? DEFAULTS.phases).map((p) => p?.[0]);
    if (!k || typeof k !== "object" || Array.isArray(k)) out.push("collector: an object");
    else {
      for (const f of Object.keys(k)) if (!Object.hasOwn(DEFAULTS.collector, f)) out.push(`collector: unknown field "${f}" (known: ${Object.keys(DEFAULTS.collector).join(", ")})`);
      for (const f of ["repoPath", "outDir", "remote", "mainBranch", "deployWorkflow"]) if (k[f] !== undefined && !(typeof k[f] === "string" && !/[\n\0]/.test(k[f]) && k[f].length <= 300)) out.push(`collector.${f}: a short string`);
      for (const f of ["remote", "mainBranch"]) if (k[f] !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/.test(String(k[f]))) out.push(`collector.${f}: a git name`);
      if (k.notes !== undefined) {
        if (!k.notes || typeof k.notes !== "object" || Array.isArray(k.notes)) out.push("collector.notes: { phase: notes ref }");
        else for (const [p, ref] of Object.entries(k.notes)) {
          if (!phaseKeys2.includes(p)) out.push(`collector.notes.${p}: not one of the phases`);
          if (!/^refs\/notes\/[A-Za-z0-9._-]{1,60}$/.test(String(ref))) out.push(`collector.notes.${p}: a refs/notes/<name> ref`);
        }
      }
      out.push(...reviewPathsErrors(k.reviewPaths, Object.keys(k.notes ?? DEFAULTS.collector.notes), "collector.reviewPaths"));
      for (const f of ["buildPhase", "shipPhase", "livePhase"]) if (k[f] !== undefined && !phaseKeys2.includes(k[f])) out.push(`collector.${f}: one of the phases`);
      if (k.lanePhases !== undefined && !(Array.isArray(k.lanePhases) && k.lanePhases.every((p) => phaseKeys2.includes(p)))) out.push("collector.lanePhases: a list of phases");
      for (const f of ["versionPattern", "shippedPattern", "liveTag", "candidatePattern"]) if (k[f] !== undefined) { try { new RegExp(k[f]); } catch { out.push(`collector.${f}: a regular expression`); } }
      // A path git shows from main: relative, inside the repository, never an option or a ref:path of its own (Security).
      if (k.releaseTimes !== undefined && !(k.releaseTimes === "" || (typeof k.releaseTimes === "string" && k.releaseTimes.length <= 200 && /^[A-Za-z0-9_][A-Za-z0-9._\/-]*$/.test(k.releaseTimes) && !k.releaseTimes.split("/").includes("..")))) out.push("collector.releaseTimes: a path inside the repository, or empty");
      // Security on #C407: the skill is a scheduled task's SKILL.md and nothing else (no probe of other files); the prompt a
      // .txt under ~ (the Collector also wants it in the config's own folder) that a shell takes unquoted: no spaces,
      // quotes or "..". The same patterns as collector/keeper.mjs.
      if (k.keeper !== undefined) {
        const p = k.keeper, SKILL = /^~\/\.claude\/scheduled-tasks\/[a-z0-9-]{1,60}\/SKILL\.md$/, PROMPT = /^~\/(?:[A-Za-z0-9._-]{1,80}\/){0,6}[A-Za-z0-9._-]{1,80}\.txt$/;
        if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some((f) => !["skill", "prompt", "promptSha256", "watchdog"].includes(f))) out.push("collector.keeper: { skill, prompt, promptSha256, watchdog }");
        else {
          // #C411: the keeper runs node <script> <state> <alert> under an exact allow rule: absolute paths a shell takes
          // unquoted, the script a .mjs, the two others .json.
          const w = p.watchdog, ABS = /^\/(?:[A-Za-z0-9._-]{1,80}\/){1,12}[A-Za-z0-9._-]{1,80}$/;
          const abs = (v, ext) => typeof v === "string" && ABS.test(v) && v.endsWith(ext) && !v.split("/").some((s) => s === ".." || s === ".");
          if (w !== undefined && w !== null && !(w && typeof w === "object" && !Array.isArray(w) && Object.keys(w).every((f) => ["script", "state", "alert"].includes(f)) && abs(w.script, ".mjs") && abs(w.state, ".json") && abs(w.alert, ".json")))
            out.push("collector.keeper.watchdog: { script: /…/<name>.mjs, state: /…/<name>.json, alert: /…/<name>.json } (absolute paths), or null");
          const set = ["skill", "prompt", "promptSha256"].filter((f) => p[f]);
          if (p.skill && !(typeof p.skill === "string" && SKILL.test(p.skill))) out.push("collector.keeper.skill: ~/.claude/scheduled-tasks/<task>/SKILL.md, or empty");
          if (p.prompt && !(typeof p.prompt === "string" && PROMPT.test(p.prompt) && !p.prompt.split("/").some((s) => s === ".." || s === "."))) out.push("collector.keeper.prompt: a .txt file under ~ (letters, digits, . _ - /), or empty");
          if (p.promptSha256 && !/^[0-9a-f]{64}$/.test(String(p.promptSha256))) out.push("collector.keeper.promptSha256: 64 hex digits, or empty");
          if (set.length && set.length < 3) out.push("collector.keeper: skill, prompt and promptSha256 all set, or none");
        }
      }
      if (k.usageScript !== undefined && !(k.usageScript === "" || (typeof k.usageScript === "string" && /^\/[A-Za-z0-9._\/-]{1,200}\.py$/.test(k.usageScript) && !k.usageScript.split("/").some((s) => s === ".." || s === ".")))) out.push("collector.usageScript: an absolute path to a .py file (#C595, the probe runs it daily, only if its sha256 is usageScriptSha256), or empty");
      // #C1005 (c): the permission-prompt ledger a hook writes, one JSON line per prompt (who, tool, at); the probe only reads it. Empty: no ledger, no ledger lines.
      if (k.promptLedger !== undefined && !(k.promptLedger === "" || (typeof k.promptLedger === "string" && /^\/[A-Za-z0-9._\/-]{1,200}\.jsonl$/.test(k.promptLedger) && !k.promptLedger.split("/").some((s) => s === ".." || s === ".")))) out.push("collector.promptLedger: an absolute path to the prompt ledger's .jsonl file (#C1005, the probe reads it, never writes it), or empty");
      if (k.usageScriptSha256 !== undefined && !(k.usageScriptSha256 === "" || /^[0-9a-f]{64}$/.test(String(k.usageScriptSha256)))) out.push("collector.usageScriptSha256: 64 hex digits (the script's sha256), or empty");
      if (k.usageScript && !/^[0-9a-f]{64}$/.test(String(k.usageScriptSha256 ?? ""))) out.push("collector.usageScript needs collector.usageScriptSha256: the probe runs only the script it was pinned to");
      if (k.usageQuota !== undefined && !(Number.isInteger(k.usageQuota) && k.usageQuota >= 0 && k.usageQuota <= 1e12)) out.push("collector.usageQuota: the week's quota in the spend script's weighted tokens (whole number), or 0 for none");
      // #C974: the config's own file in the team's repository (a relative path, no ".."), or empty: the probe keeps the live copy equal to main's.
      // #C1013: the folder the deploy pairs are made in (board-store-deploy-pc<n>.mjs and its .done marker). Empty: the dispatch skips no pair turn.
      if (k.pairFolder !== undefined && !(k.pairFolder === "" || (typeof k.pairFolder === "string" && /^(?:~|)\/[A-Za-z0-9._\/ -]{1,300}$/.test(k.pairFolder) && !k.pairFolder.split("/").some((s) => s === ".." || s === ".")))) out.push("collector.pairFolder: an absolute folder path (or one starting ~/) where the deploy pairs are made, or empty");
      if (k.configInRepo !== undefined && !(k.configInRepo === "" || (typeof k.configInRepo === "string" && /^[A-Za-z0-9._\/-]{1,200}\.json$/.test(k.configInRepo) && !k.configInRepo.startsWith("/") && !k.configInRepo.startsWith("-") && !k.configInRepo.split("/").some((s) => s === ".." || s === "." || s === "")))) out.push("collector.configInRepo: a relative path to a .json file in the team's repository (no .., no leading / or -), or empty");
      // #C973: at this share of the week's quota the dispatch stops waking builders for new build work (90 normally; the owner may raise it for a week).
      if (k.quotaCeilingPct !== undefined && !(Number.isInteger(k.quotaCeilingPct) && k.quotaCeilingPct >= 1 && k.quotaCeilingPct <= 100)) out.push("collector.quotaCeilingPct: a whole percent from 1 to 100 (90 by default): at that share of the week the dispatch stops new build work");
      if (k.usageResetAt !== undefined && !(k.usageResetAt === "" || (typeof k.usageResetAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(k.usageResetAt) && Number.isFinite(Date.parse(k.usageResetAt))))) out.push("collector.usageResetAt: one weekly reset as UTC time, like 2026-11-06T17:00Z, or empty");
      if (k.liveUrl !== undefined && !(k.liveUrl === "" || (typeof k.liveUrl === "string" && k.liveUrl.length <= 300 && /^https:\/\/[^\s/?#]+(\/[^\s]*)?$/.test(k.liveUrl)))) out.push("collector.liveUrl: an https address, or empty");
      if (k.contextRoles !== undefined && !(Array.isArray(k.contextRoles) && k.contextRoles.length <= 40 && k.contextRoles.every((r) => typeof r === "string" && /^[A-Za-z0-9_-]{1,60}$/.test(r)))) out.push("collector.contextRoles: a list of up to 40 role names (letters, digits, _ and -), each a session's exact title");
      if (k.repos !== undefined) {
        const REPO = ["name", "path", "mainBranch", "remote", "notes", "idPrefixes", "installedLink", "reviewPaths"];
        if (!Array.isArray(k.repos) || k.repos.length > 5) out.push("collector.repos: a list of up to 5 repositories");
        else {
          k.repos.forEach((r, n) => {
            const at = `collector.repos[${n}]`;
            if (!r || typeof r !== "object" || Array.isArray(r)) { out.push(`${at}: an object`); return; }
            for (const f of Object.keys(r)) if (!REPO.includes(f)) out.push(`${at}: unknown field "${f}" (known: ${REPO.join(", ")})`);
            if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(String(r.name ?? ""))) out.push(`${at}.name: lower case letters, digits and -`);
            for (const f of ["path", "installedLink"]) if (r[f] !== undefined || f === "path") if (!(typeof r[f] === "string" && r[f].length > 0 && r[f].length <= 300 && !/[\n\0]/.test(r[f]))) out.push(`${at}.${f}: a folder path`);
            for (const f of ["mainBranch", "remote"]) if (r[f] !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/.test(String(r[f]))) out.push(`${at}.${f}: a git name`);
            if (!r.notes || typeof r.notes !== "object" || Array.isArray(r.notes) || Object.entries(r.notes).some(([p, ref]) => !phaseKeys2.includes(p) || !/^refs\/notes\/[A-Za-z0-9._-]{1,60}$/.test(String(ref)))) out.push(`${at}.notes: { phase: refs/notes/<name> }`);
            if (r.notes && typeof r.notes === "object" && !Array.isArray(r.notes)) out.push(...reviewPathsErrors(r.reviewPaths, Object.keys(r.notes), `${at}.reviewPaths`));
            if (r.idPrefixes !== undefined && !(Array.isArray(r.idPrefixes) && r.idPrefixes.length <= 10 && r.idPrefixes.every((p) => /^[a-z0-9-]{1,40}$/.test(String(p))))) out.push(`${at}.idPrefixes: a list of card id prefixes`);
          });
          const names = k.repos.map((r) => r?.name);
          if (new Set(names).size !== names.length) out.push("collector.repos: each name once");
        }
      }
      if (k.refresh !== undefined) {
        const r = k.refresh;
        if (!r || typeof r !== "object" || Array.isArray(r)) out.push("collector.refresh: an object");
        else {
          for (const f of Object.keys(r)) if (!Object.hasOwn(DEFAULTS.collector.refresh, f)) out.push(`collector.refresh: unknown field "${f}" (known: ${Object.keys(DEFAULTS.collector.refresh).join(", ")})`);
          if (r.repos !== undefined && !(Array.isArray(r.repos) && r.repos.length <= 10 && r.repos.every((p) => typeof p === "string" && p.length > 0 && p.length <= 300 && !/[\n\0]/.test(p)))) out.push("collector.refresh.repos: a list of checkout folders");
          if (r.taskId !== undefined && !/^[a-z0-9][a-z0-9-]{0,60}$/.test(String(r.taskId))) out.push("collector.refresh.taskId: a scheduled task id");
          if (r.off !== undefined && typeof r.off !== "boolean") out.push("collector.refresh.off: true or false");
          for (const f of ["debounceMin", "flightMin"]) if (r[f] !== undefined && !(Number.isInteger(r[f]) && r[f] >= 1 && r[f] <= 240)) out.push(`collector.refresh.${f}: whole minutes, 1 to 240`);
        }
      }
    }
  }
  if (c.nudges !== undefined) {
    const k = c.nudges;
    if (!k || typeof k !== "object" || Array.isArray(k)) out.push("nudges: an object");
    else {
      for (const f of Object.keys(k)) if (!Object.hasOwn(DEFAULTS.nudges, f)) out.push(`nudges: unknown field "${f}" (known: ${Object.keys(DEFAULTS.nudges).join(", ")})`);
      for (const f of ["ownerWaitMin", "stepFactor", "ctxMaxHours", "staleHours", "quietMin", "deafMin", "shipTimesMin"]) if (k[f] !== undefined && !(typeof k[f] === "number" && k[f] > 0 && k[f] < 1e4)) out.push(`nudges.${f}: a positive number`);
      if (k.etaHours !== undefined && !(k.etaHours && typeof k.etaHours === "object" && !Array.isArray(k.etaHours) && Object.entries(k.etaHours).every(([s, h]) => /^[A-Za-z]{1,4}$/.test(s) && typeof h === "number" && h > 0))) out.push("nudges.etaHours: { size: hours }");
      if (k.parked !== undefined && !(Array.isArray(k.parked) && k.parked.every((x) => typeof x === "string" && KEY.test(x)))) out.push("nudges.parked: a list of statuses");
    }
  }
  if (c.traffic !== undefined) {
    const k = c.traffic;
    if (!k || typeof k !== "object" || Array.isArray(k)) out.push("traffic: an object");
    else {
      for (const f of Object.keys(k)) if (!Object.hasOwn(DEFAULTS.traffic, f)) out.push(`traffic: unknown field "${f}" (known: ${Object.keys(DEFAULTS.traffic).join(", ")})`);
      if (k.mechanical !== undefined) {
        if (!Array.isArray(k.mechanical) || k.mechanical.length > 20) out.push("traffic.mechanical: a list of up to 20 classes");
        else k.mechanical.forEach((m, n) => {
          let ok = !!m && typeof m === "object" && KEY.test(String(m.name ?? "")) && typeof m.pattern === "string" && m.pattern.length > 0 && m.pattern.length <= 300;
          if (ok) { try { new RegExp(m.pattern); } catch { ok = false; } }
          if (!ok) out.push(`traffic.mechanical[${n}]: { name, pattern }, a short lower-case name and a regular expression`);
        });
      }
    }
  }
  if (c.repos !== undefined) {
    const k = c.repos;
    if (!k || typeof k !== "object" || Array.isArray(k)) out.push("repos: an object");
    else {
      for (const f of Object.keys(k)) if (!Object.hasOwn(DEFAULTS.repos, f)) out.push(`repos: unknown field "${f}" (known: ${Object.keys(DEFAULTS.repos).join(", ")})`);
      for (const f of ["platform", "board"]) if (k[f] !== undefined && !(typeof k[f] === "string" && k[f].trim().length >= 1 && k[f].length <= 40 && !/[<>{}\n"]/.test(k[f]))) out.push(`repos.${f}: a short name`);
      if (String(k.platform ?? DEFAULTS.repos.platform).trim().toLowerCase() === String(k.board ?? DEFAULTS.repos.board).trim().toLowerCase()) out.push("repos: platform and board need different names");
      if (k.builders !== undefined && !(Array.isArray(k.builders) && k.builders.length <= 20 && k.builders.every((r) => typeof r === "string" && NAME.test(r)))) out.push("repos.builders: a list of role names");
    }
  }
  if (c.cardFields !== undefined) {
    const k = c.cardFields;
    if (!k || typeof k !== "object" || Array.isArray(k)) out.push("cardFields: an object");
    else for (const f of Object.keys(k)) {
      if (!Object.hasOwn(DEFAULTS.cardFields, f)) out.push(`cardFields: unknown field "${f}" (known: ${Object.keys(DEFAULTS.cardFields).join(", ")})`);
      else if (!(Array.isArray(k[f]) && k[f].length <= 20 && k[f].every((v) => typeof v === "string" && NAME.test(v)))) out.push(`cardFields.${f}: a list of up to 20 short values`);
    }
  }
  if (c.decisions !== undefined) {
    const k = c.decisions;
    if (!k || typeof k !== "object" || Array.isArray(k)) out.push("decisions: an object");
    else {
      for (const f of Object.keys(k)) if (!Object.hasOwn(DEFAULTS.decisions, f)) out.push(`decisions: unknown field "${f}" (known: ${Object.keys(DEFAULTS.decisions).join(", ")})`);
      for (const f of ["lookWords", "offBoard"]) if (k[f] !== undefined && !(Array.isArray(k[f]) && k[f].length <= 100 && k[f].every((w) => typeof w === "string" && w.trim().length >= 2 && w.length <= 40 && !/[<>{}\n]/.test(w)))) out.push(`decisions.${f}: a list of up to 100 short words or phrases`);
      if (k.visualLanes !== undefined && !(Array.isArray(k.visualLanes) && k.visualLanes.every((r) => typeof r === "string" && NAME.test(r)))) out.push("decisions.visualLanes: a list of role names");
    }
  }
  if (c.fileRoots !== undefined && !(Array.isArray(c.fileRoots) && c.fileRoots.length <= 5 && c.fileRoots.every((p) => typeof p === "string" && /^(\/|~\/)[^\0<>{}\n]{1,300}$/.test(p) && !p.split("/").some((s) => s === ".." || s === ".")))) out.push("fileRoots: a list of up to 5 absolute folders (or ~/ ones), none with .. or .");
  return out;
}

// The defaults with the team's values on top.
export function fullConfig(c) {
  return { ...DEFAULTS, ...c, gate: { ...DEFAULTS.gate, ...(c?.gate ?? {}) }, collector: { ...DEFAULTS.collector, ...(c?.collector ?? {}), refresh: { ...DEFAULTS.collector.refresh, ...(c?.collector?.refresh ?? {}) }, keeper: { ...DEFAULTS.collector.keeper, ...(c?.collector?.keeper ?? {}) } }, nudges: { ...DEFAULTS.nudges, ...(c?.nudges ?? {}) }, traffic: { ...DEFAULTS.traffic, ...(c?.traffic ?? {}) }, decisions: { ...DEFAULTS.decisions, ...(c?.decisions ?? {}) }, cardFields: { ...DEFAULTS.cardFields, ...(c?.cardFields ?? {}) }, repos: { ...DEFAULTS.repos, ...(c?.repos ?? {}) } };
}

// The board's id: the boardId key when it is set (#C1054), else the id in its link. What the gate matches a write's url against.
export const BOARD_ID = /^[A-Za-z0-9-]{1,80}$/;
export function boardId(c) {
  if (typeof c?.boardId === "string" && BOARD_ID.test(c.boardId)) return c.boardId;
  return /artifact\/([A-Za-z0-9-]+)$/.exec(String(c?.artifactUrl ?? ""))?.[1] ?? null;
}
