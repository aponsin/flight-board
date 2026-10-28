// The live owner check (#C394, the owner's A in #T1037): pings that reach the lead mid-turn are dropped (06:36:56 and
// 06:37:18 never arrived), and the Stop gate's view was the Collector's hourly mirror, so it couldn't see them either. A
// hook can't read the board (only a session can, with ArtifactData), so the gate asks the lead for ONE query a turn:
// the owner's messages newer than its last check. The gate reads that query's answer from the transcript (the tool
// result of an ArtifactData query of the board's messages), keeps the owner's messages in <stateDir>/<board>/live.json,
// and counts them in "the owner unanswered" from then on, so nothing waits more than one turn.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { home, writeState } from "./gate.mjs";
import { boardId } from "../scripts/config.mjs";

const DAY = 864e5;
// The owner's clock may be a little behind the hook's: the next query starts this much before the last one.
export const LIVE_SLACK = 2 * 60e3;
// What live.json keeps: the last KEEP_DAYS days' owner messages, at most KEEP of them.
const KEEP_DAYS = 2, KEEP = 300;
export const LIVE_LIMIT = 100;

export const livePath = (config) => join(home(config.gate.stateDir), boardId(config) ?? "no-board", "live.json");
// { checkedAt, msgs } for a role: checkedAt the last turn whose query was read (null: never), msgs its owner messages.
export function readLive(path, role) {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    const r = j && typeof j === "object" && Object.hasOwn(j, role) ? j[role] : null;
    return { checkedAt: typeof r?.checkedAt === "number" ? r.checkedAt : null, msgs: Array.isArray(r?.msgs) ? r.msgs.filter(isMsg) : [] };
  } catch { return { checkedAt: null, msgs: [] }; }
}
export function writeLive(path, role, live) {
  let all = {};
  try { const j = JSON.parse(readFileSync(path, "utf8")); if (j && typeof j === "object" && !Array.isArray(j)) all = j; } catch { /* none yet */ }
  writeState(path, { ...all, [role]: live });
}
// Where the next query starts: the last check less LIVE_SLACK, or a day back with none.
export const liveSince = (checkedAt, now) => (checkedAt == null ? now - DAY : checkedAt - LIVE_SLACK);

const isMsg = (m) => m && typeof m === "object" && typeof m.id === "string" && typeof m.thread === "string" && typeof m.from === "string" && typeof m.at === "number" && Number.isFinite(m.at);

// The query the gate asks for, as the lead types it.
export function liveAsk(config, since) {
  const where = JSON.stringify([["from", "==", config.owner], ["at", ">", since]]);
  return `live board check (one a turn: pings sent while you work are dropped): ArtifactData query, url ${config.artifactUrl}, collection "messages", query {"where": ${where}, "limit": ${LIVE_LIMIT}}. Answer, in its thread, any message it shows that you haven't answered; then finish`;
}

// The documents in a tool result's text: one JSON document per line between the BEGIN and END lines.
export function resultDocs(text) {
  const out = [];
  let inside = false;
  for (const line of String(text).split("\n")) {
    if (/^=== BEGIN ARTIFACT DB /.test(line)) { inside = true; continue; }
    if (/^=== END ARTIFACT DB /.test(line)) { inside = false; continue; }
    if (!inside || !line.startsWith("{")) continue;
    try {
      const d = JSON.parse(line);
      if (d && typeof d.id === "string" && d.data && typeof d.data === "object") out.push({ ...d.data, id: d.id });
    } catch { /* not a document */ }
  }
  return out;
}
const resultText = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("\n") : "");

// This turn's live check: the owner's messages its queries returned, or null when the turn ran none. A query counts when
// it is ArtifactData query (or list) of this board's "messages" whose where holds from == owner, and its result came
// back (not an error). Only the owner's messages are kept, whatever else a result held.
export function turnLive(turn, config) {
  const id = boardId(config);
  const asked = new Map();
  for (const l of turn) {
    if (l?.type !== "assistant" || !Array.isArray(l.message?.content)) continue;
    for (const p of l.message.content) {
      const i = p?.input ?? {};
      if (p?.type !== "tool_use" || p.name !== "ArtifactData" || !id || !String(i.url ?? "").includes(id)) continue;
      if (!["query", "list"].includes(i.action) || i.collection !== "messages") continue;
      const where = Array.isArray(i.query?.where) ? i.query.where : [];
      if (i.action === "query" && !where.some((w) => Array.isArray(w) && w[0] === "from" && (w[1] === "==" || w[1] === "eq") && w[2] === config.owner)) continue;
      asked.set(p.id, true);
    }
  }
  if (!asked.size) return null;
  let ran = false;
  const msgs = [];
  for (const l of turn) {
    if (l?.type !== "user" || !Array.isArray(l.message?.content)) continue;
    for (const p of l.message.content) {
      if (p?.type !== "tool_result" || !asked.has(p.tool_use_id) || p.is_error) continue;
      ran = true;
      for (const d of resultDocs(resultText(p.content))) if (isMsg(d) && d.from === config.owner) msgs.push({ id: d.id, thread: d.thread, from: d.from, at: d.at, text: typeof d.text === "string" ? d.text : "", ...(d.after ? { after: String(d.after) } : {}), ...(d.resolved ? { resolved: true } : {}) });
    }
  }
  return ran ? msgs : null;
}

// What live.json keeps for the role after this turn: the old messages and this turn's (by id, this turn's win), the last
// KEEP_DAYS days', newest KEEP; checkedAt moves to now only when the turn ran its query.
export function nextLive(before, fresh, now) {
  const by = new Map(before.msgs.map((m) => [m.id, m]));
  for (const m of fresh ?? []) by.set(m.id, m);
  const msgs = [...by.values()].filter((m) => m.at > now - KEEP_DAYS * DAY).sort((a, b) => b.at - a.at).slice(0, KEEP);
  return { checkedAt: fresh ? now : before.checkedAt, msgs };
}
