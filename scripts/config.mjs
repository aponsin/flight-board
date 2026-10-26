// board.config.json: everything particular to one team. The page, the gate, the collector and the nudges read it; nothing
// team-specific lives in this repository. checkConfig returns the problems, one line each; an empty list means it is good.
export const DEFAULTS = {
  title: "Flight Board",
  owner: "Owner",
  artifactUrl: "",
  phases: [["plan", "Plan"], ["build", "Build"], ["test", "Test"], ["language", "Language"], ["checker", "Checker"], ["security", "Security"], ["ship", "Ship"], ["live", "Live"]],
  roster: ["Manager", "Builder", "Checker", "Security", "Release"],
  order: ["Manager", "Builder", "Checker", "Security", "Release"],
  skips: [{ phase: "security", unlessLevel: "Full" }, { phase: "language", whenFalse: "customerText" }],
  boardStart: "",
  usageNote: "Runner and automation minutes come from the job-run times the scheduler reports.",
  runnerLabel: "Runners",
  automationLabel: "Automation",
  // The write gate (gate/): the lead role, item ids that are passing agent states (never items), the words that make a
  // reply a verdict, where the gate keeps its state and the board's mirror, and how old a mirror may be.
  gate: { managerRole: "Manager", transientPrefixes: [], verdictWords: ["shipped", "is live", "decided", "go ahead"], stateDir: "~/.flight-board", mirrorMaxAgeMin: 75 },
  // The collector (collector/): the team's repository and how its work shows there. notes: each review phase and the git
  // notes ref its sign-off is written to. deployWorkflow: the CI workflow whose successful run on the main branch means
  // live. lanePhases: the phases where one owner holds one card at a time (reviews and shipping queue). versionPattern: how a main-branch commit's subject names the version it shipped (first group). shippedPattern:
  // how such a subject names each branch it shipped and its commit (groups: branch, sha), for branches deleted since.
  // candidatePattern: the name of a ship run's own branch, which exists only while the run is on and whose commits name
  // what it ships (shippedPattern); empty for none. liveUrl: the live site the board's "Live now" reads (https, or empty for none); liveTag: how its page names the
  // build it serves (groups: version, commit).
  collector: { repoPath: "", outDir: "", remote: "origin", mainBranch: "main", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", deployWorkflow: "", lanePhases: ["build", "test"], versionPattern: "^v(\\d+\\.\\d+\\.\\d+)\\b", shippedPattern: "", candidatePattern: "", liveUrl: "", liveTag: "<meta name=\"generator\" content=\"[^\"]*?v?(\\d+\\.\\d+\\.\\d+) ([0-9a-f]{7,40})\"",
    // Runs on demand (collector/refresh.mjs): the checkouts whose origin/main moving means a ship (local refs, no fetch), the
    // scheduled task the lead is told to run, the quiet minutes after a run (or an ask) and how long a run may take.
    refresh: { repos: [], taskId: "board-collector", debounceMin: 10, flightMin: 15 } },
  // The nudges (collector/nudges.mjs): minutes the owner may wait for an answer; how far past its size's median a step may
  // run (etaHours: the median hours a step takes, by card size); how old a memory reading may get; how long a card may
  // stay unchanged unless its status is one of parked; and the quiet minutes before a nudge is sent again.
  nudges: { ownerWaitMin: 15, stepFactor: 1.5, etaHours: { XS: 1, S: 1.5, M: 3.5, L: 6 }, ctxMaxHours: 2, staleHours: 24, parked: ["paused"], quietMin: 120 },
};

const KEYS = Object.keys(DEFAULTS);
const KEY = /^[a-z][a-z0-9-]{0,30}$/;
const NAME = /^[^<>{}\n]{1,60}$/;

export function checkConfig(c) {
  const out = [];
  if (!c || typeof c !== "object" || Array.isArray(c)) return ["the config must be a JSON object"];
  for (const k of Object.keys(c)) if (!KEYS.includes(k)) out.push(`unknown field "${k}" (known: ${KEYS.join(", ")})`);
  for (const k of ["title", "owner"]) if (c[k] !== undefined && !(typeof c[k] === "string" && NAME.test(c[k]))) out.push(`${k}: 1 to 60 characters, no < > { } or line breaks`);
  if (c.artifactUrl !== undefined && c.artifactUrl !== "" && !/^https:\/\/claude\.ai\/(code\/)?artifact\/[A-Za-z0-9-]+$/.test(String(c.artifactUrl))) out.push("artifactUrl: a claude.ai artifact link, or empty");
  if (c.phases !== undefined) {
    if (!Array.isArray(c.phases) || c.phases.length < 2) out.push("phases: at least two [key, label] pairs");
    else {
      c.phases.forEach((p, n) => { if (!Array.isArray(p) || p.length !== 2 || !KEY.test(p[0]) || !NAME.test(p[1])) out.push(`phases[${n}]: [key, label], key in lower case letters, digits and -`); });
      const keys = c.phases.map((p) => p?.[0]);
      if (new Set(keys).size !== keys.length) out.push("phases: each key once");
    }
  }
  for (const k of ["roster", "order"]) if (c[k] !== undefined && !(Array.isArray(c[k]) && c[k].every((r) => typeof r === "string" && NAME.test(r)))) out.push(`${k}: a list of role names`);
  const phaseKeys = (c.phases ?? DEFAULTS.phases).map((p) => p?.[0]);
  if (c.skips !== undefined) {
    if (!Array.isArray(c.skips)) out.push("skips: a list");
    else c.skips.forEach((s, n) => {
      if (!s || !phaseKeys.includes(s.phase)) out.push(`skips[${n}].phase: one of the phases`);
      if (!s || (s.unlessLevel === undefined) === (s.whenFalse === undefined)) out.push(`skips[${n}]: exactly one of unlessLevel or whenFalse`);
    });
  }
  if (c.boardStart !== undefined && c.boardStart !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(String(c.boardStart))) out.push("boardStart: YYYY-MM-DD, or empty");
  for (const k of ["usageNote", "runnerLabel", "automationLabel"]) if (c[k] !== undefined && !(typeof c[k] === "string" && c[k].length <= 300 && !/[<>{}]/.test(c[k]))) out.push(`${k}: plain text, at most 300 characters`);
  if (c.gate !== undefined) {
    const g = c.gate;
    if (!g || typeof g !== "object" || Array.isArray(g)) out.push("gate: an object");
    else {
      for (const k of Object.keys(g)) if (!Object.hasOwn(DEFAULTS.gate, k)) out.push(`gate: unknown field "${k}" (known: ${Object.keys(DEFAULTS.gate).join(", ")})`);
      if (g.managerRole !== undefined && !(typeof g.managerRole === "string" && NAME.test(g.managerRole))) out.push("gate.managerRole: a role name");
      for (const k of ["transientPrefixes", "verdictWords"]) if (g[k] !== undefined && !(Array.isArray(g[k]) && g[k].every((w) => typeof w === "string" && w.trim().length >= 2 && w.length <= 60))) out.push(`gate.${k}: a list of short strings`);
      if (g.stateDir !== undefined && !(typeof g.stateDir === "string" && g.stateDir.length > 0)) out.push("gate.stateDir: a folder path");
      if (g.mirrorMaxAgeMin !== undefined && !(Number.isInteger(g.mirrorMaxAgeMin) && g.mirrorMaxAgeMin > 0)) out.push("gate.mirrorMaxAgeMin: whole minutes");
    }
  }
  if (c.collector !== undefined) {
    const k = c.collector, phaseKeys2 = (c.phases ?? DEFAULTS.phases).map((p) => p?.[0]);
    if (!k || typeof k !== "object" || Array.isArray(k)) out.push("collector: an object");
    else {
      for (const f of Object.keys(k)) if (!Object.hasOwn(DEFAULTS.collector, f)) out.push(`collector: unknown field "${f}" (known: ${Object.keys(DEFAULTS.collector).join(", ")})`);
      for (const f of ["repoPath", "outDir", "remote", "mainBranch", "deployWorkflow"]) if (k[f] !== undefined && !(typeof k[f] === "string" && !/[\n\0]/.test(k[f]) && k[f].length <= 300)) out.push(`collector.${f}: a short string`);
      for (const f of ["remote", "mainBranch"]) if (k[f] !== undefined && !/^[A-Za-z0-9._\/-]{1,100}$/.test(String(k[f]))) out.push(`collector.${f}: a git name`);
      if (k.notes !== undefined) {
        if (!k.notes || typeof k.notes !== "object" || Array.isArray(k.notes)) out.push("collector.notes: { phase: notes ref }");
        else for (const [p, ref] of Object.entries(k.notes)) {
          if (!phaseKeys2.includes(p)) out.push(`collector.notes.${p}: not one of the phases`);
          if (!/^refs\/notes\/[A-Za-z0-9._-]{1,60}$/.test(String(ref))) out.push(`collector.notes.${p}: a refs/notes/<name> ref`);
        }
      }
      for (const f of ["buildPhase", "shipPhase", "livePhase"]) if (k[f] !== undefined && !phaseKeys2.includes(k[f])) out.push(`collector.${f}: one of the phases`);
      if (k.lanePhases !== undefined && !(Array.isArray(k.lanePhases) && k.lanePhases.every((p) => phaseKeys2.includes(p)))) out.push("collector.lanePhases: a list of phases");
      for (const f of ["versionPattern", "shippedPattern", "liveTag", "candidatePattern"]) if (k[f] !== undefined) { try { new RegExp(k[f]); } catch { out.push(`collector.${f}: a regular expression`); } }
      if (k.liveUrl !== undefined && !(k.liveUrl === "" || (typeof k.liveUrl === "string" && k.liveUrl.length <= 300 && /^https:\/\/[^\s/?#]+(\/[^\s]*)?$/.test(k.liveUrl)))) out.push("collector.liveUrl: an https address, or empty");
      if (k.refresh !== undefined) {
        const r = k.refresh;
        if (!r || typeof r !== "object" || Array.isArray(r)) out.push("collector.refresh: an object");
        else {
          for (const f of Object.keys(r)) if (!Object.hasOwn(DEFAULTS.collector.refresh, f)) out.push(`collector.refresh: unknown field "${f}" (known: ${Object.keys(DEFAULTS.collector.refresh).join(", ")})`);
          if (r.repos !== undefined && !(Array.isArray(r.repos) && r.repos.length <= 10 && r.repos.every((p) => typeof p === "string" && p.length > 0 && p.length <= 300 && !/[\n\0]/.test(p)))) out.push("collector.refresh.repos: a list of checkout folders");
          if (r.taskId !== undefined && !/^[a-z0-9][a-z0-9-]{0,60}$/.test(String(r.taskId))) out.push("collector.refresh.taskId: a scheduled task id");
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
      for (const f of ["ownerWaitMin", "stepFactor", "ctxMaxHours", "staleHours", "quietMin"]) if (k[f] !== undefined && !(typeof k[f] === "number" && k[f] > 0 && k[f] < 1e4)) out.push(`nudges.${f}: a positive number`);
      if (k.etaHours !== undefined && !(k.etaHours && typeof k.etaHours === "object" && !Array.isArray(k.etaHours) && Object.entries(k.etaHours).every(([s, h]) => /^[A-Za-z]{1,4}$/.test(s) && typeof h === "number" && h > 0))) out.push("nudges.etaHours: { size: hours }");
      if (k.parked !== undefined && !(Array.isArray(k.parked) && k.parked.every((x) => typeof x === "string" && KEY.test(x)))) out.push("nudges.parked: a list of statuses");
    }
  }
  return out;
}

// The defaults with the team's values on top.
export function fullConfig(c) {
  return { ...DEFAULTS, ...c, gate: { ...DEFAULTS.gate, ...(c?.gate ?? {}) }, collector: { ...DEFAULTS.collector, ...(c?.collector ?? {}), refresh: { ...DEFAULTS.collector.refresh, ...(c?.collector?.refresh ?? {}) } }, nudges: { ...DEFAULTS.nudges, ...(c?.nudges ?? {}) } };
}

// The board's id, from its link: what the gate matches a write's url against.
export function boardId(c) {
  return /artifact\/([A-Za-z0-9-]+)$/.exec(String(c?.artifactUrl ?? ""))?.[1] ?? null;
}
