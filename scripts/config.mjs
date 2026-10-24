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
  gate: { managerRole: "Manager", transientPrefixes: [], verdictWords: ["shipped", "is live", "decided", "go ahead"], stateDir: "~/.flight-board", mirrorMaxAgeMin: 30 },
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
  return out;
}

// The defaults with the team's values on top.
export function fullConfig(c) {
  return { ...DEFAULTS, ...c, gate: { ...DEFAULTS.gate, ...(c?.gate ?? {}) } };
}

// The board's id, from its link: what the gate matches a write's url against.
export function boardId(c) {
  return /artifact\/([A-Za-z0-9-]+)$/.exec(String(c?.artifactUrl ?? ""))?.[1] ?? null;
}
