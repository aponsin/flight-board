// #C937 (the owner, 11-11: 13 landed cards showed an active blue Ship cell with a counter and "slow", so they looked stuck while they only waited for his install):
// a card of the board's repository that is on main and waits only for the owner's install has a quiet Ship cell, "Queued for your install", no counter, no slow word.
import test from "node:test";
import assert from "node:assert/strict";
import { drawPage } from "./helpers/draw-page.mjs";

const MIN = 60e3;
const card = (extra = {}) => ({ id: "landed-card", num: 937, name: "A landed card", status: "active", phase: "ship", size: "S", level: "Quick", who: "Release", customerText: false, skip: ["plan"], repo: "Flight-Board", createdAt: Date.now() - 5 * 3600e3, shipAt: Date.now() - 30 * MIN, etaLive: Date.now() + 40 * MIN, lastStepAt: Date.now() - 5 * MIN, ...extra });
const probe = (c = {}) => ({ v: 1, board: { at: Date.now() - 20e3 }, cards: { "landed-card": { headSha12: "a1b2c3d4e5f6", onMain: true, phase: "ship", shipping: false, ...c } }, agents: {} });
const draw = (cardExtra = {}, probeExtra = {}, host = "store") => drawPage({ initiatives: [card(cardExtra)], waiting: [], messages: [], steps: [], derived: [], threads: [] }, { probe: probe(probeExtra), host }).html;

test("a landed card waiting for the install: the Ship cell says 'Queued for your install', with no counter and no slow word", () => {
  const html = draw();
  assert.match(html, /Queued for your install/);
  assert.equal(/data-shipat/.test(html), false, "no running counter");
  assert.equal(/slow \(est\.\)|deploying \(est\.\)|tests \(est\.\)/.test(html), false, "no estimate words");
});

test("still shown: a Release step in progress keeps its counter, and no 'Queued for your install'", () => {
  const html = draw({}, { shipping: true });
  assert.match(html, /data-shipat="1"/);
  assert.equal(/Queued for your install/.test(html), false);
});

test("still shown: a card not yet on main keeps its counter, and a product card keeps its deploy timing", () => {
  assert.match(draw({}, { onMain: false }), /data-shipat="1"/, "not on main");
  const product = draw({ repo: "Platform" });
  assert.match(product, /data-shipat="1"/, "a product card");
  assert.equal(/Queued for your install/.test(product), false);
});

test("still shown: a landing that failed (a red line on the card) is not called queued", () => {
  const failed = drawPage({ initiatives: [card()], waiting: [], messages: [], steps: [], threads: [], derived: [{ id: "all", cards: { "landed-card": { red: ["on ship with nothing on main"] } } }] }, { probe: probe(), host: "store" }).html;
  assert.equal(/Queued for your install/.test(failed), false);
  assert.match(failed, /on ship with nothing on main/, "control: the red line is drawn");
});

test("the artifact page (not the store) is unchanged", () => {
  const html = draw({}, {}, null);
  assert.equal(/Queued for your install/.test(html), false);
});
