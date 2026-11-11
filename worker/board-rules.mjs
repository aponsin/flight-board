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
  // #C727 (parity C4): the owner's approval of one pull request at one commit; Release merges only that commit (README step 4).
  Approval: ["pr", "head", "url"],
  Answer: ["question"],
  Thread: ["text"],
};
// #C747: parts a type may carry besides the required ones. A Later ask keeps the steps and the expected result the old board gave it.
// #C748: and `where`, the line under the ask that says where to do it, on a Later and an Action.
export const ASK_OPTIONAL_PARTS = { Later: ["steps", "expect", "where"], Action: ["where"] };
const ASK_ALLOWED = new Set(["type", "title", "asked_by", "card_id", "eta_at", "eta_precondition", ...Object.values(ASK_PARTS).flat(), ...Object.values(ASK_OPTIONAL_PARTS).flat(), "screenshots"]);

const refuse = (rule, detail) => ({ rule, detail });
export const APPROVAL_ASKERS = ["Reviewer", "Manager"];
export const APPROVE = "Approve";
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}\/pull\/([1-9][0-9]{0,6})$/;
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
    // #C823: eta_at on a Decision is a "not before": the owner is not asked until then (Later until the date, Needs you from it). A time, in the
    // future when written (an import passes now = null: the date may be past by the time it runs); no precondition on a Decision.
    if (ask.eta_at !== undefined && (!Number.isFinite(ask.eta_at) || ask.eta_at <= 0 || (Number.isFinite(now) && ask.eta_at < now - 60_000))) return refuse("decision-not-before", "eta_at is a time, not in the past");
    if (ask.eta_precondition !== undefined) return refuse("decision-not-before", "a Decision takes eta_at (not before) and no precondition");
  }
  if (ask.type === "Action") { const bad = stepsRefusal(ask.steps, { needCmd: true }); if (bad) return bad; }
  if (ask.where !== undefined && (typeof ask.where !== "string" || !ask.where.trim() || ask.where.length > 300 || !(ask.type in ASK_OPTIONAL_PARTS && ASK_OPTIONAL_PARTS[ask.type].includes("where")))) return refuse("ask-missing-part", `${ask.type} where is a short line (a Later or an Action only)`);
  if (ask.type === "Approval") {
    // Asked by the role that signs pull requests (Reviewer) or the lead; for one pull request, at one full commit, with its own link.
    if (!APPROVAL_ASKERS.includes(ask.asked_by)) return refuse("approval-asker", `${ask.asked_by} cannot ask for an approval; ${APPROVAL_ASKERS.join(" or ")} can`);
    if (!Number.isInteger(ask.pr) || ask.pr < 1 || ask.pr > 1e6) return refuse("approval-shape", "pr is the pull request's number");
    if (typeof ask.head !== "string" || !/^[0-9a-f]{40}$/.test(ask.head)) return refuse("approval-shape", "head is the full 40-character commit id");
    const u = typeof ask.url === "string" ? PR_URL.exec(ask.url) : null;
    if (!u || Number(u[1]) !== ask.pr) return refuse("approval-shape", `url is https://github.com/<owner>/<repo>/pull/${ask.pr}`);
  }
  if (ask.type === "Later") {
    if (ask.steps !== undefined) { const bad = stepsRefusal(ask.steps); if (bad) return bad; }
    if (ask.expect !== undefined && !present(ask.expect)) return refuse("ask-missing-part", "Later expect is empty");
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
  // An Approval closes answered or not: closing never approves anything (a merged pull request, or one a newer head replaced).
  if (["Decision", "Answer"].includes(ask.type) && !ask.answered_at) return refuse("close-unanswered", `a ${ask.type} is answered before it is closed`);
  return null;
}

// The owner's answer in full (#C725 B2): the button he pressed (status), the note beside it, and "something else" on a Decision.
// chose = an option (with an optional note); other = "something else" (a Decision, the note says what); done and help = an action,
// terminal, session start or later (help needs its note); ack = an answer or thread (a note is a follow-up). Returns null when fine.
export const ANSWER_NOTE_MAX = 2000;
const STATUS_OF_TYPE = { Decision: ["chose"], Answer: ["ack"], Thread: ["ack"], Action: ["done", "help", "ack"], Terminal: ["done", "help", "ack"], SessionStart: ["done", "help", "ack"], Later: ["done", "help", "ack"] };
export function answerShapeRefusal(ask, { status, note, other, hasFiles } = {}) {
  const allowed = STATUS_OF_TYPE[ask.type] ?? [];
  if (!allowed.includes(status)) return refuse("answer-status", `${ask.type} is answered with ${allowed.join(" or ") || "Approve only"}, not ${String(status).slice(0, 20)}`);
  if (note !== undefined && !(typeof note === "string" && note.length <= ANSWER_NOTE_MAX)) return refuse("answer-shape", `a note is text up to ${ANSWER_NOTE_MAX} characters`);
  if (other !== undefined && typeof other !== "boolean") return refuse("answer-shape", "other is true or false");
  if (other && ask.type !== "Decision") return refuse("answer-shape", "only a Decision has a something-else answer");
  const text = typeof note === "string" ? note.trim() : "";
  if ((other || status === "help") && !text && !hasFiles) return refuse("answer-needs-note", "say in a few words what you want, or attach a file");
  return null;
}

// An agent's message may carry a kind (a short lower-case word, as the page draws it) and, with the kind "decision", two to four
// options {key A to D, label}: the page shows them as buttons under the message, and the owner's pick is his own message
// ("Chose A: Red"). The owner's messages carry neither (#C725 B1b). Returns null when fine.
const MESSAGE_KIND = /^[a-z][a-z-]{0,19}$/;
export function messageExtrasRefusal(m, who) {
  if (m.kind === undefined && m.options === undefined) return null;
  if (who === "owner") return refuse("message-shape", "the owner's message carries no kind or options");
  if (m.kind !== undefined && !(typeof m.kind === "string" && MESSAGE_KIND.test(m.kind))) return refuse("message-shape", "kind is a short lower-case word");
  if (m.options !== undefined) {
    if (m.kind !== "decision") return refuse("message-shape", "options go with the kind decision");
    const o = m.options;
    if (!Array.isArray(o) || o.length < 2 || o.length > 4) return refuse("message-options", "two to four options");
    const keys = new Set();
    for (const x of o) {
      const ok = x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).every((k) => k === "key" || k === "label") && /^[A-D]$/.test(x.key) && typeof x.label === "string" && x.label.trim() && x.label.length <= 200 && !keys.has(x.key);
      if (!ok) return refuse("message-options", "each option is {key: A to D, once; label: 1 to 200 characters}");
      keys.add(x.key);
    }
  }
  return null;
}

// #C855 (principle 8: the owner's part is exact, never a line to retype): a step that names the exact text the owner must type, paste or say
// (`Type: go, ship 1.87.0`, `Paste: <link>`, `Say "go ahead"`) carries that text in its cmd, which the page shows with a Copy button. Only a step
// that NAMES a text is held to it (Checker, on the 1,428 real steps of 415 Action asks: a step with no text named, such as "paste what it printed
// here", is the board's way to get output back, and "it should say X" is expected output; neither can be put in a cmd). The verb is an
// instruction: at the start of the step or after a sentence break, a comma, "then" or an opening bracket, then a colon or an opening quote.
const NAMED = /(?:^|[.;!?]\s+|\bthen\s+|[,(]\s*)(?:type|paste|say)\b\s*(?::\s*|["\u201c'`]\s*)([^"\u201d'`\n]+?)\s*(?:["\u201d'`]|$)/i;
export function typedWithoutCmd(step) {
  const text = typeof step === "string" ? step : step && typeof step.text === "string" ? step.text : "";
  if (!NAMED.test(text)) return false;
  // A step that names a text needs a cmd that is not blank. The cmd is not matched against the words after the colon: the sentence can go on
  // there ("type: yes, then press Enter"), so no part of it can be told apart from the text (Checker, F1).
  const cmd = step && typeof step === "object" && typeof step.cmd === "string" ? step.cmd : "";
  return !cmd.trim();
}
// An Action's steps: plain text, or {text, cmd} where cmd is a command the page shows with a Copy button.
export function stepsRefusal(steps, { needCmd = false } = {}) {
  if (!Array.isArray(steps) || steps.length > 30) return refuse("ask-missing-part", "steps are a list of at most 30");
  for (const s of steps) {
    const ok = typeof s === "string" ? s.length <= 2000 : s && typeof s === "object" && !Array.isArray(s) && Object.keys(s).every((k) => k === "text" || k === "cmd") && typeof s.text === "string" && s.text.length <= 2000 && (s.cmd === undefined || (typeof s.cmd === "string" && s.cmd.length <= 4000));
    if (!ok) return refuse("steps-shape", "a step is text, or {text, cmd} with the command as text");
    if (needCmd && typedWithoutCmd(s)) return refuse("step-types-without-cmd", "a step that tells the owner to type, paste or say something carries that exact text in its cmd (the Copy box)");
  }
  return null;
}

// #C859: the stack switch of one repository. The owner's alone: an agent, the probe and Manager are refused, whatever they claim. A repository is a
// short lower-case word (board, product); the switch is a true or false.
export const STACK_REPO = /^[a-z][a-z0-9-]{0,30}$/;
export function stackSwitchRefusal(b, who) {
  if (who !== "owner") return refuse("stack-switch-owner", `${who ?? "unknown"} cannot set a stack switch; only the owner can`);
  if (b === null || typeof b !== "object" || Array.isArray(b) || Object.keys(b).some((k) => k !== "repo" && k !== "stack")) return refuse("stack-switch-shape", "a stack switch is {repo, stack}");
  if (typeof b.repo !== "string" || !STACK_REPO.test(b.repo)) return refuse("stack-switch-shape", "repo is a short lower-case word");
  if (typeof b.stack !== "boolean") return refuse("stack-switch-shape", "stack is true or false");
  return null;
}

// #C871: an agent's queue is in an order the owner sets. A card the owner has placed (queue_set_by "owner") keeps its place against an agent's
// write: the Worker refuses it by program, whoever the agent is, the lead included. The owner moves a card that has not started up or down.
// `floor` is the last place the owner holds in the card's queue (0 when he holds none): an agent's write may not put a card at or ahead of it
// (Checker F1 on ac3d31b: an older unplaced card written to place 1 tied the owner's first card, and the number tie-break woke the agent's pick).
export function queueWriteRefusal(fields, card, who, floor = 0) {
  if (who === "owner" || !fields || !("queue_pos" in fields)) return null;
  if (card?.queue_set_by === "owner") return refuse("queue-owner-set", `${who ?? "unknown"} cannot move a card the owner has placed in the queue (its order was set by the owner)`);
  // Only a valid place (1 to 999) is held to the floor; a malformed one is refused by the card shape rule (card-queue) as before.
  if (Number.isInteger(fields.queue_pos) && fields.queue_pos >= 1 && fields.queue_pos <= floor) return refuse("queue-owner-set", `${who ?? "unknown"} cannot put a card at place ${fields.queue_pos}: the owner holds the queue up to place ${floor}; ${floor + 1} or later is open`);
  return null;
}
// The order of an agent's queue, one rule for the store, the dispatch and the page: a card held by a depends_on after those that can start (Checker F2),
// then by queue_pos (none last), a card the owner placed before one an agent placed at the same place (F1), then by number.
export const QUEUE_NONE = 1e6;
export function queueRank(a, b) {
  return (a.held ? 1 : 0) - (b.held ? 1 : 0) || (a.queue_pos ?? QUEUE_NONE) - (b.queue_pos ?? QUEUE_NONE) || (a.owner ? 0 : 1) - (b.owner ? 0 : 1) || (a.num ?? 1e9) - (b.num ?? 1e9) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export function queueMoveRefusal(b, who) {
  if (who !== "owner") return refuse("queue-move-owner", `${who ?? "unknown"} cannot reorder a queue by the owner's hand; only the owner can`);
  if (b === null || typeof b !== "object" || Array.isArray(b) || Object.keys(b).some((k) => k !== "id" && k !== "dir")) return refuse("queue-move-shape", "a queue move is {id, dir}");
  if (typeof b.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(b.id)) return refuse("queue-move-shape", "id is a card id");
  if (b.dir !== "up" && b.dir !== "down") return refuse("queue-move-shape", "dir is up or down");
  return null;
}

// Withdrawing the owner's approval (#C727): the owner's alone, on an open Approval that is approved. It clears the answer, so the
// pull request needs his Approve again; Release reads only an approval that stands.
export function withdrawRefusal(ask, role) {
  if (role !== "owner") return refuse("withdraw-not-owner", "only the owner withdraws an approval");
  if (!ask) return refuse("ask-unknown", "no such ask");
  if (ask.type !== "Approval") return refuse("withdraw-not-approval", `${ask.id} is a ${ask.type}`);
  if (ask.closed_at) return refuse("ask-already-closed", String(ask.id));
  if (!ask.answered_at) return refuse("withdraw-not-approved", `${ask.id} is not approved`);
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
const CARD_WORDS = new Set(["id", "title", "summary", "size", "review_level", "from_thread", "track", "owner_role", "next_note", "waiting_on", "blocked_reason", "paused", "dropped", "rework_reason", "customer_text", "look_change", "skip", "depends_on", "issues", "queue_pos", "check_at", "repo", "batch", "bump", "hold_end"]);
export const ISSUE_KINDS = ["bugs", "security", "language", "design", "owner"];
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
  // #C729 B4a: what the card waits on, its issue counts and its place in its owner's queue.
  if (fields.depends_on !== undefined && fields.depends_on !== null && !(Array.isArray(fields.depends_on) && fields.depends_on.length <= 8 && fields.depends_on.every((c) => typeof c === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(c)) && new Set(fields.depends_on).size === fields.depends_on.length)) return refuse("card-depends", "depends_on is a list of up to 8 different card ids");
  if (fields.issues !== undefined && fields.issues !== null && !(typeof fields.issues === "object" && !Array.isArray(fields.issues) && Object.entries(fields.issues).every(([k, v]) => ISSUE_KINDS.includes(k) && Number.isInteger(v) && v >= 0 && v <= 99))) return refuse("card-issues", `issues is counts from 0 to 99 for ${ISSUE_KINDS.join(", ")}`);
  if (fields.queue_pos !== undefined && fields.queue_pos !== null && !(Number.isInteger(fields.queue_pos) && fields.queue_pos >= 1 && fields.queue_pos <= 999)) return refuse("card-queue", "queue_pos is a whole number from 1 to 999");
  // #C731 B4b: the repository a card lives in, the batch it ships with, and its bump: what its expected version is worked out from.
  for (const f of ["repo", "batch"]) if (fields[f] !== undefined && fields[f] !== null && !(typeof fields[f] === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(fields[f]))) return refuse(`card-${f}`, `${f} is lower case letters, digits and -, up to 40`);
  if (fields.bump !== undefined && fields.bump !== null && !["patch", "minor", "major"].includes(fields.bump)) return refuse("card-bump", "bump is patch, minor or major");
  // #C731 B4b: the done-test hold, a time in ms (2020 to 2100), or null to lift it.
  if (fields.check_at !== undefined && fields.check_at !== null && !(Number.isInteger(fields.check_at) && fields.check_at >= 1577836800000 && fields.check_at <= 4102444800000)) return refuse("card-check", "check_at is a time in milliseconds, or null to lift the hold");
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

// holds-need-an-end (#C838, prevention for #T1761: #C826 sat silent because stalledWaits skips any card with a hold, and its hold had no end).
// A hold is waiting_on or blocked_reason with words in it. Its end is the card's check_at (a time) or hold_end (the id of an ask or a card
// whose closing ends it). A write that SETS a hold must leave the card with an end (this write's or one already there), else it is refused
// in the same call. holdEndRefusal is pure: `fields` is the write, `existing` the card's row (null for a new card).
export const HOLD_NO_END_AFTER_MS = 2 * 3_600_000;
const heldWord = (v) => typeof v === "string" && v.trim() !== "";
export const isHeld = (c) => !!c && (heldWord(c.waiting_on) || heldWord(c.blocked_reason));
export function holdEndRefusal(fields, existing) {
  if (fields.hold_end !== undefined && fields.hold_end !== null && !(typeof fields.hold_end === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(fields.hold_end))) return refuse("hold-end-shape", "hold_end is the id of an ask or a card, or null");
  // A blocked card must keep an end: refused when the write sets a blocked_reason, or strips the end (check_at or hold_end) of a blocked card, and leaves none.
  // A waiting_on gets its end from the store (autoHoldEnd). A write that touches none of the three is never refused for an older hold with no end.
  const blocked = "blocked_reason" in fields ? fields.blocked_reason : existing?.blocked_reason;
  if (!heldWord(blocked) || !("blocked_reason" in fields || "check_at" in fields || "hold_end" in fields)) return null;
  if (hasExplicitEnd(fields, existing)) return null;
  return refuse("hold-needs-end", "a blocked_reason needs an end: check_at, or hold_end (the id of an ask or card whose closing ends it)");
}
// The explicit end a card ends up with after a write: its check_at (a time) or hold_end (an id).
export function hasExplicitEnd(fields, existing) {
  const at = "check_at" in fields ? fields.check_at : existing?.check_at, ref = "hold_end" in fields ? fields.hold_end : existing?.hold_end;
  return (Number.isInteger(at) && at > 0) || heldWord(ref);
}
// A waiting_on written with no end (the lead's routine "next is") is given one by the store: now + 2 h, kept in hold_until. null when the write sets no
// waiting_on, sets a blocked_reason (which brings its own end) or the card already has an explicit end.
export function autoHoldEnd(fields, existing, now) {
  return heldWord(fields.waiting_on) && !heldWord(fields.blocked_reason) && !hasExplicitEnd(fields, existing) ? now + HOLD_NO_END_AFTER_MS : null;
}
// Held cards that need Manager: `endsPassed` is the Set of hold_end ids whose closing has happened (the ask is closed, the card is dropped or live).
// (b) a hold whose end has passed: "#Cn held on <reason>, its end has passed: lift or renew"; (c) a hold with no end for 2 h (counted from
// held_at, else the card's updated_at): "#Cn held on <reason>, no end set after 2 h: lift it or give it an end". One row per (card, reason).
const zDay = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z`;
export function heldWakes({ now, cards, endsPassed }) {
  const out = [];
  for (const c of cards ?? []) {
    if (!Number.isInteger(c.num) || c.dropped || !isHeld(c)) continue;
    const why = String(heldWord(c.blocked_reason) ? c.blocked_reason : c.waiting_on).trim().replace(/\s+/g, " ").slice(0, 80);
    const timed = Number.isInteger(c.check_at) && c.check_at > 0, ref = heldWord(c.hold_end) ? c.hold_end : null, until = Number.isInteger(c.hold_until) && c.hold_until > 0 ? c.hold_until : null;
    if (timed || ref || until) { // an explicit end (check_at, hold_end) wins over the one the store gave (hold_until)
      const passed = timed || ref ? (timed && c.check_at <= now) || (ref && endsPassed?.has(ref)) : until <= now;
      // The end is in the reason (the row is keyed by card and reason): a hold renewed with the same words and a new end wakes Manager again when that one passes.
      const endTxt = timed ? zDay(c.check_at) : ref ? ref : zDay(until);
      if (passed) out.push({ card_id: c.id, num: c.num, reason: `#C${c.num} held on ${why}, its end has passed: lift or renew (end ${endTxt})` });
      continue;
    }
    const since = Number.isFinite(c.held_at) ? c.held_at : c.updated_at;
    if (Number.isFinite(since) && now - since >= HOLD_NO_END_AFTER_MS) out.push({ card_id: c.id, num: c.num, reason: `#C${c.num} held on ${why}, no end set after 2 h: lift it or give it an end (held since ${zDay(since)})` });
  }
  return out;
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
// The step tool (after B4b): an agent writes a start or an end of a WAIT at a phase for a card (the old step log's wait column). The refusal for
// one call: the card id, the phase, kind, wait and time. `who` is never an argument: the store takes it from who authenticated.
export const STEP_WAITS = ["busy", "gate", "decision"], STEP_PAST_MS = 7 * 86_400_000, STEP_FUTURE_MS = 60_000;
export function stepRefusal(a, now) {
  const refuse = (rule, detail) => ({ rule, detail });
  if (a === null || typeof a !== "object" || Array.isArray(a)) return refuse("step-shape", "a step is an object");
  const unknown = Object.keys(a).filter((k) => !["init", "phase", "kind", "wait", "at"].includes(k));
  if (unknown.length) return refuse("unknown-field", unknown.join(", "));
  if (typeof a.init !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(a.init)) return refuse("step-card", "init is a card id");
  if (!PHASES.includes(a.phase)) return refuse("step-phase", `phase is one of ${PHASES.join(", ")}`);
  if (!["start", "end"].includes(a.kind)) return refuse("step-kind", "kind is start or end");
  // Only waits: the probe alone says which phase is lit, so a step with no wait (a work phase) is refused. An end carries the wait of its start.
  if (!STEP_WAITS.includes(a.wait)) return refuse("step-wait", `wait is ${STEP_WAITS.join(", ")}: the tool logs waits, never a work phase`);
  if (a.at !== undefined && !(Number.isInteger(a.at) && a.at >= now - STEP_PAST_MS && a.at <= now + STEP_FUTURE_MS)) return refuse("step-at", "at is a time in ms within the last 7 days, not in the future");
  return null;
}
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

// #C732 (the owner's pick A on #T1681, 11-09): "Stalled" for the wake covers every phase. A card that has waited STALL_AFTER_MS at its phase
// while that phase's agent is idle (and no agent works the card, no CI or ship run is going) is a stall, with a reason Manager reads:
// "#C730 waits at Checker 15 min, Checker idle since 04:40Z". The 15 min is the threshold crossed, so the reason is stable while the
// stall lasts and changes only with the phase, the agent or the time the agent went idle. The wait counts from the later of the phase's
// start and the agent going idle (a card queued behind a busy agent has not waited on an idle one). Exempt: a card that is dropped,
// paused, blocked, held on someone (waiting_on), or gated by an open ask; a live card (done); a card with no agent for its phase.
// #C828: a phase agent with NO open session (a role the `agents` reading does not list, while the reading lists others) is a stall too, counted
// from the phase's start: nobody is there to take the card, so waiting on an idle one would never fire. The reason says "no session". An empty or
// missing reading is a blind probe, never a stall: only a reading that lists someone says who is absent.
// Pure: cards = rows {id, num, owner_role, blocked_reason, paused, dropped, waiting_on}; evidence = {cardId: reading}; agents = the
// `agents` evidence; openAskCards = Set of card ids with an open ask; phaseStart = Map "<card>|<phase>" -> ms. Times are UTC ("Z").
export const STALL_AFTER_MS = 15 * 60_000;
const hhmmZ = (ms) => `${new Date(ms).toISOString().slice(11, 16)}Z`;
// #C846: whether a card waits for a card it depends on (depends_on, a JSON list of ids): one that is on the board, not dropped and not
// live. One the board does not have, or a dropped one, holds nothing (as the dispatch reads it, #C845).
export function dependsNotLive(c, cards, evidence) {
  let list = c.depends_on;
  if (typeof list === "string") { try { list = JSON.parse(list); } catch { return false; } }
  if (!Array.isArray(list)) return false;
  return list.some((d) => typeof d === "string" && d !== c.id && (cards ?? []).some((k) => k && k.id === d && !k.dropped) && evidence?.[d]?.lit?.[0] !== "live");
}
export function stalledWaits({ now, cards, evidence, agents, openAskCards, phaseStart }) {
  const out = [];
  const roster = agents && typeof agents === "object" ? agents : {};
  const working = new Set(Object.values(roster).filter((a) => a && a.state === "working" && typeof a.card === "string").map((a) => a.card));
  for (const c of cards ?? []) {
    if (!Number.isInteger(c.num) || c.dropped || c.paused || c.blocked_reason || c.waiting_on || openAskCards?.has(c.id) || working.has(c.id)) continue;
    const v = evidence?.[c.id], phase = v?.lit?.[0];
    // #C846: a card with no lit phase (nothing pushed to origin) whose owner has been idle 15 min is a stall of its own: nobody has
    // started it. It is not held, not behind a depends_on that is not live, not the lead's, and touched in the last 3 days (an old
    // card nobody has pushed for is not news). The owner's other cards do not matter: one at review and the rest queued still wake.
    if (phase === undefined || phase === null) {
      const o = typeof c.owner_role === "string" ? roster[c.owner_role] : null;
      if (!o || o.state !== "idle" || !Number.isFinite(o.since) || now - o.since < STALL_AFTER_MS) continue;
      if (c.owner_role === "Manager" || !/^[A-Za-z0-9 _-]{1,24}$/.test(c.owner_role) || isHeld(c) || c.hold_end || !Number.isFinite(c.updated_at) || now - c.updated_at > 3 * 24 * 3600e3) continue;
      if (dependsNotLive(c, cards, evidence)) continue;
      out.push({ card_id: c.id, num: c.num, phase: null, role: c.owner_role, reason: `#C${c.num}: nothing pushed, ${c.owner_role} idle since ${hhmmZ(o.since)}` });
      continue;
    }
    if (typeof phase !== "string" || phase === "live" || !PHASES.includes(phase)) continue;
    if (v.ci === "running" || v.ci === "queued" || v.shipping === true) continue;
    // #C737: a card of another repository (a repo word) that is on main and read at ship is waiting for the owner's deploy, not for Release:
    // it never wakes Manager as stalled.
    if (phase === "ship" && v.onMain === true && typeof c.repo === "string" && c.repo !== "") continue;
    // #C854: a signed tip that no longer continues main cannot be landed as it is: Release cannot take it, so the wait is its builder's (re-cut).
    const behind = phase === "ship" && v.onMain !== true && v.behindMain === true;
    const role = behind ? c.owner_role : PHASE_LANES[phase] ?? c.owner_role;
    if (typeof role !== "string" || !/^[A-Za-z0-9 _-]{1,24}$/.test(role)) continue;
    const a = roster[role], start = phaseStart?.get(`${c.id}|${phase}`);
    const at = behind ? `#C${c.num} signed but behind main${/^[0-9a-f]{12}$/.test(String(v.headSha12)) ? " " + v.headSha12 : ""}, waits at ${role} 15 min` : `#C${c.num} waits at ${phase.charAt(0).toUpperCase()}${phase.slice(1)} 15 min`;
    if (!a && Object.keys(roster).length && Number.isFinite(start)) {
      if (now - start >= STALL_AFTER_MS) out.push({ card_id: c.id, num: c.num, phase, role, reason: `${at}, no session for ${role}` });
      continue;
    }
    if (!a || a.state !== "idle" || !Number.isFinite(a.since) || !Number.isFinite(start)) continue;
    if (now - Math.max(start, a.since) < STALL_AFTER_MS) continue;
    out.push({ card_id: c.id, num: c.num, phase, role, reason: `${at}, ${role} idle since ${hhmmZ(a.since)}` });
  }
  return out;
}

// "Live now": only the probe's reading of /version.json counts, and a reading older than 3 min is stale, never live.
export const STALE_AFTER_MS = 3 * 60_000;
export function liveNow(reading, now) {
  if (!reading || typeof reading.version !== "string" || !Number.isFinite(reading.readAt)) return { state: "unknown", age: null };
  const age = Math.max(0, now - reading.readAt);
  return { state: age > STALE_AFTER_MS ? "stale" : "live", version: reading.version, age };
}
