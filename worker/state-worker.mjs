// flight-board-state (#C420): a Cloudflare Worker that keeps each board's latest state (collector/state.mjs posts it every
// minute) and serves it to the board page as a read-only remote MCP tool, board_state. Many boards, one Worker; it runs
// on the owner's own Cloudflare account, deployed by the owner from the pinned copy (scripts/state-install.mjs).
//   POST /b/<board id>/state   Authorization: Bearer <token>   (the state, at most 64 KB, once per 30 s)
//   POST /mcp/<path>           JSON-RPC: initialize, tools/list, tools/call board_state, ping
// Each board has one Worker secret, BOARD_<16 hex of sha256(board id)> = {"token": sha256(token), "path": sha256(path)}:
// the Worker holds hashes only, and compares them in constant time. A POST is checked field by field against
// collector/state-schema.mjs and stored as pickState() of it; the tool answers pickState() of what is stored, never the
// stored text. Anything else, a wrong path included, is a bare 404. No CORS: the page reaches it through claude.ai.
import { stateErrors, pickState, MAX_BYTES } from "../collector/state-schema.mjs";

export const RATE_MS = 30_000;
// KV writes are the account's, shared with every other Worker on it (Workers Paid, the owner's plan: a million a month
// included; Workers Free: 1,000 a day). A POST is stored only when what the page shows changed (changeKey), else as a
// heartbeat every HEARTBEAT_MS, and never more than WRITES_PER_DAY times a UTC day (a [vars] value in wrangler.toml;
// WRITES_DEFAULT when unset). The probe posts once a minute, 1,440 a day at most, so the default never stops a day's
// changes (Checker); the cap is there for a runaway poster. An unchanged POST is a 204 that writes nothing; one past the
// budget a 429 until midnight UTC.
export const HEARTBEAT_MS = 15 * 60e3, WRITES_DEFAULT = 2000;
// What the page shows, without the times that move on every run (board.at, each card's at, lastActivityAt) and the
// numbers that tick (ciMin).
export const changeKey = (s) => JSON.stringify([
  Object.entries(s.cards).map(([id, c]) => [id, c.num, c.phase, c.headSha12, c.signed, c.onMain, c.ci, c.liveVersion]),
  Object.entries(s.agents).map(([r, a]) => [r, a.state, a.tool, a.card, a.since]),
  s.board.probe, s.board.pageVersion,
]);
export const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const TOOL = {
  name: "board_state",
  title: "Board state",
  description: "The flight board's latest state from the Studio: each open card's stage and each agent's current activity. Ids, enums, numbers and times only.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const enc = new TextEncoder();
export async function sha256hex(s) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(s))));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Equal strings of the same length, in time that doesn't depend on where they differ.
export function sameHex(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
export const secretName = async (boardId) => `BOARD_${(await sha256hex(boardId)).slice(0, 16)}`;

// A board's secret: { token, path } as two sha256 hex strings, or null.
function boardSecret(env, name) {
  try {
    const s = JSON.parse(env[name] ?? "");
    return /^[0-9a-f]{64}$/.test(s?.token ?? "") && /^[0-9a-f]{64}$/.test(s?.path ?? "") ? s : null;
  } catch { return null; }
}

const bare = (status, headers = {}) => new Response(null, { status, headers });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A request's body as text, refused past MAX_BYTES (by its length header, and again while reading).
async function capped(request) {
  const len = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(len) || len > MAX_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_BYTES) { reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let k = 0;
  for (const p of parts) { all.set(p, k); k += p.length; }
  return new TextDecoder().decode(all);
}

// The latest state is stored under the board's secret name: the MCP path finds that name, never the board id.
async function postState(request, env, boardId, now) {
  const name = await secretName(boardId);
  const s = boardSecret(env, name);
  if (!s) return bare(404);
  const m = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("authorization") ?? "");
  if (!m || !sameHex(await sha256hex(m[1]), s.token)) return bare(401);
  if (!/^application\/json\b/.test(request.headers.get("content-type") ?? "")) return bare(415);
  const text = await capped(request);
  if (text === null) return bare(413);
  let state;
  try { state = JSON.parse(text); } catch { return json(400, { error: "not JSON" }); }
  if (stateErrors(state).length) return json(400, { error: "not the state the plan allows" });
  if (state.board.boardId !== boardId) return json(400, { error: "another board's state" });
  const key = `b:${name}`;
  let before = null;
  try { before = JSON.parse((await env.STATE.get(key)) ?? "null"); } catch { /* none */ }
  if (Number.isFinite(before?.receivedAt) && now - before.receivedAt < RATE_MS) return bare(429, { "retry-after": "30" });
  const picked = pickState(state), change = changeKey(picked);
  if (before?.change === change && now - before.receivedAt < HEARTBEAT_MS) return bare(204);
  const day = new Date(now).toISOString().slice(0, 10), budget = Number.parseInt(env.WRITES_PER_DAY ?? "", 10);
  const writes = before?.day === day && Number.isInteger(before.writes) ? before.writes : 0;
  if (writes >= (Number.isInteger(budget) && budget > 0 ? budget : WRITES_DEFAULT)) return bare(429);
  await env.STATE.put(key, JSON.stringify({ receivedAt: now, day, writes: writes + 1, change, state: picked }));
  return bare(204);
}

// The board whose MCP path this is: the secret whose path hash matches, every one compared. Null when none does.
async function boardForPath(env, path) {
  const h = await sha256hex(path);
  let found = null;
  for (const name of Object.keys(env).filter((k) => /^BOARD_[0-9a-f]{16}$/.test(k)).sort()) {
    const s = boardSecret(env, name);
    if (s && sameHex(h, s.path) && !found) found = name;
  }
  return found;
}

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

// The tool's answer: the stored state rebuilt from the schema, or a fixed "no state yet".
async function boardState(env, name) {
  let stored = null;
  try { stored = JSON.parse((await env.STATE.get(`b:${name}`)) ?? "null"); } catch { /* unreadable */ }
  const s = pickState(stored?.state);
  if (!s) return { content: [{ type: "text", text: "no state yet" }], isError: true };
  return { content: [{ type: "text", text: JSON.stringify(s) }], structuredContent: s };
}

async function mcp(request, env, path) {
  const name = await boardForPath(env, path);
  if (!name) return bare(404);
  if (request.method !== "POST") return bare(405, { allow: "POST" });
  const text = await capped(request);
  if (text === null) return bare(413);
  let msg;
  try { msg = JSON.parse(text); } catch { return json(400, rpcError(null, -32700, "parse error")); }
  if (msg === null || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return json(400, rpcError(null, -32600, "invalid request"));
  const id = typeof msg.id === "string" || Number.isInteger(msg.id) ? msg.id : null;
  // A notification (no id) gets no answer.
  if (!("id" in msg)) return bare(202);
  const ok = (result) => json(200, { jsonrpc: "2.0", id, result });
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return ok({ protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "flight-board-state", version: "1" } });
    }
    case "ping": return ok({});
    case "tools/list": return ok({ tools: [TOOL] });
    case "tools/call":
      if (msg.params?.name !== TOOL.name) return json(200, rpcError(id, -32602, "unknown tool"));
      return ok(await boardState(env, name));
    default: return json(200, rpcError(id, -32601, "method not found"));
  }
}

export default {
  async fetch(request, env, _ctx, now = Date.now()) {
    const url = new URL(request.url);
    let m = /^\/b\/([A-Za-z0-9-]{1,64})\/state$/.exec(url.pathname);
    if (m && request.method === "POST" && !url.search) return postState(request, env, m[1], now);
    m = /^\/mcp\/([0-9a-f]{32})$/.exec(url.pathname);
    if (m && !url.search) return mcp(request, env, m[1]);
    return bare(404);
  },
};
