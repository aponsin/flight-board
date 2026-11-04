// One set of rules a card must meet (#C662). The gate asks it of every card write (a write may not bring in a problem the
// card did not have), the probe asks it of every open card each minute and writes the problems as red lines, and the page
// shows the line instead of silently picking a source. Pure: the card, the board's steps, the repository's reading and the
// config come in; a list of { code, text } comes out. Every text names the field or the step at fault.
import { liveCard } from "../collector/state-schema.mjs";
import { idText } from "../collector/text.mjs";

// Every field a card may carry. A write naming any other is refused with its name (invariant 6): a misspelt field was
// silently kept and read by nothing.
export const CARD_KEYS = new Set([
  "name", "summary", "phase", "status", "who", "size", "level", "wait", "kind", "num", "skip", "customerText", "lookChange", "plan",
  "nextNote", "nextNoteAt", "etaLive", "createdAt", "updatedAt", "doneAt", "phaseReason", "phaseLog", "version", "plannedVersion",
  "liveVersion", "versionOk", "thread", "repo", "branch", "waitingOn", "issues", "issuesAt", "nextAt", "bump", "checkedAt", "queuePos",
  "deployMin", "testsMin", "parent", "dropReason", "shipDetail", "doneWhen", "depends", "dependsOn", "batch", "deleted",
]);
const TYPED = ["phase", "status", "wait", "who", "size", "level", "kind"];
const gone = (v) => !!v && typeof v === "object" && v.__delete__ === true;

// The allowed values of a typed field, from the config (phase and who from the phases and the roster).
export function allowedFor(field, config) {
  if (field === "phase") return config.phases.map((p) => p[0]);
  if (field === "who") return [...(config.roster ?? []), ...(config.gate?.cardOwners ?? []), ...(config.owner ? [config.owner] : [])];
  return config.cardFields?.[field] ?? [];
}

// The problems in the fields of a card (or of the fields a write names): an unknown field, and a typed field outside its
// list, null included (a field is removed with {"__delete__": true}, never set to null). only: a write's data, to check
// just the fields it names and skip the ones it removes.
export function fieldProblems(card, config, { only = null } = {}) {
  const out = [];
  if (!card || typeof card !== "object") return out;
  for (const k of Object.keys(card)) {
    if (k === "id" || (only && gone(only[k]))) continue;
    if (!CARD_KEYS.has(k)) out.push({ code: `field:${k}`, text: `${idText(k)}: a card has no such field (a field the card schema does not name is refused); known fields: ${[...CARD_KEYS].join(", ")}` });
  }
  for (const f of TYPED) {
    if (!(f in card) || (only && gone(only[f]))) continue;
    const v = card[f], list = allowedFor(f, config);
    if (v === null) out.push({ code: `null:${f}`, text: `${f}: null is not a value (${list.length ? `use ${list.join(", ")}` : "no value is allowed on a card"}); remove the field with {"__delete__": true}` });
    else if (!list.includes(v)) out.push({ code: `value:${f}`, text: `${f}: ${JSON.stringify(String(v).slice(0, 40))} is not allowed (${list.length ? `use ${list.join(", ")}` : "no card carries this field; remove it with {\"__delete__\": true}"})` });
  }
  return out;
}

// The problems between a card and the board's evidence. steps: the board's steps (any card's); derived: the card's reading
// from the repository (derived/all) or null; live: the fresh live state or null.
export function stepProblems(card, { steps = [], derived = null, live = null, config }) {
  const out = [];
  const order = config.phases.map((p) => p[0]), c = config.collector;
  const at = (p) => order.indexOf(p), build = at(c.buildPhase);
  // A step names its card by id or by number (C700, as halfLive reads it).
  const mine = (Array.isArray(steps) ? steps : []).filter((s) => s && (s.init === card.id || (Number.isInteger(card.num) && s.init === `C${card.num}`)) && !s.wait);
  const label = card.num ? `#C${card.num}` : idText(card.id);
  if (card.status === "queued") {
    if (card.phase !== undefined && card.phase !== null && at(card.phase) > build) out.push({ code: "queued-phase", text: `status: ${label} is queued but its phase is ${idText(card.phase)}, past ${c.buildPhase}: a queued card is in ${order.slice(0, build + 1).join(" or ")}` });
    const worked = mine.filter((s) => at(s.phase) >= build).sort((a, b) => (a.at ?? 0) - (b.at ?? 0))[0];
    if (worked) out.push({ code: "queued-step", text: `status: ${label} is queued but has a ${idText(worked.kind)} step on ${idText(worked.phase)} (${idText(worked.who ?? "someone")}): a queued card has no step of its own; mark it active, or start it with "wait": "busy"` });
  }
  const skipsBuild = Array.isArray(card.skip) && card.skip.includes(c.buildPhase);
  if (card.phase && at(card.phase) > build && card.status !== "dropped" && !skipsBuild && !mine.some((s) => s.kind === "end" && s.phase === c.buildPhase)) {
    out.push({ code: "no-build-end", text: `phase: ${label} is on ${idText(card.phase)}, past ${c.buildPhase}, but has no ${c.buildPhase} end step: log steps/${idText(card.id)}-${c.buildPhase}-end-<now> first` });
  }
  if ((card.phase === c.shipPhase || card.phase === c.livePhase) && card.status !== "dropped") {
    const fresh = liveCard(live, card.id, config);
    const onMain = (fresh && fresh.onMain === true) || derived?.onMain === true || derived?.phase === c.livePhase;
    const note = [card.version, card.liveVersion].some((v) => typeof v === "string" && v.trim());
    if (!onMain && !note) out.push({ code: `no-ship-evidence:${card.phase}`, text: `phase: ${label} is on ${idText(card.phase)} but no commit of it is on ${c.mainBranch} and it names no release version: ship needs one of the two` });
  }
  return out;
}

// All problems of a card, for the probe (a stored card is read whole).
export const cardProblems = (card, ctx) => [...fieldProblems(card, ctx.config), ...stepProblems(card, ctx)];

// What a write brings in: the problems of the card as it will be that the card did not have before, by code. A problem the card
// already carried is the probe's red line, not a reason to refuse the fix that touches the card.
export function newProblems(after, before, ctx) {
  const had = new Set(before ? cardProblems(before, ctx).map((p) => p.code) : []);
  return cardProblems(after, ctx).filter((p) => !had.has(p.code));
}
