// The gate's Stop hook: node gate/stop.mjs --config <board.config.json> [--store]
// --store (#C825, the board on the store): the lead's branch does nothing (the store's own tools and the Worker keep the board; there is no mirror, journal
// or live check to read), and an owner role's dispatch ask is unchanged.
// A lead-role reply can't end its turn when
// - it states a verdict (the config's verdictWords: shipped, is live, decided…) and the turn wrote nothing to the board
//   (case 4: "the initiative was not up to date"); or
// - the turn began with the owner's "Board thread [<id>]" message and wrote no message to that thread (case 5: an
//   answer in a comment the board never shows); or
// - the board holds something that needs the lead: the owner's word unanswered, or an ask the owner answered (needsYou).
// Exit 2 sends the reason back, so the lead writes it and finishes. A second stop in a row (stop_hook_active) passes.
import { realpathSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkConfig, fullConfig, boardId } from "../scripts/config.mjs";
import { readLines, sessionRole, currentTurn, turnCalls, lastReply } from "./session.mjs";
import { writesOf, writeState, home, readMirror, withJournal } from "./gate.mjs";
import { openOwnerWords, WAIT_MIN } from "./owner-waits.mjs";
import { turnLive, nextLive, liveAsk, liveSince, livePath, readLive, writeLive, liveDue } from "./live.mjs";
import { idText } from "../collector/text.mjs";
import { dbWritesOf } from "./tools.mjs";
import { wakePaths, watchAsk, readWakeFile, shQuote, writeAtomic } from "./wake.mjs";
import { DISPATCH_FILE, dispatchPidFile, dispatchWatchAlive, dispatchWokenFile, dispatchWaitCheckedFile } from "./reset.mjs";

const WRITES = new Set(["set", "update", "delete", "batch", "str_replace"]);
const DAY = 864e5;

// The owner's own words in a turn: what a person sent, never a message from another session, whole, whatever its body
// holds (#C298: a plan quoting the ping's format "Board thread [id]: …" read as the owner writing in a thread named
// "id"; a closing tag inside a sender's body must not end the cut early, Security), nor a system reminder.
export function ownTurnText(turn) {
  const parts = [];
  for (const l of turn) {
    if (l?.type !== "user") continue;
    const c = l.message?.content;
    for (const t of typeof c === "string" ? [c] : Array.isArray(c) ? c.filter((p) => p?.type === "text").map((p) => p.text ?? "") : []) {
      if (/<cross-session-message\b|^\s*Another Claude session sent a message/.test(t)) continue;
      parts.push(t.replace(/<system-reminder[\s\S]*<\/system-reminder>/g, ""));
    }
  }
  return parts.join("\n");
}
// The threads the page's pings name: a line that starts "Board thread [<id>]" (its "#T<n>" after it, if numbered), then
// the owner's name, as the page writes it (threadPing), or so quoted by a comment ("> ").
export function threadPings(text, owner) {
  const o = String(owner).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...String(text).matchAll(new RegExp(String.raw`^(?:>\s*)?Board thread \[([^\]\s]{1,80})\](?: #T\d+)?: ${o}:`, "gm"))].map((m) => m[1]);
}

// The hook reads the board itself (#C334, the context-tax brief's card A: the lead's two forced reads cost ~11k tokens a
// turn). Its view: the Collector's mirror (its last export) with the gate's journal laid over it (gate.mjs withJournal:
// every write the gate let through since), plus the page's pings in the transcript for what the owner wrote after the
// export. A ping that failed shows at the next export: the window is anchored to the export's listing, never past it.
//
// since (#C316): the lead's last clean check, less SLACK; with none on record, a day back. A clean check settled every
// owner word its view held WAIT_MIN minutes old or more, so one it left is under WAIT_MIN minutes old then, or written
// after the export's listing (on the owner's clock, which may be a little behind): SLACK covers both.
export const SLACK = (WAIT_MIN + 10) * 60e3;
export const sinceOf = (last, now) => (last == null ? now - DAY : last - SLACK);
// When a collection was listed in the mirror: its newest file (gate.mjs readMirror), else the export's.
const listedAt = (view, c) => (Object.hasOwn(view.atBy ?? {}, c) ? view.atBy[c] : view.at);

// The page's pings in the transcript, each in what a person sent (ownTurnText: never another session's message, nor a
// reminder), at a line's start (or quoted "> "): [{ kind: "thread", id, text, at } | { kind: "reply", id, what, text, at }],
// at the transcript line's time.
const REPLY_WHAT = String.raw`(chose \S+|said OK|asked for changes|marked done|acknowledged|asked for help)`;
export function boardPings(lines, owner) {
  const o = String(owner).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const thread = new RegExp(String.raw`^(?:>\s*)?Board thread \[([^\]\s]{1,80})\](?: #T\d+)?: ${o}: (.*)$`, "gm");
  const reply = new RegExp(String.raw`^(?:>\s*)?Board reply \[([^\]\s]{1,80})\]: ${REPLY_WHAT} on "(.*)$`, "gm");
  const out = [];
  for (const l of lines) {
    const at = Date.parse(l?.timestamp);
    if (l?.type !== "user" || l.isMeta || !Number.isFinite(at)) continue;
    const text = ownTurnText([l]);
    for (const m of text.matchAll(thread)) out.push({ kind: "thread", id: m[1], text: m[2], at });
    for (const m of text.matchAll(reply)) out.push({ kind: "reply", id: m[1], what: m[2], text: m[3], at });
  }
  return out;
}

// #C627: a thread the export lists no numbered threads/<id> doc for (the export has threads, none for this id): the gate takes
// the lead's reply there only with the number in the same batch, so the ask says so instead of the lead trying a bare reply.
const unnumbered = (view, id) => Array.isArray(view.docs.threads) && typeof id === "string" && !/^t-\d{13}$/.test(id) && !view.docs.threads.some((d) => d && d.id === id && Number.isInteger(d.num) && d.num > 0 && typeof d.title === "string" && d.title.trim() !== "");

// What needs the lead now: [{ kind: "thread" | "ask", id, text, at, unnumbered? }], oldest first.
// - a thread whose newest message since `since` is the owner's, WAIT_MIN minutes on (owner-waits.mjs), from the view,
//   this turn's own writes and the thread pings after the messages' listing;
// - an open ask (done not true) with the owner's answer, anything but an Ack or "marked done", not written this turn:
//   from the view, or a reply ping after the asks' listing.
// live: the owner's messages the lead's live queries returned (gate/live.mjs, #C394), counted like the view's. liveAsks:
// the waiting items they returned with the owner's reply (#C406), each over the view's copy when its reply is newer.
export function needsYou({ view, pings, writes, owner, lead, now, since, live = [], liveAsks = [] }) {
  const mine = writes.filter((w) => w.collection === "messages" && w.op !== "delete" && w.data && typeof w.data === "object").map((w) => ({ ...w.data, id: w.doc_id }));
  const known = new Set((view.docs.messages ?? []).map((m) => m?.id));
  const msgs = [...(view.docs.messages ?? []), ...live.filter((m) => !known.has(m.id)), ...mine,
    ...pings.filter((p) => p.kind === "thread" && p.at > listedAt(view, "messages")).map((p) => ({ id: `ping-${p.id}-${p.at}`, thread: p.id, from: owner, text: p.text, at: p.at }))];
  const textOf = new Map(msgs.map((m) => [m.id, m.text]));
  const out = openOwnerWords(msgs.filter((m) => m && typeof m.at === "number" && m.at > since), { owner, now, minutes: WAIT_MIN })
    .map((w) => ({ kind: "thread", id: w.thread, text: textOf.get(w.id), at: w.at, ...(unnumbered(view, w.thread) ? { unnumbered: true } : {}) }));
  const written = new Set(writes.filter((w) => w.collection === "waiting").map((w) => w.doc_id));
  const asks = new Map((view.docs.waiting ?? []).map((d) => [d.id, d]));
  for (const a of liveAsks) {
    const seen = asks.get(a.id), seenAt = typeof seen?.respondedAt === "number" ? seen.respondedAt : seen?.response?.at;
    if (!(typeof seenAt === "number" && seenAt >= a.respondedAt)) asks.set(a.id, { ...seen, ...a });
  }
  const owed = new Map();
  for (const [id, d] of asks) {
    const s = d?.response?.status;
    if (d.done !== true && typeof s === "string" && s !== "ack" && s !== "done") owed.set(id, { what: s === "chose" ? `chose ${d.response.choice ?? ""}`.trim() : s, text: d.text ?? d.question, at: d.response.at ?? d.since ?? 0 });
  }
  for (const p of pings) {
    if (p.kind !== "reply" || !(p.at > listedAt(view, "waiting")) || asks.get(p.id)?.done === true) continue;
    if (p.what === "acknowledged" || p.what === "marked done") owed.delete(p.id);
    else owed.set(p.id, { what: p.what, text: asks.get(p.id)?.text ?? p.text.replace(/"\..*$/, ""), at: p.at });
  }
  // #C460 (cwm-domain-name, "help on: …" at every stop after the team had answered in its thread): a reply is owed only
  // while it is newer than the lead's newest word in the ask's thread (the view, the journal, the live reads, this turn).
  // The lead's only (Security's LOW on 4de1202f): another role's note in the thread doesn't answer the owner.
  const leadAt = new Map();
  for (const m of msgs) if (m && typeof m.thread === "string" && m.from === lead && lead !== owner && typeof m.at === "number" && m.at > (leadAt.get(m.thread) ?? -Infinity)) leadAt.set(m.thread, m.at);
  for (const [id, o] of owed) if (!written.has(id) && !(leadAt.get(id) > o.at)) out.push({ kind: "ask", id, text: `${o.what} on: ${o.text ?? id}`, at: o.at });
  return out.sort((a, b) => a.at - b.at);
}

// Board text in a refusal: one line, no tags, 80 characters at most; ids through idText (Security: a refusal reaches the
// lead with the owner's weight, and board text is a writer's).
const MAX_SHOWN = 20;
const brief = (t) => {
  const s = String(t ?? "").replace(/[\u0000-\u001f\u007f<>"]+/g, " ").replace(/\s+/g, " ").trim();
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
};
export function needsText(items, lead, now) {
  const shown = items.slice(0, MAX_SHOWN).map((i) => `${i.kind} ${idText(i.id)} "${brief(i.text)}" (${Math.max(0, Math.round((now - i.at) / 60e3))} min)`);
  const more = items.length > MAX_SHOWN ? `; and ${items.length - MAX_SHOWN} more` : "";
  const num = items.filter((i) => i.kind === "thread" && i.unnumbered).slice(0, 3).map((i) => idText(i.id));
  const how = [items.some((i) => i.kind === "thread") && `answer in its thread (messages {thread, from: "${lead}", text, at})${num.length ? `; ${num.join(", ")} ${num.length === 1 ? "has" : "have"} no number yet, so number ${num.length === 1 ? "it" : "them"} in the same batch (threads/<id> {num, title} and meta/threadSeq) or the gate refuses the reply` : ""}`, items.some((i) => i.kind === "ask") && "act on each ask and mark it done (waiting update done:true, if_version)"].filter(Boolean).join("; ");
  return `Board: ${items.length} ${items.length === 1 ? "thing needs" : "things need"} you: ${shown.join("; ")}${more}. To finish: ${how}.`;
}

// The view for the hook: the mirror under <stateDir>/<board>, the gate's journal over it; null with no mirror.
export function boardView(config) {
  const dir = join(home(config.gate.stateDir), boardId(config) ?? "no-board");
  let state = {};
  try { state = JSON.parse(readFileSync(join(dir, "gate.json"), "utf8")); } catch { /* none yet */ }
  const m = readMirror(join(dir, "mirror"));
  return m && Object.keys(m.docs).length ? withJournal(m, state.journal) : null;
}

// The record of checked turns: <stateDir>/<board>/stop.json, { sessions: { <role, or a transcript's name>: time } }. A
// key with none, or a time that isn't a number before now, has no last turn (lastPass null).
export const passPath = (config) => join(home(config.gate.stateDir), boardId(config) ?? "no-board", "stop.json");
const readPasses = (path) => {
  try { const j = JSON.parse(readFileSync(path, "utf8")); return j && typeof j.sessions === "object" && j.sessions ? j.sessions : {}; } catch { return {}; }
};
export function lastPass(path, session, now) {
  const s = readPasses(path), t = Object.hasOwn(s, session) ? s[session] : null;
  return typeof t === "number" && Number.isFinite(t) && t <= now ? t : null;
}
// Another session's record written meanwhile may be lost (read, then written whole): that session reads a day back.
export function recordPass(path, session, readAt) {
  writeState(path, { sessions: { ...readPasses(path), [session]: readAt } });
}

// A note that only acknowledges ("ok", "done.", "Thanks!"): the same list as the page's ACK_ONLY, which settles an ask.
export const ACK_ONLY = /^(?:ok(?:ay)?|k|done|thanks?(?: you)?|thx|ty|got it|noted|yes|yep|yup|sure|great|perfect|good|cool|nice|fine|all good|will do|👍|✅|🙏)$/i;
export const ackOnly = (text) => ACK_ONLY.test(String(text || "").trim().replace(/[\s.!👍✅🙏]+$/u, "").replace(/^[\s👍✅🙏]+/u, "") || "ok");

// The notes on the owner's button replies in a turn's text: [{ id, note, files }]. A ping reads 'Board reply [<id>]: <what>
// on "<text>". Note: <note>[ Files (n): …]', in a comment that quotes each line with "> "; the note starts at the page's own
// separator '". Note: ' (the item's text may say "Note: " itself, and run over lines: #C272) and runs to the next ping or
// the comment's end. Only a text holding '". Note: ' itself can still mislead it.
const PING_END = String.raw`(?=\n>?\s*Board (?:reply|thread) \[|\n=== END|$)`;
export function replyNotes(text) {
  const out = [];
  const re = new RegExp(String.raw`Board reply \[([^\]\s]{1,80})\]: (?:(?!\n>?\s*Board (?:reply|thread) \[)[\s\S])*?"\. Note: ([\s\S]*?)` + PING_END, "g");
  for (const m of String(text).matchAll(re)) {
    const body = m[2].replace(/^>\s?/gm, "");
    out.push({ id: m[1], note: body.replace(/ Files \(\d+\): [\s\S]*$/, "").trim(), files: / Files \(\d+\): /.test(body) });
  }
  return out;
}

// view: the board as the hook sees it (boardView), or null with no mirror. journal: unused here (the view has it laid
// over). since: the window's start for owner words (sinceOf). Returns { errs, record, note }: record, when the check is
// clean, is the time to remember for the next turn: the messages' listing in the mirror, which the view is whole up to
// (never later than now); note, a line for the user when the board couldn't be seen.
export const stopCheck = (lines, opts) => stopRun(lines, opts).errs;
// live (#C394): { stored, require } — stored, what live.json holds for the lead ({ checkedAt, msgs }); require, whether
// a turn with no live query is refused (the hook always asks; a caller that passes nothing checks as before). liveNext
// is what live.json keeps after this turn.
// wake (#C580): { hasWake, aliveAt, command } — whether the probe polls the Worker's wake counter, the wake watch's
// heartbeat, and the command that arms it; null asks nothing (a caller that passes nothing checks as before).
// A reply that asks the owner for something (#C584, Director's miss 2: an agent's question for them died in chat) must name
// the card or #T item it lives on. A request is the owner's name near a verb that asks something of them ("<owner> to
// approve", "needs <owner> to", "waiting on <owner>", "<owner>, please"); a reference is #T<n>, #C<n> or a thread id.
// Narrow on purpose: a status line that merely names the owner is not a request.
export function asksOwnerWithoutItem(reply, owner) {
  const text = String(reply ?? ""), name = String(owner ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!name || !text) return false;
  const verbs = "(?:approve|decide|choose|pick|answer|confirm|install|paste|run|click|sign|download|allow|reply|respond|say)";
  const asks = new RegExp(`\\b${name}\\b[^.\\n]{0,40}\\b(?:to|should|must|needs to|has to|please)\\s+${verbs}\\b|\\b(?:needs|needing|waiting on|asks|asking)\\s+${name}\\b|\\b${name},?\\s+please\\b`, "gi");
  // A request, not a negated status line ("nothing is waiting on <owner>", "no need for <owner> to approve it", "nothing
  // needs <owner> now"): a negation earlier in the same sentence, before the match, clears it (Checker on 46d97a0).
  // In front of the match: a negation word. Inside it: only the set forms that negate the request itself ("doesn't need
  // to", "has not been asked to"), not any "never" in a relative clause ("<owner>, who never sleeps, needs to approve").
  const NEG_BEFORE = /\b(?:nothing|nobody|no one|none|no need|not|never|without|neither|nor|isn't|aren't)\b/i;
  const NEG_INSIDE = /\b(?:doesn't|does not|don't|do not|needn't|need not|no need|has not been|hasn't been|have not been|haven't been|is not asked|isn't asked|not asked)\b/i;
  const requested = [...text.matchAll(asks)].some((m) => {
    // Only a negation right in front (the three words before the match) or inside it governs it: "Not urgent, but waiting on
    // <owner>" is still a request (Checker on 650d96f).
    const sentence = text.slice(0, m.index).split(/[.\n;!?]/).pop();
    const clause = sentence.split(/[,:]|\b(?:but|however|though|and|yet)\b/i).pop();
    const near = clause.trim().split(/\s+/).filter(Boolean).slice(-3).join(" ");
    return !(NEG_BEFORE.test(near) || NEG_INSIDE.test(m[0]));
  });
  if (!requested) return false;
  return !/#[TC]\d{1,6}\b|\bt-\d{6,}\b|\bNeeds[- ]you item\b/i.test(text);
}
// dispatch (#C631): { on, alive, askedAt, command } for a roster role other than the lead — whether the probe dispatches (dispatch.json
// exists), whether the role's own watch (a background Bash) is running, when this hook last asked, and the command that arms it.
// The ask is made at most every DISPATCH_ASK_GAP_MS, so a session that can't run a background command is not stopped for ever.
export const DISPATCH_ASK_GAP_MS = 10 * 60e3;
export const dispatchAsk = ({ on, alive, askedAt, command }, now) =>
  on && !alive && !(Number.isFinite(askedAt) && askedAt <= now + 5_000 && now - askedAt < DISPATCH_ASK_GAP_MS)
    ? `Dispatch watch: the board wakes you through it when a card of yours waits and you are idle, and it isn't running. Arm it now (Bash with run_in_background true and no timeout): ${command}. When it ends it has printed a DISPATCH line: act on it, then arm it again.`
    : null;
// #C848 (no-unread-questions, reshaped): nobody reads an agent's chat, so a turn that ends while the board woke the role for a card, with
// nothing pushed and nothing posted on that card's thread, is refused once. The evidence is the board's wake (the DISPATCH its watch printed,
// kept in dispatch-woken-<Role>.json: { at, cards }) and what the turn did (a `git push` in a Bash call, a store `post` to the card's thread),
// never the wording of the last message. Judged once per wake: `checkedAt` is when the last judgment was made.
const WOKEN_CARD = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STORE_POST = /^mcp__[0-9A-Za-z-]{8,64}__post$/;
const GIT_PUSH = /(?:^|[\s;&|(])git\b(?:\s+-[-\w]+(?:[= ]\S+)?)*\s+push\b/;
// A turn the board's wake started is one a background task's notification (the watch ended) or a DISPATCH line opened; a turn a person
// typed into the role's session or another session sent is not judged, and the wake stays unjudged for the turn that is.
const WAKE_TURN = /<task-notification>|\bDISPATCH(?:-LATE)?\b/;
export function startedByWake(turn) {
  const first = (Array.isArray(turn) ? turn : []).find((l) => l?.type === "user" && !l.isMeta);
  const c = first?.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p?.type === "text" ? p.text ?? "" : p?.type === "tool_result" ? JSON.stringify(p.content ?? "") : "")).join("\n") : "";
  return WAKE_TURN.test(text);
}
export function wokenCheck(woken, checkedAt, calls, started = true) {
  if (!started || !woken || !Number.isFinite(woken.at) || (Number.isFinite(checkedAt) && woken.at <= checkedAt)) return { judged: false, ask: null };
  const cards = (Array.isArray(woken.cards) ? woken.cards : []).filter((c) => typeof c === "string" && WOKEN_CARD.test(c));
  const pushed = calls.some((c) => c.name === "Bash" && GIT_PUSH.test(String(c.input?.command ?? "")));
  const posted = new Set(calls.filter((c) => STORE_POST.test(String(c.name))).map((c) => c.input?.thread_id));
  const left = cards.filter((c) => !pushed && !posted.has(c));
  if (!left.length) return { judged: true, ask: null };
  return { judged: true, ask: `Nobody reads this chat. The board woke you for ${left.map(idText).join(", ")}, and this turn pushed nothing and posted nothing on ${left.length === 1 ? "its" : "their"} thread. If it is in your lane, do it (pushing your own build branch, sending READY and taking your next queued card need no go from anyone); otherwise post the question on the card's thread for Manager.` };
}
// #C853 (stop-hook-unpushed-build; R2: models do judgment, programs do hand-offs): a turn that ends on a local build branch with commits
// origin does not have is refused once per tip, whatever the turn said. The evidence is git, read in the session's own folder (the board's
// repository or a product worktree): the branch is build/..., and `git rev-list --count HEAD --not --remotes=origin` counts the commits no
// origin ref holds (a branch never pushed counts too). Once per tip: unpushed-refused-<Role>.json keeps { branch: sha } of the last refusal.
const BUILD_BRANCH = /^build\/[A-Za-z0-9._\/-]{1,120}$/;
export function supersededBy(branch, heads) {
  const m = /^(.*?)(?:-v([0-9]{1,4}))?$/.exec(String(branch)), base = m[1], n = m[2] ? Number(m[2]) : 1;
  return (Array.isArray(heads) ? heads : []).find((h) => { const k = /^(.*?)-v([0-9]{1,4})$/.exec(String(h)); return k && k[1] === base && Number(k[2]) > n; }) ?? null;
}
// A turn that leaves a background task running (a Bash call with run_in_background) is not judged: the agent ends it to wait, and a push now would wake the reviewer on unchecked work.
export function backgroundRunning(calls) { return (Array.isArray(calls) ? calls : []).some((c) => c.name === "Bash" && c.input?.run_in_background === true); }
export function unpushedState(cwd, run = (args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })) {
  try {
    if (typeof cwd !== "string" || !cwd.startsWith("/")) return null;
    const branch = run(["symbolic-ref", "--short", "-q", "HEAD"]).trim();
    if (!BUILD_BRANCH.test(branch)) return null;
    const sha = run(["rev-parse", "HEAD"]).trim();
    const ahead = Number(run(["rev-list", "--count", "HEAD", "--not", "--remotes=origin"]).trim());
    if (!/^[0-9a-f]{40}$/.test(sha) || !Number.isInteger(ahead) || ahead < 0) return null;
    // A re-cut lands and the older -vN is deleted from origin: a session still on it is not asked to push the dead branch back.
    const heads = run(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/build/"]).split("\n").map((l) => l.trim().replace(/^origin\//, ""));
    if (supersededBy(branch, heads)) return null;
    return { branch, sha, ahead };
  } catch { return null; }
}
export function unpushedCheck(state, refused) {
  if (!state || !BUILD_BRANCH.test(String(state.branch)) || !(state.ahead > 0) || !/^[0-9a-f]{40}$/.test(String(state.sha))) return { ask: null, judged: null };
  if (refused && typeof refused === "object" && refused[state.branch] === state.sha) return { ask: null, judged: null };
  const n = state.ahead;
  return { judged: { branch: state.branch, sha: state.sha }, ask: `Your build branch ${state.branch} has ${n} commit${n === 1 ? "" : "s"} that origin does not have (tip ${state.sha.slice(0, 12)}). Push it once the work is green, if it is your own build branch (the owner authorises pushing your own build branch: git push origin ${state.branch}), then send READY. This is asked once per tip.` };
}
export function stopRun(lines, { config, env = {}, now = Date.now(), since = sinceOf(null, now), view = null, live = null, wake = null, dispatch = null, store = false, unpushed = null }) {
  const { role } = sessionRole(lines, env.FLIGHT_BOARD_ROLE);
  if (store && role === config.gate.managerRole) return { errs: [], record: null, note: null, liveNext: null, dispatchAsked: false };
  if (role !== config.gate.managerRole) {
    const ask = dispatch && role && config.roster.includes(role) ? dispatchAsk(dispatch, now) : null;
    const wait = dispatch && role && config.roster.includes(role) ? wokenCheck(dispatch.woken, dispatch.checkedAt, turnCalls(currentTurn(lines)), startedByWake(currentTurn(lines))) : { judged: false, ask: null };
    const push = unpushed && role && config.roster.includes(role) && !backgroundRunning(turnCalls(currentTurn(lines))) ? unpushedCheck(unpushed.state, unpushed.refused) : { ask: null, judged: null };
    const errs = [ask, wait.ask, push.ask].filter(Boolean);
    return { errs, record: null, note: null, liveNext: null, dispatchAsked: !!ask, waitJudged: wait.judged, unpushedJudged: push.judged };
  }
  const id = boardId(config);
  const turn = currentTurn(lines);
  const stored = live?.stored ?? { checkedAt: null, msgs: [], asks: [] };
  const fresh = turnLive(turn, config, liveSince(stored.checkedAt, now)), liveNext = nextLive(stored, fresh, now);
  // The board writes of a call: the old ArtifactData, or the claude-artifacts server's db_write / db_str_replace (#C652).
  const boardWrites = (c) => c.name === "ArtifactData" ? (id && String(c.input.url ?? "").includes(id) && WRITES.has(c.input.action) ? writesOf(c.input) : []) : dbWritesOf(c.name, c.input, config);
  const writes = turnCalls(turn).flatMap((c) => { try { return boardWrites(c); } catch { return []; } });
  // #C607: an ask the lead marked done (waiting update/set done:true) stays done in the kept copy: the live query reads only
  // replies newer than the last check, so it never returns the closed document again, and the copy kept from before the
  // lead acted listed it as owed on every later turn.
  // Only a write that landed counts (Security): a refused, conflicting or failed one leaves the item open on the board.
  const landed = turnCalls(turn, { succeeded: true }).flatMap((c) => { try { return boardWrites(c); } catch { return []; } });
  const closed = new Set(landed.filter((w) => w.collection === "waiting" && w.op !== "delete" && w.data?.done === true).map((w) => w.doc_id));
  if (closed.size) liveNext.asks = liveNext.asks.map((a) => (closed.has(a.id) ? { ...a, done: true } : a));
  const out = [];
  const reply = lastReply(turn);
  const said = (config.gate.verdictWords ?? []).filter((w) => new RegExp(`(^|[^A-Za-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z]|$)`, "i").test(reply));
  if (said.length && !writes.length) out.push(`your reply says "${said[0]}" but this turn wrote nothing to the board: write it there first (the item, its step, or the event)`);
  if (asksOwnerWithoutItem(reply, config.owner)) out.push(`your reply asks ${idText(config.owner)} for something but names no card or #T item: write it as a Needs-you item on the board (a waiting document), and name its #T here; a request left in chat alone never reaches them`);
  const text = ownTurnText(turn);
  const asked = threadPings(text, config.owner);
  // A button reply with a note is the owner's word in that item's thread too: the page writes the note there (#C268:
  // the lead answered such notes on #T854-#T856 by comment only). A note that only acknowledges is owed nothing,
  // unless the turn answered it anyway, by comment: then the answer belongs in the thread.
  const commented = turnCalls(turn).some((c) => c.name === "ArtifactComments" && c.input.action === "reply");
  // Files with a note keep the ask waiting on the lead on the page too (settled() wants none): owed, like a question.
  for (const { id: t, note, files } of replyNotes(text)) if (commented || files || !ackOnly(note)) asked.push(t);
  // A thread id in a refusal goes through idText: the refusal reaches the lead with the owner's weight, and an id is
  // board text a writer chose (Security).
  for (const t of new Set(asked)) {
    if (!writes.some((w) => w.collection === "messages" && w.op !== "delete" && w.data?.thread === t)) out.push(`the owner wrote in thread ${idText(t)}: answer there (messages {thread: "${idText(t)}", from: "${role}", text, at}), not only here`);
  }
  // The check, once a minute (#C556, liveDue); a cut-short or half-done one is asked again whenever: its checkedAt didn't
  // move, and what it missed may be the owner's.
  if (live?.require && (fresh === null ? liveDue(stored.checkedAt, now) : !fresh.complete)) out.push(liveAsk(config, liveSince(stored.checkedAt, now), fresh !== null));
  // The wake watch (#C580): the owner's board messages reach the lead through it, so a turn can't end while it is off.
  const wakeAsk = wake ? watchAsk({ ...wake, now }) : null;
  if (wakeAsk) out.push(wakeAsk);
  // With no mirror, the live check's finds still count (they need none); the rest of the board waits for one.
  if (!view) {
    const bare = { docs: { messages: [], waiting: [] }, at: now, atBy: {} };
    const items = liveNext.msgs.length || liveNext.asks.length ? needsYou({ view: bare, pings: [], writes, owner: config.owner, lead: role, now, since, live: liveNext.msgs, liveAsks: liveNext.asks }) : [];
    if (items.length) out.push(needsText(items, role, now));
    return { errs: out, record: null, note: "Flight board: no board mirror yet, so the Stop hook couldn't check the board this turn (the Collector's next run makes one).", liveNext };
  }
  const items = needsYou({ view, pings: boardPings(lines, config.owner), writes, owner: config.owner, lead: role, now, since, live: liveNext.msgs, liveAsks: liveNext.asks });
  if (items.length) out.push(needsText(items, role, now));
  return { errs: out, record: out.length ? null : Math.min(now, listedAt(view, "messages")), note: null, liveNext };
}

// An owner's dispatch state for the ask (#C631): dispatch.json there (the probe dispatches), the role's watch running (its pid file
// beaten and the process alive), when this hook last asked (dispatch-asked-<Role>.json), and the command that arms the watch.
export function dispatchState(config, configPath, role, now) {
  const dir = join(home(config.gate.stateDir), boardId(config) ?? "no-board");
  const on = (() => { try { readFileSync(join(dir, DISPATCH_FILE), "utf8"); return true; } catch { return false; } })();
  let askedAt = null;
  try { const a = JSON.parse(readFileSync(join(dir, `dispatch-asked-${role}.json`), "utf8")); askedAt = Number.isFinite(a?.at) ? a.at : null; } catch { /* never */ }
  const script = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts", "wake-watch.mjs");
  const readJ = (name) => { try { return JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { return null; } };
  const checked = readJ(dispatchWaitCheckedFile(role));
  return { on, woken: readJ(dispatchWokenFile(role)), checkedAt: Number.isFinite(checked?.at) ? checked.at : null, alive: dispatchWatchAlive(join(dir, dispatchPidFile(role)), now), askedAt, command: `node ${shQuote(script)} --config ${shQuote(configPath)} --role ${shQuote(role)} --once` };
}

// The wake watch's state for the ask: wake.json there (the probe polls the Worker), the heartbeat's time, and the command
// that arms the watch from this very copy of the code.
export function wakeState(config, configPath) {
  const p = wakePaths(join(home(config.gate.stateDir), boardId(config) ?? "no-board"));
  let aliveAt = null;
  try { const a = JSON.parse(readFileSync(p.alive, "utf8")); aliveAt = Number.isFinite(a?.at) ? a.at : null; } catch { /* none */ }
  const script = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts", "wake-watch.mjs");
  return { hasWake: readWakeFile(p.wake) !== null, aliveAt, command: `node ${shQuote(script)} --config ${shQuote(configPath)}` };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const at = process.argv.indexOf("--config");
  let config;
  try {
    const raw = JSON.parse(readFileSync(process.argv[at + 1], "utf8"));
    if (at < 0 || checkConfig(raw).length) throw new Error("bad config");
    config = fullConfig(raw);
  } catch { process.exit(0); }
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    let input = {};
    try { input = JSON.parse(raw); } catch { process.exit(0); }
    if (!input.transcript_path) process.exit(0);
    // A second stop in a row passes, but it records the turn only when its check is clean: a refused turn never moves
    // the next turn's since past an owner word it left waiting. The record is the role's (#C334: a reset starts a new
    // transcript and keeps the window); a session with no role keys it by its transcript's name.
    const now = Date.now(), path = passPath(config), lines = readLines(input.transcript_path);
    const store = process.argv.includes("--store");
    const key = sessionRole(lines, process.env.FLIGHT_BOARD_ROLE).role || basename(String(input.transcript_path), ".jsonl");
    let view = null;
    if (!store) { try { view = boardView(config); } catch { /* unreadable: as none */ } }
    const lp = livePath(config);
    const sessionRoleName = sessionRole(lines, process.env.FLIGHT_BOARD_ROLE).role;
    let dispatch = null;
    if (sessionRoleName && sessionRoleName !== config.gate.managerRole && config.roster.includes(sessionRoleName)) { try { dispatch = dispatchState(config, process.argv[at + 1], sessionRoleName, now); } catch { /* none: no ask */ } }
    // #C853: the session's own folder, read as git sees it; the last refusal per branch (one per tip).
    const refusedPath = join(home(config.gate.stateDir), boardId(config) ?? "no-board", `unpushed-refused-${sessionRoleName}.json`);
    let unpushed = null;
    if (sessionRoleName && sessionRoleName !== config.gate.managerRole && config.roster.includes(sessionRoleName)) {
      let refused = null;
      try { refused = JSON.parse(readFileSync(refusedPath, "utf8")); } catch { /* none */ }
      unpushed = { state: unpushedState(input.cwd), refused };
    }
    const { errs, record, note, liveNext, dispatchAsked, waitJudged, unpushedJudged } = stopRun(lines, { config, env: process.env, now, since: sinceOf(lastPass(path, key, now), now), view, live: { stored: readLive(lp, key), require: true }, wake: wakeState(config, process.argv[at + 1]), dispatch, store, unpushed });
    if (unpushedJudged) { try { mkdirSync(dirname(refusedPath), { recursive: true, mode: 0o700 }); writeAtomic(refusedPath, JSON.stringify(Object.fromEntries([...Object.entries(unpushed.refused && typeof unpushed.refused === "object" ? unpushed.refused : {}), [unpushedJudged.branch, unpushedJudged.sha]].slice(-20)))); } catch { /* asked again at this tip */ } }
    if (dispatchAsked && !input.stop_hook_active) { try { writeAtomic(join(home(config.gate.stateDir), boardId(config) ?? "no-board", `dispatch-asked-${sessionRoleName}.json`), JSON.stringify({ at: now })); } catch { /* asks again */ } }
    if (waitJudged) { try { writeAtomic(join(home(config.gate.stateDir), boardId(config) ?? "no-board", dispatchWaitCheckedFile(sessionRoleName)), JSON.stringify({ at: now })); } catch { /* judged again next stop */ } }
    if (!errs.length && record != null) { try { recordPass(path, key, record); } catch { /* no record: a day back next turn */ } }
    // The live check's messages are kept even on a refused or second stop: they are what the lead's query saw.
    if (liveNext) { try { writeLive(lp, key, liveNext); } catch { /* none kept: the next query reads a day back */ } }
    if (input.stop_hook_active) process.exit(0);
    // A refusal is a JSON block on stdout with exit 0 (#C588), as the red-ask hook does: the app read exit 2 with a phrase
    // like "can't open" in the stderr text (an unanswered thread quoted in the refusal) as a missing script and let the stop
    // through, so the refusal never reached the lead.
    if (errs.length) { process.stdout.write(JSON.stringify({ decision: "block", reason: `Before you finish:\n- ${errs.join("\n- ")}` })); process.exit(0); }
    if (note) process.stdout.write(JSON.stringify({ systemMessage: note }));
    process.exit(0);
  });
}
