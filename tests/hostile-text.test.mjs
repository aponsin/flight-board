// Hostile text through every collection the old page reads (#C723, board parity A1; plan rule 3). On the artifact the page
// ran in a sandboxed frame; served by the store Worker it shares the owner's session with the write routes, so no board text
// may ever become markup. The page's own script draws every fixture plus a document for each collection the fixtures don't
// cover, and the probe's reading, with attack strings in their text; every element it wrote is then read back.
// Two passes: every string tainted (ids, kinds and times included: nothing may break out even where the page stops making
// sense), and only the words tainted (so the page draws normally, and each collection's words are seen to arrive escaped).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { FIXTURES, times } from "../scripts/fixtures.mjs";
import { drawPage, TEMPLATE as template } from "./helpers/draw-page.mjs";

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
// Addresses: a link or picture field gets a javascript: or data: address in place of its own (the attack can't ride at the end
// of an address and still be one).
const URLS = new Set(["url", "href", "src", "link", "image", "images", "screenshots"]);
const badUrl = (tag) => (tag.length % 2 ? `javascript:hostile_${tag}()` : `data:text/html,<script>hostile_${tag}()</script>`);
// mode: "all" (every string, attack at the end), "end" (the words, attack at the end), "start" (the words, attack first, so a
// field the page cuts short still carries it; addresses replaced).
function taint(v, tag, mode, key = "") {
  if (typeof v === "string") {
    if (mode === "start" && URLS.has(key)) return badUrl(tag);
    return mode === "all" || WORDS.has(key) ? (mode === "start" ? attack(tag) + v : v + attack(tag)) : v;
  }
  if (Array.isArray(v)) return v.map((x) => taint(x, tag, mode, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, taint(x, tag, mode, WORDS.has(key) || URLS.has(key) ? key : k)]));
  return v;
}

// Markup that came from board text: a tag whose attributes carry the attack outside a quoted value (an attribute or a tag
// broke out), an element the attack names (img, svg, b) carrying its marker or its own attributes even when a cut lost the
// marker, or a javascript: or data: address.
export function leaks(html) {
  const found = [];
  // A stray quote (an attribute value the attack closed early) is matched on its own, so the rest of the tag is still read.
  for (const m of html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*'|["'])*)>/g)) {
    const [tag, name, attrs] = m;
    if (/hostile_/.test(attrs.replace(/"[^"]*"|'[^']*'/g, '""'))) found.push(tag);
    else if (/^(img|svg|script|iframe|object|embed)$/i.test(name) && /hostile_/.test(tag)) found.push(tag);
  }
  // The attack's own tags, marker or not: the page never writes an <img src=x> or an <svg onload>.
  for (const m of html.matchAll(/<img src=x\b|<svg onload\b|<b>hostile_[a-z]*/g)) found.push(m[0]);
  for (const m of html.matchAll(/\b(?:href|src|action|formaction|data)\s*=\s*["']?\s*(?:javascript|data):/gi)) found.push(m[0]);
  return found;
}

const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).map((f) => ({ file: f, docs: times(JSON.parse(readFileSync(new URL(f, `file://${FIXTURES}/`), "utf8")).docs, NOW) }));
const tainted = (docs, mode) => Object.fromEntries(Object.entries(docs).map(([c, list]) => [c, taint(list, c.toLowerCase(), mode)]));
// The sinks a plain draw never reaches (Builder's review): the hover bubbles on #T and #C links, and a new thread's receipt.
const EXPOSE = ["threadBubble", "cardBubble", "sentLine"];
function unreached(b, docs) {
  const ids = new Set([...(docs.waiting ?? []), ...(docs.threads ?? [])].map((d) => d.id).concat((docs.messages ?? []).map((m) => m.thread)).filter(Boolean));
  return [
    ...[...ids].map((id) => b.threadBubble(id)),
    ...b.state.initiatives.map((i) => b.cardBubble(i)),
    ...[...ids].map((id) => b.sentLine(id, "unsent", attack("sent"))),
  ].join("\n");
}

test("the leak check itself finds markup and javascript: addresses, and lets escaped text through", () => {
  assert.deepEqual(leaks(`<div>${"&lt;img src=x onerror=hostile_x()&gt;&quot;&#39;&gt;"}</div><a href="https://a.example/&quot;&gt;">ok</a>`), []);
  assert.ok(leaks(`<div><img src=x onerror=hostile_x()></div>`).length > 0);
  assert.ok(leaks(`<a title="x"' onmouseover=hostile_x() y="">`).length > 0);
  assert.ok(leaks(`<a href="javascript:hostile_x()">`).length > 0);
  assert.ok(leaks(`<span><b>hostile_x</b></span>`).length > 0);
  assert.ok(leaks(`<span>A long title cut here <img src=x onerr…</span>`).length > 0, "a cut that lost the marker");
  assert.ok(leaks(`<img src="data:text/html,x">`).length > 0);
});

for (const host of ["store", null]) for (const mode of ["all", "end", "start"]) {
  test(`no board text becomes markup (${host ? "the store's page" : "the artifact's page"}): every fixture and every other collection, ${{ all: "every string", end: "the words", start: "the words with the attack first, and bad addresses" }[mode]}`, () => {
    const runs = fixtures.map(({ file, docs }) => ({ file, docs: { ...docs, ...EXTRA, ...Object.fromEntries(Object.entries(EXTRA).map(([c, l]) => [c, [...(docs[c] ?? []), ...l]])) } }));
    let seen = "";
    for (const { file, docs } of runs) {
      const bad = tainted(docs, mode), drawn = drawPage(bad, { probe: taint(PROBE, "probe", mode), host, expose: EXPOSE });
      const { attrs } = drawn, html = drawn.html + "\n" + unreached(drawn.b, bad);
      const found = leaks(html);
      assert.deepEqual(found, [], `${file}: board text became markup, in: ${found.map((f) => html.slice(Math.max(0, html.indexOf(f) - 200), html.indexOf(f) + 40)).join(" | ")}`);
      assert.deepEqual(leaks(attrs), [], `${file}: board text became an attribute`);
      seen += html;
    }
    // The words do arrive (escaped): otherwise the pass proves nothing. The probe's values are drawn only after a format
    // check (roles, ids, versions, known words), so its attack is refused before it is drawn; it stays in both passes.
    // The pull request panel shows on both pages (#C727 brought it back to the store, fed by Approval asks).
    if (mode !== "all") for (const c of ["waiting", "messages", "threads", "initiatives", "events", "todo", "ideas", "meta", "plan", "agentprs"]) assert.match(seen, new RegExp(`hostile_${c}\\(\\)`), `${c}'s words were drawn`);
  });
}

// #C874 added one: renderFeed's "Went live, not yet acknowledged" list (#unacked). Its words are the events' version and text,
// each through esc() (the text then through cardLinks, as the feed's own row), and the hostile passes above draw it on the store's page.
// #C919 added one: renderTeam's Team notes list. Its words are the card's title or the thread's name, each through esc() (teamRow), and the thread
// under a row is threadHtml's, as every other thread's.
// #C972 added one: the push steps box (#pushhelp). Its words are pushSteps' own fixed strings and its browser name, each through esc()
// (pushHelpHtml); nothing from the board or the user agent is written raw (the user agent is only matched, never shown).
test("the page's innerHTML sinks are the 44 audited (41 for #C723, 1 for #C874, 1 for #C919, 1 for #C972): a new one fails here until it is audited", () => {
  assert.equal((template.match(/innerHTML/g) ?? []).length, 44);
});
