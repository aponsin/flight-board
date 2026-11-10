// Board Worker (#C719): HTTP + typed MCP tools over the D1 store. Behind Cloudflare Access; `authenticate(request, env)` returns
// { who, role } or null (role: "agent" | "owner" | "probe") and is the only place identity comes from. No tool writes status:
// evidence is a probe-only endpoint, and status is never a field of any tool.
//   GET  /api/view          the one JSON view (ETag; If-None-Match answers 304 with no body)
//   POST /api/probe/evidence  { key, value, track? }   role probe only
//   POST /mcp               JSON-RPC: initialize, ping, tools/list, tools/call
import { ASK_TYPES, ASK_PARTS, ROSTER_ROLES } from "./board-rules.mjs";
import { pageHtml } from "./page.mjs";
import { compatView } from "./compat-view.mjs";
import { routeWrite } from "./compat-write.mjs";
import { COMPAT_SHIM } from "./compat-shim.mjs";
import { FILE_TYPES, MAX_BODY_BYTES, putFile, fileResponse } from "./file-store.mjs";
import { writeUsageDay } from "./compat-usage.mjs";
import { createCard, updateCard, createAsk, postMessage, answerAsk, closeAsk, createListItem, updateListItem, ackShip, writeEvidence, readView, refuse, wakeAsk, wakeResult, takeInbox } from "./board-store.mjs";

export const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = { type: "string" };

const askProps = { type: { type: "string", enum: ASK_TYPES }, title: str, asked_by: str, card_id: str, eta_at: { type: "integer" }, eta_precondition: str, screenshots: { type: "array", items: str }, pr: { type: "integer" } };
// An Action's step is text, or {text, cmd}: the page shows cmd with a Copy button (#C725 B2).
const stepItem = { anyOf: [str, { type: "object", properties: { text: str, cmd: str }, required: ["text"], additionalProperties: false }] };
for (const part of new Set(Object.values(ASK_PARTS).flat())) askProps[part] ??= part === "options" ? { type: "array", items: str } : part === "steps" ? { type: "array", items: stepItem } : part === "commands" ? { type: "array", items: str } : str;

// Typed tools (schema visible before the call). Roles allowed per tool; none writes status.
export const TOOLS = [
  { name: "read_view", description: "The board's whole view: cards, asks, evidence, last refusals, Live now.", inputSchema: obj({}), roles: ["agent", "owner", "probe"] },
  { name: "card_create", description: "Create a card (words only; the store mints its #C number).", inputSchema: obj({ id: str, title: str, summary: str, size: { type: "string", enum: ["XS", "S", "M", "L", "XL"] }, review_level: { type: "string", enum: ["None", "Quick", "Full"] }, from_thread: { type: "integer" }, track: str, owner_role: str, next_note: str, customer_text: { type: "boolean" }, look_change: { type: "boolean" }, skip: { type: "array", items: str }, depends_on: { type: "array", items: str }, issues: obj({ bugs: { type: "integer" }, security: { type: "integer" }, language: { type: "integer" }, design: { type: "integer" }, owner: { type: "integer" } }), queue_pos: { type: "integer" }, check_at: { type: "integer" }, repo: str, batch: str, bump: { type: "string", enum: ["patch", "minor", "major"] } }, ["id", "title"]), roles: ["agent", "owner"] },
  { name: "card_update", description: "Change a card's words (never status or phase: the probe reads those).", inputSchema: obj({ id: str, title: str, summary: str, size: str, review_level: str, track: str, owner_role: str, next_note: str, waiting_on: str, blocked_reason: str, paused: { type: "boolean" }, dropped: { type: "boolean" }, rework_reason: str, customer_text: { type: "boolean" }, look_change: { type: "boolean" }, skip: { type: "array", items: str }, depends_on: { type: "array", items: str }, issues: obj({ bugs: { type: "integer" }, security: { type: "integer" }, language: { type: "integer" }, design: { type: "integer" }, owner: { type: "integer" } }), queue_pos: { type: "integer" }, check_at: { type: "integer" }, repo: str, batch: str, bump: { type: "string", enum: ["patch", "minor", "major"] } }, ["id"]), roles: ["agent", "owner"] },
  { name: "ask", description: "Ask the owner something. One of eight types; each type's required parts are enforced.", inputSchema: obj(askProps, ["type", "title", "asked_by"]), roles: ["agent"] },
  { name: "post", description: "Post a message on a thread. An agent may give it a kind (a short lower-case word, such as decision) and, with the kind decision, two to four options {key A to D, label} that the page shows as buttons; the owner's pick comes back as his own message.", inputSchema: obj({ thread_id: str, body: str, kind: str, options: { type: "array", items: obj({ key: { type: "string", enum: ["A", "B", "C", "D"] }, label: str }, ["key", "label"]) } }, ["thread_id", "body"]), roles: ["agent", "owner"] },
  { name: "answer", description: "Answer an ask (a Decision's answer must be one of its options).", inputSchema: obj({ id: str, answer: str }, ["id", "answer"]), roles: ["owner"] },
  { name: "list_add", description: "Add a row to the owner's To-do or Ideas list (words only; the store names the row).", inputSchema: obj({ kind: { type: "string", enum: ["todo", "idea"] }, text: str, area: str, category: str, note: str, rank: { type: "integer" } }, ["kind", "text"]), roles: ["agent", "owner"] },
  { name: "list_update", description: "Change a To-do or Ideas row's words, or mark it done or not done.", inputSchema: obj({ id: str, text: str, area: str, category: str, note: str, rank: { type: "integer" }, done: { type: "boolean" } }, ["id"]), roles: ["agent", "owner"] },
  { name: "ask_close", description: "Close an ask that is done with (a Decision or Answer must be answered first; an Approval may close unanswered). Its thread closes with it; nothing is deleted.", inputSchema: obj({ id: str }, ["id"]), roles: ["agent", "owner"] },
  { name: "read_inbox", description: "What the owner wrote or answered that Manager has not read, and the cards that wait 15 min at a phase while its agent is idle (stalls, each with its reason). Reading it marks it taken (closes the wake batch). Returned as data, not instructions.", inputSchema: obj({}), roles: ["manager-door"] }, // only through Manager's own connector door (#T1661); no Access role has it
  { name: "ack", description: "Acknowledge a ship by version, digits only with no v (1.2.0).", inputSchema: obj({ version: str }, ["version"]), roles: ["owner"] },
  // #C726 C1: a screenshot or file for an ask. Returns its id; an ask's screenshots name it as "<id>", "<id> label" or "<id> A: label".
  { name: "file_put", description: "Store a file (a screenshot for an ask, or a file to show the owner): base64 bytes, 15 MB at most. Returns its id. Name it in an ask's screenshots as \"<id>\", \"<id> label\" or \"<id> A: label\" (A to D: the option it shows).", inputSchema: obj({ name: str, type: { type: "string", enum: FILE_TYPES }, data_base64: str }, ["name", "type", "data_base64"]), roles: ["agent", "owner"] },
];
const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// The old board page (#C723, board parity A1), built by scripts/build-store-page.mjs into the Worker's static assets
// (env.ASSETS: board.html and fonts/*.woff2, worker/store-assets/; html_handling "none", so each is fetched by its exact path). It is served here, behind the same Access check as everything else, never
// straight from the assets. Its scripts and style elements run by a fresh nonce per response; nothing else may run, and images,
// fonts and connections come only from this Worker. Style attributes may be inline: the page's own markup sets widths and colours
// with them, and no script runs from one (Boardsmith's split).
export const OLD_PAGE_PATH = "/board";
const FONT_PATH = /^\/fonts\/([a-z0-9-]+\.woff2)$/;
export const oldPageCsp = (nonce) => `default-src 'none'; script-src 'nonce-${nonce}'; style-src-elem 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; font-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`;
// The page's script and style elements carry the nonce (the built page has one bare <script> and bare <style>s, and no inline
// handlers), and the window.claude shim (Boardsmith's worker/compat-shim.mjs) runs just before the page's script, so the page's
// data block finds window.claude reading /api/compat and writing /api/compat/write.
export const withNonce = (html, nonce, shim = COMPAT_SHIM) => html
  .replaceAll("<style>", `<style nonce="${nonce}">`)
  .replace("<script>", () => `<script nonce="${nonce}">${shim}</script><script nonce="${nonce}">`)
  .replaceAll("<script>", `<script nonce="${nonce}">`);
function newNonce() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_");
}
async function asset(env, url, path) {
  if (!env.ASSETS) return null;
  // No redirect is followed: an asset is its exact path or nothing.
  const r = await env.ASSETS.fetch(new Request(new URL(path, url), { redirect: "manual" }));
  return r.status === 200 ? r : null;
}
async function oldPage(env, url) {
  const r = await asset(env, url, "/board.html");
  if (!r) return new Response("The board page is not built: run scripts/build-store-page.mjs, then deploy.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  const nonce = newNonce();
  return new Response(withNonce(await r.text(), nonce), { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": oldPageCsp(nonce), "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY" } });
}
async function font(env, url, file) {
  const r = await asset(env, url, `/fonts/${file}`);
  if (!r) return bare(404);
  return new Response(r.body, { status: 200, headers: { "content-type": "font/woff2", "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" } });
}

const bare = (status, headers = {}) => new Response(null, { status, headers });
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const text = (result) => ({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: result?.ok === false });

async function callTool(db, now, who, role, name, args, env = {}) {
  switch (name) {
    case "file_put": return text(await putFile({ db, bucket: env.FILES, now, who, refuse }, { name: args.name, type: args.type, data: args.data_base64 }));
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
    case "list_add": return text(await createListItem(db, now, who, args));
    case "list_update": return text(await updateListItem(db, now, who, args));
    case "ask_close": return text(await closeAsk(db, now, who, args?.id, role));
    case "ack": return text(await ackShip(db, now, who, args?.version));
  }
}

// The shared connector (#T1659, the owner's pick A): ONE URL, /mcp/<secret>, for all sixteen roles. It sits outside Access (one
// bypass for this path), so the secret is the whole door: the Worker keeps only its SHA-256 (env.CONNECTOR_HASH, hex), compared
// in constant time. The principal is always role "agent"; WHO is the `as` argument of each call, which must be one of the
// roster's roles, never the owner. Tools the owner or the probe alone may call are not offered. read_inbox marks Manager's
// batch taken, so it is NOT on this door at all (not even as `as: Manager`): it lives only on Manager's own door (#T1661, the
// owner's pick A), /mcp/<manager secret>, whose hash is env.MANAGER_CONNECTOR_HASH and whose principal is fixed to Manager (no
// `as`). The two hashes must differ, else both doors are shut.
const CONNECTOR_TOOLS = TOOLS.filter((t) => t.roles.includes("agent"));
const MANAGER_TOOLS = [...CONNECTOR_TOOLS, byName.read_inbox];
const plain = ({ roles, ...t }) => t;
const asProp = { type: "string", enum: ROSTER_ROLES, description: "Which role is calling. The board records this name on what you write." };
const connectorTool = ({ roles, ...t }) => ({ ...t, inputSchema: { ...t.inputSchema, properties: { as: asProp, ...t.inputSchema.properties }, required: ["as", ...t.inputSchema.required.filter((r) => !(t.name === "ask" && r === "asked_by"))] } });
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export async function secretMatches(secret, expectedHex) {
  if (typeof secret !== "string" || !/^[0-9a-f]{64}$/.test(expectedHex ?? "")) return false;
  const got = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= got.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  return diff === 0;
}

async function connector(request, env, now, door = "shared") {
  let msg;
  try { msg = JSON.parse(await request.text()); } catch { return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
  if (!("id" in msg)) return bare(202);
  if (msg.method !== "tools/list" && msg.method !== "tools/call") return mcp(request, env, { who: "connector", role: "agent" }, now, msg);
  const id = msg.id;
  const ok = (result) => json(200, { jsonrpc: "2.0", id, result });
  const err = (code, message) => json(200, { jsonrpc: "2.0", id, error: { code, message } });
  const manager = door === "manager";
  if (msg.method === "tools/list") return ok({ tools: manager ? MANAGER_TOOLS.map(plain) : CONNECTOR_TOOLS.map(connectorTool) });
  if (msg.params?.arguments === null || typeof (msg.params?.arguments ?? {}) !== "object" || Array.isArray(msg.params?.arguments)) return err(-32602, "arguments are an object");
  const tool = (manager ? MANAGER_TOOLS : CONNECTOR_TOOLS).find((t) => t.name === msg.params?.name);
  if (!tool) {
    // read_inbox on the shared door is refused and logged, whoever `as` claims to be.
    if (msg.params?.name === "read_inbox") await refuse(env.DB, now, { rule: "tool-not-allowed", detail: "read_inbox is Manager's own door only" }, null, "connector");
    return err(-32602, "unknown tool");
  }
  const { as, ...args } = msg.params?.arguments ?? {};
  if (manager) {
    // Manager's door has no `as`: who is always Manager.
    if (as !== undefined) {
      await refuse(env.DB, now, { rule: "as-on-manager-door", detail: "this door is Manager's and takes no `as`" }, null, "Manager");
      return err(-32602, "this door takes no `as`");
    }
    return ok(await callTool(env.DB, now, "Manager", "agent", tool.name, args, env));
  }
  if (!ROSTER_ROLES.includes(as)) {
    await refuse(env.DB, now, { rule: "as-not-in-roster", detail: `as: ${typeof as === "string" ? as.slice(0, 40) : typeof as}` }, null, "connector");
    return err(-32602, "as is one of the roster's roles");
  }
  return ok(await callTool(env.DB, now, as, "agent", tool.name, args, env));
}

async function mcp(request, env, auth, now, parsed) {
  let msg = parsed;
  if (!msg) {
    try { msg = JSON.parse(await request.text()); } catch { return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
    if (!("id" in msg)) return bare(202);
  }
  const id = msg.id;
  const ok = (result) => json(200, { jsonrpc: "2.0", id, result });
  const err = (code, message) => json(200, { jsonrpc: "2.0", id, error: { code, message } });
  switch (msg.method) {
    case "initialize": return ok({ protocolVersion: PROTOCOLS.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "flight-board", version: "2" } });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS.filter((t) => t.roles.includes(auth.role)).map(({ roles, ...t }) => t) });
    case "tools/call": {
      const tool = byName[msg.params?.name];
      if (!tool || !tool.roles.includes(auth.role)) {
        // A real tool the role may not call is logged (an agent trying to answer the owner's ask), as any refusal is.
        if (tool) await refuse(env.DB, now, { rule: "tool-not-allowed", detail: `${auth.role} cannot call ${tool.name}` }, null, auth.who);
        return err(-32602, "unknown tool");
      }
      const args = msg.params?.arguments ?? {};
      if (args === null || typeof args !== "object" || Array.isArray(args)) return err(-32602, "arguments are an object");
      return ok(await callTool(env.DB, now, auth.who, auth.role, tool.name, args, env));
    }
    default: return err(-32601, "method not found");
  }
}

export default {
  async fetch(request, env, _ctx, now = Date.now(), authenticate = env.authenticate) {
    const url = new URL(request.url);
    // A body over one file's size (base64 plus its JSON) is refused before anything reads it (#C726: the Worker has 128 MB).
    if (request.method === "POST" && Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return bare(413);
    // The shared connector, before Access identity (its path is the one Access bypass): the secret is checked, nothing else is served here.
    if (url.pathname.startsWith("/mcp/")) {
      const secret = url.pathname.slice(5);
      if (request.method !== "POST") return bare(404);
      // Two doors, two hashes (a shared one for the sixteen roles, Manager's own); the same hash on both shuts both.
      const sameHash = typeof env.CONNECTOR_HASH === "string" && env.CONNECTOR_HASH === env.MANAGER_CONNECTOR_HASH;
      const onShared = !sameHash && await secretMatches(secret, env.CONNECTOR_HASH), onManager = !sameHash && await secretMatches(secret, env.MANAGER_CONNECTOR_HASH);
      if (!onShared && !onManager) return bare(404);
      if (!/^application\/json(\s*;|$)/i.test(request.headers.get("content-type") ?? "")) return json(415, { error: "POST needs content-type application/json" });
      if (request.headers.get("origin") !== null) return bare(403); // a browser page is never an agent
      return connector(request, env, now, onManager ? "manager" : "shared");
    }
    const auth = await authenticate(request, env);
    if (!auth) return bare(401);
    // The name "owner" is the owner's alone: an identity that carries it without the owner role is refused outright.
    if (auth.who === "owner" && auth.role !== "owner") return bare(403);
    // Cross-site writes (Security): a page on another site can send a "simple" POST (a text/plain form whose body is valid JSON)
    // with the owner's Access cookie. Every POST must say application/json (which a cross-site page cannot send without a
    // preflight this Worker never grants), and a browser's Origin / Sec-Fetch-Site must be this very site. Agents and the probe
    // send JSON and no Origin.
    if (request.method === "POST") {
      if (!/^application\/json(\s*;|$)/i.test(request.headers.get("content-type") ?? "")) return json(415, { error: "POST needs content-type application/json" });
      const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site");
      if ((origin !== null && origin !== url.origin) || (site !== null && !["same-origin", "none"].includes(site))) return bare(403);
    }
    // The page is for people and agents, as /api/compat is: the probe gets neither.
    const fontFile = request.method === "GET" && FONT_PATH.exec(url.pathname);
    if (((url.pathname === OLD_PAGE_PATH && request.method === "GET") || fontFile) && auth.role === "probe") return bare(403);
    if (url.pathname === OLD_PAGE_PATH && request.method === "GET") return oldPage(env, url);
    if (fontFile) return font(env, url, fontFile[1]);
    // Files and screenshots (#C726 C1): read by people and agents at /_blob/<id>; the owner's page uploads through /api/files
    // (JSON with base64 bytes, so the same-site and application/json checks above hold for it too).
    const blob = request.method === "GET" && /^\/_blob\/([^/]+)$/.exec(url.pathname);
    if (blob) return auth.role === "probe" ? bare(403) : fileResponse(env.DB, env.FILES, blob[1]);
    if (url.pathname === "/api/files" && request.method === "POST") {
      if (auth.role !== "owner") return bare(403);
      let b;
      try { b = await request.json(); } catch { return json(400, { error: "not JSON" }); }
      const r = await putFile({ db: env.DB, bucket: env.FILES, now, who: auth.who, refuse }, { name: b?.name, type: b?.type, data: b?.data });
      return json(r.ok ? 200 : 422, r);
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
    // The owner's click on a To-do or Ideas row (mark done / not done, edit words): the same rules as the typed tool.
    if (url.pathname === "/api/list" && request.method === "POST") {
      if (auth.role !== "owner") return bare(403);
      let b;
      try { b = await request.json(); } catch { return json(400, { error: "not JSON" }); }
      const r = await updateListItem(env.DB, now, auth.who, b);
      return json(r.ok ? 200 : 422, r);
    }
    if (url.pathname === "/api/view" && request.method === "GET") {
      const v = await readView(env.DB, now);
      const etag = `"${v.tag}"`;
      if (request.headers.get("if-none-match") === etag) return bare(304, { etag });
      return json(200, v, { etag, "cache-control": "no-store" });
    }
    // The old page's data (#C723 A2): the same store view in the old collection shapes. Read only; same ETag rule as /api/view.
    if (url.pathname === "/api/compat" && request.method === "GET") {
      if (auth.role === "probe") return bare(403);
      const c = compatView(await readView(env.DB, now));
      const etag = `"c-${c.tag}"`;
      if (request.headers.get("if-none-match") === etag) return bare(304, { etag });
      return json(200, c, { etag, "cache-control": "no-store" });
    }
    // The old page's writes (#C723 A3): one {op, path, data} per call, owner only, routed to the store's own functions.
    if (url.pathname === "/api/compat/write" && request.method === "POST") {
      if (auth.role !== "owner") return bare(403);
      let b;
      try { b = await request.json(); } catch { return json(400, { error: "not JSON" }); }
      const r = await routeWrite(env.DB, now, auth.who, b);
      return json(r.ok ? 200 : 422, r.ok ? { ok: true } : r);
    }
    if (url.pathname === "/api/probe/evidence" && request.method === "POST") {
      if (auth.role !== "probe") return bare(403);
      let b;
      try { b = await request.json(); } catch { return json(400, { error: "not JSON" }); }
      const r = await writeEvidence(env.DB, now, "probe", b?.key, b?.value, b?.track);
      return json(r.ok ? 200 : 422, r);
    }
    // A day's runner and automation minutes and Actions cost (#C726 C3), probe only: the usage collection's rows.
    if (url.pathname === "/api/probe/usage" && request.method === "POST") {
      if (auth.role !== "probe") return bare(403);
      let b;
      try { b = await request.json(); } catch { return json(400, { error: "not JSON" }); }
      const r = await writeUsageDay(env.DB, now, b, refuse);
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
