// Board store write rules (#C719, docs/DATA.md "Refuse early"): every write is checked in the same call and refused with
// { rule, detail }; the Worker logs each refusal (rule, card, time) to the refusals table. Pure functions, no I/O.
// A check returns null when the write is allowed.
import { mtTime, mtDayTime } from "./team-time.mjs";

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
const ASK_ALLOWED = new Set(["type", "title", "asked_by", "card_id", "eta_at", "eta_precondition", "owed_by",...Object.values(ASK_PARTS).flat(), ...Object.values(ASK_OPTIONAL_PARTS).flat(), "screenshots"]);

const refuse = (rule, detail) => ({ rule, detail });
export const APPROVAL_ASKERS = ["Reviewer", "Manager"];
export const APPROVE = "Approve";
export const PROMISE_ROLES = ["Manager"];
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}\/pull\/([1-9][0-9]{0,6})$/;
// A Terminal line that only changes folder: "cd", "cd <path>", "pushd <path>", with nothing chained after it.
// #C931 (Checker's LOWs on #C921): the line is trimmed first, so "cd ~/x" plus a newline is still bare; "cd" must be the whole word (cd-tool
// and cdk are commands of their own); the same test runs on every step's cmd (an Action's or a Later's Copy box), not only Terminal lines.
const BARE_CD = /^(cd|pushd)(\s[^;&|\n]*)?$/;
export const bareCd = (c) => typeof c === "string" && BARE_CD.test(c.trim());
const BARE_CD_FIX = "give each line full or ~ paths, or put the cd in the same line (cd <folder> && <command>)";
const present = (v) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "") && !(Array.isArray(v) && v.length === 0);

// #C952: a look decision needs a picture per option, as the old board's gate did (gate/rules.mjs lookErrors, page lookDecision). It is a look
// when its text or title names one of the look words (a whole word, a plural too). The Worker has no board config, so the words are the
// default list copied from scripts/config.mjs DEFAULTS.decisions.lookWords (a test holds the two equal). The team's visual lanes (#C956) reach
// the Worker as the probe's evidence `look`, and a Decision on a card of one of those lanes is a look one whatever its words say; the team's own
// look words are still not read. "Something else" and "Not now" need no picture. A picture
// names its option with the letter in front of its label ("<id> A: label", file-store parseShot): A is the first option, B the second.
export const LOOK_WORDS = ["mock-up", "mockup", "screenshot", "layout", "band", "icon", "colour", "color", "font", "spacing", "px", "hero", "banner", "logo", "photo", "button", "text size"];
const LOOK_RE = new RegExp("(?<![A-Za-z])(?:" + LOOK_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")).join("|") + ")(?:e?s)?(?![A-Za-z])", "i");
export const isLookText = (...texts) => texts.some((t) => typeof t === "string" && LOOK_RE.test(t));
const NO_PICTURE = /^(?:something else|not now)[.!]?$/i;
// options: [{ key, label }]; shots: the screenshot strings. null when fine, else the refusal naming the options without a picture.
// #C956: lane is true when the Decision's card is built in one of the team's visual lanes (config decisions.visualLanes, which the probe posts
// as evidence `look`): such a Decision is a look one whatever its words say, as the old board's gate held.
export const LANE_NAME = /^[^<>{}\n]{1,60}$/; // the config's own NAME rule (scripts/config.mjs), so a lane the config accepts is one the store takes
export const inVisualLane = (owner, lanes) => typeof owner === "string" && Array.isArray(lanes) && lanes.includes(owner);
export function lookRefusal({ texts, options, shots, lane = false }) {
  if (!lane && !isLookText(...texts)) return null;
  const shown = new Set((Array.isArray(shots) ? shots : []).map((s) => /^\s*[A-Za-z0-9_-]{16,64}\s+([A-D]):/.exec(String(s ?? ""))?.[1]).filter(Boolean));
  const missing = (options ?? []).filter((o) => o && !NO_PICTURE.test(String(o.label ?? "").trim()) && !shown.has(o.key)).map((o) => o.key);
  return missing.length ? refuse("look-needs-screenshots", `a look decision needs a screenshot for each option (missing: ${missing.join(", ")}); add each as "<file id> A: label" in screenshots, the letter being the option's`) : null;
}

// #C979 (Director check 3e(ii)): the owner reads Mountain Time only, yet three team posts in his threads carried a UTC "Z" time in a week. A
// time of day followed by Z ("03:45Z", "3:45 Z", "03:45:09Z", "2026-11-12T03:45Z") in what the owner reads is refused. Not a time: a commit
// or an id with a Z in it (no hh:mm), the word "Z" in prose. Not his reading: text inside a code span (`...`) or a fenced block, a step's cmd
// (the Copy box), a Terminal ask's commands and a SessionStart's words (what he pastes, exactly). The refusal names the time it found.
const Z_TIME = /(?<![\w:])(?:\d{4}-\d{2}-\d{2}[T ])?\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?\s?Z(?![A-Za-z0-9])/;
const CODE_SPANS = /```[\s\S]*?```|`[^`\n]*`/g;
export function zTimeIn(text) {
  if (typeof text !== "string") return null;
  return Z_TIME.exec(text.replace(CODE_SPANS, " "))?.[0] ?? null;
}
export function zTimeRefusal(texts) {
  for (const t of texts) {
    const z = zTimeIn(t);
    if (z) return refuse("owner-reads-mountain-time", `"${z}" is a UTC time; the owner reads Mountain Time only: write it like "8:45 pm MT" (a time inside a code span or a Copy box may stay)`);
  }
  return null;
}
// #C965 (the owner on #T1779, 11-11 ~8:15 pm MT: "Multiples points, and not numbered list ?"): four points packed as "(1) … (2) … (3) … (4)" in
// one paragraph. A paragraph (text between blank lines) holding 3 or more inline markers "(1)" or "1)" is refused: one numbered line per point.
// A marker at the start of its line is a list, not inline. Still allowed: a "1." list, one or two inline mentions, option lines "A: …", code spans.
const LIST_MARK = /(?<![\w#:().])\(?\d{1,2}\)(?=\s)/g;
export const INLINE_LIST_MIN = 3;
export function inlineListIn(text) {
  if (typeof text !== "string") return null;
  for (const para of text.replace(CODE_SPANS, " ").split(/\n[ \t]*\n/)) {
    const inline = [...para.matchAll(LIST_MARK)].filter((m) => !/^[ \t]*$/.test(para.slice(para.lastIndexOf("\n", m.index - 1) + 1, m.index)));
    if (inline.length >= INLINE_LIST_MIN) return inline.map((m) => m[0]).slice(0, 4).join(" ");
  }
  return null;
}
export function inlineListRefusal(texts) {
  for (const t of texts) {
    const l = inlineListIn(t);
    if (l) return refuse("one-point-per-line", `${l}: points packed in one paragraph; write one numbered line per point ("1. …" on its own line, then "2. …")`);
  }
  return null;
}
// The parts of an ask the owner reads as prose: its title and every part but the ones he copies (commands, words, a step's cmd).
export function askProse(ask) {
  const steps = Array.isArray(ask.steps) ? ask.steps.map((s) => (typeof s === "string" ? s : s?.text)) : [];
  return [ask.title, ask.question, ask.recommended, ...(Array.isArray(ask.options) ? ask.options : []), ask.text, ask.expect, ask.where, ...steps];
}

// An ask missing a required part, an unknown field, or a Later without an ETA.
// look: { lanes, cardOwner } from the store (#C956): the visual lanes the probe posted and the owner role of the ask's card.
export function askRefusal(ask, now, look = {}) {
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
    // #C952: a live look Decision (an import, now = null, keeps its old shape) needs a picture per option.
    if (Number.isFinite(now)) { const bad = lookRefusal({ texts: [ask.title, ask.question], options: ask.options.map((label, i) => ({ key: "ABCD"[i], label })), shots: ask.screenshots, lane: inVisualLane(look?.cardOwner, look?.lanes) }); if (bad) return bad; }
  }
  if (ask.type === "Action") { const bad = stepsRefusal(ask.steps, { needCmd: true }); if (bad) return bad; }
  // #C921 (#T1802): the owner may run any one line alone, so no line may be a bare "cd" that a later line relies on. A cd in the
  // same line as its command ("cd ~/x && node y") is fine; so is a full or ~ path with no cd at all.
  if (ask.type === "Terminal" && Array.isArray(ask.commands)) {
    const bare = ask.commands.find(bareCd);
    if (bare !== undefined) return refuse("terminal-bare-cd", `"${bare.trim().slice(0, 80)}" is a cd on its own line: ${BARE_CD_FIX}`);
  }
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
  // #C925 (11-11: #T1779 and #T1785 were Manager's own dated promises, read "waiting on you" at 8 am, and woke nobody): owed_by marks a
  // Later the asker owes the owner. Only the lead may promise, only for itself, and only with a date (eta_at): no precondition, which
  // nothing could wake on.
  if (ask.owed_by !== undefined) {
    if (ask.type !== "Later") return refuse("promise-shape", "owed_by is on a Later ask only");
    if (!PROMISE_ROLES.includes(ask.owed_by) || ask.owed_by !== ask.asked_by) return refuse("promise-shape", `owed_by is the asker itself, and only ${PROMISE_ROLES.join(" or ")} promises`);
    if (!Number.isFinite(ask.eta_at) || ask.eta_precondition !== undefined) return refuse("promise-shape", "a promise has a date (eta_at) and no precondition");
  }
  // #C979: no UTC time in what the owner reads. A live write only: an import (now = null) keeps the old ask's words.
  if (Number.isFinite(now)) { const z = zTimeRefusal(askProse(ask)) ?? inlineListRefusal(askProse(ask)); if (z) return z; }
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
  if (m.kind === undefined && m.options === undefined && m.screenshots === undefined) return null;
  if (who === "owner") return refuse("message-shape", "the owner's message carries no kind, options or screenshots");
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
    // #C952: a look decision in a thread carries a picture per option too ("<id> A: label"), the same shape an ask's pictures read.
    const look = lookRefusal({ texts: [m.body], options: o, shots: m.screenshots });
    if (look) return look;
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
    if (s && typeof s === "object" && bareCd(s.cmd)) return refuse("terminal-bare-cd", `the step "${String(s.text).trim().slice(0, 60)}" copies a cd on its own: ${BARE_CD_FIX}`);
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
const CARD_WORDS = new Set(["id", "title", "summary", "size", "review_level", "from_thread", "track", "owner_role", "next_note", "waiting_on", "blocked_reason", "paused", "dropped", "rework_reason", "customer_text", "look_change", "skip", "depends_on", "issues", "queue_pos", "check_at", "repo", "batch", "bump", "hold_end", "done", "done_evidence"]);
// #C902: what shows a card with no branch is done: a file path (~/ or /), an https link, or a thread message's id (m-<time>-<8 hex>).
export const DONE_EVIDENCE = /^(?:(?:~\/|\/)[^\s]|https:\/\/[^\s]|m-\d{10,16}-[0-9a-f]{8}$)/;
export const ISSUE_KINDS = ["bugs", "security", "language", "design", "owner"];
export const CARD_SIZES = ["XS", "S", "M", "L", "XL"];
const CARD_FORBIDDEN = new Set(["status", "phase", "num", "live_version", "signed", "on_main", "ci", "evidence"]);

// #C912, #C932: an answer string that is an old response object (an imported "something else": a JSON object with the owner's typed `note`,
// kept whole as the answer with no answer_status): that object, else null. The view and Manager's inbox both read it.
export const typedOther = (answer) => {
  if (typeof answer !== "string" || answer[0] !== "{") return null;
  try { const v = JSON.parse(answer); return v && typeof v === "object" && !Array.isArray(v) && typeof v.note === "string" ? v : null; } catch { return null; }
};
// #C949: the card ids the probe reads (the same as collector/state-schema.mjs CARD_ID and CARD_ID_MAX; a test holds the two equal). The Worker
// is bundled without collector/, so the pattern is copied here, not imported.
export const PROBE_CARD_ID = /^[a-z0-9]{1,16}(?:-[a-z0-9]{1,16}){0,4}$/;
export const PROBE_CARD_ID_MAX = 40;
export function cardWriteRefusal(fields, evidence) {
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return refuse("card-shape", "card words are an object");
  const typed = Object.keys(fields).filter((k) => CARD_FORBIDDEN.has(k));
  if (typed.length) return refuse("only-probe-writes-status", typed.join(", "));
  const unknown = Object.keys(fields).filter((k) => !CARD_WORDS.has(k));
  if (unknown.length) return refuse("unknown-field", unknown.join(", "));
  // #C877 (Security R1 on 1be0ac1): the page keys the estimate's medians on the size, so a size is one of the card words, never any text.
  if (fields.size !== undefined && fields.size !== null && !CARD_SIZES.includes(fields.size)) return refuse("card-size", `size is one of ${CARD_SIZES.join(", ")}`);
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
  // #C902: done closes a card whose work leaves no branch (a review, a file). Only true (closing), always with its evidence, never with dropped.
  if (fields.done !== undefined || fields.done_evidence !== undefined) {
    // #C949: say which part is missing, so a write that only lacks `done` does not read as "already done".
    if (fields.done === undefined) return refuse("card-done", "done_evidence was sent without done: send done: true together with done_evidence to close the card (nothing was changed)");
    if (fields.done !== true) return refuse("card-done", "done can only be set to true, with done_evidence: a write never reopens a done card (nothing was changed)");
    const ev = fields.done_evidence;
    if (typeof ev !== "string" || ev.length > 500 || !DONE_EVIDENCE.test(ev.trim())) return refuse("done-needs-evidence", "done needs done_evidence: a file path (~/ or /), an https link, or a thread message id (m-...)");
    if (fields.dropped === true || fields.dropped === 1) return refuse("card-done", "a card is done or dropped, not both");
  }
  // A typed word that contradicts the probe's reading: Dropped on a card the probe reads as live.
  if ((fields.dropped === 1 || fields.dropped === true) && evidence?.phase === "live") return refuse("contradicts-evidence", "the probe reads this card as live");
  // Rework: a commit after a sign-off puts the card in Rework; until a reason is attached, other card writes are refused.
  if (evidence?.rework === true && !present(fields.rework_reason) && Object.keys(fields).some((k) => k !== "id" && k !== "rework_reason")) {
    return refuse("rework-reason-missing", `Rework: reason missing. Attach a rework_reason (${REWORK_REASONS.join(", ")}) before other writes`);
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
// #C915 (b): a hold is OPEN while its end has not come: a hold_end naming an ask that is not closed (or a card not dropped or live; one the
// store cannot find stays open), or a check_at still in the future. `endsPassed` is the Set of hold_end ids whose closing has happened.
// An open hold is somebody's decision, not a stall and not a dispatch (collector/store-dispatch.mjs holdOpen is the same rule; a test pins it).
export function holdOpen(c, now, endsPassed) {
  return !!c && ((heldWord(c.hold_end) && !endsPassed?.has(c.hold_end)) || (Number.isInteger(c.check_at) && c.check_at > now));
}
// Held cards that need Manager: `endsPassed` is the Set of hold_end ids whose closing has happened (the ask is closed, the card is dropped or live).
// (b) a hold whose end has passed: "#Cn held on <reason>, its end has passed: lift or renew"; (c) a hold with no end for 2 h (counted from
// held_at, else the card's updated_at): "#Cn held on <reason>, no end set after 2 h: lift it or give it an end". One row per (card, reason).
// #C983: the times in these reasons are Mountain Time ("Nov 12 8:45 pm MT"), as Manager and the owner read them.
export function heldWakes({ now, cards, endsPassed }) {
  const out = [];
  for (const c of cards ?? []) {
    if (!Number.isInteger(c.num) || c.dropped || c.done_at) continue;
    if (!isHeld(c)) {
      // #C915 (Checker F2): a hold that is only a hold_end (no waiting_on) hides the card from the stall rule, the slow rule and the dispatch while its end has
      // not come; an end that stays open for 2 h (an answer nobody closed, say) is a line to Manager, so the card cannot disappear for ever. One row per (card, end, since).
      if (heldWord(c.hold_end) && !endsPassed?.has(c.hold_end)) {
        const since = Number.isFinite(c.held_at) ? c.held_at : c.updated_at;
        if (Number.isFinite(since) && now - since >= HOLD_NO_END_AFTER_MS) out.push({ card_id: c.id, num: c.num, reason: `#C${c.num} waits on ${String(c.hold_end).trim().slice(0, 80)}, whose end has not come after 2 h: close it or lift the hold (since ${mtDayTime(since)})` });
      }
      continue;
    }
    const why = String(heldWord(c.blocked_reason) ? c.blocked_reason : c.waiting_on).trim().replace(/\s+/g, " ").slice(0, 80);
    const timed = Number.isInteger(c.check_at) && c.check_at > 0, ref = heldWord(c.hold_end) ? c.hold_end : null, until = Number.isInteger(c.hold_until) && c.hold_until > 0 ? c.hold_until : null;
    if (timed || ref || until) { // an explicit end (check_at, hold_end) wins over the one the store gave (hold_until)
      const passed = timed || ref ? (timed && c.check_at <= now) || (ref && endsPassed?.has(ref)) : until <= now;
      // The end is in the reason (the row is keyed by card and reason): a hold renewed with the same words and a new end wakes Manager again when that one passes.
      const endTxt = timed ? mtDayTime(c.check_at) : ref ? ref : mtDayTime(until);
      if (passed) out.push({ card_id: c.id, num: c.num, reason: `#C${c.num} held on ${why}, its end has passed: lift or renew (end ${endTxt})` });
      continue;
    }
    const since = Number.isFinite(c.held_at) ? c.held_at : c.updated_at;
    if (Number.isFinite(since) && now - since >= HOLD_NO_END_AFTER_MS) out.push({ card_id: c.id, num: c.num, reason: `#C${c.num} held on ${why}, no end set after 2 h: lift it or give it an end (held since ${mtDayTime(since)})` });
  }
  return out;
}

// #C987 (the owner, 11-11 ~11:05 pm MT, on answered asks still listed With the team: "those look stuck?"): an answered Decision that
// Manager has taken (answer_taken_at), whose card then moved on (its next_note or waiting_on changed after the answer: moved_at), is
// closed by the store 30 minutes after it moved on, with a line to Manager first. Left open, each a test: an answer Manager has not
// taken; a "help" answer (it waits for Manager's reply); any other type; a card that has not moved since the answer; an ask closed by
// the store once and then reopened (auto_closed_at). Returns [{ ask_id, card_id, num, reason, closeAt, due }].
export const AUTO_CLOSE_AFTER_MS = 30 * 60000;
export const AUTO_CLOSED_BY = "board";
// lastWord: Map of ask id → its thread's newest message { author, at } (Checker 2 F1 on 1ab7673: the owner's follow-up after his answer,
// the newest word in the thread, keeps the ask open: it waits on the team, so the board never closes over it).
export function movedOnAsks({ now, asks, cards, lastWord }) {
  const byId = new Map((cards ?? []).map((c) => [c.id, c]));
  const out = [];
  for (const a of asks ?? []) {
    if (a.type !== "Decision" || !Number.isFinite(a.answered_at) || a.closed_at || a.withdrawn_at || a.auto_closed_at) continue;
    if (!Number.isFinite(a.answer_taken_at) || a.answer_status === "help") continue;
    const w = lastWord?.get(a.id);
    if (w && w.author === "owner" && w.at > a.answered_at) continue;
    const c = byId.get(a.card_id);
    if (!c || !Number.isFinite(c.moved_at) || c.moved_at <= a.answered_at) continue;
    const closeAt = Math.max(c.moved_at, a.answer_taken_at) + AUTO_CLOSE_AFTER_MS;
    const card = Number.isInteger(c.num) ? `#C${c.num}` : "its card";
    out.push({ ask_id: a.id, card_id: c.id, num: c.num, closeAt, due: now >= closeAt, reason: `#T${a.num} is answered and ${card} has moved on: the board closes it at ${mtTime(closeAt)}` });
  }
  return out;
}

// #C873: the product's daily full test run, as the probe reads it (the product's scripts/daily-e2e.mjs --status):
// { state: ok|red|missed|unknown, reason, run (an https link or null), lastGreenAt (iso or null) }.
export const E2E_STATES = ["ok", "red", "missed", "unknown"];
export const E2E_CARD = "daily-e2e"; // the stall_wakes row's card_id: not a card, the one line the reading adds to Manager's batch
export const e2eRun = (v) => (typeof v === "string" && v.length <= 300 && /^https:\/\/[^\s"'<>\\]+$/.test(v) ? v : null);
// #C962: the evidence job's own reading of its last run (the page shows why the probe is failing, or that it runs slow). Plain words only.
const RUN_KEYS = ["ok", "at", "line", "ms", "stateMs", "slow"];
export const runShape = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every((k) => RUN_KEYS.includes(k))
  && typeof v.ok === "boolean" && Number.isFinite(v.at) && (v.line === undefined || (typeof v.line === "string" && v.line.length <= 160 && /^[\x20-\x7e]*$/.test(v.line)))
  && [v.ms, v.stateMs].every((n) => n === undefined || Number.isFinite(n)) && (v.slow === undefined || v.slow === true);
const e2eShape =(v) => v !== null && typeof v === "object" && !Array.isArray(v) && E2E_STATES.includes(v.state) && typeof v.reason === "string" && v.reason.length <= 300
  && (v.run === null || v.run === undefined || typeof v.run === "string") && (v.lastGreenAt === null || v.lastGreenAt === undefined || typeof v.lastGreenAt === "string");
// The one line for Manager's batch when the reading is red, missed or unknown and fresh; null otherwise. Keyed by the state in its first
// words, so the store tells it once per state change (syncE2e), however the reason's hours or the run's link move on.
export const e2eWakeLine = (state) => `daily full test run is ${state}`;
export function e2eWake({ now, value, readAt }) {
  if (!e2eShape(value) || value.state === "ok" || !(now - readAt <= STALE_AFTER_MS)) return null;
  const why = value.reason.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim().slice(0, 150), run = e2eRun(value.run);
  return { state: value.state, reason: `${e2eWakeLine(value.state)}: ${why}${run ? ` (${run})` : ""}. Look at the product's daily run and tell the owner.` };
}

// Evidence: one lit phase per card, and only the probe writes it.
export function evidenceRefusal(key, value, who, track) {
  if (who !== "probe") return refuse("only-probe-writes-status", `${who ?? "unknown"} cannot write evidence`);
  if (typeof key !== "string" || !/^[a-z][a-z0-9]*(\.[A-Za-z0-9._-]+)?$/.test(key)) return refuse("evidence-key", String(key));
  if (key === "run.evidence" && !runShape(value)) return refuse("run-shape", "run.evidence is { ok: true|false, at, line up to 160 characters, ms, stateMs, slow: true }");
  if (key === "e2e" && !e2eShape(value)) return refuse("e2e-shape", "e2e is { state: ok|red|missed|unknown, reason, run, lastGreenAt }");
  // #C956: the team's visual lanes, from the board config: { visualLanes: [role names], up to 20 }.
  if (key === "look" && !(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((k) => k === "visualLanes") && Array.isArray(value.visualLanes) && value.visualLanes.length <= 20 && value.visualLanes.every((r) => typeof r === "string" && LANE_NAME.test(r)))) return refuse("look-shape", "look is { visualLanes: [up to 20 role names] }");
  if (key.startsWith("cards.")) {
    const lit = value?.lit;
    if (!Array.isArray(lit) || lit.length !== 1) return refuse("one-lit-phase", `${key} has ${Array.isArray(lit) ? lit.length : 0} lit phases`);
    if (!PHASES.includes(lit[0])) return refuse("one-lit-phase", `unknown phase ${lit[0]}`);
    if (Array.isArray(track) && !track.includes(lit[0])) return refuse("one-lit-phase", `${lit[0]} is not a phase of this track`);
  }
  return null;
}

// #C875 (audit 2026-11-10, group B row 36): Rework is read from evidence. The rule that refuses other card writes while a rework has no reason
// existed (cardWriteRefusal, evidence.rework), but nothing ever set it. It is set on a TRANSITION between two readings of a card, never on a
// state, so a reading repeated every minute cannot set it again once its reason is attached:
//   a commit after a review sent the tip back                       (a new tip while the last reading had findings),
//   a review sends the tip back                                      (findings appear where the last reading had none),
//   the card goes back to build                                      (from a review or ship phase to plan, build or test).
// A new tip after SIGN-OFFS alone is not rework (Checker F1 on 4fee97e): a re-cut of a signed commit onto a newer main (a new head, the same patch,
// the sign-offs gone) reads exactly like one, and every re-cut is asked for by the release process. Telling them apart needs the patch itself,
// which the Worker does not have; the probe could send an "equal patch" flag one day. Until then only a review's FINDINGS or a return to build counts.
// Never for a card on main or live. `prev` is the card's last stored reading (null the first time: nothing to compare with), `next` the new one.
const REVIEWED = ["language", "design", "checker", "security", "ship"], BEFORE_REVIEW = ["plan", "build", "test"];
// #C981: a card's FIRST push is never rework. #C964 was read at a review phase before anything was pushed (a re-cut kept locally after the
// pre-push scan refused it), then its first push read as build: a "return to build" that was no return. With no pushed head before, nothing came back.
export function reworkTriggered(prev, next) {
  if (!prev || typeof prev !== "object" || !next || typeof next !== "object") return false;
  if (prev.onMain === true || next.onMain === true || next.lit?.[0] === "live") return false;
  if (typeof prev.headSha12 !== "string" || prev.headSha12 === "") return false;
  const had = (v) => Array.isArray(v) && v.length > 0;
  const newTip = typeof prev.headSha12 === "string" && typeof next.headSha12 === "string" && prev.headSha12 !== next.headSha12;
  if (newTip && had(prev.findings)) return true;
  if (!had(prev.findings) && had(next.findings)) return true;
  return REVIEWED.includes(prev.lit?.[0]) && BEFORE_REVIEW.includes(next.lit?.[0]);
}
// Phase history (#C723 B3b): who a phase change is put down to when no agent is working on the card at that moment: the phase's lane
// role; the early phases (and any not named here) belong to the card's own owner_role.
export const PHASE_LANES = { language: "Linguist", design: "Designer", checker: "Checker", security: "Security", ship: "Release", live: "Release", pack: "Release", install: "Release" };
// The step tool (after B4b): an agent writes a start or an end of a WAIT at a phase for a card (the old step log's wait column). The refusal for
// one call: the card id, the phase, kind, wait and time. `who` is never an argument: the store takes it from who authenticated.
export const STEP_WAITS = ["busy", "gate", "decision"], STEP_PAST_MS = 7 * 86_400_000, STEP_FUTURE_MS = 60_000;
// #C976 (Director check 1c: every board ship row had an empty wait, so landing time and the owner's install time could not be told apart): a
// card with a repo of its own (a board card), at ship and read on main, waits on the owner's install. The store writes that wait itself, never
// the step tool: "start" when the wait begins (no install wait open), "end" when it stops (the card goes live, or leaves ship or main) with one
// open; null otherwise. A product card (no repo) never has one. open: whether the card's newest install-wait row is a start.
export const INSTALL_WAIT = "install";
export function installWaitStep({ repo, next, onMain, open }) {
  const waiting = typeof repo === "string" && repo !== "" && next === "ship" && onMain === true;
  return waiting && !open ? "start" : !waiting && open ? "end" : null;
}
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
// The role to put a phase on: a phase with a lane (a review or the release) is the lane's role, whoever else works the card at that moment
// (#C881: the builder still on a card read as the "who" of its Checker start, and a reviewer left on it as the "who" of its ship start);
// the early phases (plan, build, test) are the agent the `agents` evidence shows working on this card now, else the card's owner.
export function whoForPhase(cardId, phase, agents, ownerRole) {
  if (PHASE_LANES[phase]) return PHASE_LANES[phase];
  const working = Object.entries(agents && typeof agents === "object" ? agents : {}).find(([, a]) => a && a.state === "working" && a.card === cardId);
  return working ? working[0] : ownerRole ?? null;
}

// #C732 (the owner's pick A on #T1681, 11-09): "Stalled" for the wake covers every phase. A card that has waited STALL_AFTER_MS at its phase
// while that phase's agent is idle (and no agent works the card, no CI or ship run is going) is a stall, with a reason Manager reads:
// "#C730 waits at Checker 15 min, Checker idle since 9:40 pm MT". The 15 min is the threshold crossed, so the reason is stable while the
// stall lasts and changes only with the phase, the agent or the time the agent went idle. The wait counts from the later of the phase's
// start and the agent going idle (a card queued behind a busy agent has not waited on an idle one). Exempt: a card that is dropped,
// paused, blocked, held on someone (waiting_on), or gated by an open ask; a live card (done); a card with no agent for its phase.
// #C828: a phase agent with NO open session (a role the `agents` reading does not list, while the reading lists others) is a stall too, counted
// from the phase's start: nobody is there to take the card, so waiting on an idle one would never fire. The reason says "no session". An empty or
// missing reading is a blind probe, never a stall: only a reading that lists someone says who is absent.
// Pure: cards = rows {id, num, owner_role, blocked_reason, paused, dropped, waiting_on}; evidence = {cardId: reading}; agents = the
// `agents` evidence; openAskCards = Set of card ids with an open ask; phaseStart = Map "<card>|<phase>" -> ms. Times in the reasons are Mountain Time (#C983).
export const STALL_AFTER_MS = 15 * 60_000;
// #C846: whether a card waits for a card it depends on (depends_on, a JSON list of ids): one that is on the board, not dropped and not
// live. One the board does not have, or a dropped one, holds nothing (as the dispatch reads it, #C845).
export function dependsNotLive(c, cards, evidence) {
  let list = c.depends_on;
  if (typeof list === "string") { try { list = JSON.parse(list); } catch { return false; } }
  if (!Array.isArray(list)) return false;
  return list.some((d) => typeof d === "string" && d !== c.id && (cards ?? []).some((k) => k && k.id === d && !k.dropped && !k.done_at) && evidence?.[d]?.lit?.[0] !== "live");
}
// #C885 (11-10 9:45 pm MT: #C884, Designer's own card, stalled as "nothing pushed, Designer idle"): a read-only role never pushes for its own
// card; its work is a post or a note on the card's thread. For such a card with nothing pushed, a post by its owner on the card's thread in the
// last POSTED_FRESH_MS means it is being worked (no stall); with none, it stalls on a line of its own that says "nothing posted". postedAt:
// Map card id -> ms of the owner's newest post on the card's thread (the store passes it; missing = none).
export const READ_ONLY_ROLES = ["Designer", "Checker", "Security", "Linguist"], POSTED_FRESH_MS = 60 * 60_000;
export function stalledWaits({ now, cards, evidence, agents, openAskCards, phaseStart, postedAt, endsPassed }) {
  const out = [], queued = new Map(), idleOf = new Map(), noSession = new Map();
  const roster = agents && typeof agents === "object" ? agents : {};
  const working = new Set(Object.values(roster).filter((a) => a && a.state === "working" && typeof a.card === "string").map((a) => a.card));
  for (const c of cards ?? []) {
    // #C915 (b): a card with an open hold end (hold_end on an open ask or card, or a check_at to come) raises no stall: the hold says why it waits.
    if (!Number.isInteger(c.num) || c.dropped || c.done_at || c.paused || c.blocked_reason || c.waiting_on || holdOpen(c, now, endsPassed) || openAskCards?.has(c.id) || working.has(c.id)) continue;
    const v = evidence?.[c.id], phase = v?.lit?.[0];
    // #C846: a card with no lit phase (nothing pushed to origin) whose owner has been idle 15 min is a stall of its own: nobody has
    // started it. It is not held, not behind a depends_on that is not live, not the lead's, and touched in the last 3 days (an old
    // card nobody has pushed for is not news). The owner's other cards do not matter: one at review and the rest queued still wake.
    if (phase === undefined || phase === null) {
      const o = typeof c.owner_role === "string" ? roster[c.owner_role] : null;
      // #C940: a reset session reads "unknown" with no `since` until it has said something: idle since its own last activity (see dispatchItems).
      const idleFrom = !o ? null : o.state === "idle" ? o.since : o.state === "unknown" ? o.lastActivityAt : null;
      if (c.owner_role === "Manager" || typeof c.owner_role !== "string" || !/^[A-Za-z0-9 _-]{1,24}$/.test(c.owner_role) || isHeld(c) || holdOpen(c, now, endsPassed) || !Number.isFinite(c.updated_at) || now - c.updated_at > 3 * 24 * 3600e3) continue;
      if (dependsNotLive(c, cards, evidence)) continue;
      // #C947 (the gap #C940 left, seen as Role=none in the dispatch log): a card whose owner has NO open session at all, in a reading that lists
      // others (an empty reading is a blind probe, never a stall), has nobody to start it. One line per role, below. A card younger than the stall time
      // is not news. An idle, working or unknown session, a held card, a dependency not live and a closed card raise nothing here.
      if (!o) {
        if (Object.keys(roster).length && now - c.updated_at >= STALL_AFTER_MS) noSession.set(c.owner_role, [...(noSession.get(c.owner_role) ?? []), c]);
        continue;
      }
      if (!Number.isFinite(idleFrom) || now - idleFrom < STALL_AFTER_MS) continue;
      if (READ_ONLY_ROLES.includes(c.owner_role)) {
        const posted = postedAt instanceof Map ? postedAt.get(c.id) : undefined;
        if (Number.isFinite(posted) && now - posted <= POSTED_FRESH_MS) continue;
        out.push({ card_id: c.id, num: c.num, phase: null, role: c.owner_role, reason: `#C${c.num} nothing posted on its thread in the last hour, ${c.owner_role} idle since ${mtTime(idleFrom)}` });
        continue;
      }
      queued.set(c.owner_role, [...(queued.get(c.owner_role) ?? []), c]);
      idleOf.set(c.owner_role, idleFrom);
      continue;
    }
    if (typeof phase !== "string" || phase === "live" || !PHASES.includes(phase)) continue;
    if (v.ci === "running" || v.ci === "queued" || v.shipping === true) continue;
    // #C737: a card of another repository (a repo word) that is on main and read at ship is waiting for the owner's deploy, not for Release:
    // it never wakes Manager as stalled.
    // #C915 (a): this is the "landed" case: a board-repository card read as ship + onMain raises no stall (the probe now reads a card whose Board-Id
    // commit is on main this way, where its stale tip used to read checker). A team-flow card with no repo word still waits on Release (#C737's control).
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
    out.push({ card_id: c.id, num: c.num, phase, role, reason: `${at}, ${role} idle since ${mtTime(a.since)}` });
  }
  // #C910: one line per idle agent, not one per queued card (22 queued cards were 22 lines): "Boardsmith idle since 07:31Z, 22 queued, next #C901".
  // The next card is the first of the agent's queue (queueRank, as the dispatch wakes it); the line is its row, so it changes with the count or the next card.
  // #C947: one line per role with no open session, not one per card; the row is its text, so the same count and next card is the same row (not sent every minute).
  for (const [role, list] of noSession) {
    const next = [...list].sort((x, y) => queueRank({ queue_pos: x.queue_pos, owner: x.queue_set_by === "owner", num: x.num, id: x.id }, { queue_pos: y.queue_pos, owner: y.queue_set_by === "owner", num: y.num, id: y.id }))[0];
    out.push({ card_id: next.id, num: next.num, phase: null, role, reason: `${role} has no open session, ${list.length} queued, next #C${next.num}` });
  }
  for (const [role, list] of queued) {
    const next = [...list].sort((x, y) => queueRank({ queue_pos: x.queue_pos, owner: x.queue_set_by === "owner", num: x.num, id: x.id }, { queue_pos: y.queue_pos, owner: y.queue_set_by === "owner", num: y.num, id: y.id }))[0];
    out.push({ card_id: next.id, num: next.num, phase: null, role, reason: `${role} idle since ${mtTime(idleOf.get(role))}, ${list.length} queued, next #C${next.num}` });
  }
  return out;
}

// #C915 (d): a card that runs past its estimate with nobody having said why. The estimate is the page's: Release's ship is about 10 min (slow from
// the 11th), any other phase is slow past twice the usual time of that phase (`medians`: { phase: ms }, taken by the store from the phase history).
// "No reason" = no waiting_on, no blocked_reason, no pause, no open hold end, no open ask, no unfinished dependency. A card landed on main and not
// deployed is waiting for the install, not slow. One row per card ("#Cn is slow with no reason: add one or unstick it"): giving a reason (or the
// card moving on) ends it, and a row Manager has read is not sent again.
export const SHIP_SLOW_MS = 11 * 60_000;
export const SLOW_LINE_TAIL = " is slow with no reason: add one or unstick it";
export const slowLine = (num) => `#C${num}${SLOW_LINE_TAIL}`;
// #C981: a card in rework whose reason is missing (the evidence's `rework` flag: the store refuses its other writes until one is attached) is
// not "slow with no reason": its line says what is missing and who attaches it, and the dispatch wakes that owner too (store-dispatch.mjs).
// The row ends with the same words as the slow line's, so the store keeps and clears it the same way.
export const SLOW_ROW_END = ": add one or unstick it";
export const reworkReasonLine = (num, owner) => `#C${num} is slow, rework reason missing (${owner} attaches it)${SLOW_ROW_END}`;
// The usual time of each work phase: the median of the finished (start then end) work rows of the history, a phase with 3 or more of them.
// rows: [{ id, card_id, phase, kind, at }] with no wait rows, any order. A row of 0 ms or less says nothing (a card first read at a later phase).
export function phaseMedians(rows) {
  const open = new Map(), by = {};
  for (const r of [...(rows ?? [])].sort((a, b) => a.id - b.id)) {
    const key = `${r.card_id}|${r.phase}`;
    if (r.kind === "start") open.set(key, r.at);
    else if (r.kind === "end" && open.has(key)) { const ms = r.at - open.get(key); open.delete(key); if (ms > 0) (by[r.phase] ??= []).push(ms); }
  }
  const out = {};
  for (const [p, l] of Object.entries(by)) if (l.length >= 3) { l.sort((a, b) => a - b); out[p] = l[Math.floor(l.length / 2)]; }
  return out;
}
export function slowWakes({ now, cards, evidence, openAskCards, phaseStart, medians, endsPassed }) {
  const out = [];
  for (const c of cards ?? []) {
    if (!Number.isInteger(c.num) || c.dropped || c.done_at || c.paused || isHeld(c) || holdOpen(c, now, endsPassed) || openAskCards?.has(c.id) || dependsNotLive(c, cards, evidence)) continue;
    const v = evidence?.[c.id], phase = v?.lit?.[0];
    if (typeof phase !== "string" || !PHASES.includes(phase) || ["live", "pack", "install"].includes(phase)) continue;
    if (phase === "ship" && v.onMain === true) continue;
    const start = phaseStart?.get(`${c.id}|${phase}`);
    if (!Number.isFinite(start) || start > now) continue;
    const limit = phase === "ship" ? SHIP_SLOW_MS : Number.isFinite(medians?.[phase]) && medians[phase] > 0 ? 2 * medians[phase] : null;
    const missing = v.rework === true && !(typeof c.rework_reason === "string" && c.rework_reason !== "");
    const owner = typeof c.owner_role === "string" && /^[A-Za-z][A-Za-z0-9 _-]{0,40}$/.test(c.owner_role) ? c.owner_role : "the owner";
    if (limit !== null && now - start > limit) out.push({ card_id: c.id, num: c.num, reason: missing ? reworkReasonLine(c.num, owner) : slowLine(c.num) });
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

// #C927 (the owner, 11-11: a card's tile read "repository copy 47 h 56 min old" and nothing told Manager): the probe's copy of a repository
// is as old as the last time it wrote that repository's cards. The evidence of every open card carries its read time (read_at); a repository's
// word (the card's `repo`, "board" for a card with none) whose OLDEST open reading is over COPY_STALE_MS old is stale. ONE stall per repository
// word and spell (the row's card_id is COPY_CARD + word; the store keeps its reason while the spell lasts, as the daily run's). A card that is
// dropped, closed as done (#C902), live or has no reading is not counted: a reading never written is not an old one.
export const COPY_STALE_MS = 60 * 60_000, COPY_CARD = "repo-copy:";
export const copyWord = (c) => (typeof c?.repo === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(c.repo) ? c.repo : "board");
export function staleCopies({ now, cards, evidence, readAt }) {
  const oldest = new Map();
  for (const c of cards ?? []) {
    // #C902: a card closed as done (done_at) is closed like a dropped one: its reading is no longer rewritten.
    if (!c || c.dropped || c.done_at || evidence?.[c.id]?.lit?.[0] === "live") continue;
    const at = readAt?.[c.id];
    if (!Number.isFinite(at)) continue;
    const w = copyWord(c), age = Math.max(0, now - at);
    if (age > (oldest.get(w) ?? -1)) oldest.set(w, age);
  }
  const hours = (ms) => Math.floor(ms / 3_600_000);
  return [...oldest].filter(([, age]) => age > COPY_STALE_MS).sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([w, age]) => ({ card_id: COPY_CARD + w, num: null, word: w, reason: `the probe's copy of ${w} is ${hours(age)} h old: a fetch may be failing, or a card's reading has stopped being rewritten` }));
}
