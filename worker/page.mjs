// The board page, served by the Worker (#C719). One HTML document: the header (page-header.mjs, drawn on the client from the
// same functions the tests check), then Needs you, Cards and Refused. It polls /api/view every 2.5 s while the tab is visible
// (never while hidden), sends If-None-Match so an unchanged answer costs bytes only, and redraws the ages every second from
// the readings' own times. Every tile shows its source and age. Board text comes from agents: the client writes it with
// textContent / createTextNode only, never innerHTML (the header's markup is built from our own functions with escaping).
import { headerHtml, liveChip, ageText, HEADER_CSS } from "./page-header.mjs";

const POLL_MS = 2500;

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--mute:#666;--line:#ddd}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--mute:#999;--line:#333}.hd .chip{background:#2a2a2a}.hd .chip.bad{background:#4a1c1c;color:#fbb}.hd .chip.warn{background:#4a3a10}}
html,body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,sans-serif}
main{padding:12px 16px;max-width:900px;margin:0 auto}
h2{font-size:15px;margin:20px 0 8px;color:var(--mute);text-transform:uppercase;letter-spacing:.04em}
.tile{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:8px 0}
.tile .src{color:var(--mute);font-size:12px;margin-top:4px}
.tile .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
button{font:inherit;padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer;min-height:40px}
button.rec{border-color:currentColor;font-weight:600}
.empty{color:var(--mute)}
${HEADER_CSS}`;

// The client script. The header functions are embedded from the module so the page and the tests run the same code.
const CLIENT = `
${headerHtml.toString()}
${liveChip.toString()}
const ageText = ${ageText.toString()};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const POLL_MS = ${POLL_MS};
let view = null, etag = null, fetchedAt = 0, failed = null;
const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };

async function poll() {
  if (document.visibilityState !== "visible") return;
  try {
    const r = await fetch("/api/view", { headers: etag ? { "if-none-match": etag } : {}, cache: "no-store" });
    if (r.status === 200) { view = await r.json(); etag = r.headers.get("etag"); }
    if (r.status === 200 || r.status === 304) { fetchedAt = Date.now(); failed = null; }
    else failed = "board answered " + r.status;
  } catch (e) { failed = "cannot reach the board"; }
  draw();
}

async function act(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) alert("Refused: " + (out.refused ? out.refused.rule + " (" + out.refused.detail + ")" : r.status));
  etag = null; poll();
}

const age = (t) => (t ? ageText(Math.max(0, Date.now() - t)) + " ago" : "never");

function draw() {
  if (!view) { $("hd").textContent = failed || "loading"; return; }
  const sinceRead = Date.now() - fetchedAt;
  // Live now: re-aged on the client from the probe's own reading time, so it goes stale on screen without a new fetch.
  const lr = view.evidence.live ? { version: view.evidence.live.value.version, readAt: view.evidence.live.readAt } : null;
  const live = lr ? { state: Date.now() - lr.readAt > 180000 ? "stale" : "live", version: lr.version, age: Date.now() - lr.readAt } : { state: "unknown" };
  const probe = view.probe.state === "silent" || Date.now() - (view.probe.lastAt || 0) > 180000 ? { state: "silent", since: view.probe.since || view.probe.lastAt } : view.probe;
  $("hd").innerHTML = headerHtml({ live, probe }, { boardVersion: document.body.dataset.version || "", wake: failed ? { state: "red", reason: failed } : { state: "idle" } });
  $("fetched").textContent = "fetched " + ageText(sinceRead) + " ago";

  const open = view.asks.filter((a) => !a.answered_at);
  const needs = $("needs"); needs.replaceChildren();
  if (!open.length) needs.append(el("p", "Nothing needs you.", "empty"));
  for (const a of open) {
    const body = JSON.parse(a.body), t = el("div", undefined, "tile");
    t.append(el("b", "#T" + a.num + " " + a.type + ": " + a.title));
    t.append(el("div", body.question || body.text || body.words || ""));
    if (a.type === "Decision") {
      const row = el("div", undefined, "row");
      for (const o of body.options) { const b = el("button", o + (o === body.recommended ? " (recommended)" : ""), o === body.recommended ? "rec" : ""); b.onclick = () => act("/api/answer", { id: a.id, answer: o }); row.append(b); }
      t.append(row);
    } else {
      const b = el("button", "Done"); b.onclick = () => act("/api/answer", { id: a.id, answer: "Done" }); const row = el("div", undefined, "row"); row.append(b); t.append(row);
    }
    t.append(el("div", "from " + a.asked_by + " · asked " + age(a.created_at) + " · source: the asking session", "src"));
    needs.append(t);
  }

  const cards = $("cards"); cards.replaceChildren();
  if (!view.cards.length) cards.append(el("p", "No cards.", "empty"));
  for (const c of view.cards) {
    const ev = view.evidence["cards." + c.id], t = el("div", undefined, "tile");
    t.append(el("b", "#C" + c.num + " " + c.title));
    t.append(el("div", ev ? "Phase: " + ev.value.lit.join(", ") : "Phase: no reading from the probe yet"));
    if (c.next_note) t.append(el("div", "Next: " + c.next_note));
    t.append(el("div", (ev ? "source: the probe, read " + age(ev.readAt) : "source: none yet") + " · words: " + (c.owner_role || "—") + ", updated " + age(c.updated_at), "src"));
    cards.append(t);
  }

  const ref = $("refused"); ref.replaceChildren();
  if (!view.refusals.length) ref.append(el("p", "No refused writes.", "empty"));
  for (const r of view.refusals) ref.append(el("div", r.rule + (r.card_id ? " · " + r.card_id : "") + " · " + (r.who || "?") + " · " + age(r.at) + (r.detail ? " · " + r.detail : ""), "tile"));
}

poll();
setInterval(poll, POLL_MS);
setInterval(() => { if (document.visibilityState === "visible") draw(); }, 1000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") poll(); });
`;

export function pageHtml({ version = "" } = {}) {
  const safe = String(version).replace(/[^A-Za-z0-9 ._+-]/g, "").slice(0, 40);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Flight board</title><style>${CSS}</style></head>
<body data-version="${safe}">
<div id="hd">loading</div>
<main>
<div class="empty" id="fetched"></div>
<h2>Needs you</h2><div id="needs"></div>
<h2>Cards</h2><div id="cards"></div>
<h2>Refused writes</h2><div id="refused"></div>
</main>
<script>${CLIENT}</script>
</body></html>`;
}
