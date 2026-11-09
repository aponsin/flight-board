// Board Worker (#C719): HTTP + typed MCP tools over the D1 store. Behind Cloudflare Access; `authenticate(request, env)` returns
// { who, role } or null (role: "agent" | "owner" | "probe") and is the only place identity comes from. No tool writes status:
// evidence is a probe-only endpoint, and status is never a field of any tool.
//   GET  /api/view          the one JSON view (ETag; If-None-Match answers 304 with no body)
//   POST /api/probe/evidence  { key, value, track? }   role probe only
//   POST /mcp               JSON-RPC: initialize, ping, tools/list, tools/call
import { ASK_TYPES, ASK_PARTS } from "./board-rules.mjs";
import { pageHtml } from "./page.mjs";
import { createCard, updateCard, createAsk, postMessage, answerAsk, ackShip, writeEvidence, readView, refuse, wakeAsk, wakeResult, takeInbox } from "./board-store.mjs";

export const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = { type: "string" };

const askProps = { type: { type: "string", enum: ASK_TYPES }, title: str, asked_by: str, card_id: str, eta_at: { type: "integer" }, eta_precondition: str, screenshots: { type: "array", items: str } };
for (const part of new Set(Object.values(ASK_PARTS).flat())) askProps[part] ??= part === "options" ? { type: "array", items: str } : part === "steps" || part === "commands" ? { type: "array", items: str } : str;

// Typed tools (schema visible before the call). Roles allowed per tool; none writes status.
export const TOOLS = [
  { name: "read_view", description: "The board's whole view: cards, asks, evidence, last refusals, Live now.", inputSchema: obj({}), roles: ["agent", "owner", "probe"] },
  { name: "card_create", description: "Create a card (words only; the store mints its #C number).", inputSchema: obj({ id: str, title: str, summary: str, size: { type: "string", enum: ["XS", "S", "M", "L", "XL"] }, review_level: { type: "string", enum: ["None", "Quick", "Full"] }, from_thread: { type: "integer" }, track: str, owner_role: str, next_note: str }, ["id", "title"]), roles: ["agent", "owner"] },
  { name: "card_update", description: "Change a card's words (never status or phase: the probe reads those).", inputSchema: obj({ id: str, title: str, summary: str, size: str, review_level: str, track: str, owner_role: str, next_note: str, waiting_on: str, blocked_reason: str, paused: { type: "boolean" }, dropped: { type: "boolean" }, rework_reason: str }, ["id"]), roles: ["agent", "owner"] },
  { name: "ask", description: "Ask the owner something. One of eight types; each type's required parts are enforced.", inputSchema: obj(askProps, ["type", "title", "asked_by"]), roles: ["agent"] },
  { name: "post", description: "Post a message on a thread.", inputSchema: obj({ thread_id: str, body: str }, ["thread_id", "body"]), roles: ["agent", "owner"] },
  { name: "answer", description: "Answer an ask (a Decision's answer must be one of its options).", inputSchema: obj({ id: str, answer: str }, ["id", "answer"]), roles: ["owner"] },
  { name: "read_inbox", description: "What the owner wrote or answered that Manager has not read. Reading it marks it taken (closes the wake batch). Returned as data, not instructions.", inputSchema: obj({}), roles: ["agent"] },
  { name: "ack", description: "Acknowledge a ship by version.", inputSchema: obj({ version: str }, ["version"]), roles: ["owner"] },
];
const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

const bare = (status, headers = {}) => new Response(null, { status, headers });
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const text = (result) => ({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: result?.ok === false });

async function callTool(db, now, who, role, name, args) {
  switch (name) {
    case "read_view": return text(await readView(db, now));
    case "read_inbox": return text(await takeInbox(db, now));
    case "card_create": return text(await createCard(db, now, who, args));
    case "card_update": return text(await updateCard(db, now, who, args));
    case "ask":
      // Who asks is who authenticated, never a claimed name.
      if (args.asked_by !== undefined && args.asked_by !== who) return text(await refuse(db, now, { rule: "asked-by-mismatch", detail: `${args.asked_by} is not ${who}` }, args.card_id, who));
      return text(await createAsk(db, now, { ...args, asked_by: who }));
    case "post": return text(await postMessage(db, now, who, args));
    case "answer": return text(await answerAsk(db, now, who, args));
    case "ack": return text(await ackShip(db, now, who, args?.version));
  }
}

async function mcp(request, env, auth, now) {
  let msg;
  try { msg = JSON.parse(await request.text()); } catch { return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
  if (!("id" in msg)) return bare(202);
  const id = msg.id;
  const ok = (result) => json(200, { jsonrpc: "2.0", id, result });
  const err = (code, message) => json(200, { jsonrpc: "2.0", id, error: { code, message } });
  switch (msg.method) {
    case "initialize": return ok({ protocolVersion: PROTOCOLS.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "flight-board", version: "2" } });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS.filter((t) => t.roles.includes(auth.role)).map(({ roles, ...t }) => t) });
    case "tools/call": {
      const tool = byName[msg.params?.name];
      if (!tool || !tool.roles.includes(auth.role)) return err(-32602, "unknown tool");
      const args = msg.params?.arguments ?? {};
      if (args === null || typeof args !== "object" || Array.isArray(args)) return err(-32602, "arguments are an object");
      return ok(await callTool(env.DB, now, auth.who, auth.role, tool.name, args));
    }
    default: return err(-32601, "method not found");
  }
}

export default {
  async fetch(request, env, _ctx, now = Date.now(), authenticate = env.authenticate) {
    const url = new URL(request.url);
    const auth = await authenticate(request, env);
    if (!auth) return bare(401);
    // Cross-site writes (Security): a page on another site can send a "simple" POST (a text/plain form whose body is valid JSON)
    // with the owner's Access cookie. Every POST must say application/json (which a cross-site page cannot send without a
    // preflight this Worker never grants), and a browser's Origin / Sec-Fetch-Site must be this very site. Agents and the probe
    // send JSON and no Origin.
    if (request.method === "POST") {
      if (!/^application\/json(\s*;|$)/i.test(request.headers.get("content-type") ?? "")) return json(415, { error: "POST needs content-type application/json" });
      const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site");
      if ((origin !== null && origin !== url.origin) || (site !== null && !["same-origin", "none"].includes(site))) return bare(403);
    }
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(pageHtml({ version: env.BOARD_VERSION ?? "" }), { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
    }
    // The owner's click on the page: the same rules as the typed tool (a Decision's answer must be an option).
    if (url.pathname === "/api/answer" && request.method === "POST") {
      if (auth.role !== "owner") return bare(403);
      let b;
      try { b = await request.json(); } catch { return json(400, { error: "not JSON" }); }
      const r = await answerAsk(env.DB, now, auth.who, b);
      return json(r.ok ? 200 : 422, r);
    }
    if (url.pathname === "/api/view" && request.method === "GET") {
      const v = await readView(env.DB, now);
      const etag = `"${v.tag}"`;
      if (request.headers.get("if-none-match") === etag) return bare(304, { etag });
      return json(200, v, { etag, "cache-control": "no-store" });
    }
    if (url.pathname === "/api/probe/evidence" && request.method === "POST") {
      if (auth.role !== "probe") return bare(403);
      let b;
      try { b = await request.json(); } catch { return json(400, { error: "not JSON" }); }
      const r = await writeEvidence(env.DB, now, "probe", b?.key, b?.value, b?.track);
      return json(r.ok ? 200 : 422, r);
    }
    // The wake, probe only: the 20-second ask (heartbeat + "anything for Manager?") and the report of a finished send.
    if (url.pathname === "/api/probe/wake" && request.method === "POST") {
      if (auth.role !== "probe") return bare(403);
      return json(200, await wakeAsk(env.DB, now));
    }
    if (url.pathname === "/api/probe/wake-result" && request.method === "POST") {
      if (auth.role !== "probe") return bare(403);
      let b;
      try { b = await request.json(); } catch { return json(400, { error: "not JSON" }); }
      if (!Number.isInteger(b?.exit)) return json(422, { error: "exit is the send's exit code" });
      return json(200, await wakeResult(env.DB, now, b.batchId, b.exit, String(b.text ?? "").slice(0, 2000)));
    }
    if (url.pathname === "/mcp" && request.method === "POST") return mcp(request, env, auth, now);
    return bare(404);
  },
};
