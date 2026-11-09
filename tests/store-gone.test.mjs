// What the owner agreed is gone (docs/DATA.md "Deleted"; docs/PARITY.md), left out of the old page when the store Worker serves
// it (#C723 A4), and still drawn on the artifact's page, which runs as it is until the owner switches. Plus the "Manager missed"
// line, hidden on the store until the phase history (B3b) gives it its data (Manager, 2026-11-09).
import test from "node:test";
import assert from "node:assert/strict";
import { drawPage } from "./helpers/draw-page.mjs";

const NOW = Date.now(), H = 36e5;
const DOCS = {
  // An open card with a typed phase the repository disagrees with, no ETA and no next step: the Check button, the source flag
  // and "Manager missed".
  initiatives: [{ id: "card-1", num: 5, name: "A card", status: "active", phase: "build", size: "M", level: "Quick", createdAt: NOW - 2 * H, who: "Builder" }],
  derived: [{ id: "all", at: NOW - 60e3, cards: { "card-1": { phase: "checker", at: NOW - 60e3, evidence: "branch tip" } } }],
  // An Action ask with no steps: "Manager missed" on the ask.
  waiting: [{ id: "ask-1", kind: "action", text: "Press the button", since: NOW - H }],
  meta: [
    { id: "commentThreads", count: 950, at: NOW - H },
    { id: "context", at: NOW, agents: { Builder: { at: NOW - 3 * H, pct: 40, tokens: 400000, saved: true, savedPct: 40, savedTokens: 400000 } } },
  ],
  ctx: [{ id: "Builder", at: NOW - 3 * H, pct: 40, tokens: 400000 }],
  ideas: [{ id: "idea-1", text: "A darker theme", area: "Board", rank: 1, addedAt: NOW - H, done: false }],
  agentPrs: [{ id: "pr12", title: "Add a business", head: "a1b2c3d4", signedHead: "a1b2c3d4", signedAt: NOW - H, review: "signed", checks: "green", merged: false }],
};

const GONE = [
  ["the Check button on a card (row 38)", (d) => d.html.includes("data-check=")],
  ["the source-disagreement flag (row 28)", (d) => d.html.includes("evidence differs")],
  ["\"Manager missed\" on a card and an ask (until B3b)", (d) => d.html.includes("Manager missed")],
  ["the comment threads full line (row 11)", (d) => d.els.threadsfull && !d.els.threadsfull.hidden],
  ["the pull request panel (row 22: now Approval asks)", (d) => d.els.agentprs && !d.els.agentprs.hidden && d.els.agentprs.innerHTML !== ""],
  ["the memory tile's Refresh request (row 15)", (d) => d.html.includes("data-ctxref=")],
  ["the \"/clear me\" flag (row 14)", (d) => d.html.includes("/clear me")],
  ["\"Let's start\" on an idea (not part of the lists change)", (d) => d.html.includes('data-td="start"')],
  ["the v3 layout link (row 45)", (d) => !d.els.viewlink?.hidden],
];

test("the artifact's page still draws every one of them (it runs as it is until the owner switches)", () => {
  const d = drawPage(DOCS);
  assert.equal(d.b.STORE, false);
  for (const [what, shown] of GONE) assert.ok(shown(d), what);
});

test("the store's page leaves each of them out", () => {
  const d = drawPage(DOCS, { host: "store" });
  assert.equal(d.b.STORE, true);
  for (const [what, shown] of GONE) assert.ok(!shown(d), what);
  // The card itself is still there, with its #C number as plain text.
  assert.match(d.html, /#C5/);
});

test("the store's page has no keeper line and never says its data is behind (rows 12 and 3)", () => {
  const { b } = drawPage({}, { host: "store", expose: ["keeperLine", "dataBehind"] });
  assert.equal(b.keeperLine(), "");
  assert.equal(b.dataBehind(Date.now()), false);
});
