// The live owner check (#C394, the owner's A in #T1037): pings that reach the lead mid-turn are dropped (06:36:56 and
// 06:37:18 never arrived), and the Stop gate's view was the Collector's hourly mirror, so it couldn't see them either. A
// hook can't read the board (only a session can, with ArtifactData), so the gate asks the lead for ONE check a turn:
// the owner's messages newer than its last check, and (#C406, Manager's B) the waiting items the owner replied to since,
// two queries. The gate reads their answers from the transcript (the tool results of the ArtifactData queries), keeps
// what they found in <stateDir>/<board>/live.json, and counts it in "the owner unanswered" from then on, so nothing
// waits more than one turn.

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
// Every lead turn runs it (#C406): #C394's 5-minute throttle let a turn end unchecked a minute after a check, and Manager
// missed the owner's 18:03Z reply for ~10 min. The owner's A in #T1037 was one query per turn.

export const livePath = (config) => join(home(config.gate.stateDir), boardId(config) ?? "no-board", "live.json");
// { checkedAt, msgs, asks } for a role: checkedAt the last turn whose check was read whole (null: never), msgs its owner
// messages, asks the waiting items it returned with the owner's reply (#C406).
export function readLive(path, role) {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    const r = j && typeof j === "object" && Object.hasOwn(j, role) ? j[role] : null;
    return { checkedAt: typeof r?.checkedAt === "number" ? r.checkedAt : null, msgs: Array.isArray(r?.msgs) ? r.msgs.filter(isMsg) : [], asks: Array.isArray(r?.asks) ? r.asks.filter(isAsk) : [] };
  } catch { return { checkedAt: null, msgs: [], asks: [] }; }
}
export function writeLive(path, role, live) {
  let all = {};
  try { const j = JSON.parse(readFileSync(path, "utf8")); if (j && typeof j === "object" && !Array.isArray(j)) all = j; } catch { /* none yet */ }
  writeState(path, { ...all, [role]: live });
}
// Where the next query starts: the last check less LIVE_SLACK, or a day back with none.
export const liveSince = (checkedAt, now) => (checkedAt == null ? now - DAY : checkedAt - LIVE_SLACK);

const isMsg = (m) => m && typeof m === "object" && typeof m.id === "string" && typeof m.thread === "string" && typeof m.from === "string" && typeof m.at === "number" && Number.isFinite(m.at);
// A waiting item the owner replied to: the page stamps respondedAt beside its response (#C406), since a query can't
// reach the nested response.at.
const isAsk = (a) => a && typeof a === "object" && typeof a.id === "string" && a.response && typeof a.response === "object" && typeof a.respondedAt === "number" && Number.isFinite(a.respondedAt);

// The ArtifactData query's largest page: what the gate asks for after a cut-short result.
const LIVE_MAX = 1000;

// The check the gate asks for, as the lead types it: two queries, one check (#C406, Manager's B): the owner's messages,
// and the waiting items the owner replied to (a button with no note writes no message). cut: the turn's check came back
// cut short or half done, so it is asked again with the largest page.
export function liveAsk(config, since, cut = false) {
  const where = JSON.stringify([["from", "==", config.owner], ["at", ">", since]]), replied = JSON.stringify([["respondedAt", ">", since]]);
  const why = cut ? "your last one came back cut short (its limit filled, or more pages) or without both queries, so it doesn't count yet; run both again" : "every turn: pings sent while you work are dropped";
  const limit = cut ? LIVE_MAX : LIVE_LIMIT;
  return `live board check (${why}): two ArtifactData queries, url ${config.artifactUrl}: collection "messages", query {"where": ${where}, "limit": ${limit}}; and collection "waiting", query {"where": ${replied}, "limit": ${limit}}. Answer, in its thread, any message they show that you haven't answered, and act on any reply; then finish`;
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
const isGt = (op) => op === ">" || op === "gt";
// Whether a call is one of the two queries the gate asks for (Checker's FINDINGS on 5b07a2c): ArtifactData query of
// this board, no cursor (a later page isn't the window) and nothing else in the query but its where, limit and order,
// with a time bound X a number no later than since, so the window reaches back to the last check. "messages": where
// exactly from == owner and at > X (either order). "waiting" (#C406): where exactly respondedAt > X. Returns { kind,
// limit } (100 by default, as the tool's); null: not the live check.
function liveQuery(i, config, id, since) {
  if (i.action !== "query" || !["messages", "waiting"].includes(i.collection) || !String(i.url ?? "").includes(id)) return null;
  const q = i.query;
  if (!q || typeof q !== "object" || Object.keys(q).some((k) => !["where", "limit", "order_by"].includes(k))) return null;
  const where = Array.isArray(q.where) ? q.where : [];
  if (!where.every((w) => Array.isArray(w) && w.length === 3)) return null;
  const bound = (w) => w && isGt(w[1]) && typeof w[2] === "number" && w[2] <= since;
  if (i.collection === "messages") {
    if (where.length !== 2) return null;
    const from = where.find((w) => w[0] === "from"), at = where.find((w) => w[0] === "at");
    if (!from || !isEq(from[1]) || from[2] !== config.owner || !bound(at)) return null;
  } else if (where.length !== 1 || where[0][0] !== "respondedAt" || !bound(where[0])) return null;
  const limit = q.limit ?? LIVE_LIMIT;
  return Number.isInteger(limit) && limit > 0 ? { kind: i.collection, limit } : null;
}

// This turn's live check: { msgs, asks, complete }, or null when the turn ran neither query. msgs, the owner's messages
// its messages queries returned (only the owner's, whatever else a result held); asks, the waiting items its waiting
// queries returned with a reply on them; complete, whether each of the two came back whole at least once: fewer
// documents than its limit and no next_cursor. A cut-short or missing half's finds still count, but it isn't the check
// (Checker: a truncated result moved checkedAt, so the next window skipped what it cut). since: where the window must
// start (liveSince).
export function turnLive(turn, config, since) {
  const id = boardId(config);
  if (!id) return null;
  const asked = new Map();
  for (const l of turn) {
    if (l?.type !== "assistant" || !Array.isArray(l.message?.content)) continue;
    for (const p of l.message.content) {
      if (p?.type !== "tool_use" || p.name !== "ArtifactData") continue;
      const q = liveQuery(p.input ?? {}, config, id, since);
      if (q) asked.set(p.id, q);
    }
  }
  if (!asked.size) return null;
  let ran = false;
  const whole = new Set(), msgs = [], asks = [];
  for (const l of turn) {
    if (l?.type !== "user" || !Array.isArray(l.message?.content)) continue;
    for (const p of l.message.content) {
      if (p?.type !== "tool_result" || !asked.has(p.tool_use_id) || p.is_error) continue;
      ran = true;
      const { kind, limit } = asked.get(p.tool_use_id), { docs, more } = resultPage(resultText(p.content));
      if (!more && docs.length < limit) whole.add(kind);
      for (const d of docs) {
        if (kind === "messages" && isMsg(d) && d.from === config.owner) msgs.push({ id: d.id, thread: d.thread, from: d.from, at: d.at, text: typeof d.text === "string" ? d.text : "", ...(d.after ? { after: String(d.after) } : {}), ...(d.resolved ? { resolved: true } : {}) });
        if (kind === "waiting" && isAsk(d)) asks.push({ id: d.id, respondedAt: d.respondedAt, response: d.response, ...(d.done === true ? { done: true } : {}), ...(typeof d.text === "string" ? { text: d.text } : {}), ...(typeof d.question === "string" ? { question: d.question } : {}), ...(typeof d.since === "number" ? { since: d.since } : {}) });
      }
    }
  }
  return ran ? { msgs, asks, complete: whole.has("messages") && whole.has("waiting") } : null;
}

// What live.json keeps for the role after this turn: the old messages and asks and this turn's (by id, this turn's win),
// the last KEEP_DAYS days', newest KEEP of each; checkedAt moves to now only when the turn's check came back whole.
export function nextLive(before, fresh, now) {
  const keep = (old, got, at) => {
    const by = new Map(old.map((x) => [x.id, x]));
    for (const x of got) by.set(x.id, x);
    return [...by.values()].filter((x) => at(x) > now - KEEP_DAYS * DAY).sort((a, b) => at(b) - at(a)).slice(0, KEEP);
  };
  return { checkedAt: fresh?.complete ? now : before.checkedAt, msgs: keep(before.msgs, fresh?.msgs ?? [], (m) => m.at), asks: keep(before.asks ?? [], fresh?.asks ?? [], (a) => a.respondedAt) };
}
