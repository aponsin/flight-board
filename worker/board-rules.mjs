// Board store write rules (#C719, docs/DATA.md "Refuse early"): every write is checked in the same call and refused with
// { rule, detail }; the Worker logs each refusal (rule, card, time) to the refusals table. Pure functions, no I/O.
// A check returns null when the write is allowed.

export const ASK_TYPES = ["Decision", "Action", "Terminal", "SessionStart", "Later", "Approval", "Answer", "Thread"];
// The language review's key is "language" (its label is Linguist): the board config's phase key, which the probe reads and writes.
export const PHASES = ["plan", "build", "test", "language", "design", "checker", "security", "ship", "live", "pack", "install", "review", "approve", "merge"];
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

// The 16 roles that may use the shared connector (#T1659, the owner's pick A). Never "owner", never the probe.
export const ROSTER_ROLES = ["Builder", "Admin", "Demos", "Mainsite", "Linguist", "Designer", "Checker", "Security", "Release", "Manager", "Boardsmith", "Reviewer", "Steward", "Ops", "Triage", "Sales"];

// Closing an ask: it must exist and be open; only the owner, or the agent that asked it, may close it (the import closes in the
// owner's name, for an ask the old board has since resolved); a Decision, Answer or Approval must have been answered first. A
// closed ask's thread is closed with it.
// The owner is a ROLE, never a name: a caller whose role is not "owner" is the owner's under no name (Security's nit 1 on v11), and
// one that names itself "owner" without the role is refused even as the asker.
export function closeRefusal(ask, who, role) {
  if (!ask) return refuse("ask-unknown", "no such ask");
  if (ask.closed_at) return refuse("ask-already-closed", String(ask.id));
  if (role !== "owner" && (who === "owner" || who !== ask.asked_by)) return refuse("close-not-yours", `${who ?? "unknown"} did not ask ${ask.id}; only the owner or the asker closes it`);
  if (["Decision", "Answer", "Approval"].includes(ask.type) && !ask.answered_at) return refuse("close-unanswered", `a ${ask.type} is answered before it is closed`);
  return null;
}

// A To-do or Ideas row (the owner's two lists). Words only: a kind (todo or idea, set when it is made), the text, an area, an
// optional category, a note, a rank, done. No trigger and no ETA: a to-do is not a Later ask.
const LIST_WORDS = new Set(["id", "kind", "text", "area", "category", "note", "rank", "done"]);
export function listWriteRefusal(fields, { create = false } = {}) {
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return refuse("list-shape", "a list row is an object");
  const unknown = Object.keys(fields).filter((k) => !LIST_WORDS.has(k));
  if (unknown.length) return refuse("unknown-field", unknown.join(", "));
  if (create) {
    if (!["todo", "idea"].includes(fields.kind)) return refuse("list-kind", "kind is todo or idea");
    if (fields.id !== undefined) return refuse("list-id", "the store names a new row");
  } else if (fields.kind !== undefined) return refuse("list-kind", "a row's kind does not change");
  if ((create || fields.text !== undefined) && !(typeof fields.text === "string" && fields.text.trim() && fields.text.length <= 2000)) return refuse("list-text", "text is 1 to 2000 characters");
  for (const [k, max] of [["area", 200], ["category", 200], ["note", 4000]]) if (fields[k] !== undefined && fields[k] !== null && !(typeof fields[k] === "string" && fields[k].length <= max)) return refuse("list-text", `${k} is text up to ${max} characters`);
  if (fields.rank !== undefined && fields.rank !== null && !(Number.isInteger(fields.rank) && fields.rank >= 0 && fields.rank <= 1_000_000)) return refuse("list-rank", "rank is a whole number from 0 to 1000000");
  if (fields.done !== undefined && ![0, 1, true, false].includes(fields.done)) return refuse("list-done", "done is true or false");
  return null;
}

// Card words: only these fields are typed; status, phase, evidence and numbers are never written by a session.
const CARD_WORDS = new Set(["id", "title", "summary", "size", "review_level", "from_thread", "track", "owner_role", "next_note", "waiting_on", "blocked_reason", "paused", "dropped", "rework_reason", "customer_text", "look_change", "skip"]);
const CARD_FORBIDDEN = new Set(["status", "phase", "num", "live_version", "signed", "on_main", "ci", "evidence"]);

export function cardWriteRefusal(fields, evidence) {
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return refuse("card-shape", "card words are an object");
  const typed = Object.keys(fields).filter((k) => CARD_FORBIDDEN.has(k));
  if (typed.length) return refuse("only-probe-writes-status", typed.join(", "));
  const unknown = Object.keys(fields).filter((k) => !CARD_WORDS.has(k));
  if (unknown.length) return refuse("unknown-field", unknown.join(", "));
  if (fields.rework_reason !== undefined && !REWORK_REASONS.includes(fields.rework_reason)) return refuse("rework-reason", `one of ${REWORK_REASONS.join(", ")}`);
  for (const k of ["customer_text", "look_change"]) if (fields[k] !== undefined && fields[k] !== null && ![0, 1, true, false].includes(fields[k])) return refuse("card-flag", `${k} is true or false`);
  // The old board's skip lists also carry words that are no phase of ours (such as "look"); state.mjs ignores a word it does not know,
  // so the store keeps a list of plain lowercase words as it is and refuses anything else (it never rewrites an old card's list).
  if (fields.skip !== undefined && fields.skip !== null && !(Array.isArray(fields.skip) && fields.skip.length <= 16 && fields.skip.every((p) => typeof p === "string" && /^[a-z]{2,20}$/.test(p)))) return refuse("card-skip", "skip is a list of up to 16 lowercase words, such as language or security");
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

// Phase history (#C723 B3b): who a phase change is put down to when no agent is working on the card at that moment: the phase's lane
// role; the early phases (and any not named here) belong to the card's own owner_role.
export const PHASE_LANES = { language: "Linguist", design: "Designer", checker: "Checker", security: "Security", ship: "Release", live: "Release", pack: "Release", install: "Release" };
// The rows one lit-phase change adds: the old phase ends and the new one starts at `at`. `prev` null (first reading) only starts.
// The old step log put the same `who` on a phase's end as on its start; prevWho is the start's.
export function historyRows(cardId, prev, next, at, who, prevWho = null) {
  if (prev === next) return [];
  return [...(prev ? [{ card_id: cardId, phase: prev, kind: "end", at, who: prevWho }] : []), { card_id: cardId, phase: next, kind: "start", at, who }];
}
// The role to put a phase on: an agent the `agents` evidence shows working on this card now, else the phase's lane, else the owner.
export function whoForPhase(cardId, phase, agents, ownerRole) {
  const working = Object.entries(agents && typeof agents === "object" ? agents : {}).find(([, a]) => a && a.state === "working" && a.card === cardId);
  return working ? working[0] : PHASE_LANES[phase] ?? ownerRole ?? null;
}

// "Live now": only the probe's reading of /version.json counts, and a reading older than 3 min is stale, never live.
export const STALE_AFTER_MS = 3 * 60_000;
export function liveNow(reading, now) {
  if (!reading || typeof reading.version !== "string" || !Number.isFinite(reading.readAt)) return { state: "unknown", age: null };
  const age = Math.max(0, now - reading.readAt);
  return { state: age > STALE_AFTER_MS ? "stale" : "live", version: reading.version, age };
}
