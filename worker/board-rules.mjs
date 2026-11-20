// Board store write rules (#C719, docs/DATA.md "Refuse early"): every write is checked in the same call and refused with
// { rule, detail }; the Worker logs each refusal (rule, card, time) to the refusals table. Pure functions, no I/O.
// A check returns null when the write is allowed.
import { mtTime, mtDayTime } from "./team-time.mjs";
import { KNOBS, knobsShape, knobFrom } from "./knobs.mjs";
import { isHeldBy } from "./held-by.mjs"; // #C1164: the one reading of waiting_on

export const ASK_TYPES = ["Decision", "Action", "Terminal", "SessionStart", "Later", "Approval", "Answer", "Thread"];
// The language review's key is "language" (its label is Linguist): the board config's phase key, which the probe reads and writes.
export const PHASES = ["plan", "build", "test", "language", "design", "checker", "security", "ship", "live", "pack", "install", "review", "approve", "merge"];
export const REWORK_REASONS = ["bug found in test", "review findings", "design change", "security finding", "owner change", "wording"];
// #C1114 part 2: each accepted reason adds 1 to the matching counter, once, on the write that attaches it to a rework waiting for one. "review findings" adds none: the
// FINDINGS notes already fill the counters (collector/findings-count.mjs), so counting the reason too would count the same finding twice.
export const REASON_COUNTER = { "bug found in test": "bugs", "security finding": "security", "design change": "design", wording: "language", "owner change": "owner" };

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
// #C1254 (the owner on #T2106,"add a copy-and-open button for Google Voice texts?"): a feature yes/no that names a look word ("button") was held to a
// picture per option and refused, so he got a plain ask with no buttons. An option that starts "Yes" or "No" as a word ("Yes, add the button",
// "No, leave it") answers a yes/no and shows no look, so it needs no picture. Not on a visual lane's card (a lane's Decision is a look one
// whatever its words say, #C956); and a real look choice ("A: blue band", "B: green band") names its options by their looks, so it still needs them.
const YES_NO = /^(?:yes|no)(?!\w)/i;
// options: [{ key, label }]; shots: the screenshot strings. null when fine, else the refusal naming the options without a picture.
// #C956: lane is true when the Decision's card is built in one of the team's visual lanes (config decisions.visualLanes, which the probe posts
// as evidence `look`): such a Decision is a look one whatever its words say, as the old board's gate held.
export const LANE_NAME = /^[^<>{}\n]{1,60}$/; // the config's own NAME rule (scripts/config.mjs), so a lane the config accepts is one the store takes
export const inVisualLane = (owner, lanes) => typeof owner === "string" && Array.isArray(lanes) && lanes.includes(owner);
// #C1254 (Checker 2's F1 on 482ee293): noYesNo turns the Yes/No exemption off without making the Decision a lane one. A thread post reads the words only
// (the lane hold is the ask's), so on a card of a visual lane the post keeps its words rule and loses the exemption: it needs pictures as it did before.
export function lookRefusal({ texts, options, shots, lane = false, noYesNo = false }) {
  if (!lane && !isLookText(...texts)) return null;
  const shown = new Set((Array.isArray(shots) ? shots : []).map((s) => /^\s*[A-Za-z0-9_-]{16,64}\s+([A-D]):/.exec(String(s ?? ""))?.[1]).filter(Boolean));
  const bare = (o) => { const l = String(o.label ?? "").trim(); return NO_PICTURE.test(l) || (!lane && !noYesNo && YES_NO.test(l)); };
  const missing = (options ?? []).filter((o) => o && !bare(o) && !shown.has(o.key)).map((o) => o.key);
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
  // #C1012 (#T1865: a Terminal ask with eta_at 7 am was nudged at 10 minutes and would have pushed to the owner's phone at 30, overnight): only a
  // Decision ("not before") and a Later (its date) wait for eta_at. Any other type with one is refused on a live write rather than ignored; an
  // import (now = null) keeps the old ask's shape.
  if (Number.isFinite(now) && ask.eta_at !== undefined && ask.type !== "Decision" && ask.type !== "Later") return refuse("eta-unsupported", `${ask.type} does not wait for eta_at, so the owner would be asked at once: send it when it is due, or ask a Decision (not before) or a Later`);
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
// #C1046 (the owner, 2026-11-12): an agent closes a thread only when the newest message on it is the owner's (his Ack, Done, Closed, an answer);
// otherwise the agent posts and leaves the thread for him. `last` is the thread's newest message { author } or null (a thread nobody has written
// in has no owner's word). The owner closes at any time, from the page or otherwise: his role is not asked. An Approval is the one exception: the
// Reviewer closes it when its pull request is merged or a newer head replaces it, with no word from the owner, and that is housekeeping, not an
// agent ending a conversation (closing never approves anything, below); the card's rule is for the threads he talks in.
// #C1109 (the lead's own rule, kept in memory: never close an ask the owner just answered or marked Done, he closes it): an agent cannot close an ask the owner answered within
// the last ANSWERED_CLOSE_HOLD_MS; the owner's own close is never held. `now` null (an old caller, a test) skips the check.
export const ANSWERED_CLOSE_HOLD_MS = 3_600_000;
export function closeRefusal(ask, who, role, last = null, now = null) {
  if (!ask) return refuse("ask-unknown", "no such ask");
  if (ask.closed_at) return refuse("ask-already-closed", String(ask.id));
  if (role !== "owner" && (who === "owner" || who !== ask.asked_by)) return refuse("close-not-yours", `${who ?? "unknown"} did not ask ${ask.id}; only the owner or the asker closes it`);
  // An Approval is the Reviewer's housekeeping (its pull request merged), not a conversation: the hold does not apply to it.
  if (role !== "owner" && ask.type !== "Approval" && Number.isFinite(now) && Number.isFinite(ask.answered_at) && ask.answered_at <= now && now - ask.answered_at < ANSWERED_CLOSE_HOLD_MS) {
    return refuse("close-owner-just-answered", `${ask.id}: the owner answered it ${Math.max(1, Math.round((now - ask.answered_at) / 60_000))} min ago; he closes it (an agent may close it an hour after his answer, and posts a note meanwhile)`);
  }
  if (role !== "owner" && ask.type !== "Approval" && last?.author !== "owner") return refuse("close-not-after-owner", `${ask.id}: an agent closes a thread only when the owner's message is the newest on it; post your note and leave the thread for the owner to close`);
  // An Approval closes answered or not: closing never approves anything (a merged pull request, or one a newer head replaced).
  if (["Decision", "Answer"].includes(ask.type) && !ask.answered_at) return refuse("close-unanswered", `a ${ask.type} is answered before it is closed`);
  if (role !== "owner") { const uncarded = planStepsRefusal(ask); if (uncarded) return uncarded; }
  return null;
}

// #C863 (half 1 of 3): an answered plan or decision does not close, for an agent, while its answer lists steps that name no card. A step is a list line (1. or 1), a dash, a
// star, a bullet, or "Step 1:"); it names a card when it carries a card number (#C123). The answer is the owner's chosen option or typed note and his note beside it. No steps listed,
// or every step carded, closes as before; the owner's own close is never refused (#C1046: he closes at any time). Applies to a Decision, and to any answered ask whose answer says
// it "becomes a card". The card is the agent's to make: the board does not make one per step.
export const STEP_LINE = /^\s*(?:\d{1,2}[.)]|[-*•]|step\s*\d{1,2}\s*[:.)])\s+\S/i;
export const CARD_REF = /#C\d{1,6}\b/i;
// The ask's own question and option text (asks.body is JSON {question, options, ...}): a plan posted as a Decision lists its steps in the question and is answered "A: go" (#C863 M1).
// Note: a question that uses "- " bullets for context therefore blocks an agent's close until each such line names a card; the owner can always close.
export function questionStepText(ask) {
  let body = ask?.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return []; } }
  if (!body || typeof body !== "object") return [];
  const opts = Array.isArray(body.options) ? body.options.flatMap((o) => (typeof o === "string" ? [o] : o && typeof o === "object" ? [o.label, o.description, o.text].filter((s) => typeof s === "string") : [])) : [];
  return [body.question, ...opts].filter((s) => typeof s === "string" && s.trim());
}
export function answerStepLines(ask) {
  const typed = typedOther(ask?.answer);
  const parts = [typed ? typed.note : ask?.answer, ask?.answer_note, ...questionStepText(ask)].filter((s) => typeof s === "string" && s.trim());
  return parts.join("\n").split(/\r?\n/).filter((l) => STEP_LINE.test(l));
}
export function planStepsRefusal(ask) {
  if (!ask || !ask.answered_at) return null;
  const text = [typedOther(ask.answer)?.note ?? ask.answer, ask.answer_note].filter((s) => typeof s === "string").join("\n");
  if (ask.type !== "Decision" && !/becomes?\s+a\s+card/i.test(text)) return null;
  const uncarded = answerStepLines(ask).filter((l) => !CARD_REF.test(l));
  if (!uncarded.length) return null;
  const shown = uncarded.slice(0, 5).map((l) => `"${l.trim().slice(0, 80)}"`).join("; ");
  return refuse("plan-steps-uncarded", `${ask.id}: ${uncarded.length} step${uncarded.length === 1 ? "" : "s"} of the answer name no card (add its #C number): ${shown}${uncarded.length > 5 ? "; ..." : ""}`);
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
// look: { lanes, cardOwner } from the store when the thread is a card (postMessage); a thread of a visual lane's card gets no Yes/No exemption (#C1254).
export function messageExtrasRefusal(m, who, look = {}) {
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
    const lookBad = lookRefusal({ texts: [m.body], options: o, shots: m.screenshots, noYesNo: inVisualLane(look?.cardOwner, look?.lanes) });
    if (lookBad) return lookBad;
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

// #C1018 / #C1035: one checker per tip. A Checker session claims a tip (its full 40-hex commit) before it reviews it; the first claim wins. Only Checker
// (for itself, as "Checker" or "Checker <n>") and Manager (for a named checker, and to release a gone checker's claim) write one. card_id (optional) is the
// card the tip belongs to: a re-cut of it keeps the claim of the checker who held the old tip.
export const CHECKER_NAME = /^Checker(?: [0-9]{1,2})?$/;
export const REVIEW_SHA = /^[0-9a-f]{40}$/;
// #C1115 (11-16: G6 was due about 1:20 pm and missed it by more than an hour; Checker 2 ran 30 mutants, each against the whole suite, about 75 minutes the ETA never counted):
// a review's ETA adds the reviewer's mutants at their measured time (the claim's mutant_sec, the runner's median; 150 s when none is given: 75 min over 30), and a review
// REVIEW_LATE_MS past that ETA wakes Manager with the reviewer's own progress line. The base is the checker phase's median (30 min when there is none yet).
export const MUTANTS_MAX = 200, MUTANT_SEC_DEFAULT = 150, REVIEW_LATE_MS = 30 * 60e3, REVIEW_BASE_DEFAULT_MS = 30 * 60e3;
export const reviewExtraMs = (claim) => (Number.isInteger(claim?.mutants) && claim.mutants > 0 ? claim.mutants * (Number.isInteger(claim.mutant_sec) && claim.mutant_sec > 0 ? claim.mutant_sec : MUTANT_SEC_DEFAULT) * 1000 : 0);
export const reviewEtaAt = (claim, baseMs) => claim.claimed_at + (Number.isFinite(baseMs) && baseMs > 0 ? baseMs : REVIEW_BASE_DEFAULT_MS) + reviewExtraMs(claim);
export const REVIEW_LATE_MARK = " min past its ETA";
// The late-review lines for Manager: every open claim whose card is still waiting at that review (the probe's reading says the checker phase is lit and the tip
// has no Checker note), whose ETA plus REVIEW_LATE_MS has passed. `claims` are review_claims rows, `evidence` the cards' readings by card id, `medians` the phases' medians.
export function reviewLateWakes({ now, claims, cards, evidence, medians, outages = [] }) {
  const out = [], byId = new Map((Array.isArray(cards) ? cards : []).map((c) => [c.id, c]));
  for (const c of Array.isArray(claims) ? claims : []) {
    if (!c || c.released_at != null || typeof c.card_id !== "string" || !Number.isFinite(c.claimed_at)) continue;
    const card = byId.get(c.card_id), e = evidence?.[c.card_id];
    if (!card || card.dropped || card.done_at || (e?.phase ?? e?.lit?.[0]) !== "checker") continue;
    const eta = reviewEtaAt(c, medians?.checker), over = waited(eta, now, outages);
    if (!(now > eta && over >= REVIEW_LATE_MS)) continue;
    const who = typeof c.checker === "string" && /^Checker( \d{1,3})?$/.test(c.checker) ? c.checker : "the checker";
    // The words stay the same until the reviewer's progress line changes, so the row (card, reason) is one wake per spell, and a new progress line is a new one.
    const prog = typeof c.progress === "string" && c.progress.trim() ? c.progress.trim().slice(0, 160) : "no progress line";
    const n = Number.isInteger(c.mutants) && c.mutants > 0 ? `, ${c.mutants} mutants` : "";
    out.push({ card_id: c.card_id, num: card.num, reason: `#C${card.num} review by ${who} is over ${REVIEW_LATE_MS / 60e3}${REVIEW_LATE_MARK}${n}: ${prog}` });
  }
  return out;
}
export function reviewClaimRefusal(b, who, op = "claim") {
  if (who !== "Checker" && who !== "Manager") return refuse("review-claim-role", `${who ?? "unknown"} cannot ${op} a review; only Checker and Manager can`);
  const allowed = op === "claim" ? ["sha", "checker", "card_id", "mutants", "mutant_sec", "progress"] : ["sha", "checker"];
  if (b === null || typeof b !== "object" || Array.isArray(b) || Object.keys(b).some((k) => !allowed.includes(k))) return refuse("review-claim-shape", `a review ${op} is {${allowed.join(", ")}}`);
  // #C1115: how many mutants the reviewer will run, the seconds each takes (the runner's measured median), and a progress line, all optional.
  if (op === "claim") {
    if (b.mutants !== undefined && !(Number.isInteger(b.mutants) && b.mutants >= 0 && b.mutants <= MUTANTS_MAX)) return refuse("review-claim-shape", `mutants is a whole number from 0 to ${MUTANTS_MAX}`);
    if (b.mutant_sec !== undefined && !(Number.isInteger(b.mutant_sec) && b.mutant_sec >= 1 && b.mutant_sec <= 3600)) return refuse("review-claim-shape", "mutant_sec is the seconds one mutant takes, 1 to 3600");
    if (b.progress !== undefined && !(typeof b.progress === "string" && b.progress.length <= 160 && !/[\r\n]/.test(b.progress))) return refuse("review-claim-shape", "progress is one line of up to 160 characters");
    // The line goes into a stall row's reason, and the cleanups find rows by LIKE on the reason: a line that carries another cleanup's mark would be deleted and put back on every sync (Security's LOW 1).
    if (typeof b.progress === "string" && STALL_LIKE_MARKS.some((m) => b.progress.toLowerCase().includes(m.toLowerCase()))) return refuse("review-claim-shape", "progress must not contain the stall lines' own wording");
  }
  if (typeof b.sha !== "string" || !REVIEW_SHA.test(b.sha)) return refuse("review-claim-shape", "sha is the tip's full 40-character lower-case hex commit");
  if (b.checker !== undefined && (typeof b.checker !== "string" || !CHECKER_NAME.test(b.checker))) return refuse("review-claim-shape", "checker is \"Checker\" or \"Checker <n>\"");
  if (op === "claim") {
    if (who === "Manager" && b.checker === undefined) return refuse("review-claim-shape", "Manager names the checker the tip is for");
    if (b.card_id !== undefined && (typeof b.card_id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(b.card_id))) return refuse("review-claim-shape", "card_id is a card id");
  }
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

// Pulling a card out of its group (#C1008): the owner's alone, shaped {id}.
export function pullOutRefusal(b, who) {
  if (who !== "owner") return refuse("pull-out-owner", `${who ?? "unknown"} cannot pull a card out of its group; only the owner can`);
  if (b === null || typeof b !== "object" || Array.isArray(b) || Object.keys(b).some((k) => k !== "id")) return refuse("pull-out-shape", "a pull-out is {id}");
  if (typeof b.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(b.id)) return refuse("pull-out-shape", "id is a card id");
  return null;
}

// The order of the card groups (#C1053). The owner moves a group up or down from the page; Manager's tool is the fallback. Shaped {batch, dir}.
export const GROUP_ORDER_WRITERS = ["owner", "Manager"];
export const GROUP_ID_SHAPE = /^[A-Za-z0-9._\/-]{1,100}$/;
export function groupMoveRefusal(b, who) {
  if (!GROUP_ORDER_WRITERS.includes(who)) return refuse("group-move-owner", `${who ?? "unknown"} cannot order the groups; only the owner (or Manager, as the fallback) can`);
  if (b === null || typeof b !== "object" || Array.isArray(b) || Object.keys(b).some((k) => k !== "batch" && k !== "dir")) return refuse("group-move-shape", "a group move is {batch, dir}");
  if (typeof b.batch !== "string" || !GROUP_ID_SHAPE.test(b.batch)) return refuse("group-move-shape", "batch is a group id");
  if (b.dir !== "up" && b.dir !== "down") return refuse("group-move-shape", "dir is up or down");
  return null;
}
// One rule for the store, the dispatch and the page: a placed group by its place, a group nobody has placed (a new one) after every placed group, a
// card in no group after all groups. `order` is a list of { batch, pos } (or a Map batch -> pos). Two groups of one rank compare by their id.
export const GROUP_NEW = 1e6, GROUP_NONE = 1e9;
export function groupRank(batch, order) {
  if (typeof batch !== "string" || !batch) return GROUP_NONE;
  const pos = order instanceof Map ? order.get(batch) : (Array.isArray(order) ? order.find((o) => o && o.batch === batch)?.pos : undefined);
  return Number.isInteger(pos) && pos >= 1 ? pos : GROUP_NEW;
}
// The id tie-break reads digits as numbers, so g2-... comes before g10-... (a plain string compare would put g10 first).
export const groupIdCompare = (a, b) => String(a || "").localeCompare(String(b || ""), "en", { numeric: true }) || (String(a || "") < String(b || "") ? -1 : String(a || "") > String(b || "") ? 1 : 0);
export function groupCompare(a, b, order) {
  return groupRank(a, order) - groupRank(b, order) || groupIdCompare(a, b);
}

// ONE order of an agent's work, read by the dispatch (collector/store-dispatch.mjs), the stall line (stalledWaits) and the owner's queue move
// (queueCards), so no part of the board can name a different next card than the dispatch wakes the agent for (#C1053, the owner's A and B on 11-12):
//   (1) a card the agent can start comes before one held by a depends_on; (2) its REWORK (a card sent back with findings, or in rework with no reason
//   yet), from any group; (3) its cards in a STARTED group; (4) the next group in the owner's order (a card in no group last); (5) queue_pos, a card
//   the owner placed before one an agent placed, then the card's number (queueRank).
// A card here is { held, rework, groupStarted, group, queue_pos, owner, num, id }.
export function agentRank(a, b, order) {
  return (a.held ? 1 : 0) - (b.held ? 1 : 0) || (a.rework ? 0 : 1) - (b.rework ? 0 : 1) || (a.groupStarted ? 0 : 1) - (b.groupStarted ? 0 : 1) || groupCompare(a.group, b.group, order) || queueRank(a, b);
}
// A card's group as a plain word: its batch id when it is in the plain shape, "" for none or an odd value (as the dispatch's batchOf reads it).
export const groupOf = (c) => (typeof c?.batch === "string" && GROUP_ID_SHAPE.test(c.batch.trim()) ? c.batch.trim() : "");
// The phases whose review note can send a card back with findings (a lane's note: language, design, checker, security).
export const REVIEW_NOTE_PHASES = new Set(["language", "design", "checker", "security"]);
// Whether a card is in REWORK, as the dispatch reads it in turnsOf: the store read a rework with no reason attached yet, or a review's note on the
// card's head says FINDINGS while the card sits at that review's phase. `e` is the card's evidence value (cards.<id>), `card` its row.
export function isRework(card, e) {
  if (e?.rework === true && !(typeof card?.rework_reason === "string" && card.rework_reason !== "")) return true;
  const phase = e?.phase ?? e?.lit?.[0];
  if (typeof phase !== "string" || !REVIEW_NOTE_PHASES.has(phase)) return false;
  return (Array.isArray(e?.findings) ? e.findings : []).some((s) => typeof s === "string" && REVIEW_NOTE_PHASES.has(s));
}
// #C1103 (the owner, 11-16: Boardsmith worked g13 while g3, g10 and g6 waited, because Manager sent the work by hand): a role does not start a card of a lower group
// while a higher group (the owner's order, groupCompare) has an open card of the same role that is the ROLE's turn. ONE rule, read by the pre-push check on a card
// branch's first push (scripts/group-order-check.mjs, from stack-queue.json) and by the store's "being worked out of order" line (outOfOrderWork).
// A card here is the plain shape { id, num, owner_role, group, held, turn }: `turn` = the card needs its owner now (ownerTurn), `held` = paused, blocked, waiting on
// someone else or on a card not live. A card in no group is never a blocker (it ranks after every group). Returns the first blocker { id, num, group }
// (the highest group, then the queue order), or null: allowed in order, and allowed when no higher group has anything for that role.
export function ownerTurn(c, e) {
  const phase = e?.phase ?? e?.lit?.[0];
  if (phase === "live") return false;
  const pushed = !!e && typeof e === "object" && (typeof e.headSha12 === "string" || typeof e.headSha === "string");
  return !pushed || phase === "build" || isRework(c, e);
}
// The owner's ruling (the owner chose A on 11-16, #C1103; Checker 2's M1): the group order decides only which NEW work starts. A card sent back with findings (`rework`) and
// the next card of a group already started (`groupStarted`) come first, as the dispatch's agentRank puts them, so neither is ever blocked or named.
export function groupOrderBlock(card, cards, order) {
  const role = card?.owner_role, mine = typeof card?.group === "string" ? card.group : "";
  if (typeof role !== "string" || !role) return null;
  if (card.rework === true || card.groupStarted === true) return null;
  let best = null;
  for (const c of Array.isArray(cards) ? cards : []) {
    if (!c || c.id === card.id || c.owner_role !== role || !c.turn || c.held || typeof c.group !== "string" || !c.group || c.group === mine) continue;
    if (groupCompare(c.group, mine, order) >= 0) continue;
    if (!best || groupCompare(c.group, best.group, order) < 0 || (c.group === best.group && queueRank(c, best) < 0)) best = c;
  }
  return best ? { id: best.id, num: best.num, group: best.group } : null;
}
// The rows of the store (cards, the evidence by card id) as the rule's plain cards. A dropped, done or live card is no card of the rule.
export function orderCards(rows, evidence) {
  const out = [], members = startedGroupMembers(Array.isArray(rows) ? rows.filter(Boolean) : [], (id) => evidence?.[id]);
  for (const c of Array.isArray(rows) ? rows : []) {
    if (!c || typeof c.id !== "string" || c.dropped || c.done_at) continue;
    const e = evidence?.[c.id];
    if ((e?.phase ?? e?.lit?.[0]) === "live") continue;
    out.push({ id: c.id, num: c.num, owner_role: c.owner_role, group: groupOf(c), queue_pos: c.queue_pos, owner: c.queue_set_by === "owner", held: !!(c.paused || isHeld(c) || dependsNotLive(c, rows, evidence)), turn: ownerTurn(c, e), rework: isRework(c, e), groupStarted: groupStartedByOther(members, groupOf(c), c.id) });
  }
  return out;
}
// The card's role is working it now (the roster reading { role: { state, card } }) while a higher group waits for that role: a line for Manager.
export const ORDER_ROW_END = ": stop it, or have the owner move its group up";
export const orderLine = (c, b) => `#C${c.num} (${c.group || "no group"}) is being worked while #C${b.num} (${b.group}), a higher group's card for the same role, waits${ORDER_ROW_END}`;
// #C1118 (11-16: Manager added review LOWs to #C1113's next_note and the line said "#C1113 is being worked while #C865 waits: stop it"; nobody was building #C1113): the agents
// reading's `card` is only the last card the session's transcript NAMES, so a role that read a note it did not write looked like it was working that card. Only the owner's own
// work counts as worked: a push on the card's branch (a head in the card's evidence), or a step or an ask from the owner role (ownWork: the set of card ids that have one,
// from the store). A next_note or summary write by Manager or a reviewer is none of these.
export function ownWorkOn(c, evidence, ownWork) {
  const e = evidence?.[c.id];
  return (typeof e?.headSha12 === "string" && e.headSha12 !== "") || (typeof e?.headSha === "string" && e.headSha !== "") || (ownWork instanceof Set && ownWork.has(c.id));
}
export function outOfOrderWork({ cards, evidence, agents, groupOrder, ownWork }) {
  const all = orderCards(cards, evidence), roster = agents && typeof agents === "object" ? agents : {}, out = [];
  for (const c of all) {
    const on = roster[c.owner_role];
    if (!(on && on.state === "working" && on.card === c.id) || !c.turn) continue;
    if (!ownWorkOn(c, evidence, ownWork)) continue;
    const b = groupOrderBlock(c, all, groupOrder);
    if (b) out.push({ card_id: c.id, num: c.num, reason: orderLine(c, b) });
  }
  return out;
}
// The groups that have STARTED: a group (batch id) with a card, not dropped, that has been pushed, has landed (live) or is closed as done.
// `rows` are card rows { id, batch, dropped, done_at }; `evidenceOf(id)` gives the card's evidence value.
export function startedGroupSet(rows, evidenceOf) {
  return new Set(startedGroupMembers(rows, evidenceOf).keys());
}
// The same reading, with the cards that started each group: Map group -> Set of card ids. #C1103: the NEXT card of a started group is one another card started,
// so a card's own first push does not make its group "started" for it.
export function startedGroupMembers(rows, evidenceOf) {
  const out = new Map();
  for (const k of rows) {
    if (!k || typeof k.id !== "string" || k.dropped || typeof k.batch !== "string" || !GROUP_ID_SHAPE.test(k.batch.trim())) continue;
    const e = evidenceOf(k.id);
    const pushed = !!e && typeof e === "object" && (typeof e.headSha12 === "string" || typeof e.headSha === "string");
    if (k.done_at || pushed || (e?.phase ?? e?.lit?.[0]) === "live") { const g = k.batch.trim(); if (!out.has(g)) out.set(g, new Set()); out.get(g).add(k.id); }
  }
  return out;
}
// Whether a group was started by a card other than `id` (the card's own push does not count).
export const groupStartedByOther = (members, group, id) => { const s = members.get(group); return !!s && (s.size > 1 || !s.has(id)); };
// #C1082 (the stall line's "next #C.." named a card the dispatch holds): the open-group rule of the dispatch (collector/store-dispatch.mjs, #C1080),
// as a pure function of the store's rows, so the stall line names only a card the dispatch would send. While a role has a STARTED group that is not
// yet READY (a card of the role's in it, active, not asked, not held, not waiting on someone else, with nothing pushed or pushed with the probe's
// stackHold), a NEW build turn is withheld for a card outside that group, except a blocker (of the same role, and theirs in turn) of the group's
// cards; a started group whose unfinished cards all wait on ANOTHER role's cards lets the role take a loose card (in no group), never a card of
// another group. Returns withheld({ role, id, group }) -> boolean for a card nothing is pushed for. ONE rule: the dispatch (collector/store-dispatch.mjs)
// and the stall line (stalledWaits) both call this function (Manager on #C1082: "nothing can drift"); tests/stall-line-knows-open-group.test.mjs runs
// dispatchInput and stalledWaits over the same boards. Inputs: `evidenceOf(id)` the card's evidence value; `askedCards` the cards with an UNANSWERED
// open ask (closed_at and answered_at both null: an answered ask left open does not hold a card, as the dispatch always read it); `endPassed(ref)`
// whether a hold's end has come; `stackOn` the board repository's stack switch (a dependency the same builder has pushed is then satisfied for a board
// card).
export function openGroupWithheld({ now, cards, evidenceOf, askedCards, endPassed, stackOn = false }) {
  const rows = (cards ?? []).filter((k) => k && typeof k.id === "string");
  const phaseOf = (id) => { const e = evidenceOf(id); return e?.phase ?? e?.lit?.[0]; };
  const hasHead = (id) => { const e = evidenceOf(id); return !!e && typeof e === "object" && (typeof e.headSha12 === "string" || typeof e.headSha === "string"); };
  const holdIsOpen = (c) => (typeof c.hold_end === "string" && c.hold_end.trim() !== "" && !endPassed(c.hold_end)) || (Number.isInteger(c.check_at) && c.check_at > now);
  const open = new Map(rows.filter((k) => !k.dropped && !k.done_at).map((k) => [k.id, k]));
  const dependsOf = (c) => { let l = c.depends_on; if (typeof l === "string") { try { l = JSON.parse(l); } catch { return []; } } return Array.isArray(l) ? l.filter((d) => typeof d === "string") : []; };
  const pushed = (id) => hasHead(id) && evidenceOf(id).stack?.outside !== true;
  const waitsOn = (c) => dependsOf(c).filter((d) => d !== c.id && open.has(d) && phaseOf(d) !== "live" && !(stackSatisfies(stackOn, c, open.get(d)) && pushed(d)));
  const active = (k) => !k.paused && !k.dropped && !k.done_at && !k.blocked_reason && phaseOf(k.id) !== "live";
  const started = startedGroupSet(rows.map((k) => ({ ...k, batch: groupOf(k) })), evidenceOf);
  const openG = new Map(), blockedG = new Map(), needed = new Set();
  for (const k of rows) {
    if (typeof k.owner_role !== "string") continue;
    const g = groupOf(k);
    if (g === "" || !started.has(g) || !active(k) || askedCards?.has(k.id) || holdIsOpen(k)) continue;
    if (isHeldBy(k)) continue;
    const blockers = waitsOn(k);
    // #C1160 (Checker 2's F1): a WIP start push has a head but is not READY, in a repository with the stack switch off too (where nothing sets stackHold).
    const unready = !hasHead(k.id) || evidenceOf(k.id)?.stackHold === true || evidenceOf(k.id)?.wipHead === true;
    if (blockers.some((d) => open.get(d)?.owner_role !== k.owner_role)) { if (unready) blockedG.set(k.owner_role, new Set([...(blockedG.get(k.owner_role) ?? []), g])); continue; }
    if (unready) { openG.set(k.owner_role, new Set([...(openG.get(k.owner_role) ?? []), g])); for (const d of blockers) needed.add(d); }
  }
  for (let grew = true; grew;) { grew = false; for (const id of [...needed]) for (const d of open.has(id) ? waitsOn(open.get(id)) : []) if (!needed.has(d)) { needed.add(d); grew = true; } }
  // withheld({ role, id, group }): whether a NEW build turn of the role's card `id` (in `group`, "" for none) is held back.
  return ({ role, id, group }) => {
    const og = openG.get(role), bg = blockedG.get(role);
    return og?.size ? !og.has(group) && !needed.has(id) : bg?.size ? group !== "" && !bg.has(group) : false;
  };
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
const CARD_WORDS = new Set(["id", "title", "summary", "size", "review_level", "from_thread", "track", "owner_role", "next_note", "waiting_on", "blocked_reason", "paused", "dropped", "rework_reason", "customer_text", "look_change", "skip", "depends_on", "issues", "queue_pos", "check_at", "repo", "batch", "bump", "hold_end", "removes", "contract", "changes_definition", "done", "done_evidence"]);
// #C902: what shows a card with no branch is done: a file path (~/ or /), an https link, or a thread message's id (m-<time>-<8 hex>).
export const DONE_EVIDENCE = /^(?:(?:~\/|\/)[^\s]|https:\/\/[^\s]|m-\d{10,16}-[0-9a-f]{8}$)/;
export const ISSUE_KINDS = ["bugs", "security", "language", "design", "owner", "release"];
// #C1114: the counters the probe read from the review notes (reading.issueCounts: bugs, security, language, design) raise the card's stored `issues`: each kind
// becomes the larger of the stored number and the read one, so a later PASS, the same note read again, or a hand-typed number above the read one never lowers
// or doubles anything. `owner` is only ever typed. Returns the new counts, or null when nothing rises (or the reading is no counts).
export function raisedIssues(stored, read) {
  if (!read || typeof read !== "object" || Array.isArray(read)) return null;
  const have = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  const out = { ...have };
  let rose = false;
  for (const k of ["bugs", "security", "language", "design"]) {
    const n = read[k];
    if (!Number.isInteger(n) || n < 1 || n > 99) continue;
    if (!(Number.isInteger(have[k]) && have[k] >= n)) { out[k] = n; rose = true; }
  }
  return rose ? out : null;
}
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
  // #C866: what the card removes, one line of plain words (the page escapes it); null clears it.
  if (fields.removes !== undefined && fields.removes !== null && !(typeof fields.removes === "string" && fields.removes.length <= 300 && !/[\u0000-\u001f\u007f]/.test(fields.removes))) return refuse("card-removes", "removes is one line of up to 300 characters, or null to clear it");
  // #C1169: what a flight-board card touches: one line of plain words naming principle numbers and DATA.md rows (null clears it), and whether it changes one.
  if (fields.contract !== undefined && fields.contract !== null && !(typeof fields.contract === "string" && fields.contract.length <= 400 && !/[\u0000-\u001f\u007f]/.test(fields.contract))) return refuse("card-contract", "contract is one line of up to 400 characters, or null to clear it");
  if (fields.changes_definition !== undefined && fields.changes_definition !== null && ![0, 1, true, false].includes(fields.changes_definition)) return refuse("card-flag", "changes_definition is true or false");
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
// #C1106: the setting holdNoEndSec (worker/knobs.mjs); this is its default. holdWordsOf: "2 h" at the default, whole hours, else minutes.
export const HOLD_NO_END_AFTER_MS = KNOBS.holdNoEndSec.default * 1000;
export const holdNoEndMsOf = (stored) => knobFrom(stored, "holdNoEndSec") * 1000;
export const durWords = (ms) => (ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : `${Math.ceil(ms / 60_000)} min`);
const heldWord = (v) => typeof v === "string" && v.trim() !== "";
// #C1164: waiting_on has ONE reading (worker/held-by.mjs); the stall rules, the open-group rule, the next-card pick, the dispatch and the page (through the view's heldBy) all use it.
export { isHeldBy, heldFor } from "./held-by.mjs";
export const isHeld = (c) => !!c && (!!isHeldBy(c) || heldWord(c.blocked_reason));
// #C1164 (Checker 2's LOW 2): the store's hold BOOKKEEPING (held_at, hold_until, the end it gives a waiting_on) goes by the words alone, whoever they name and whether or not the row or write carries an
// owner_role, so create and update write the same thing; isHeld/isHeldBy above are the READING of who the card is held for.
export const holdWords = (c) => !!c && (heldWord(c.waiting_on) || heldWord(c.blocked_reason));
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
export function autoHoldEnd(fields, existing, now, holdMs = HOLD_NO_END_AFTER_MS) {
  return heldWord(fields.waiting_on) && !heldWord(fields.blocked_reason) && !hasExplicitEnd(fields, existing) ? now + holdMs : null;
}
// #C915 (b): a hold is OPEN while its end has not come: a hold_end naming an ask that is not closed (or a card not dropped or live; one the
// store cannot find stays open), or a check_at still in the future. `endsPassed` is the Set of hold_end ids whose closing has happened.
// An open hold is somebody's decision, not a stall and not a dispatch (collector/store-dispatch.mjs holdOpen is the same rule; a test pins it).
export function holdOpen(c, now, endsPassed) {
  return !!c && ((heldWord(c.hold_end) && !endsPassed?.has(c.hold_end)) || (Number.isInteger(c.check_at) && c.check_at > now));
}
// #C1104 (the owner, 2026-11-16: #C996 kept a Nov 12 hold): a hold whose end has passed ends by itself, instead of a line to Manager to lift it by hand.
// Only two ends end a hold by themselves (Manager's ruling on #C1104): a check_at that has passed, or the store's own 2 h end (hold_until) on a hold with no
// explicit end. A hold_end is never one: a hold whose hold_end names something still open (an open card or ask) stands, even with a check_at that has passed
// (the G17 group holds wait on cards: lapsing them would let the land job land cards alone), and a hold_end that has closed with no check_at still wakes
// Manager through heldWakes ("its end has passed: lift or renew"). A hold with no end at all is not ended here either (heldWakes: "no end set after 2 h").
// Returns [{ id, num, waiting_on, blocked_reason, hold_end, check_at, hold_until, clearCheckAt }]: what the hold said (for hold_history) and whether the
// check_at that ended it goes too (it always is the end here: a check_at still in the future never ends a hold, that date is somebody's wish to look again).
export function endedHolds({ now, cards, endsPassed }) {
  const out = [];
  for (const c of cards ?? []) {
    if (!c || !Number.isInteger(c.num) || c.dropped || c.done_at || !isHeld(c)) continue;
    const timed = Number.isInteger(c.check_at) && c.check_at > 0, ref = heldWord(c.hold_end) ? c.hold_end : null, until = Number.isInteger(c.hold_until) && c.hold_until > 0 ? c.hold_until : null;
    if (ref && !endsPassed?.has(ref)) continue;
    const passed = timed ? c.check_at <= now : !ref && until !== null && until <= now;
    if (!passed) continue;
    out.push({ id: c.id, num: c.num, waiting_on: c.waiting_on ?? null, blocked_reason: c.blocked_reason ?? null, hold_end: c.hold_end ?? null, check_at: c.check_at ?? null, hold_until: c.hold_until ?? null, clearCheckAt: timed && c.check_at <= now });
  }
  return out;
}
// Held cards that need Manager: `endsPassed` is the Set of hold_end ids whose closing has happened (the ask is closed, the card is dropped or live).
// (b) a hold whose end has passed: "#Cn held on <reason>, its end has passed: lift or renew"; (c) a hold with no end for 2 h (counted from
// held_at, else the card's updated_at): "#Cn held on <reason>, no end set after 2 h: lift it or give it an end". One row per (card, reason).
// #C983: the times in these reasons are Mountain Time ("Nov 12 8:45 pm MT"), as Manager and the owner read them.
export function heldWakes({ now, cards, endsPassed, holdMs = HOLD_NO_END_AFTER_MS }) {
  const out = [];
  for (const c of cards ?? []) {
    if (!Number.isInteger(c.num) || c.dropped || c.done_at) continue;
    if (!isHeld(c)) {
      // #C915 (Checker F2): a hold that is only a hold_end (no waiting_on) hides the card from the stall rule, the slow rule and the dispatch while its end has
      // not come; an end that stays open for 2 h (an answer nobody closed, say) is a line to Manager, so the card cannot disappear for ever. One row per (card, end, since).
      if (heldWord(c.hold_end) && !endsPassed?.has(c.hold_end)) {
        const since = Number.isFinite(c.held_at) ? c.held_at : c.updated_at;
        if (Number.isFinite(since) && now - since >= holdMs) out.push({ card_id: c.id, num: c.num, reason: `#C${c.num} waits on ${String(c.hold_end).trim().slice(0, 80)}, whose end has not come after ${durWords(holdMs)}: close it or lift the hold (since ${mtDayTime(since)})` });
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
    if (Number.isFinite(since) && now - since >= holdMs) out.push({ card_id: c.id, num: c.num, reason: `#C${c.num} held on ${why}, no end set after ${durWords(holdMs)}: lift it or give it an end (held since ${mtDayTime(since)})` });
  }
  return out;
}

// #C987 (the owner, 11-11 ~11:05 pm MT, on answered asks still listed With the team: "those look stuck?"): an answered Decision that
// Manager has taken (answer_taken_at), whose card then moved on (its next_note or waiting_on changed after the answer: moved_at), is
// closed by the store 30 minutes after it moved on, with a line to Manager first. Left open, each a test: an answer Manager has not
// taken; a "help" answer (it waits for Manager's reply); any other type; a card that has not moved since the answer; an ask closed by
// the store once and then reopened (auto_closed_at). Returns [{ ask_id, card_id, num, reason, closeAt, due }].
export const AUTO_CLOSE_AFTER_MS = KNOBS.autoCloseSec.default * 1000; // #C1106: the setting autoCloseSec; this is its default
export const autoCloseMsOf = (stored) => knobFrom(stored, "autoCloseSec") * 1000;
export const AUTO_CLOSED_BY = "board";
// lastWord: Map of ask id → its thread's newest message { author, at } (Checker 2 F1 on 1ab7673: the owner's follow-up after his answer,
// the newest word in the thread, keeps the ask open: it waits on the team, so the board never closes over it).
export function movedOnAsks({ now, asks, cards, lastWord, closeMs = AUTO_CLOSE_AFTER_MS }) {
  const byId = new Map((cards ?? []).map((c) => [c.id, c]));
  const out = [];
  for (const a of asks ?? []) {
    if (a.type !== "Decision" || !Number.isFinite(a.answered_at) || a.closed_at || a.withdrawn_at || a.auto_closed_at) continue;
    if (!Number.isFinite(a.answer_taken_at) || a.answer_status === "help") continue;
    const w = lastWord?.get(a.id);
    if (w && w.author === "owner" && w.at > a.answered_at) continue;
    const c = byId.get(a.card_id);
    if (!c || !Number.isFinite(c.moved_at) || c.moved_at <= a.answered_at) continue;
    const closeAt = Math.max(c.moved_at, a.answer_taken_at) + closeMs;
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
// #C982: the board Worker deploy's last result as the probe reads it from the owner's deploy file: { ok, at, line? }, a plain line of up to 160 characters.
// The page shows "Deploy failed: <line>" while the reading is a failure and under 5 minutes old; the next success replaces it.
export const deployLastShape = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every((k) => ["ok", "at", "line"].includes(k))
  && typeof v.ok === "boolean" && Number.isFinite(v.at) && (v.line === undefined || (typeof v.line === "string" && v.line.length <= 160 && /^[\x20-\x7e]*$/.test(v.line)));
// #C1006: each scheduled task's chosen model against the model its last run used, as the probe reads them (collector/schedule-models.mjs):
// { at, tasks: [{ id, chosen, lastRun, at }] }, 30 tasks at most; ids and model names are plain words, chosen and lastRun null when not known.
const SCHED_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, SCHED_MODEL = /^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,63}$/;
const schedWord = (v, re) => v === null || (typeof v === "string" && re.test(v));
export const scheduleModelsShape = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every((k) => k === "at" || k === "tasks")
  && Number.isFinite(v.at) && Array.isArray(v.tasks) && v.tasks.length <= 30
  && v.tasks.every((t) => t !== null && typeof t === "object" && !Array.isArray(t) && Object.keys(t).every((k) => ["id", "chosen", "lastRun", "at"].includes(k))
    && typeof t.id === "string" && SCHED_ID.test(t.id) && schedWord(t.chosen, SCHED_MODEL) && schedWord(t.lastRun, SCHED_MODEL) && (t.at === null || Number.isFinite(t.at)));
// #C1111: each role's chosen model and effort against what its open session runs on (collector/role-sessions.mjs):
// { at, roles: [{ role, chosen, ran, chosenEffort, ranEffort, at }] }, 20 roles at most; names are plain words, any of them null when not known.
const ROLE_WORD = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/, EFFORT_RE = /^(low|medium|high|xhigh|max)$/;
export const sessionChecksShape = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every((k) => k === "at" || k === "roles")
  && Number.isFinite(v.at) && Array.isArray(v.roles) && v.roles.length <= 20
  && v.roles.every((t) => t !== null && typeof t === "object" && !Array.isArray(t) && Object.keys(t).every((k) => ["role", "chosen", "ran", "chosenEffort", "ranEffort", "at"].includes(k))
    && typeof t.role === "string" && ROLE_WORD.test(t.role) && schedWord(t.chosen, SCHED_MODEL) && schedWord(t.ran, SCHED_MODEL)
    && (t.chosenEffort === null || (typeof t.chosenEffort === "string" && EFFORT_RE.test(t.chosenEffort))) && (t.ranEffort === null || (typeof t.ranEffort === "string" && EFFORT_RE.test(t.ranEffort)))
    && (t.at === null || Number.isFinite(t.at)));
// #C1112: the branches whose tip is on main, as the probe lists them (collector/shipped-branches.mjs): { at, repos: [{ name, dir, remote, main, remoteBranches,
// localBranches }] }, 6 repositories and 60 branches of each kind at most, plain names only (the delete lines go to the owner's Terminal as they are).
const SW_NAME = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/, SW_DIR = /^~\/[A-Za-z0-9._\/-]{1,200}$/, SW_WORD = /^[A-Za-z0-9._-]{1,40}$/;
const swBranch = (b) => typeof b === "string" && SW_NAME.test(b) && !b.includes("..") && !b.endsWith("/") && !b.endsWith(".lock");
// Security's L1 on 1a936c92 (#C1112): the never-list is the Worker's too, so a bad probe reading can never put a delete line for main, master, dev or HEAD, or for
// the repository's own main branch (the entry's `main`), in an ask the owner pastes.
const SW_NEVER = new Set(["main", "master", "dev", "HEAD"]);
const swOk = (b, main) => swBranch(b) && !SW_NEVER.has(b) && b !== main;
const swUnique = (names) => new Set(names).size === names.length;
const swList = (l, main) => Array.isArray(l) && l.length <= 60 && l.every((b) => swOk(b, main)) && swUnique(l);
// A remote branch is { name, sha }: the tip the probe saw, which the delete line leases on (Checker 2's LOW 2: a branch pushed again since the listing is not deleted).
const swRemoteList = (l, main) => Array.isArray(l) && l.length <= 60
  && l.every((b) => b !== null && typeof b === "object" && !Array.isArray(b) && Object.keys(b).every((k) => k === "name" || k === "sha") && swOk(b.name, main) && typeof b.sha === "string" && /^[0-9a-f]{40}$/.test(b.sha))
  && swUnique(l.map((b) => b.name));
export const shippedBranchesShape = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every((k) => k === "at" || k === "repos")
  && Number.isFinite(v.at) && Array.isArray(v.repos) && v.repos.length <= 6
  && v.repos.every((r) => r !== null && typeof r === "object" && !Array.isArray(r) && Object.keys(r).every((k) => ["name", "dir", "remote", "main", "remoteBranches", "localBranches"].includes(k))
    && typeof r.name === "string" && SW_WORD.test(r.name) && typeof r.dir === "string" && SW_DIR.test(r.dir) && !r.dir.split("/").includes("..")
    && typeof r.remote === "string" && SW_WORD.test(r.remote) && swBranch(r.main) && swRemoteList(r.remoteBranches, r.main) && swList(r.localBranches, r.main));
export const SWEEP_TITLE = "Shipped branches to delete", SWEEP_CHUNK = 15;
// The Terminal ask for a posted list: one `git push <remote> --force-with-lease=<b>:<sha> ... --delete ...` line per 15 remote branches (a branch pushed again since the
// listing no longer has the sha leased, so it is not deleted) and one `git branch -d ...` per 15 local ones (-d refuses an unmerged branch), each a command of its own with its folder (-C), so any line may be run alone. null when there is nothing to delete.
export function sweepAsk(value) {
  if (!shippedBranchesShape(value)) return null;
  const commands = [];
  let n = 0;
  for (const r of value.repos) {
    for (let i = 0; i < r.remoteBranches.length; i += SWEEP_CHUNK) {
      const chunk = r.remoteBranches.slice(i, i + SWEEP_CHUNK);
      commands.push(`git -C ${r.dir} push ${r.remote} ${chunk.map((b) => `--force-with-lease=${b.name}:${b.sha}`).join(" ")} --delete ${chunk.map((b) => b.name).join(" ")}`);
    }
    for (let i = 0; i < r.localBranches.length; i += SWEEP_CHUNK) commands.push(`git -C ${r.dir} branch -d ${r.localBranches.slice(i, i + SWEEP_CHUNK).join(" ")}`);
    n += r.remoteBranches.length + r.localBranches.length;
  }
  return commands.length ? { title: `${SWEEP_TITLE}: ${n} on main already`, commands } : null;
}
const e2eShape =(v) => v !== null && typeof v === "object" && !Array.isArray(v) && E2E_STATES.includes(v.state) && typeof v.reason === "string" && v.reason.length <= 300
  && (v.run === null || v.run === undefined || typeof v.run === "string") && (v.lastGreenAt === null || v.lastGreenAt === undefined || typeof v.lastGreenAt === "string");
// The one line for Manager's batch when the reading is red, missed or unknown and fresh; null otherwise. Keyed by the state in its first
// words, so the store tells it once per state change (syncE2e), however the reason's hours or the run's link move on.
export const e2eWakeLine = (state) => `daily full test run is ${state}`;
export function e2eWake({ now, value, readAt, staleMs = STALE_AFTER_MS }) {
  if (!e2eShape(value) || value.state === "ok" || !(now - readAt <= staleMs)) return null;
  const why = value.reason.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim().slice(0, 150), run = e2eRun(value.run);
  return { state: value.state, reason: `${e2eWakeLine(value.state)}: ${why}${run ? ` (${run})` : ""}. Look at the product's daily run and tell the owner.` };
}

// Evidence: one lit phase per card, and only the probe writes it.
// #C1100: the shape of the `reviewers` evidence; reviewerOf reads it as collector/store-dispatch.mjs's reviewerFor does (this file imports nothing of the collector: a test holds the two equal).
export const reviewersShape = (v) => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && !!v.reviewers && typeof v.reviewers === "object" && !Array.isArray(v.reviewers)
  && Object.keys(v.reviewers).length <= 20 && Object.entries(v.reviewers).every(([k, r]) => /^[A-Za-z0-9._-]{1,40}$/.test(k) && typeof r === "string" && /^[A-Za-z0-9 _-]{1,24}$/.test(r));
export function reviewerOf(card, reviewers) {
  if (!reviewers || typeof reviewers !== "object" || Array.isArray(reviewers)) return undefined;
  const key = isBoardCard(card) ? "flight-board" : card.repo;
  const role = Object.hasOwn(reviewers, key) ? reviewers[key] : undefined;
  return typeof role === "string" && /^[A-Za-z0-9 _-]{1,24}$/.test(role) ? role : undefined;
}
export function evidenceRefusal(key, value, who, track) {
  if (who !== "probe") return refuse("only-probe-writes-status", `${who ?? "unknown"} cannot write evidence`);
  if (typeof key !== "string" || !/^[a-z][a-z0-9]*(\.[A-Za-z0-9._-]+)?$/.test(key)) return refuse("evidence-key", String(key));
  // #C988: usage.week is a session's reading (the week_usage tool, worker/board-store.mjs writeWeekUsage), never the probe's.
  if (key === "usage.week") return refuse("evidence-key", "usage.week is written by the week_usage tool only");
  if (key === "run.evidence" && !runShape(value)) return refuse("run-shape", "run.evidence is { ok: true|false, at, line up to 160 characters, ms, stateMs, slow: true }");
  if (key === "deploy.last" && !deployLastShape(value)) return refuse("deploy-last-shape", "deploy.last is { ok: true|false, at, line up to 160 characters }");
  if (key === "schedule.models" && !scheduleModelsShape(value)) return refuse("schedule-models-shape", "schedule.models is { at, tasks: [up to 30 of { id, chosen, lastRun, at }] }, ids and model names plain words");
  if (key === "session.checks" && !sessionChecksShape(value)) return refuse("session-checks-shape", "session.checks is { at, roles: [up to 20 of { role, chosen, ran, chosenEffort, ranEffort, at }] }, names plain words");
  if (key === "branches.shipped" && !shippedBranchesShape(value)) return refuse("branches-shipped-shape", "branches.shipped is { at, repos: [up to 6 of { name, dir (~/ folder), remote, main, remoteBranches: [{ name, sha }], localBranches }] }, up to 60 plain branch names of each kind, never main, master, dev or HEAD");
  if (key === "e2e" && !e2eShape(value)) return refuse("e2e-shape", "e2e is { state: ok|red|missed|unknown, reason, run, lastGreenAt }");
  // #C997: the operational settings the probe resolved from the board config's ops section, and the ones it ignored (worker/knobs.mjs).
  if (key === "knobs" && !knobsShape(value)) return refuse("knobs-shape", "knobs is { values: { setting: number }, ignored: [up to 40 of { key, why }] }");
  // #C956: the team's visual lanes, from the board config: { visualLanes: [role names], up to 20 }.
  if (key === "look" && !(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((k) => k === "visualLanes") && Array.isArray(value.visualLanes) && value.visualLanes.length <= 20 && value.visualLanes.every((r) => typeof r === "string" && LANE_NAME.test(r)))) return refuse("look-shape", "look is { visualLanes: [up to 20 role names] }");
  // #C1100: the config's collector.reviewers, { reviewers: { repository word: role name }, up to 20 }, for the stall line's reviewer.
  if (key === "reviewers" && !reviewersShape(value)) return refuse("reviewers-shape", "reviewers is { reviewers: { repository word: role name, up to 20 } }");
  // #C1135: the config's roster, { roster: [up to 40 exact role names] }, for the Remote Control lines.
  if (key === "roster" && !rosterShape(value)) return refuse("roster-shape", "roster is { roster: [up to 40 distinct role names] }");
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
// #C1114 part 2: a step back the probe derives from git (a card at a review phase read at plan, build or test) with no FINDINGS note on the tip it was
// reviewed at and no reason on file. The card does NOT move back: writeEvidence keeps the stored review reading, marks it rework: "unexplained" (the page
// draws it red, the dispatch wakes the reviewer to file the finding) and keeps the real reading in `actual`. A reason attached to it (updateCard) records the
// head it was given for in `reasoned`, and the reading at that head then moves the card back as before. A WIP push before READY is never one: the card
// was not at a review phase (#C1066). Same guards as reworkTriggered: the first push, a card on main or live, nothing before it.
// The sum of a reading's issueCounts (the review notes' items the probe counted across the branch's commits): what the hold compares, so a finding filed on the held head ends it.
export const issueTotal = (c) => (c && typeof c === "object" && !Array.isArray(c) ? Object.values(c).filter((n) => Number.isInteger(n) && n > 0).reduce((a, b) => a + b, 0) : 0);
export function unexplainedStepBack(prev, next) {
  if (!prev || typeof prev !== "object" || !next || typeof next !== "object") return false;
  if (prev.onMain === true || next.onMain === true || next.lit?.[0] === "live") return false;
  // Checker 2's M1 on a7bd1ff5: the reviewer's FINDINGS note is written on the HELD head (A), which the probe's reading of the new tip (B) does not carry as `findings`, but does count
  // in issueCounts (the notes across the branch). A hold ends when that total rises above what the card held at the start of it (`reworkCounts`): the step back is explained.
  if (prev.rework === "unexplained" && issueTotal(next.issueCounts) > (Number.isInteger(prev.reworkCounts) ? prev.reworkCounts : 0)) return false;
  if (typeof prev.headSha12 !== "string" || prev.headSha12 === "") return false;
  if (Array.isArray(prev.findings) && prev.findings.length > 0) return false;
  if (typeof prev.reasoned === "string" && prev.reasoned !== "" && prev.reasoned === next.headSha12) return false;
  return REVIEWED.includes(prev.lit?.[0]) && BEFORE_REVIEW.includes(next.lit?.[0]);
}
// #C992 (11-11: #C913 read "Held: Checker: Full review" for hours after Checker's PASS at 3:41 pm, and the dispatch, which drops a turn whose card's
// waiting_on names someone else, hid Security's turn too): the reviewer roles whose sign-off is NEW in this reading (in next.signed, not in
// prev.signed), and of those the one a card's waiting_on names first ("Checker: Full review", "checker 2 …"), or null. On the transition only: a
// waiting_on written after the sign-off, or one naming a reviewer still due, is never matched. A first reading (prev null) counts its sign-offs as new.
const SIGN_ROLE = { language: "Linguist", design: "Designer", checker: "Checker", security: "Security" };
const signedOf = (v) => new Set((Array.isArray(v?.signed) ? v.signed : []).filter((s) => typeof s === "string" && Object.hasOwn(SIGN_ROLE, s)));
// #C1048 (Security's LOW on G4 v3, the lead's pick A): only a hold in the fixed review-hold form is a review hold, so only it ends when its
// reviewer signs: the role (a numbered second session too), then ": review", ": quick review" or ": full review", any case, nothing after.
// A bare role ("Checker", which builders write as an ordinary hold) is not one. Any other hold ("Security: wait for the owner's ok") stays
// until it is lifted or its end passes. Returns the role it names, or null.
const REVIEW_HOLD = new RegExp(`^(${Object.values(SIGN_ROLE).join("|")})(?: \\d)?: (?:(?:quick|full) )?review$`, "i");
export function reviewHoldRole(waitingOn) {
  const m = typeof waitingOn === "string" ? REVIEW_HOLD.exec(waitingOn.trim().replace(/\s+/g, " ")) : null;
  return m ? Object.values(SIGN_ROLE).find((r) => r.toLowerCase() === m[1].toLowerCase()) : null;
}
export function signoffClears(prev, next, waitingOn) {
  const held = reviewHoldRole(waitingOn);
  if (!held) return null;
  const had = signedOf(prev);
  for (const s of signedOf(next)) if (!had.has(s) && SIGN_ROLE[s] === held) return held;
  return null;
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
// #C1104 part 2 (the owner, 2026-11-16: #C1003 and #C1059 sat open three days after landing; Manager's ruling: option 1): a card in a named repository with no
// install step closes when its commit is on main, with that commit as evidence. A board card (the repo word is one of LANDED_REPO_WORDS) waits for the
// owner's install and closes when it reads live (#C832); a product card (no repo) goes live by its deploy. A card with a part marked in its next_note
// ("part <sha>", #C890) that is not on main stays open: the probe says so in `partsMissing`. Pure: the card's repo word and the reading's two fields in.
export function closesAtLanding({ repo, onMain, partsMissing }) {
  const word = typeof repo === "string" ? repo.trim() : "";
  return onMain === true && word !== "" && !isBoardRepo(word) && !(Array.isArray(partsMissing) && partsMissing.length > 0);
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
// #C1106: the setting stallAfterSec (worker/knobs.mjs); this is its default. The store passes the posted one (stallMsOf) to stalledWaits.
export const STALL_AFTER_MS = KNOBS.stallAfterSec.default * 1000;
export const stallMsOf = (stored) => knobFrom(stored, "stallAfterSec") * 1000;
// The words of a threshold in a stall line: "15 min" at the default, "20 min" at 1200 s; a part of a minute is rounded up, so the row never says less than it waited.
export const minWords = (ms) => `${Math.ceil(ms / 60_000)} min`;
// #C1097 (11-16, about 5 am to 10 am MT: three signed cards sat with Boardsmith and #C1095 with Release; the stalls were in Manager's inbox only, and nothing
// woke the agents): a stall of stalledWaits (an idle or sessionless agent, a card waiting for it) that has lasted STALL_WAKE_AFTER_MS since the store first
// raised it also gets a DISPATCH line for the stalled role, by the dispatch's own path (collector/store-dispatch.mjs agentStallCards); the stall still goes to
// Manager's inbox as before. The store keeps each CURRENT such stall as a row of stall_wakes under card_id "agent-stall:<card id>" and reason "<role>|<reason>",
// already taken (Manager's inbox never holds it), created_at the time it was first raised; the row goes when the stall is over, and a stall with a new reason is a
// new row, so the line fires again only when the reason changes. Role names are plain (no "|").
export const AGENT_STALL = "agent-stall:", STALL_WAKE_AFTER_MS = 30 * 60_000;
export const agentStallRow = (s) => (typeof s?.card_id === "string" && typeof s.role === "string" && /^[A-Za-z0-9 _-]{1,24}$/.test(s.role) && typeof s.reason === "string" ? { card_id: `${AGENT_STALL}${s.card_id}`, reason: `${s.role}|${s.reason}` } : null);
// The view's rows read back: { card_id, role, reason, at }.
export const agentStallOf = (r) => {
  const bar = typeof r?.reason === "string" ? r.reason.indexOf("|") : -1;
  return typeof r?.card_id === "string" && r.card_id.startsWith(AGENT_STALL) && bar > 0 ? { card_id: r.card_id.slice(AGENT_STALL.length), role: r.reason.slice(0, bar), reason: r.reason.slice(bar + 1), at: r.created_at } : null;
};
// #C846: whether a card waits for a card it depends on (depends_on, a JSON list of ids): one that is on the board, not dropped and not
// live. One the board does not have, or a dropped one, holds nothing (as the dispatch reads it, #C845).
// #C1082: with the board repository's stack switch on (stackOn), a dependency the SAME role has pushed is satisfied for a board card, as the dispatch's
// waitsOn reads it (#C914 R4), so the stall line and the dispatch agree on which cards can start.
export function dependsNotLive(c, cards, evidence, stackOn = false) {
  let list = c.depends_on;
  if (typeof list === "string") { try { list = JSON.parse(list); } catch { return false; } }
  if (!Array.isArray(list)) return false;
  const pushed = (d) => { const e = evidence?.[d]; return !!e && typeof e === "object" && (typeof e.headSha12 === "string" || typeof e.headSha === "string") && e.stack?.outside !== true; };
  return list.some((d) => {
    if (typeof d !== "string" || d === c.id) return false;
    const dep = (cards ?? []).find((k) => k && k.id === d && !k.dropped && !k.done_at);
    if (!dep || evidence?.[d]?.lit?.[0] === "live") return false;
    return !(stackSatisfies(stackOn, c, dep) && pushed(d));
  });
}
// #C885 (11-10 9:45 pm MT: #C884, Designer's own card, stalled as "nothing pushed, Designer idle"): a read-only role never pushes for its own
// card; its work is a post or a note on the card's thread. For such a card with nothing pushed, a post by its owner on the card's thread in the
// last POSTED_FRESH_MS means it is being worked (no stall); with none, it stalls on a line of its own that says "nothing posted". postedAt:
// Map card id -> ms of the owner's newest post on the card's thread (the store passes it; missing = none).
export const READ_ONLY_ROLES = ["Designer", "Checker", "Security", "Linguist"], POSTED_FRESH_MS = KNOBS.postedFreshSec.default * 1000; // #C1106: the setting postedFreshSec; this is its default
export const postedFreshMsOf = (stored) => knobFrom(stored, "postedFreshSec") * 1000;
// A span in a line's words: "hour" at the default, then whole hours, else minutes.
export const spanWords = (ms) => (ms === 3_600_000 ? "hour" : ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : `${Math.ceil(ms / 60_000)} min`);
// #C1076 (11-13: #C1006 landed overnight and nobody built its deploy pair for about 7 hours. The dispatch wakes only the card's owner, and
// #C915 (a) keeps a landed board card out of every stall line, so a stopped or out-of-quota owner told nobody): a card of the board's own
// repository, read at ship and on main, that no deploy pair holds (evidence `packed` is not true) 30 minutes after it landed is a line to Manager,
// by day or night and whatever its owner is doing. The landing time is the start of the card's install wait (installWaitStep, #C976). One line per
// group (batch), on the group's newest card, or one per card with no group; the words hold times and ids, not a running count, so the line is
// one row until a pair holds the landing (then nothing is current and the store retires the row). The repo words are collector/pairs.mjs's
// BOARD_REPO_WORDS (this file imports nothing of the collector: tests/landed-wakes-pack-build.test.mjs holds the two equal).
export const LANDED_REPO_WORDS = new Set(["flight-board", "board"]);
// #C1166 (2): copies of collector/pairs.mjs's repoKey, isBoardRepo and isBoardCard (this file imports nothing of the collector; tests/small-duplicate-readings.test.mjs holds the two equal).
export const repoKey = (r) => (typeof r === "string" ? r.trim().toLowerCase().replace(/^.*\//, "").replace(/\.git$/, "") : "");
export const isBoardRepo = (word) => LANDED_REPO_WORDS.has(repoKey(word));
export const isBoardCard = (card) => !card?.repo || isBoardRepo(card.repo);
// #C1295 (product groups stack): the stack switch is per repository. A card's switch row is "board" for a card of the board's own repository and "product" for any other.
// `stackOn` (the rules below take it as a parameter) is a Set of the switch rows that are on, or, as before, a plain boolean that means the board's row alone.
export const stackKeyOf = (card) => (isBoardCard(card) ? "board" : "product");
export const stackOnFor = (stackOn, card) => (stackOn instanceof Set ? stackOn.has(stackKeyOf(card)) : stackOn === true && isBoardCard(card));
// Whether a dependency the same role has pushed is satisfied for `card` (#C914 R4): its repository's switch is on, and the dependency is a card of that same repository.
export const stackSatisfies = (stackOn, card, dep) => stackOnFor(stackOn, card) && stackKeyOf(card) === stackKeyOf(dep) && dep.owner_role === card.owner_role;
export const LANDED_UNBUILT_MS = KNOBS.landedUnbuiltSec.default * 1000; // #C1106: the setting landedUnbuiltSec; this is its default
export const landedUnbuiltMsOf = (stored) => knobFrom(stored, "landedUnbuiltSec") * 1000;
export function landedUnbuilt({ now, cards, evidence, installStart, unbuiltMs = LANDED_UNBUILT_MS }) {
  const groups = new Map();
  for (const c of cards ?? []) {
    if (!Number.isInteger(c.num) || c.dropped || c.done_at || c.paused || !isBoardRepo(c.repo)) continue;
    const v = evidence?.[c.id];
    if (v?.lit?.[0] !== "ship" || v.onMain !== true || v.packed === true) continue;
    const at = installStart instanceof Map ? installStart.get(c.id) : undefined;
    if (!Number.isFinite(at) || now - at < unbuiltMs) continue;
    const key = typeof c.batch === "string" && c.batch.trim() ? c.batch.trim() : c.id;
    groups.set(key, [...(groups.get(key) ?? []), { c, at }]);
  }
  return [...groups].map(([key, list]) => {
    list.sort((x, y) => x.c.num - y.c.num);
    const newest = list[list.length - 1].c, first = Math.min(...list.map((x) => x.at));
    const nums = list.map((x) => `#C${x.c.num}`).join(", ");
    const who = typeof newest.owner_role === "string" && /^[A-Za-z0-9 _-]{1,24}$/.test(newest.owner_role) ? newest.owner_role : "its owner";
    return { card_id: newest.id, num: newest.num, reason: `${nums} landed at ${mtTime(first)} and no deploy pair holds ${list.length > 1 ? "them" : "it"}: ${who} builds it${key !== newest.id ? ` (pack ${/^[A-Za-z0-9._\/-]{1,100}$/.test(key) ? key : "of its group"})` : ""}` };
  });
}
// #C1162 (11-17: #C843 sat paused "until #C827's deploy pair has run" long after #C827 landed, and nobody unpaused it): a card that is paused and names cards in depends_on, every one of
// which has landed (done, or on main, or live), is one line to Manager: its pause reason has landed, unpause it or close it. The board never unpauses a card by itself. A card paused
// with no depends_on, one with a dependency still open (or dropped, or unknown to the board), and a dropped or done card are untouched. The words hold ids, not times, so the row is one
// row per spell: PAUSE_DEP_END ends every such line, and the store drops the row when the line is no longer current (unpaused, or a dependency moved), so a later spell tells again.
export const PAUSE_DEP_END = ": unpause it or close it";
// An open hold (holdOpen: a hold_end that has not ended, or a check_at still to come) is somebody's decision, not a stall (#C915 b), so such a card is skipped as in every other stall line:
// its hold_end ends by the store's own rule (the card dropped, done or live), not by the dependency reaching main (Checker 2's F1).
export function pausedDepLanded({ now = 0, cards, evidence, endsPassed }) {
  const out = [];
  for (const c of cards ?? []) {
    if (!c || !Number.isInteger(c.num) || !c.paused || c.dropped || c.done_at || holdOpen(c, now, endsPassed)) continue;
    let list = c.depends_on;
    if (typeof list === "string") { try { list = JSON.parse(list); } catch { continue; } }
    if (!Array.isArray(list) || !list.length) continue;
    const deps = list.filter((d) => typeof d === "string" && d !== c.id);
    if (!deps.length) continue;
    const landed = deps.map((d) => {
      const dep = (cards ?? []).find((k) => k && k.id === d);
      const ev = evidence?.[d];
      return dep && !dep.dropped && (!!dep.done_at || ev?.onMain === true || ev?.lit?.[0] === "live") ? dep : null;
    });
    if (landed.some((d) => !d)) continue;
    const nums = landed.map((d) => (Number.isInteger(d.num) ? `#C${d.num}` : d.id)).join(", ");
    out.push({ card_id: c.id, num: c.num, reason: `#C${c.num}'s pause has outlived its dependency: ${nums} ${landed.length > 1 ? "have" : "has"} landed${PAUSE_DEP_END}` });
  }
  return out;
}
// #C990 (11-11 about 11:40 pm MT, the disk-full outage: the probe could not run, every step kept its clock, and #C964's Checker step turned red as if
// Checker were stalled): while the probe is silent the team is in an outage, and a step's clock does not run. An outage is { start, end }, the time of the
// last probe post before the silence and of the first one after it (the open one ends at `now`); worker/board-store.mjs records them (team_outages, 0035).
// A step's waited time is its elapsed time less the outage time inside it: a step that was already past its limit before the outage is still late
// during and after it, and one that was not does not turn late because of it. No outages: plain elapsed time, as before.
export const outageOverlap = (from, to, outages) => (Array.isArray(outages) ? outages : []).reduce((sum, o) => (Number.isFinite(o?.start) && Number.isFinite(o?.end) ? sum + Math.max(0, Math.min(o.end, to) - Math.max(o.start, from)) : sum), 0);
export const waited = (from, now, outages) => now - from - outageOverlap(from, now, outages);
// #C1073: a Decision the lead posts in a thread (kind "decision", no ask row: #C920) is open until the owner has written in that thread after it (or a later message of the thread is
// resolved); the card it names (a "Card: <id>" line, else the one #C<n> in its first line) is held like a card with an open ask. This is collector/store-dispatch.mjs openDecisionCards,
// copied (this file imports nothing of the collector): a test fails if the two differ. messages: rows { thread_id, author, body, created_at, kind, resolved }; cards: rows { id, num }.
// Checker 2's note: a decision posted in a card's own thread (thread_id = the card's id) that names no card by a Card line or one #C<n> holds that card.
// openDecisionHolds is the same rule returning Map card id -> id of the card's newest open decision, for the stall line's "held by open decision <id>" row (Manager's second change).
export const openDecisionCards = (messages, cards, lead = "Manager") => new Set(openDecisionHolds(messages, cards, lead).keys());
export function openDecisionHolds(messages, cards, lead = "Manager") {
  const out = new Map(), idByNum = new Map(), ids = new Set();
  for (const c of Array.isArray(cards) ? cards : []) if (c && typeof c.id === "string") { ids.add(c.id); if (Number.isInteger(c.num)) idByNum.set(c.num, c.id); }
  const msgs = (Array.isArray(messages) ? messages : []).filter((m) => m && typeof m.thread_id === "string" && Number.isFinite(m.created_at));
  const settledAt = new Map();
  for (const m of msgs) if (m.author === "owner" || m.resolved) settledAt.set(m.thread_id, Math.max(settledAt.get(m.thread_id) ?? -Infinity, m.created_at));
  for (const m of [...msgs].sort((a, b) => a.created_at - b.created_at)) {
    if (m.kind !== "decision" || typeof lead !== "string" || !lead || m.author !== lead || (settledAt.get(m.thread_id) ?? -Infinity) >= m.created_at) continue; // a resolved decision is settled by itself (settledAt counts it)
    const body = String(m.body ?? ""), named = [...new Set(body.split("\n")[0].match(/#C\d{1,7}\b/g) ?? [])];
    const tagged = /^Card: ([a-z0-9][a-z0-9-]{0,63})$/m.exec(body)?.[1];
    const id = tagged && ids.has(tagged) ? tagged : named.length === 1 ? idByNum.get(Number(named[0].slice(2))) ?? null : ids.has(m.thread_id) ? m.thread_id : null;
    if (id && ids.has(id)) out.set(id, typeof m.id === "string" ? m.id : "");
  }
  return out;
}
// #C1143 (11-16/17: "Boardsmith idle since 11:14 pm" and "Builder idle since 10:25 pm" woke Manager while both sessions were running): the idle reading can lag the
// session. A role whose newest read carries activity inside the stall time (lastActivityAt, the probe's latest read of its transcript) is not idle, whatever its
// `since` says. A reading with no usable lastActivityAt (a blind one) says nothing here, so the idle `since` decides as before; a time a little ahead of `now`
// (a skew between the probe's read and now, up to ACTIVITY_SKEW_MS) is still activity; one further ahead is no activity at all (Security's INFO on cf4eb085: a far-future
// time would silence that role's stall lines for as long as it lies ahead).
export const ACTIVITY_SKEW_MS = 5 * 60_000;
export const activeRecently = (a, now, stallMs = STALL_AFTER_MS) => Number.isFinite(a?.lastActivityAt) && a.lastActivityAt - now <= ACTIVITY_SKEW_MS && now - a.lastActivityAt < stallMs;
export function stalledWaits({ now, cards, evidence, agents, openAskCards, phaseStart, postedAt, endsPassed, groupOrder = [], claims, stackOn = false, unansweredAskCards, outages = [], stallMs = STALL_AFTER_MS, postedFreshMs = POSTED_FRESH_MS, reviewers, decisionHolds }) {
  const out = [], queued = new Map(), idleOf = new Map(), noSession = new Map();
  const roster = agents && typeof agents === "object" ? agents : {};
  const working = new Set(Object.values(roster).filter((a) => a && a.state === "working" && typeof a.card === "string").map((a) => a.card));
  for (const c of cards ?? []) {
    // #C915 (b): a card with an open hold end (hold_end on an open ask or card, or a check_at to come) raises no stall: the hold says why it waits.
    if (!Number.isInteger(c.num) || c.dropped || c.done_at || c.paused || c.blocked_reason || isHeldBy(c) || holdOpen(c, now, endsPassed) || working.has(c.id)) continue;
    const v = evidence?.[c.id], phase = v?.lit?.[0];
    // #C1092 (Checker 2's follow-up on #C1082): the dispatch builds a card whose ask is ANSWERED (an answered Decision left open holds nothing), so the QUEUED test (a
    // card with nothing pushed) asks the same set the dispatch asks, the unanswered open asks; before, c3 with an answered Decision was skipped here ("next #C4")
    // while the dispatch built c3. A card at a phase keeps the plain open-ask test.
    if ((phase === undefined || phase === null ? (unansweredAskCards ?? openAskCards) : openAskCards)?.has(c.id)) continue;
    // #C846: a card with no lit phase (nothing pushed to origin) whose owner has been idle 15 min is a stall of its own: nobody has
    // started it. It is not held, not behind a depends_on that is not live, not the lead's, and touched in the last 3 days (an old
    // card nobody has pushed for is not news). The owner's other cards do not matter: one at review and the rest queued still wake.
    if (phase === undefined || phase === null) {
      const o = typeof c.owner_role === "string" ? roster[c.owner_role] : null;
      // #C940: a reset session reads "unknown" with no `since` until it has said something: idle since its own last activity (see dispatchItems).
      const idleFrom = !o ? null : o.state === "idle" ? o.since : o.state === "unknown" ? o.lastActivityAt : null;
      if (c.owner_role === "Manager" || typeof c.owner_role !== "string" || !/^[A-Za-z0-9 _-]{1,24}$/.test(c.owner_role) || isHeld(c) || holdOpen(c, now, endsPassed) || !Number.isFinite(c.updated_at) || now - c.updated_at > 3 * 24 * 3600e3) continue;
      if (dependsNotLive(c, cards, evidence, stackOn)) continue;
      // #C947 (the gap #C940 left, seen as Role=none in the dispatch log): a card whose owner has NO open session at all, in a reading that lists
      // others (an empty reading is a blind probe, never a stall), has nobody to start it. One line per role, below. A card younger than the stall time
      // is not news. An idle, working or unknown session, a held card, a dependency not live and a closed card raise nothing here.
      if (!o) {
        if (Object.keys(roster).length && waited(c.updated_at, now, outages) >= stallMs) noSession.set(c.owner_role, [...(noSession.get(c.owner_role) ?? []), c]);
        continue;
      }
      if (!Number.isFinite(idleFrom) || waited(idleFrom, now, outages) < stallMs || activeRecently(o, now, stallMs)) continue;
      if (READ_ONLY_ROLES.includes(c.owner_role)) {
        const posted = postedAt instanceof Map ? postedAt.get(c.id) : undefined;
        if (Number.isFinite(posted) && now - posted <= postedFreshMs) continue;
        out.push({ card_id: c.id, num: c.num, phase: null, role: c.owner_role, reason: `#C${c.num} nothing posted on its thread in the last ${spanWords(postedFreshMs)}, ${c.owner_role} idle since ${mtTime(idleFrom)}` });
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
    // #C1084 (11-16: "#C1081 waits at Checker 15 min, Checker idle since 12:47 pm MT" fired while Checker 2 was reviewing it, for #C1078 and #C1080 too):
    // a review a numbered checker holds a claim on (claims: Map card id -> the claim's checker, from the store's review_claims) is that session's wait,
    // so the idle test and the line name it, not the bare role. A claim whose name is not a Checker role is ignored.
    const claimed = phase === "checker" && !behind && claims instanceof Map ? claims.get(c.id) : undefined;
    // #C1100: the checker phase's reviewer is the config's collector.reviewers entry for the card's repository, as the dispatch wakes it (#C1098); a claim still names its own checker first.
    const reviewer = phase === "checker" && !behind ? reviewerOf(c, reviewers) : undefined;
    const role = behind ? c.owner_role : typeof claimed === "string" && /^Checker( [0-9]{1,3})?$/.test(claimed) ? claimed : reviewer ?? PHASE_LANES[phase] ?? c.owner_role;
    if (typeof role !== "string" || !/^[A-Za-z0-9 _-]{1,24}$/.test(role)) continue;
    const a = roster[role], start = phaseStart?.get(`${c.id}|${phase}`);
    const at = behind ? `#C${c.num} signed but behind main${/^[0-9a-f]{12}$/.test(String(v.headSha12)) ? " " + v.headSha12 : ""}, waits at ${role} ${minWords(stallMs)}` : `#C${c.num} waits at ${phase.charAt(0).toUpperCase()}${phase.slice(1)} ${minWords(stallMs)}`;
    if (!a && Object.keys(roster).length && Number.isFinite(start)) {
      if (waited(start, now, outages) >= stallMs) out.push({ card_id: c.id, num: c.num, phase, role, reason: `${at}, no session for ${role}` });
      continue;
    }
    if (!a || a.state !== "idle" || !Number.isFinite(a.since) || !Number.isFinite(start) || activeRecently(a, now, stallMs)) continue;
    if (waited(Math.max(start, a.since), now, outages) < stallMs) continue;
    out.push({ card_id: c.id, num: c.num, phase, role, reason: `${at}, ${role} idle since ${mtTime(a.since)}` });
  }
  // #C1073 (Manager's second change): a card an open decision holds is out of the dispatch and out of the idle-agent count above, but not off the board: its owner idle for the
  // stall time raises one row naming the decision, so a decision the owner settled somewhere else (chat, an answer that is no owner message) cannot freeze a card silently.
  // decisionHolds: Map card id -> the decision's message id (openDecisionHolds). The row is the same words while the decision stays, so it is told once per spell.
  if (decisionHolds instanceof Map) for (const [cardId, msgId] of decisionHolds) {
    const c = (cards ?? []).find((k) => k.id === cardId), o = typeof c?.owner_role === "string" ? roster[c.owner_role] : null;
    if (!c || !Number.isInteger(c.num) || c.dropped || c.done_at || c.paused || c.blocked_reason || holdOpen(c, now, endsPassed) || c.owner_role === "Manager" || !o || o.state !== "idle" || !Number.isFinite(o.since)) continue;
    if (waited(o.since, now, outages) < stallMs || activeRecently(o, now, stallMs)) continue;
    out.push({ card_id: c.id, num: c.num, phase: null, role: c.owner_role, reason: `#C${c.num} held by open decision ${msgId || "(no id)"}, ${c.owner_role} idle since ${mtTime(o.since)}` });
  }
  // #C910: one line per idle agent, not one per queued card (22 queued cards were 22 lines): "Boardsmith idle since 07:31Z, 22 queued, next #C901".
  // The next card is the first of the agent's queue (queueRank, as the dispatch wakes it); the line is its row, so it changes with the count or the next card.
  // #C947: one line per role with no open session, not one per card; the row is its text, so the same count and next card is the same row (not sent every minute).
  // #C1053 (Manager: "so the stall line can never name a different next card"): the next card is the dispatch's pick, by the same function (agentRank): the
  // agent's rework first (a card sent back with findings, which the queued list does not hold: it has a phase), then its started group, then the
  // owner's group order, then queue_pos.
  const started = startedGroupSet((cards ?? []).map((c) => ({ ...c, batch: groupOf(c) })), (id) => evidence?.[id]);
  const rankOf = (c, rework) => ({ id: c.id, num: c.num, queue_pos: c.queue_pos, owner: c.queue_set_by === "owner", group: groupOf(c), groupStarted: started.has(groupOf(c)), rework });
  const fixable = (c) => !c.dropped && !c.done_at && !c.paused && !c.blocked_reason && !(unansweredAskCards ?? openAskCards)?.has(c.id) && !isHeldBy(c) && isRework(c, evidence?.[c.id]);
  const nextOf = (role, list) => [...list.map((c) => ({ c, k: rankOf(c, false) })), ...(cards ?? []).filter((c) => c.owner_role === role && !list.includes(c) && fixable(c)).map((c) => ({ c, k: rankOf(c, true) }))].sort((x, y) => agentRank(x.k, y.k, groupOrder))[0]?.c;
  // #C1082: a card the dispatch's open-group rule withholds (a started group of the role is not READY yet; #C1080) is not queued for the line: it is
  // neither counted nor named as next, and a role whose whole queue is withheld has no line (the dispatch would wake it for nothing either).
  const withheldBy = openGroupWithheld({ now, cards, evidenceOf: (id) => evidence?.[id], askedCards: unansweredAskCards ?? openAskCards, endPassed: (ref) => !!endsPassed?.has(ref), stackOn });
  const withheld = (c) => withheldBy({ role: c.owner_role, id: c.id, group: groupOf(c) });
  for (const [role, all] of noSession) {
    const list = all.filter((c) => !withheld(c)), next = nextOf(role, list);
    if (!next) continue;
    out.push({ card_id: next.id, num: next.num, phase: null, role, reason: `${role} has no open session, ${list.length} queued, next #C${next.num}` });
  }
  for (const [role, all] of queued) {
    const list = all.filter((c) => !withheld(c)), next = nextOf(role, list);
    if (!next) continue;
    out.push({ card_id: next.id, num: next.num, phase: null, role, reason: `${role} idle since ${mtTime(idleOf.get(role))}, ${list.length} queued, next #C${next.num}` });
  }
  return out;
}
// #C1078 (11-13: the quota hit 100% and the dispatch woke Manager once per queued Boardsmith card, "idle, N queued, next #C...", each wake a turn
// that could change nothing): while the session's reading of the week (the week_usage tool, fresh, for the week still running) is QUOTA_OUT_PCT or
// more, every stall stalledWaits raises is about an idle or sessionless agent, and none of them is held back to be sent after the reset: they are
// dropped from this round, so the store retires their rows as any stall that is over, and ONE line goes to Manager instead. The line holds the
// reset time and no percent, so it is one row for the whole spell (a reading of 98, then 99, then 100 is not three wakes). A stale or missing
// reading is no hold (the quota stop of the dispatch treats it the same way). `week` is sessionWeek()'s answer (collector/week-usage.mjs: this file
// imports nothing of the collector). Only stalledWaits' output is passed in: held cards, asks, prompts, landed packs and stale copies are not an
// idle agent's stall and go on as before.
// #C1106: the setting quotaOutPct (worker/knobs.mjs); this is its default. The store passes the posted one (quotaOutPctOf) as outPct.
export const QUOTA_OUT_PCT = KNOBS.quotaOutPct.default, QUOTA_OUT_CARD = "quota-out:";
export const quotaOutPctOf = (stored) => knobFrom(stored, "quotaOutPct");
export function quotaHold({ now, week, stalls, outPct = QUOTA_OUT_PCT }) {
  const list = Array.isArray(stalls) ? stalls : [];
  const out = week?.state === "fresh" && Number.isInteger(week.pct) && week.pct >= outPct && Number.isFinite(week.resetsAt) && week.resetsAt > now;
  if (!out) return { stalls: list, line: [] };
  return { stalls: [], line: [{ card_id: `${QUOTA_OUT_CARD}${week.resetsAt}`, num: null, reason: `The week's quota is used up (${outPct}% or more): idle-agent stall lines are held until it resets at ${mtDayTime(week.resetsAt)}` }] };
}

// #C915 (d): a card that runs past its estimate with nobody having said why. The estimate is the page's: Release's ship is about 10 min (slow from
// the 11th), any other phase is slow past twice the usual time of that phase (`medians`: { phase: ms }, taken by the store from the phase history).
// "No reason" = no waiting_on, no blocked_reason, no pause, no open hold end, no open ask, no unfinished dependency. A card landed on main and not
// deployed is waiting for the install, not slow. One row per card ("#Cn is slow with no reason: add one or unstick it"): giving a reason (or the
// card moving on) ends it, and a row Manager has read is not sent again.
export const SHIP_SLOW_MS = KNOBS.shipSlowSec.default * 1000; // #C1106: the setting shipSlowSec (worker/knobs.mjs); this is its default
export const shipSlowMsOf = (stored) => knobFrom(stored, "shipSlowSec") * 1000;
export const SLOW_LINE_TAIL = " is slow with no reason: add one or unstick it";
export const slowLine = (num) => `#C${num}${SLOW_LINE_TAIL}`;
// #C981: a card in rework whose reason is missing (the evidence's `rework` flag: the store refuses its other writes until one is attached) is
// not "slow with no reason": its line says what is missing and who attaches it, and the dispatch wakes that owner too (store-dispatch.mjs).
// The row ends with the same words as the slow line's, so the store keeps and clears it the same way.
export const SLOW_ROW_END = ": add one or unstick it";
// #C1122: a role whose session has its Remote Control switch turned off (the probe's `rcOff: true` on the agent's reading, from the app's session file) is a line for Manager,
// once per spell: its row goes when the switch is on again (the pending-row cleanup), so a later spell wakes again. No row for a role the probe says nothing about (null is unknown, not off).
export const RC_OFF_CARD = "rc-off:";
// #C1129 (Security's INFO I1 on #C1122): the role must be a roster role, not just a plain name: a roster role's name with optional digits ("Checker 2"), as the probe's own agent rule takes
// them, so a session with a made-up title cannot put a name in Manager's batch. ROSTER_ROLES is the Worker's list of the roster (the same list that names who may write as whom).
// #C1135 (found on #C1129): that list is hard-coded and drifted two ways: a role added to the config but not to it ("Checker 2" was) never got a line, and any roster name plus digits passed,
// "Checker 7" too. The probe now posts the config's own roster (the `roster` evidence, { roster: [exact role names] }) and a role passes only by EXACT name in it. Until the first
// posting arrives (no roster given) the old rule stands.
export const ROSTER_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,23}$/;
export const rosterShape = (v) => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && Array.isArray(v.roster)
  && v.roster.length <= 40 && v.roster.every((r) => typeof r === "string" && ROSTER_NAME.test(r)) && new Set(v.roster).size === v.roster.length;
export const rosterRole = (role, roster) => ROSTER_NAME.test(role) && (Array.isArray(roster) ? roster.includes(role) : ROSTER_ROLES.includes(role.replace(/ \d+$/, "")));
export const rcOffWakes = (agents, roster) => (agents && typeof agents === "object" ? Object.entries(agents) : [])
  .filter(([role, a]) => rosterRole(role, roster) && a?.rcOff === true)
  .sort(([x], [y]) => (x < y ? -1 : 1))
  .map(([role]) => ({ card_id: `${RC_OFF_CARD}${role}`, num: null, reason: `${role} has Remote Control turned off in the app: switch it on in the session's toolbar` }));
// Every wording a syncStalls cleanup finds its rows by with LIKE (SQLite's LIKE ignores ASCII case): writer text that carries one would have its row deleted and put back on every
// sync, a fresh wake each time. claim_review's progress line is refused if it contains any of them, in any case. A new cleanup's mark goes in this list (Security's LOW 1 on #C1115).
export const STALL_LIKE_MARKS = [SLOW_ROW_END, ORDER_ROW_END, REVIEW_LATE_MARK];
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
// #C1093 (11-16: Manager got about 10 of these in a day, each costing a turn: some minutes after a card started, #C1087 a minute after Manager set its reason and note,
// #C1090 while it was only queued behind the owner's current card): (1) a next_note written in the last NOTE_FRESH_MS is the reason (the card's moved_at is when its
// next_note or waiting_on last changed; the "rework reason missing" line is not hidden by it, since the note is refused until the reason is attached); (2) a card the
// owner has not started is not slow: its owner's session is working a DIFFERENT card now (`agents`: the roster reading { role: { state, card } }). No reading, or the owner
// idle or on this card, and the old rule stands.
export const NOTE_FRESH_MS = 60 * 60_000;
// #C1120 (11-16, #C1104, #C1105, #C1108: Manager got "rework reason missing" and then, about 30 s after the reason was attached, "is slow with no reason"): attaching a reason
// clears the card's rework flag, so the #C1063 clause below (which needs the flag) never saw it. `reasonAt` is { card_id: time } of the newest rework_history row; a reason
// attached in the last NOTE_FRESH_MS counts as the line's reason like a fresh next_note, flag or no flag.
export function slowWakes({ now, cards, evidence, openAskCards, phaseStart, medians, endsPassed, outages = [], shipSlowMs = SHIP_SLOW_MS, agents, reasonAt, stackOn = false }) {
  const out = [];
  const roster = agents && typeof agents === "object" ? agents : {};
  for (const c of cards ?? []) {
    if (!Number.isInteger(c.num) || c.dropped || c.done_at || c.paused || isHeld(c) || holdOpen(c, now, endsPassed) || openAskCards?.has(c.id) || dependsNotLive(c, cards, evidence, stackOn)) continue;
    const v = evidence?.[c.id], phase = v?.lit?.[0];
    if (typeof phase !== "string" || !PHASES.includes(phase) || ["live", "pack", "install"].includes(phase)) continue;
    if (phase === "ship" && v.onMain === true) continue;
    const start = phaseStart?.get(`${c.id}|${phase}`);
    if (!Number.isFinite(start) || start > now) continue;
    const limit = phase === "ship" ? shipSlowMs : Number.isFinite(medians?.[phase]) && medians[phase] > 0 ? 2 * medians[phase] : null;
    const missing = v.rework === true && !(typeof c.rework_reason === "string" && c.rework_reason !== "");
    const owner = typeof c.owner_role === "string" && /^[A-Za-z][A-Za-z0-9 _-]{0,40}$/.test(c.owner_role) ? c.owner_role : "the owner";
    // #C1093 (1): a note written in the last hour is the reason. (2): the owner's session is on another card, so this one is queued behind it, not slow.
    if (!missing && typeof c.next_note === "string" && c.next_note.trim() !== "" && Number.isFinite(c.moved_at) && c.moved_at <= now && now - c.moved_at < NOTE_FRESH_MS) continue;
    const on = roster[c.owner_role];
    // Checker 2's M1 on e78bf708: (2) is only where the OWNER does the card's work: build (before it is started or while it is built), or a card sent back to it with findings.
    // At language, design, checker, security and ship the card waits on a reviewer or on Release, and the owner has normally moved on: that wait is exactly what this line is for.
    const ownerWorks = phase === "build" || isRework(c, v);
    if (ownerWorks && on && on.state === "working" && typeof on.card === "string" && on.card !== "" && on.card !== c.id) continue;
    // #C1063 (11-12, #C1053: the line flipped every few minutes between "rework reason missing" and "slow with no reason", and neither Manager's rework_reason nor a note silenced it):
    // a rework card whose reason was attached within the hour has its reason (the card was written to then), and a rework card whose reason is still missing while its owner's
    // session is working this very card is being worked on: that owner attaches it. Neither says anything.
    if (v.rework === true && !missing && Number.isFinite(c.updated_at) && c.updated_at <= now && now - c.updated_at < NOTE_FRESH_MS) continue;
    if (missing && on && on.state === "working" && on.card === c.id) continue;
    const ra = reasonAt instanceof Map ? reasonAt.get(c.id) : reasonAt?.[c.id];
    if (!missing && typeof c.rework_reason === "string" && c.rework_reason !== "" && Number.isFinite(ra) && ra <= now && now - ra < NOTE_FRESH_MS) continue;
    if (limit !== null && waited(start, now, outages) > limit) out.push({ card_id: c.id, num: c.num, reason: missing ? reworkReasonLine(c.num, owner) : slowLine(c.num) });
  }
  return out;
}

// "Live now": only the probe's reading of /version.json counts, and a reading older than 3 min is stale, never live.
// #C997: the setting staleAfterSec (worker/knobs.mjs); this is its default. Readers take the posted setting when the store has one (staleMsOf).
export const STALE_AFTER_MS = KNOBS.staleAfterSec.default * 1000;
export const staleMsOf = (stored) => knobFrom(stored, "staleAfterSec") * 1000;
export function liveNow(reading, now, staleMs = STALE_AFTER_MS) {
  if (!reading || typeof reading.version !== "string" || !Number.isFinite(reading.readAt)) return { state: "unknown", age: null };
  const age = Math.max(0, now - reading.readAt);
  return { state: age > staleMs ? "stale" : "live", version: reading.version, age };
}

// #C927 (the owner, 11-11: a card's tile read "repository copy 47 h 56 min old" and nothing told Manager): the probe's copy of a repository
// is as old as the last time it wrote that repository's cards. The evidence of every open card carries its read time (read_at); a repository's
// word (the card's `repo`, "board" for a card with none) whose OLDEST open reading is over COPY_STALE_MS old is stale. ONE stall per repository
// word and spell (the row's card_id is COPY_CARD + word; the store keeps its reason while the spell lasts, as the daily run's). A card that is
// dropped, closed as done (#C902), live or has no reading is not counted: a reading never written is not an old one.
export const COPY_STALE_MS = KNOBS.copyStaleSec.default * 1000, COPY_CARD = "repo-copy:";
export const copyStaleMsOf = (stored) => knobFrom(stored, "copyStaleSec") * 1000;
export const copyWord = (c) => (typeof c?.repo === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(c.repo) ? c.repo : "board");
export function staleCopies({ now, cards, evidence, readAt, staleMs = COPY_STALE_MS }) {
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
  return [...oldest].filter(([, age]) => age > staleMs).sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([w, age]) => ({ card_id: COPY_CARD + w, num: null, word: w, reason: `the probe's copy of ${w} is ${hours(age)} h old: a fetch may be failing, or a card's reading has stopped being rewritten` }));
}
