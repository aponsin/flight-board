// Each card's expected version (#C400, the owner's picks in #T1043 and #T1044): worked out in code, never written by hand.
// The base is the newest version known: the live site's, main's (deploying), or a ship run's on now (its candidate branch
// names it). The queue (signed cards not on main, by when they went READY, as the page orders it) follows: the cards the
// lead marks with one batch:<name> ship together in one version, at the place of the earliest of them; any other card
// is a version of its own. Each version is a patch on the one before unless a card in it is marked bump "minor" (a
// feature) or "major": the largest wins. A card still in review comes after the queue, "at the earliest".
// The guard keeps each card's last prediction from the queue and says CONFLICT when a card ships in another version,
// when one batch's cards ship in two, or when a ship's bump isn't its cards'.
import { repoOf, closed } from "./derive.mjs";
import { idText } from "./text.mjs";

export const BUMPS = ["patch", "minor", "major"];
const X = /^v?(\d+)\.(\d+)\.(\d+)$/;
const parts = (v) => { const m = X.exec(String(v ?? "")); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
const cmp = (a, b) => { const x = parts(a), y = parts(b); for (let k = 0; k < 3; k++) if (x[k] !== y[k]) return x[k] - y[k]; return 0; };
const bumpRank = (b) => Math.max(0, BUMPS.indexOf(b));
const cardBump = (k) => (BUMPS.includes(k?.bump) ? k.bump : "patch");

// v plus one bump: patch +0.0.1, minor +0.1.0 (patch 0), major +1.0.0 (minor and patch 0).
export function bumped(v, bump) {
  const [a, b, c] = parts(v);
  return bump === "major" ? `${a + 1}.0.0` : bump === "minor" ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;
}

// The bump that took from to to, or null when to isn't above from.
export function bumpOf(from, to) {
  const x = parts(from), y = parts(to);
  if (!x || !y || cmp(to, from) <= 0) return null;
  return y[0] !== x[0] ? "major" : y[1] !== x[1] ? "minor" : "patch";
}

// The version a ship run's candidate branch names (build/ship-v1.158.15), or null.
export function runVersion(branch) {
  const m = /(\d+\.\d+\.\d+)/.exec(String(branch ?? ""));
  return m ? m[1] : null;
}

// cards: the board's cards; derived: { id: derived phase }; live: { version, mainVersion } (either may be missing);
// runOf: { id: the candidate branch of the run shipping it now }. Returns { id: expected }: { version, shipping: true }
// for a card in the run on now; { version, place, with: [ids], bump } in the queue; { version, earliest: true, bump }
// in review. Nothing for a card building, already with its version, in another repository, or when no base is known.
export function expectedVersions({ cards, derived, live, runOf = {}, config }) {
  const c = config.collector, keys = config.phases.map((p) => p[0]);
  const at = (p) => keys.indexOf(p);
  const known = [live?.version, live?.mainVersion, ...Object.values(runOf).map(runVersion)].filter((v) => parts(v));
  if (!known.length) return {};
  const base = known.reduce((a, b) => (cmp(a, b) >= 0 ? a : b));
  const open = cards.filter((k) => k && !closed(k) && derived[k.id] && !repoOf(k, config));
  const out = {};
  for (const k of open) {
    const d = derived[k.id], v = runVersion(runOf[k.id]);
    if (d.shipping && !d.version && v) out[k.id] = { version: v, shipping: true };
  }
  const queue = open.filter((k) => { const d = derived[k.id]; return d.phase === c.shipPhase && !d.version && !d.shipping && d.firm !== false; })
    .sort((a, b) => (derived[a.id].readyAt ?? Infinity) - (derived[b.id].readyAt ?? Infinity) || (a.id < b.id ? -1 : 1));
  const groups = [], byBatch = new Map();
  for (const k of queue) {
    const name = typeof k.batch === "string" && k.batch ? k.batch : null;
    if (name && byBatch.has(name)) { byBatch.get(name).push(k); continue; }
    const g = [k];
    groups.push(g);
    if (name) byBatch.set(name, g);
  }
  let v = base;
  groups.forEach((g, n) => {
    const bump = BUMPS[Math.max(...g.map((k) => bumpRank(cardBump(k))))];
    v = bumped(v, bump);
    for (const k of g) out[k.id] = { version: v, place: n + 1, with: g.filter((o) => o !== k).map((o) => o.id), bump };
  });
  for (const k of open) {
    const d = derived[k.id], p = at(d.phase);
    if (d.firm === false || d.version || d.shipping || (c.lanePhases ?? []).includes(d.phase) || !(p > at(c.buildPhase) && p < at(c.shipPhase))) continue;
    out[k.id] = { version: bumped(v, cardBump(k)), earliest: true, bump: cardBump(k) };
  }
  return out;
}

const ref = (k) => (Number.isInteger(k.num) ? `#C${k.num}` : idText(k.id));
const broken = (k, got, due, now) => `${ref(k)} ${now ? "is shipping" : "shipped"} in v${got} but was due in v${due} (the order changed after it was predicted, or the bump differed). Manager: say which is right.`;

// One run of the guard. expected: this run's expectedVersions; versions: the versions the main line names, oldest first;
// state: the last run's ({ due: { id: version }, broke: { id: line } }). Only a queue place is a prediction (the run's
// own version would always agree with itself; a review's is "at the earliest"). A broken one is said every run while
// its card is open, like every other conflict. Returns { lines, state }.
export function guardExpected({ cards, derived, expected, versions = [], state = {} }) {
  const open = new Map(cards.filter((k) => k && !closed(k)).map((k) => [k.id, k]));
  const due = Object.fromEntries(Object.entries(state.due ?? {}).filter(([id]) => open.has(id)));
  const broke = Object.fromEntries(Object.entries(state.broke ?? {}).filter(([id]) => open.has(id)));
  for (const [id, k] of open) {
    const got = derived[id]?.version ?? (expected[id]?.shipping ? expected[id].version : null);
    if (!got || !due[id]) continue;
    if (String(got).replace(/^v/, "") !== due[id]) broke[id] = broken(k, String(got).replace(/^v/, ""), due[id], !derived[id]?.version);
    if (derived[id]?.version) delete due[id];
  }
  for (const [id, e] of Object.entries(expected)) if (open.has(id) && Number.isInteger(e.place)) due[id] = e.version;
  const lines = [...open.keys()].filter((id) => broke[id]).map((id) => broke[id]);
  // A batch is one version.
  const batches = new Map();
  for (const k of open.values()) if (typeof k.batch === "string" && k.batch && parts(derived[k.id]?.version)) (batches.get(k.batch) ?? batches.set(k.batch, []).get(k.batch)).push(k);
  for (const [name, ks] of batches) if (new Set(ks.map((k) => derived[k.id].version)).size > 1)
    lines.push(`batch ${idText(name)} shipped in two versions: ${ks.map((k) => `${ref(k)} in v${derived[k.id].version}`).join(", ")}. Manager: one batch is one version.`);
  // A ship's bump is its cards' largest.
  const shipped = new Map();
  for (const k of open.values()) { const v = derived[k.id]?.version; if (parts(v)) (shipped.get(v) ?? shipped.set(v, []).get(v)).push(k); }
  const line = versions.filter((v) => parts(v));
  for (const [v, ks] of shipped) {
    const before = line.filter((o) => cmp(o, v) < 0);
    if (!before.length) continue;
    const went = bumpOf(before.reduce((a, b) => (cmp(a, b) >= 0 ? a : b)), v);
    const want = BUMPS[Math.max(...ks.map((k) => bumpRank(cardBump(k))))];
    if (went && went !== want) lines.push(`v${v} went out as a ${went} but ${ks.map((k) => `${ref(k)} is marked ${cardBump(k)}`).join(", ")}. Manager: say which is right.`);
  }
  return { lines, state: { due, broke } };
}
