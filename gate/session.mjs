// Who is writing, and what this turn did, from the session's transcript (the JSON lines the hooks are given a path to).
// The role is the session's title as the app keeps it (its latest "customTitle"), never a "/pickup <Role>" in the
// conversation: a mistaken pickup once made Release write as Manager. $FLIGHT_BOARD_ROLE, when set, must agree.
import { readFileSync } from "node:fs";

export function readLines(path) {
  let raw = "";
  try { raw = readFileSync(path, "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { /* a line being written */ } }
  return out;
}

// { role, error }: the title's role, checked against the environment's.
export function sessionRole(lines, envRole = "") {
  let title = null;
  for (const l of lines) if (l && typeof l.customTitle === "string" && l.customTitle.trim()) title = l.customTitle.trim();
  const env = String(envRole ?? "").trim();
  if (title && env && title !== env) return { role: null, error: `this session's title is "${title}" but FLIGHT_BOARD_ROLE is "${env}": fix one` };
  const role = title || env || null;
  return { role, error: role ? null : null };
}

// The current turn: everything after the last message a person (or another session) sent, as opposed to tool results.
export function currentTurn(lines) {
  let start = 0;
  lines.forEach((l, n) => {
    if (l?.type !== "user" || l.isMeta) return;
    const c = l.message?.content;
    const fromPerson = typeof c === "string" || (Array.isArray(c) && c.some((p) => p?.type === "text"));
    if (fromPerson) start = n;
  });
  return lines.slice(start);
}

export function turnText(turn, role) {
  const parts = [];
  for (const l of turn) {
    if (l?.type !== role) continue;
    const c = l.message?.content;
    if (typeof c === "string") parts.push(c);
    else if (Array.isArray(c)) for (const p of c) if (p?.type === "text") parts.push(p.text ?? "");
  }
  return parts.join("\n");
}

// The tool calls the assistant made this turn: [{ name, input }].
export function turnCalls(turn) {
  const out = [];
  for (const l of turn) {
    if (l?.type !== "assistant" || !Array.isArray(l.message?.content)) continue;
    for (const p of l.message.content) if (p?.type === "tool_use") out.push({ name: p.name, input: p.input ?? {} });
  }
  return out;
}

// The last thing the assistant said this turn (what the owner reads).
export function lastReply(turn) {
  for (let n = turn.length - 1; n >= 0; n--) {
    const l = turn[n];
    if (l?.type !== "assistant" || !Array.isArray(l.message?.content)) continue;
    const t = l.message.content.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("\n").trim();
    if (t) return t;
  }
  return "";
}
