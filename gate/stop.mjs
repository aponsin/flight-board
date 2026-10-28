// The gate's Stop hook: node gate/stop.mjs --config <board.config.json>
// A lead-role reply can't end its turn when
// - it states a verdict (the config's verdictWords: shipped, is live, decided…) and the turn wrote nothing to the board
//   (case 4: "the initiative was not up to date"); or
// - the turn began with the owner's "Board thread [<id>]" message and wrote no message to that thread (case 5: an
//   answer in a comment the board never shows); or
// - the board holds something that needs the lead: the owner's word unanswered, or an ask the owner answered (needsYou).
// Exit 2 sends the reason back, so the lead writes it and finishes. A second stop in a row (stop_hook_active) passes.
import { realpathSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkConfig, fullConfig, boardId } from "../scripts/config.mjs";
import { readLines, sessionRole, currentTurn, turnCalls, lastReply } from "./session.mjs";
import { writesOf, writeState, home, readMirror, withJournal } from "./gate.mjs";
import { openOwnerWords, WAIT_MIN } from "./owner-waits.mjs";
import { turnLive, nextLive, liveAsk, liveSince, liveDue, livePath, readLive, writeLive } from "./live.mjs";
import { idText } from "../collector/text.mjs";

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

// What needs the lead now: [{ kind: "thread" | "ask", id, text, at }], oldest first.
// - a thread whose newest message since `since` is the owner's, WAIT_MIN minutes on (owner-waits.mjs), from the view,
//   this turn's own writes and the thread pings after the messages' listing;
// - an open ask (done not true) with the owner's answer, anything but an Ack or "marked done", not written this turn:
//   from the view, or a reply ping after the asks' listing.
// live: the owner's messages the lead's live queries returned (gate/live.mjs, #C394), counted like the view's.
export function needsYou({ view, pings, writes, owner, now, since, live = [] }) {
  const mine = writes.filter((w) => w.collection === "messages" && w.op !== "delete" && w.data && typeof w.data === "object").map((w) => ({ ...w.data, id: w.doc_id }));
  const known = new Set((view.docs.messages ?? []).map((m) => m?.id));
  const msgs = [...(view.docs.messages ?? []), ...live.filter((m) => !known.has(m.id)), ...mine,
    ...pings.filter((p) => p.kind === "thread" && p.at > listedAt(view, "messages")).map((p) => ({ id: `ping-${p.id}-${p.at}`, thread: p.id, from: owner, text: p.text, at: p.at }))];
  const textOf = new Map(msgs.map((m) => [m.id, m.text]));
  const out = openOwnerWords(msgs.filter((m) => m && typeof m.at === "number" && m.at > since), { owner, now, minutes: WAIT_MIN })
    .map((w) => ({ kind: "thread", id: w.thread, text: textOf.get(w.id), at: w.at }));
  const written = new Set(writes.filter((w) => w.collection === "waiting").map((w) => w.doc_id));
  const asks = new Map((view.docs.waiting ?? []).map((d) => [d.id, d]));
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
  for (const [id, o] of owed) if (!written.has(id)) out.push({ kind: "ask", id, text: `${o.what} on: ${o.text ?? id}`, at: o.at });
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
  const how = [items.some((i) => i.kind === "thread") && `answer in its thread (messages {thread, from: "${lead}", text, at})`, items.some((i) => i.kind === "ask") && "act on each ask and mark it done (waiting update done:true, if_version)"].filter(Boolean).join("; ");
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
export function stopRun(lines, { config, env = {}, now = Date.now(), since = sinceOf(null, now), view = null, live = null }) {
  const { role } = sessionRole(lines, env.FLIGHT_BOARD_ROLE);
  if (role !== config.gate.managerRole) return { errs: [], record: null, note: null, liveNext: null };
  const id = boardId(config);
  const turn = currentTurn(lines);
  const stored = live?.stored ?? { checkedAt: null, msgs: [] };
  const fresh = turnLive(turn, config, liveSince(stored.checkedAt, now)), liveNext = nextLive(stored, fresh, now);
  const writes = turnCalls(turn).filter((c) => c.name === "ArtifactData" && id && String(c.input.url ?? "").includes(id) && WRITES.has(c.input.action))
    .flatMap((c) => { try { return writesOf(c.input); } catch { return []; } });
  const out = [];
  const reply = lastReply(turn);
  const said = (config.gate.verdictWords ?? []).filter((w) => new RegExp(`(^|[^A-Za-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z]|$)`, "i").test(reply));
  if (said.length && !writes.length) out.push(`your reply says "${said[0]}" but this turn wrote nothing to the board: write it there first (the item, its step, or the event)`);
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
  // A cut-short check is asked again at once, whatever the 5-min throttle says: its checkedAt didn't move.
  if (live?.require && (fresh === null ? liveDue(stored.checkedAt, now) : !fresh.complete)) out.push(liveAsk(config, liveSince(stored.checkedAt, now), fresh !== null));
  // With no mirror, the live check's messages still count (they need none); the rest of the board waits for one.
  if (!view) {
    const bare = { docs: { messages: [], waiting: [] }, at: now, atBy: {} };
    const items = liveNext.msgs.length ? needsYou({ view: bare, pings: [], writes, owner: config.owner, now, since, live: liveNext.msgs }) : [];
    if (items.length) out.push(needsText(items, role, now));
    return { errs: out, record: null, note: "Flight board: no board mirror yet, so the Stop hook couldn't check the board this turn (the Collector's next run makes one).", liveNext };
  }
  const items = needsYou({ view, pings: boardPings(lines, config.owner), writes, owner: config.owner, now, since, live: liveNext.msgs });
  if (items.length) out.push(needsText(items, role, now));
  return { errs: out, record: out.length ? null : Math.min(now, listedAt(view, "messages")), note: null, liveNext };
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
    const key = sessionRole(lines, process.env.FLIGHT_BOARD_ROLE).role || basename(String(input.transcript_path), ".jsonl");
    let view = null;
    try { view = boardView(config); } catch { /* unreadable: as none */ }
    const lp = livePath(config);
    const { errs, record, note, liveNext } = stopRun(lines, { config, env: process.env, now, since: sinceOf(lastPass(path, key, now), now), view, live: { stored: readLive(lp, key), require: true } });
    if (!errs.length && record != null) { try { recordPass(path, key, record); } catch { /* no record: a day back next turn */ } }
    // The live check's messages are kept even on a refused or second stop: they are what the lead's query saw.
    if (liveNext) { try { writeLive(lp, key, liveNext); } catch { /* none kept: the next query reads a day back */ } }
    if (input.stop_hook_active) process.exit(0);
    if (errs.length) { process.stderr.write(`Before you finish:\n- ${errs.join("\n- ")}\n`); process.exit(2); }
    if (note) process.stdout.write(JSON.stringify({ systemMessage: note }));
    process.exit(0);
  });
}
