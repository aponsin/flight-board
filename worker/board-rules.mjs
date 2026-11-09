// Board store write rules (#C719, docs/DATA.md "Refuse early"): every write is checked in the same call and refused with
// { rule, detail }; the Worker logs each refusal (rule, card, time) to the refusals table. Pure functions, no I/O.
// A check returns null when the write is allowed.

export const ASK_TYPES = ["Decision", "Action", "Terminal", "SessionStart", "Later", "Approval", "Answer", "Thread"];
export const PHASES = ["plan", "build", "test", "linguist", "design", "checker", "security", "ship", "live", "pack", "install", "review", "approve", "merge"];
export const REWORK_REASONS = ["bug found in test", "review findings", "design change", "security finding", "owner change"];

// What each ask type must carry (parts of the ask body), per DATA.md "Ask types".
export const ASK_PARTS = {
  Decision: ["question", "options", "recommended"],
  Action: ["steps", "expect"],
  Terminal: ["commands"],
  SessionStart: ["words"],
  Later: ["text"],
  Approval: ["card", "version"],
  Answer: ["question"],
  Thread: ["text"],
};
const ASK_ALLOWED = new Set(["type", "title", "asked_by", "card_id", "eta_at", "eta_precondition", ...Object.values(ASK_PARTS).flat(), "screenshots"]);

const refuse = (rule, detail) => ({ rule, detail });
const present = (v) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "") && !(Array.isArray(v) && v.length === 0);

// An ask missing a required part, an unknown field, or a Later without an ETA.
export function askRefusal(ask, now) {
  if (ask === null || typeof ask !== "object" || Array.isArray(ask)) return refuse("ask-shape", "an ask is an object");
  if (!ASK_TYPES.includes(ask.type)) return refuse("ask-type", `type is one of ${ASK_TYPES.join(", ")}`);
  const unknown = Object.keys(ask).filter((k) => !ASK_ALLOWED.has(k));
  if (unknown.length) return refuse("unknown-field", unknown.join(", "));
  for (const k of ["title", "asked_by"]) if (!present(ask[k])) return refuse("ask-missing-part", k);
  for (const k of ASK_PARTS[ask.type]) if (!present(ask[k])) return refuse("ask-missing-part", `${ask.type} needs ${k}`);
  if (ask.type === "Decision") {
    if (!Array.isArray(ask.options) || ask.options.length < 2 || ask.options.length > 4) return refuse("ask-missing-part", "Decision needs 2 to 4 options");
    if (!ask.options.includes(ask.recommended)) return refuse("ask-missing-part", "recommended must be one of the options");
  }
  if (ask.type === "Later") {
    const dated = Number.isFinite(ask.eta_at) && ask.eta_at > 0;
    if (!dated && !(present(ask.eta_precondition) && Number.isFinite(ask.eta_at))) return refuse("later-without-eta", "a date, or a precondition plus its expected date");
    if (Number.isFinite(now) && ask.eta_at < now - 60_000) return refuse("later-without-eta", "the ETA is in the past");
  }
  return null;
}

// Card words: only these fields are typed; status, phase, evidence and numbers are never written by a session.
const CARD_WORDS = new Set(["id", "title", "summary", "size", "review_level", "from_thread", "track", "owner_role", "next_note", "waiting_on", "blocked_reason", "paused", "dropped", "rework_reason"]);
const CARD_FORBIDDEN = new Set(["status", "phase", "num", "live_version", "signed", "on_main", "ci", "evidence"]);

export function cardWriteRefusal(fields, evidence) {
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return refuse("card-shape", "card words are an object");
  const typed = Object.keys(fields).filter((k) => CARD_FORBIDDEN.has(k));
  if (typed.length) return refuse("only-probe-writes-status", typed.join(", "));
  const unknown = Object.keys(fields).filter((k) => !CARD_WORDS.has(k));
  if (unknown.length) return refuse("unknown-field", unknown.join(", "));
  if (fields.rework_reason !== undefined && !REWORK_REASONS.includes(fields.rework_reason)) return refuse("rework-reason", `one of ${REWORK_REASONS.join(", ")}`);
  if ((fields.blocked_reason !== undefined || fields.paused === 1 || fields.paused === true) && !present(fields.next_note)) {
    return refuse("blocked-needs-note", "Blocked or Paused needs a current next_note");
  }
  // A typed word that contradicts the probe's reading: Dropped on a card the probe reads as live.
  if ((fields.dropped === 1 || fields.dropped === true) && evidence?.phase === "live") return refuse("contradicts-evidence", "the probe reads this card as live");
  // Rework: a commit after a sign-off puts the card in Rework; until a reason is attached, other card writes are refused.
  if (evidence?.rework === true && !present(fields.rework_reason) && Object.keys(fields).some((k) => k !== "id" && k !== "rework_reason")) {
    return refuse("rework-reason-missing", "attach a rework_reason before other writes");
  }
  return null;
}

// Evidence: one lit phase per card, and only the probe writes it.
export function evidenceRefusal(key, value, who, track) {
  if (who !== "probe") return refuse("only-probe-writes-status", `${who ?? "unknown"} cannot write evidence`);
  if (typeof key !== "string" || !/^[a-z]+(\.[A-Za-z0-9._-]+)?$/.test(key)) return refuse("evidence-key", String(key));
  if (key.startsWith("cards.")) {
    const lit = value?.lit;
    if (!Array.isArray(lit) || lit.length !== 1) return refuse("one-lit-phase", `${key} has ${Array.isArray(lit) ? lit.length : 0} lit phases`);
    if (!PHASES.includes(lit[0])) return refuse("one-lit-phase", `unknown phase ${lit[0]}`);
    if (Array.isArray(track) && !track.includes(lit[0])) return refuse("one-lit-phase", `${lit[0]} is not a phase of this track`);
  }
  return null;
}

// "Live now": only the probe's reading of /version.json counts, and a reading older than 3 min is stale, never live.
export const STALE_AFTER_MS = 3 * 60_000;
export function liveNow(reading, now) {
  if (!reading || typeof reading.version !== "string" || !Number.isFinite(reading.readAt)) return { state: "unknown", age: null };
  const age = Math.max(0, now - reading.readAt);
  return { state: age > STALE_AFTER_MS ? "stale" : "live", version: reading.version, age };
}
