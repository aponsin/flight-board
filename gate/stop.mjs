// The gate's Stop hook: node gate/stop.mjs --config <board.config.json>
// A lead-role reply can't end its turn when
// - it states a verdict (the config's verdictWords: shipped, is live, decided…) and the turn wrote nothing to the board
//   (case 4: "the initiative was not up to date"); or
// - the turn began with the owner's "Board thread [<id>]" message and wrote no message to that thread (case 5: an
//   answer in a comment the board never shows).
// Exit 2 sends the reason back, so the lead writes it and finishes. A second stop in a row (stop_hook_active) passes.
import { realpathSync } from "node:fs";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { checkConfig, fullConfig, boardId } from "../scripts/config.mjs";
import { readLines, sessionRole, currentTurn, turnCalls, turnText, lastReply } from "./session.mjs";
import { writesOf } from "./gate.mjs";
import { openOwnerWords, WAIT_MIN } from "./owner-waits.mjs";

const WRITES = new Set(["set", "update", "delete", "batch", "str_replace"]);
const DAY = 864e5;

// The owner's own words in a turn's text: never another session's message, or a reminder, that quotes a ping (#C297:
// a plan quoting the ping's format "Board thread [id]: …" read as the owner writing in a thread named "id").
export const ownText = (text) => String(text).replace(/<cross-session-message[\s\S]*?<\/cross-session-message>/g, "").replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, "");
// The threads the page's pings name: a line that starts "Board thread [<id>]" (its "#T<n>" after it, if numbered), then
// the owner's name, as the page writes it (threadPing), or so quoted by a comment ("> ").
export function threadPings(text, owner) {
  const o = String(owner).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...ownText(text).matchAll(new RegExp(String.raw`^(?:>\s*)?Board thread \[([^\]\s]{1,80})\](?: #T\d+)?: ${o}:`, "gm"))].map((m) => m[1]);
}

// A read of the board's messages that can show every thread waiting (#C297): a list, or a query on "at" alone going back
// a day or more. One thread's messages, or the last hour's, can't.
function readsAll(input, now) {
  if (input.collection !== "messages") return false;
  if (input.action === "list") return true;
  if (input.action !== "query") return false;
  const where = Array.isArray(input.query?.where) ? input.query.where : [];
  return where.every((w) => Array.isArray(w) && w[0] === "at" && (w[1] === ">" || w[1] === ">=") && typeof w[2] === "number" && w[2] <= now - DAY);
}

// The messages this turn's reads of the board returned: [{ id, ...data }], from the result's lines ({"id", "data"} each)
// or from the files an out_dir read saved (<dir>/messages/<id>.json). read: whether any of them reads them all.
export function messagesRead(turn, id, now) {
  const reads = new Map();
  for (const l of turn) {
    if (l?.type !== "assistant" || !Array.isArray(l.message?.content)) continue;
    for (const p of l.message.content) {
      if (p?.type === "tool_use" && p.name === "ArtifactData" && id && String(p.input?.url ?? "").includes(id) && p.input?.collection === "messages") reads.set(p.id, p.input);
    }
  }
  const docs = [];
  let read = false;
  for (const l of turn) {
    if (l?.type !== "user" || !Array.isArray(l.message?.content)) continue;
    for (const p of l.message.content) {
      if (p?.type !== "tool_result" || !reads.has(p.tool_use_id)) continue;
      if (readsAll(reads.get(p.tool_use_id), now)) read = true;
      const body = typeof p.content === "string" ? p.content : Array.isArray(p.content) ? p.content.map((c) => c?.text ?? "").join("\n") : "";
      for (const line of body.split("\n")) {
        if (!line.startsWith("{")) continue;
        try { const d = JSON.parse(line); if (d && typeof d.id === "string" && d.data && typeof d.data === "object") docs.push({ ...d.data, id: d.id }); } catch { /* not a document line */ }
      }
      for (const [f] of body.matchAll(/\/[^\s"']+\/messages\/[^\s"'/]+\.json/g)) {
        try { const d = JSON.parse(readFileSync(f, "utf8")); const data = d?.data && typeof d.data === "object" ? d.data : d; docs.push({ ...data, id: typeof d?.id === "string" ? d.id : f.split("/").pop().slice(0, -5) }); } catch { /* gone or not JSON */ }
      }
    }
  }
  return { read, docs };
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

export function stopCheck(lines, { config, env = {}, now = Date.now() }) {
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
  const text = turnText(turn, "user");
  const asked = threadPings(text, config.owner);
  // A button reply with a note is the owner's word in that item's thread too: the page writes the note there (#C268:
  // the lead answered such notes on #T854-#T856 by comment only). A note that only acknowledges is owed nothing,
  // unless the turn answered it anyway, by comment: then the answer belongs in the thread.
  const commented = turnCalls(turn).some((c) => c.name === "ArtifactComments" && c.input.action === "reply");
  // Files with a note keep the ask waiting on the lead on the page too (settled() wants none): owed, like a question.
  for (const { id: t, note, files } of replyNotes(ownText(text))) if (commented || files || !ackOnly(note)) asked.push(t);
  for (const t of new Set(asked)) {
    if (!writes.some((w) => w.collection === "messages" && w.op !== "delete" && w.data?.thread === t)) out.push(`the owner wrote in thread ${t}: answer there (messages {thread: "${t}", from: "${role}", text, at}), not only here`);
  }
  // The owner's word unanswered on the board (#C297): read the messages every turn, and answer each thread whose newest
  // message is the owner's, WAIT_MIN minutes on, before finishing. This turn's own messages count as answers.
  const seen = messagesRead(turn, id, now);
  if (!seen.read) out.push(`read the board's messages this turn before finishing (ArtifactData query, collection messages, where at > ${now - DAY}, out_dir your scratchpad), then answer every thread whose newest message is the owner's`);
  else {
    const mine = writes.filter((w) => w.collection === "messages" && w.op !== "delete" && w.data && typeof w.data === "object").map((w) => ({ ...w.data, id: w.doc_id }));
    for (const w of openOwnerWords([...seen.docs, ...mine], { owner: config.owner, now, minutes: WAIT_MIN })) {
      out.push(`the owner's message in thread ${w.thread} has waited ${Math.round((now - w.at) / 60e3)} min with no answer: answer there (messages {thread: "${w.thread}", from: "${role}", text, at}) before finishing`);
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
    const errs = stopCheck(readLines(input.transcript_path), { config, env: process.env });
    if (errs.length) { process.stderr.write(`Before you finish:\n- ${errs.join("\n- ")}\n`); process.exit(2); }
    process.exit(0);
  });
}
