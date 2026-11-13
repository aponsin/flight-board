// #C1049 (the owner, 2026-11-12, a screenshot): the header badge "Not now: Admin, Builder, Demos, … working" was too long. It now reads "Not now: agents
// working", a real button; a click opens who is working in a pop-over that floats over the page (it takes no room in the header); a click outside or Escape
// closes it. The badge's own words and markup do not depend on how many agents work, so the header is as wide with 1 as with 12.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const NAMES = ["Admin", "Builder", "Checker", "Demos", "Designer", "Linguist", "Mainsite", "Ops", "Release", "Reviewer", "Sales", "Security"];
const turn = () => ({ state: "working", tool: "Edit", lastActivityAt: Date.now() - 5 * 60e3, since: Date.now() - 5 * 60e3 });
const idle = () => ({ state: "idle", lastActivityAt: Date.now() - 60e3 });
function board(agents) {
  const b = loadNames(["shipNow", "shipCandidate", "restartState", "renderRestart", "probeEvent", "setRestartPop", "onRestartClick", "onRestartKey"]);
  b.state.initRaw = [{ id: "c-1", num: 499, status: "active" }];
  b.state.derived = [{ id: "all", cards: {} }];
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { at: Date.now() - 20e3 }, cards: { "c-1": { phase: "build", headSha12: "a1b2c3d4e5f6" } }, agents } } });
  // Spies on what the page does to the two elements: attributes and focus on the button, and every write of the badge's markup.
  const attrs = {}, focus = { n: 0 }, writes = { n: 0 };
  const btn = b.document.getElementById("restartbtn");
  btn.setAttribute = (k, v) => { attrs[k] = v; };
  btn.focus = () => { focus.n++; };
  const badge = b.els.restartbadge;
  let inner = badge.innerHTML;
  Object.defineProperty(badge, "innerHTML", { get: () => inner, set: (v) => { inner = v; writes.n++; } });
  return { ...b, attrs, focus, writes, badge, pop: b.els.restartpop };
}
const crowd = (n) => Object.fromEntries(NAMES.slice(0, n).map((x) => [x, turn()]));
const click = (b, inside) => b.onRestartClick({ target: { closest: (sel) => (inside.includes(sel) ? {} : null) } });
const onButton = ["#restartbtn"], inPop = ["#restartpop"], elsewhere = [];

test("busy: the badge is one short label whatever the number of agents, and the names are in the pop-over, not in the badge", () => {
  const one = board({ ...crowd(1), Manager: turn() });
  one.renderRestart();
  const twelve = board(crowd(12));
  twelve.renderRestart();
  assert.equal(one.badge.className, "rb bad");
  assert.equal(one.badge.innerHTML, twelve.badge.innerHTML, "the same markup, so the header is as wide with 1 agent as with 12");
  assert.equal(one.badge.innerHTML.replace(/<[^>]*>/g, ""), "Not now: agents working");
  for (const n of NAMES) assert.ok(!twelve.badge.innerHTML.includes(n), `${n} is not in the badge`);
  assert.deepEqual(twelve.pop.innerHTML.match(/<li>[A-Za-z]+<\/li>/g).map((x) => x.replace(/<\/?li>/g, "")), NAMES, "the pop-over lists every working agent, in order");
  assert.equal(one.pop.innerHTML.match(/<li>/g).length, 1, "one agent: one row (the lead is not a team agent)");
});

test("the badge is a real button with its pop-over wired for keyboard and screen readers", () => {
  const b = board(crowd(3));
  b.renderRestart();
  assert.match(b.badge.innerHTML, /^<button type="button" class="rbbtn" id="restartbtn" aria-haspopup="true" aria-controls="restartpop" aria-expanded="false">Not now: agents working<\/button>$/);
  assert.match(html, /<div class="rbpop" id="restartpop" role="region" aria-label="Agents working" hidden><\/div>/);
  assert.equal(b.pop.hidden, true, "closed to start with");
});

test("a click on the button opens the pop-over and a second one closes it; a click outside closes it; a click inside keeps it open", () => {
  const b = board(crowd(3));
  b.renderRestart();
  click(b, onButton);
  assert.equal(b.pop.hidden, false); assert.equal(b.attrs["aria-expanded"], "true");
  click(b, inPop);
  assert.equal(b.pop.hidden, false, "a click inside the pop-over leaves it");
  click(b, onButton);
  assert.equal(b.pop.hidden, true); assert.equal(b.attrs["aria-expanded"], "false");
  click(b, onButton);
  click(b, elsewhere);
  assert.equal(b.pop.hidden, true, "a click outside closes it"); assert.equal(b.attrs["aria-expanded"], "false");
  click(b, elsewhere);
  assert.equal(b.pop.hidden, true, "a click outside with it closed does nothing");
});

test("Escape closes the open pop-over and puts the focus back on the button; with it closed Escape does nothing, and other keys do nothing", () => {
  const b = board(crowd(3));
  b.renderRestart();
  b.onRestartKey({ key: "Escape" });
  assert.equal(b.focus.n, 0, "closed: Escape leaves the focus alone");
  click(b, onButton);
  b.onRestartKey({ key: "Enter" }); b.onRestartKey({ key: "a" });
  assert.equal(b.pop.hidden, false, "other keys leave it open");
  b.onRestartKey({ key: "Escape" });
  assert.equal(b.pop.hidden, true); assert.equal(b.focus.n, 1, "the focus is back on the button"); assert.equal(b.attrs["aria-expanded"], "false");
});

test("a redraw keeps an open pop-over open and does not rewrite the button (so the focus stays); a change of who is working updates the list", () => {
  const b = board(crowd(2));
  b.renderRestart();
  const writes = b.writes.n;
  click(b, onButton);
  for (let n = 0; n < 5; n++) b.renderRestart();
  assert.equal(b.pop.hidden, false, "still open after redraws");
  assert.equal(b.writes.n, writes, "the badge's markup is not rewritten while it is the same");
  assert.equal(b.attrs["aria-expanded"], "true");
  // Another agent starts working: the list gains it, the pop-over stays open, the button is still the same markup.
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { at: Date.now() - 10e3 }, cards: { "c-1": { phase: "build", headSha12: "a1b2c3d4e5f6" } }, agents: crowd(3) } } });
  b.renderRestart();
  assert.equal(b.pop.innerHTML.match(/<li>/g).length, 3);
  assert.equal(b.pop.hidden, false); assert.equal(b.writes.n, writes);
});

test("the pop-over closes when the badge is no longer the busy one: safe, another reason, or no fresh reading; and the other reasons stay plain text", () => {
  const b = board(crowd(2));
  b.renderRestart(); click(b, onButton);
  assert.equal(b.pop.hidden, false);
  // Everyone goes idle: "Safe to restart", plain text, the pop-over closed.
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { at: Date.now() - 5e3 }, cards: { "c-1": { phase: "build", headSha12: "a1b2c3d4e5f6" } }, agents: { Builder: idle(), Admin: idle() } } } });
  b.renderRestart();
  assert.equal(b.pop.hidden, true); assert.equal(b.badge.textContent, "Safe to restart"); assert.equal(b.badge.className, "rb ok");
  // Another reason with a name in it keeps its full words as text.
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { at: Date.now() - 5e3 }, cards: { "c-1": { phase: "ship", headSha12: "a1b2c3d4e5f6" } }, agents: { Release: { state: "working", card: "c-1", since: Date.now() - 60e3 } } } } });
  b.renderRestart();
  assert.equal(b.badge.textContent, "Not now: Release is shipping");
  // Back to busy and open, then no fresh reading: the badge hides and the pop-over with it.
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { at: Date.now() - 5e3 }, cards: { "c-1": { phase: "build", headSha12: "a1b2c3d4e5f6" } }, agents: crowd(2) } } });
  b.renderRestart(); click(b, onButton);
  assert.equal(b.pop.hidden, false);
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { at: Date.now() - 20 * 60e3 }, cards: {}, agents: crowd(2) } } });
  b.renderRestart();
  assert.equal(b.badge.hidden, true); assert.equal(b.pop.hidden, true);
});

test("the pop-over floats: absolute over the page, above it in the stack, and takes no room in the header; its listeners are the page's own", () => {
  const rule = (sel) => html.match(new RegExp(`\\n${sel.replace(/[.[\]]/g, "\\$&")}\\{([^}]*)\\}`))?.[1];
  assert.match(rule(".rbpop"), /position:absolute/);
  assert.match(rule(".rbpop"), /z-index:\d+/);
  assert.match(rule(".rbpop"), /background:var\(--panel\)/);
  assert.match(rule(".rbpop[hidden]"), /display:none/);
  assert.match(html, /\.hdr-badges\{position:relative\}/);
  // The pop-over sits inside the badges row, after the chip and the reload button, so the row's own order is unchanged.
  const row = html.match(/<div class="hdr-badges">([\s\S]*?)<\/div><\/div>\s*\n?\s*<div class="hdr-right">/)?.[1] ?? html.match(/<div class="hdr-badges">[\s\S]*?id="restartpop"[^>]*><\/div>/)[0];
  assert.ok(row.indexOf('id="restartbadge"') < row.indexOf('id="boardver"') && row.indexOf('id="boardver"') < row.indexOf('id="restartpop"'));
  // The button takes the badge's colours and shows a focus ring; the label does not depend on the agents.
  assert.match(rule(".rbbtn"), /color:inherit/);
  assert.match(html, /\.rbbtn:focus-visible\{outline:2px solid/);
  const b = board(crowd(1));
  assert.ok(b.listeners.click.some((f) => f.name === "onRestartClick") && b.listeners.keydown.some((f) => f.name === "onRestartKey"), "wired on the document");
});
