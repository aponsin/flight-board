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
// A turn ending within LIVE_EVERY_MIN of the last check isn't asked again (Manager's yes to the design: at most one
// query every 5 minutes); what that check returned still counts.
export const LIVE_EVERY_MIN = 5;
export const liveDue = (checkedAt, now) => checkedAt == null || now - checkedAt >= LIVE_EVERY_MIN * 60e3;

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

// The ArtifactData query's largest page: what the gate asks for after a cut-short result.
const LIVE_MAX = 1000;

// The query the gate asks for, as the lead types it. cut: the turn's query came back cut short, so it is asked again with
// the largest page.
export function liveAsk(config, since, cut = false) {
  const where = JSON.stringify([["from", "==", config.owner], ["at", ">", since]]);
  const why = cut ? "your last one came back cut short (its limit filled, or more pages), so it doesn't count yet; run it again" : "at most one every 5 min: pings sent while you work are dropped";
  return `live board check (${why}): ArtifactData query, url ${config.artifactUrl}, collection "messages", query {"where": ${where}, "limit": ${cut ? LIVE_MAX : LIVE_LIMIT}}. Answer, in its thread, any message it shows that you haven't answered; then finish`;
}

// A tool result's page: its documents (one JSON document per line between the BEGIN and END lines) and whether it says
// more exist (a next_cursor line outside them).
export function resultPage(text) {
  const docs = [];
  let inside = false, more = false;
  for (const line of String(text).split("\n")) {
    if (/^=== BEGIN ARTIFACT DB /.test(line)) { inside = true; continue; }
    if (/^=== END ARTIFACT DB /.test(line)) { inside = false; continue; }
    if (!inside) { if (/^next_cursor:/.test(line)) more = true; continue; }
    if (!line.startsWith("{")) continue;
    try {
      const d = JSON.parse(line);
      if (d && typeof d.id === "string" && d.data && typeof d.data === "object") docs.push({ ...d.data, id: d.id });
    } catch { /* not a document */ }
  }
  return { docs, more };
}
export const resultDocs = (text) => resultPage(text).docs;
const resultText = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("\n") : "");

const isEq = (op) => op === "==" || op === "eq";
// Whether a call is the query the gate asks for (Checker's FINDINGS on 5b07a2c): ArtifactData query of this board's
// "messages", where exactly from == owner and at > X (either order) with X a number no later than since, so the window
// reaches back to the last check; no cursor (a later page isn't the window) and nothing else in the query but its limit
// and order. Its limit (100 by default, as the tool's) is returned; null: not the live check.
function liveQuery(i, config, id, since) {
  if (i.action !== "query" || i.collection !== "messages" || !String(i.url ?? "").includes(id)) return null;
  const q = i.query;
  if (!q || typeof q !== "object" || Object.keys(q).some((k) => !["where", "limit", "order_by"].includes(k))) return null;
  const where = Array.isArray(q.where) ? q.where : [];
  if (where.length !== 2 || !where.every(Array.isArray)) return null;
  const from = where.find((w) => w[0] === "from"), at = where.find((w) => w[0] === "at");
  if (!from || !at || from.length !== 3 || at.length !== 3 || !isEq(from[1]) || from[2] !== config.owner) return null;
  if (!(at[1] === ">" || at[1] === "gt") || typeof at[2] !== "number" || !(at[2] <= since)) return null;
  const limit = q.limit ?? LIVE_LIMIT;
  return Number.isInteger(limit) && limit > 0 ? limit : null;
}

// This turn's live check: { msgs, complete }, or null when the turn ran none. msgs, the owner's messages its live queries
// returned (only the owner's, whatever else a result held); complete, whether one came back whole: fewer documents than
// its limit and no next_cursor. A cut-short result's messages still count, but it isn't the check (Checker: a truncated
// result moved checkedAt, and the 5-min throttle then hid what it cut). since: where the window must start (liveSince).
export function turnLive(turn, config, since) {
  const id = boardId(config);
  if (!id) return null;
  const asked = new Map();
  for (const l of turn) {
    if (l?.type !== "assistant" || !Array.isArray(l.message?.content)) continue;
    for (const p of l.message.content) {
      if (p?.type !== "tool_use" || p.name !== "ArtifactData") continue;
      const limit = liveQuery(p.input ?? {}, config, id, since);
      if (limit != null) asked.set(p.id, limit);
    }
  }
  if (!asked.size) return null;
  let ran = false, complete = false;
  const msgs = [];
  for (const l of turn) {
    if (l?.type !== "user" || !Array.isArray(l.message?.content)) continue;
    for (const p of l.message.content) {
      if (p?.type !== "tool_result" || !asked.has(p.tool_use_id) || p.is_error) continue;
      ran = true;
      const { docs, more } = resultPage(resultText(p.content));
      if (!more && docs.length < asked.get(p.tool_use_id)) complete = true;
      for (const d of docs) if (isMsg(d) && d.from === config.owner) msgs.push({ id: d.id, thread: d.thread, from: d.from, at: d.at, text: typeof d.text === "string" ? d.text : "", ...(d.after ? { after: String(d.after) } : {}), ...(d.resolved ? { resolved: true } : {}) });
    }
  }
  return ran ? { msgs, complete } : null;
}

// What live.json keeps for the role after this turn: the old messages and this turn's (by id, this turn's win), the last
// KEEP_DAYS days', newest KEEP; checkedAt moves to now only when the turn's query came back whole.
export function nextLive(before, fresh, now) {
  const by = new Map(before.msgs.map((m) => [m.id, m]));
  for (const m of fresh?.msgs ?? []) by.set(m.id, m);
  const msgs = [...by.values()].filter((m) => m.at > now - KEEP_DAYS * DAY).sort((a, b) => b.at - a.at).slice(0, KEEP);
  return { checkedAt: fresh?.complete ? now : before.checkedAt, msgs };
}
