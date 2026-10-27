// The gate's Stop hook: node gate/stop.mjs --config <board.config.json>
// A lead-role reply can't end its turn when
// - it states a verdict (the config's verdictWords: shipped, is live, decided…) and the turn wrote nothing to the board
//   (case 4: "the initiative was not up to date"); or
// - the turn began with the owner's "Board thread [<id>]" message and wrote no message to that thread (case 5: an
//   answer in a comment the board never shows).
// Exit 2 sends the reason back, so the lead writes it and finishes. A second stop in a row (stop_hook_active) passes.
import { realpathSync, statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { checkConfig, fullConfig, boardId } from "../scripts/config.mjs";
import { readLines, sessionRole, currentTurn, turnCalls, lastReply } from "./session.mjs";
import { writesOf } from "./gate.mjs";
import { openOwnerWords, WAIT_MIN } from "./owner-waits.mjs";
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

// The lead's reads of the board's messages this turn (#C298, Manager's design after Checker's findings: every message
// of a day was hundreds, cut to 50 paths with out_dir or one page without a limit; then one read per thread was ~75).
// Two reads, each inline (no out_dir), whole (no "more" in its result) and limit 1000 or more: the owner's own messages
// and the lead's, each a day back or more (where from == <them>, and at > a time a day ago or earlier). Any answer to an
// owner word of the last day is itself of the last day, so the two settle every thread.
const MANY = 1000;
function readKind(input, now, owner, lead) {
  if (input.collection !== "messages" || input.action !== "query" || input.out_dir || !(Number(input.query?.limit) >= MANY)) return null;
  const where = Array.isArray(input.query?.where) ? input.query.where : [];
  const is = (w, f, op) => Array.isArray(w) && w[0] === f && w[1] === op;
  const by = where.filter((w) => is(w, "from", "=="));
  if (by.length !== 1 || (by[0][2] !== owner && by[0][2] !== lead)) return null;
  if (!where.every((w) => w === by[0] || ((is(w, "at", ">") || is(w, "at", ">=")) && typeof w[2] === "number" && w[2] <= now - DAY))) return null;
  return by[0][2] === owner ? "owner" : "lead";
}
// A result cut short: the board's own marker for documents it didn't print, or a cursor to the next page.
const CUT = /next_cursor|\[\d+ more\b|\bmore (?:saved )?documents\b/i;
// A result too large for the transcript is saved to a file, and the transcript keeps a 2 KB preview (Checker: a day's
// owner messages are ~48 KB): the whole result is that file, read only from this session's own tool-results folder
// (<transcript without .jsonl>/tool-results, a regular file there). Anything else is no read: null.
const SAVED = /<persisted-output>[\s\S]*?Full output saved to: (\S+)/;
export function wholeBody(body, results) {
  const m = SAVED.exec(body);
  if (!m) return body;
  if (!results) return null;
  try {
    const f = realpathSync(m[1]), root = realpathSync(results);
    const s = statSync(f);
    if (!f.startsWith(root + sep) || !s.isFile() || s.size > 64e6) return null;
    const raw = readFileSync(f, "utf8");
    try { const j = JSON.parse(raw); if (Array.isArray(j)) return j.map((c) => c?.text ?? "").join("\n"); } catch { /* the text itself */ }
    return raw;
  } catch { return null; }
}
export const resultsDir = (transcript) => (transcript ? join(dirname(transcript), basename(transcript, ".jsonl"), "tool-results") : null);

// What this turn read: { owner, lead: whether each one's messages were read whole, docs: [{ id, ...data }] } from the
// result's document lines ({"id", "data", "version"} each, one per line).
export function messagesRead(turn, id, now, { owner, lead, results = null }) {
  const reads = new Map();
  for (const l of turn) {
    if (l?.type !== "assistant" || !Array.isArray(l.message?.content)) continue;
    for (const p of l.message.content) {
      if (p?.type === "tool_use" && p.name === "ArtifactData" && id && String(p.input?.url ?? "").includes(id)) {
        const k = readKind(p.input ?? {}, now, owner, lead);
        if (k) reads.set(p.id, k);
      }
    }
  }
  const docs = [], whole = new Set();
  for (const l of turn) {
    if (l?.type !== "user" || !Array.isArray(l.message?.content)) continue;
    for (const p of l.message.content) {
      if (p?.type !== "tool_result" || !reads.has(p.tool_use_id)) continue;
      const body = wholeBody(typeof p.content === "string" ? p.content : Array.isArray(p.content) ? p.content.map((c) => c?.text ?? "").join("\n") : "", results);
      if (body == null || CUT.test(body)) continue;
      whole.add(reads.get(p.tool_use_id));
      for (const line of body.split("\n")) {
        if (!line.startsWith("{")) continue;
        try {
          const d = JSON.parse(line);
          if (d && typeof d.id === "string" && d.data && typeof d.data === "object" && "version" in d) docs.push({ ...d.data, id: d.id });
        } catch { /* not a document line */ }
      }
    }
  }
  return { owner: whole.has("owner"), lead: whole.has("lead"), docs };
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

// transcript: the transcript's path, for a result saved beside it (wholeBody).
export function stopCheck(lines, { config, env = {}, now = Date.now(), transcript = null }) {
  const { role } = sessionRole(lines, env.FLIGHT_BOARD_ROLE);
  if (role !== config.gate.managerRole) return [];
  const id = boardId(config);
  const turn = currentTurn(lines);
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
  // The owner's word unanswered on the board (#C298): every turn reads the owner's messages of the last day and the
  // lead's (this turn's own messages count too); a thread whose newest message is the owner's, WAIT_MIN minutes on,
  // refuses the stop until it's answered there.
  const seen = messagesRead(turn, id, now, { owner: config.owner, lead: role, results: resultsDir(transcript) });
  const need = [[seen.owner, config.owner], [seen.lead, role]].filter(([done]) => !done).map(([, who]) => who);
  if (need.length) out.push(`read ${need.map((w) => `${w}'s`).join(" and ")} messages this turn before finishing (ArtifactData query, collection messages, where from == "<name>" and at > ${now - DAY}, limit ${MANY}, no out_dir; one query each)`);
  else {
    const mine = writes.filter((w) => w.collection === "messages" && w.op !== "delete" && w.data && typeof w.data === "object").map((w) => ({ ...w.data, id: w.doc_id }));
    for (const w of openOwnerWords([...seen.docs, ...mine], { owner: config.owner, now, minutes: WAIT_MIN })) {
      const t = idText(w.thread);
      out.push(`the owner's message in thread ${t} has waited ${Math.round((now - w.at) / 60e3)} min with no answer: answer there (messages {thread: "${t}", from: "${role}", text, at}) before finishing`);
    }
  }
  return out;
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
    if (input.stop_hook_active || !input.transcript_path) process.exit(0);
    const errs = stopCheck(readLines(input.transcript_path), { config, env: process.env, transcript: input.transcript_path });
    if (errs.length) { process.stderr.write(`Before you finish:\n- ${errs.join("\n- ")}\n`); process.exit(2); }
    process.exit(0);
  });
}
