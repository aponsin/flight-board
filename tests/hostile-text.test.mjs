// Hostile text through every collection the old page reads (#C723, board parity A1; plan rule 3). On the artifact the page
// ran in a sandboxed frame; served by the store Worker it shares the owner's session with the write routes, so no board text
// may ever become markup. The page's own script draws every fixture plus a document for each collection the fixtures don't
// cover, and the probe's reading, with attack strings in their text; every element it wrote is then read back.
// Two passes: every string tainted (ids, kinds and times included: nothing may break out even where the page stops making
// sense), and only the words tainted (so the page draws normally, and each collection's words are seen to arrive escaped).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";
import { FIXTURES, times } from "../scripts/fixtures.mjs";

const template = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const script = template.match(/<script>([\s\S]*?)<\/script>/)[1];

// The attack, marked with where it came from so a leak names its collection.
const attack = (tag) => `<img src=x onerror=hostile_${tag}()>"'><svg onload=hostile_${tag}()> javascript:hostile_${tag}() https://x.example/"><b>hostile_${tag}</b>`;

const NOW = Date.now(); // the page reads its own clock (a probe reading is "live" only when fresh); every time below is relative
const H = 36e5;
// Fictional documents for the collections the fixtures don't cover, in the shapes the old board stores.
const EXTRA = {
  events: [{ id: "board-1a2b3c4", at: NOW - H, text: "Shipped the thing", version: "1.2.3" }],
  usage: [{ id: "2027-01-14", day: "2027-01-14", actionsMin: 12, actionsUsd: 0.4, runnerMin: 30, runs: 4 }],
  meta: [
    { id: "live", version: "1.2.3", commit: "abc1234", checkedAt: NOW - 60e3 },
    { id: "context", at: NOW, agents: { Builder: { at: NOW - 60e3, pct: 40, tokens: 400000 } } },
    { id: "crew", notes: { Builder: "On the parity page" } },
    { id: "models", at: NOW, agents: { Builder: { model: "opus", effort: "high" } } },
    { id: "stuck", "waiting:ask-1": { reason: "Refused three times", at: NOW - H, you: "Press Done", owner: "Manager" } },
    { id: "commentThreads", at: NOW, count: 3 },
    { id: "board", wake: "batch" },
  ],
  todo: [{ id: "todo-1", text: "Read the parity list", area: "Board", note: "Before Friday", rank: 1, addedAt: NOW - H, done: false }],
  ideas: [{ id: "idea-1", text: "A darker theme", area: "Board", note: "Maybe", rank: 1, addedAt: NOW - H, done: false, kind: "idea" }],
  ctx: [{ id: "Builder", at: NOW - 60e3, pct: 40, tokens: 400000 }],
  plan: [
    { id: "obj-1", kind: "objective", text: "Board parity", outcome: "The owner switches", measure: "No gaps left", due: "2027-02-01", order: 1, parent: null },
    { id: "step-1", kind: "step", text: "Serve the old page", note: "A1", order: 1, parent: "obj-1" },
  ],
  timings: [{ id: "card-done", steps: [{ id: "s1", init: "card-done", phase: "build", who: "Builder", kind: "end", at: NOW - H }] }],
  ctxRequests: [{ id: "Builder", at: NOW - 30e3 }],
  checkRequests: [{ id: "card-1", at: NOW - 30e3 }],
  threadPings: [{ id: "t-1", at: NOW - 30e3 }],
  pingThreads: [{ id: "ref-1", threadId: "t-1", at: NOW - 30e3 }],
  agentPrs: [{ id: "pr12", title: "Add a business", head: "a1b2c3d4", signedHead: "a1b2c3d4", signedAt: NOW - H, review: "signed", checks: "green", url: "https://github.com/example/repo/pull/12", merged: false }],
  approvals: [{ id: "pr12", number: 12, head: "0f0f0f0f", at: NOW - H, by: "Owner" }],
};
const PROBE = {
  v: 1, board: { at: NOW - 20e3, wakeAliveAt: NOW - 20e3, wakeSeenAt: NOW - 30e3, cardsCheckedAt: NOW - 20e3, evidenceAt: NOW - 20e3, pageVersion: "v3.1" },
  cards: { "card-1": { phase: "build", branch: "build/card-1", headSha12: "a1b2c3d4e5f6", onMain: false, shipping: { version: "1.2.4" } } },
  agents: { Builder: { state: "working", card: "card-1", since: NOW - H, lastActivityAt: NOW - 30e3, verb: "editing", tool: "Bash", by: "title" } },
  ctx: { Builder: { pct: 40, tokens: 400000, at: NOW - 60e3 } },
  stuck: { Builder: { kind: "user", since: NOW - H, card: "card-1", what: "a permission prompt" } },
  usage: { at: NOW - 60e3, level: "ok", weekPct: 40, pace: 1, top: [{ src: "Builder", pct: 30 }] },
  ship: { at: NOW - 60e3, ci: "running", version: "1.2.4", card: "card-1" },
};

// Words, not structure: the fields whose values the page shows as text.
const WORDS = new Set(["text", "title", "name", "note", "notes", "summary", "nextNote", "outcome", "measure", "reason", "you", "body", "question", "expect", "where", "doneWhen", "label", "caption", "what", "verb", "tool", "dropReason", "blockedReason", "waitingOn", "kind_text", "answer", "choice", "steps", "options", "cmd", "dependsOn", "Builder"]);
function taint(v, tag, all, key = "") {
  if (typeof v === "string") return all || WORDS.has(key) ? v + attack(tag) : v;
  if (Array.isArray(v)) return v.map((x) => taint(x, tag, all, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, taint(x, tag, all, WORDS.has(key) ? key : k)]));
  return v;
}

// The page's script on a set of documents and a probe reading: every element it wrote, as HTML and attribute values.
function draw(docs, probe) {
  const els = {}, attrs = [];
  const el = (id) => (els[id] ||= { id, innerHTML: "", textContent: "", value: "", hidden: false, scrollTop: 0, dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, setAttribute: (k, v) => attrs.push(`${k}=${v}`), removeAttribute() {},
    querySelectorAll: () => [], querySelector: () => null, appendChild() {}, focus() {}, getBoundingClientRect: () => ({ left: 0, width: 0, top: 0, height: 0 }) });
  const document = { getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}), createElement: () => el("_new") };
  const ctx = { document, window: { scrollY: 0, scrollTo() {}, addEventListener() {} }, console, setInterval() {}, setTimeout() {}, clearTimeout() {}, queueMicrotask() {}, navigator: {}, getSelection: () => ({}),
    localStorage: { getItem: () => null, setItem() {} }, location: { hash: "", search: "" }, Date, Math, JSON, Number, String, Array, Object, Set, Map, WeakMap, isFinite, URLSearchParams };
  vm.createContext(ctx);
  vm.runInContext(script + "\n;globalThis.__b={state,renderAll,probeEvent};", ctx);
  const b = ctx.__b;
  for (const [c, list] of Object.entries(docs)) {
    const key = c === "initiatives" ? "initRaw" : c;
    if (Array.isArray(b.state[key])) b.state[key] = list;
  }
  if (probe) b.probeEvent({ type: "data", result: { payload: probe } });
  b.renderAll();
  return { html: Object.values(els).map((e) => e.innerHTML).join("\n"), attrs: attrs.join("\n") };
}

// Markup that came from board text: a tag whose attributes carry the attack outside a quoted value (an attribute or a tag
// broke out), an element the attack names (img, svg, b) carrying its marker, or a javascript: address.
export function leaks(html) {
  const found = [];
  // A stray quote (an attribute value the attack closed early) is matched on its own, so the rest of the tag is still read.
  for (const m of html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*'|["'])*)>/g)) {
    const [tag, name, attrs] = m;
    if (/hostile_/.test(attrs.replace(/"[^"]*"|'[^']*'/g, '""'))) found.push(tag);
    else if (/^(img|svg|script|iframe|object|embed)$/i.test(name) && /hostile_/.test(tag)) found.push(tag);
  }
  for (const m of html.matchAll(/<b>hostile_[a-z]+<\/b>/g)) found.push(m[0]);
  for (const m of html.matchAll(/\b(?:href|src|action|formaction)\s*=\s*["']?\s*javascript:/gi)) found.push(m[0]);
  return found;
}

const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).map((f) => ({ file: f, docs: times(JSON.parse(readFileSync(new URL(f, `file://${FIXTURES}/`), "utf8")).docs, NOW) }));
const tainted = (docs, all) => Object.fromEntries(Object.entries(docs).map(([c, list]) => [c, taint(list, c.toLowerCase(), all)]));

test("the leak check itself finds markup and javascript: addresses, and lets escaped text through", () => {
  assert.deepEqual(leaks(`<div>${"&lt;img src=x onerror=hostile_x()&gt;&quot;&#39;&gt;"}</div><a href="https://a.example/&quot;&gt;">ok</a>`), []);
  assert.equal(leaks(`<div><img src=x onerror=hostile_x()></div>`).length, 1);
  assert.equal(leaks(`<a title="x"' onmouseover=hostile_x() y="">`).length, 1);
  assert.equal(leaks(`<a href="javascript:hostile_x()">`).length, 1);
  assert.equal(leaks(`<span><b>hostile_x</b></span>`).length, 1);
});

for (const all of [true, false]) {
  test(`no board text becomes markup: every fixture and every other collection, ${all ? "every string" : "the words"} tainted`, () => {
    const runs = fixtures.map(({ file, docs }) => ({ file, docs: { ...docs, ...EXTRA, ...Object.fromEntries(Object.entries(EXTRA).map(([c, l]) => [c, [...(docs[c] ?? []), ...l]])) } }));
    let seen = "";
    for (const { file, docs } of runs) {
      const { html, attrs } = draw(tainted(docs, all), taint(PROBE, "probe", all));
      const found = leaks(html);
      assert.deepEqual(found, [], `${file}: board text became markup, in: ${found.map((f) => html.slice(Math.max(0, html.indexOf(f) - 200), html.indexOf(f) + 40)).join(" | ")}`);
      assert.deepEqual(leaks(attrs), [], `${file}: board text became an attribute`);
      seen += html;
    }
    // The words do arrive (escaped): otherwise the pass proves nothing. The probe's values are drawn only after a format
    // check (roles, ids, versions, known words), so its attack is refused before it is drawn; it stays in both passes.
    if (!all) for (const c of ["waiting", "messages", "threads", "initiatives", "events", "todo", "ideas", "meta", "plan", "agentprs"]) assert.match(seen, new RegExp(`hostile_${c}\\(\\)`), `${c}'s words were drawn`);
  });
}

test("the page's innerHTML sinks are the 41 audited for #C723: a new one fails here until it is audited", () => {
  assert.equal((template.match(/innerHTML/g) ?? []).length, 41);
});
