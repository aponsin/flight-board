// #C997: the operational numbers that are settings, in one place. Imports nothing, so the Worker, the probe and the Mac scripts read the same table.
// The board config's `ops` section holds { key: number } (seconds). It is read at EVERY run on the Mac; the Worker has no board config, so the
// evidence job posts resolveKnobs()'s answer under the evidence key `knobs` and the Worker reads it from the store (as it reads `look`).
// A value that is missing keeps its default quietly. A value that is not a number, below its minimum, above its maximum or not under the
// setting it must stay under is IGNORED: the default stands and the page's header names the setting and why (never a refused config file).
// Stays in code, never a setting: anything that decides who may sign, land or deploy, and the write-validity windows (see FIXED below).
export const KNOBS = {
  evidenceIntervalSec: { default: 60, min: 30, max: 600, label: "how often the evidence job starts (s)" },
  evidenceLimitSec: { default: 170, min: 60, max: 290, label: "the evidence job's time limit (s)" },
  slowRunSec: { default: 150, min: 30, max: 280, under: "evidenceLimitSec", label: "a run longer than this is shown as slow (s)" },
  staleAfterSec: { default: 300, min: 120, max: 1800, label: "an evidence reading older than this is stale on the page (s)" },
  probeSilentSec: { default: 300, min: 120, max: 1800, label: "no probe post for this long makes the Probe chip silent (s)" },
  agentsFreshSec: { default: 300, min: 60, max: 1800, label: "the agents reading is used by the dispatch for this long (s)" },
  evidenceStaleSec: { default: 300, min: 120, max: 1800, label: "the lead's no-evidence line starts after this long (s)" },
};
export const KNOB_KEYS = Object.keys(KNOBS);

// raw: the config's `ops` value (anything). Returns { values: { key: number }, ignored: [{ key, why }] }; values has every key.
export function resolveKnobs(raw) {
  const values = {}, ignored = [];
  const bag = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  if (raw !== undefined && raw !== null && bag !== raw) ignored.push({ key: "ops", why: "unreadable" });
  for (const [key, k] of Object.entries(KNOBS)) {
    values[key] = k.default;
    if (!(key in bag)) continue;
    const v = bag[key];
    if (typeof v !== "number" || !Number.isFinite(v)) ignored.push({ key, why: "not a number" });
    else if (v < k.min) ignored.push({ key, why: "too low" });
    else if (v > k.max) ignored.push({ key, why: "too high" });
    else values[key] = v;
  }
  // A setting that must stay under another is checked after both are resolved.
  for (const [key, k] of Object.entries(KNOBS)) {
    if (k.under && values[key] >= values[k.under] && !ignored.some((i) => i.key === key)) { ignored.push({ key, why: `not under ${k.under}` }); values[key] = Math.min(k.default, values[k.under] - 1); }
  }
  for (const key of Object.keys(bag)) if (!(key in KNOBS)) ignored.push({ key, why: "unknown setting" });
  return { values, ignored };
}

// The shape the Worker accepts under the evidence key `knobs`: { values: {known key: finite number}, ignored: [{ key, why }] up to 40 }.
const WHY = /^[a-z][a-z0-9 _-]{0,40}$/i, KEY = /^[A-Za-z][A-Za-z0-9]{0,40}$/;
export const knobsShape = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every((k) => k === "values" || k === "ignored")
  && v.values !== null && typeof v.values === "object" && !Array.isArray(v.values) && Object.entries(v.values).every(([k, n]) => k in KNOBS && Number.isFinite(n))
  && Array.isArray(v.ignored) && v.ignored.length <= 40 && v.ignored.every((i) => i !== null && typeof i === "object" && typeof i.key === "string" && KEY.test(i.key) && typeof i.why === "string" && WHY.test(i.why));

// The value of a setting from a stored reading (the Worker side): the reading's number when it is known and valid, else the default.
export const knobFrom = (stored, key) => {
  const n = stored?.values?.[key], k = KNOBS[key];
  return Number.isFinite(n) && n >= k.min && n <= k.max ? n : k.default;
};
