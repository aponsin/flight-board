// An agent's question for the owner can't die in chat (#C584, Director's miss 2: Builder's font-download ask and four of
// Boardsmith's questions never reached the owner). The probe lists the open cards waiting on the owner with no Needs-you
// item; the lead's wake watch prints "ASK <role> <card>" once; and the lead's Stop hook refuses a reply that asks the owner
// for something without naming a card or #T item.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerAsks, askSince } from "../collector/readings.mjs";
import { asksPending, asksSeen, askLine } from "../gate/reset.mjs";
import { tick } from "../scripts/wake-watch.mjs";
import { stopRun, asksOwnerWithoutItem } from "../gate/stop.mjs";
import { mirrorFresh } from "../collector/state.mjs";
import { fullConfig } from "../scripts/config.mjs";

const T = 1_800_000_000_000, MIN = 60e3;

test("a card waiting on the owner with no open Needs-you item is listed, once an item is open it is not", () => {
  const cards = [
    { id: "font-download", who: "Builder", waitingOn: "Pat" },
    { id: "has-item", who: "Checker", waitingOn: "pat" },
    { id: "not-owner", who: "Release", waitingOn: "Builder" },
    { id: "by-owner", who: "Pat", waitingOn: "Pat" },
    { id: "Bad Id!", who: "Ops", waitingOn: "Pat" },
    { id: "odd-who", who: "not a role", waitingOn: "Pat" },
    null,
  ];
  const waiting = [{ id: "w1", initiative: "has-item", done: false }, { id: "w2", initiative: "font-download", done: true }, null];
  assert.deepEqual(ownerAsks({ cards, waiting, owner: "Pat" }), [{ card: "font-download", role: "Builder" }], "a closed item doesn't count");
  assert.deepEqual(ownerAsks({ cards: [], waiting: [], owner: "Pat" }), []);
  assert.deepEqual(ownerAsks({ cards, waiting: "x", owner: "Pat" }).map((a) => a.card), ["font-download", "has-item"], "an odd export is no item");
});

test("no ask is listed from a board export older than 2 h, or from none (an item written since isn't in it)", () => {
  assert.equal(mirrorFresh(T - 60 * MIN, T), true);
  assert.equal(mirrorFresh(T - 120 * MIN, T), true, "the answer gate's own limit, inclusive");
  assert.equal(mirrorFresh(T - 121 * MIN, T), false);
  assert.equal(mirrorFresh(0, T), false, "no files: no export");
  assert.equal(mirrorFresh(T + 10 * MIN, T), false, "from the future");
  assert.equal(mirrorFresh(NaN, T), false);
});

test("an ask keeps the time it was first seen, and a new one is fresh", () => {
  const first = askSince([{ card: "a-card", role: "Builder" }], null, T);
  assert.deepEqual(first, { asks: [{ card: "a-card", role: "Builder", since: T }], fresh: [{ card: "a-card", role: "Builder", since: T }] });
  const next = askSince([{ card: "a-card", role: "Builder" }, { card: "b-card", role: "Ops" }], { asks: first.asks }, T + MIN);
  assert.deepEqual(next.asks.map((a) => [a.card, a.since]), [["a-card", T], ["b-card", T + MIN]]);
  assert.deepEqual(next.fresh.map((a) => a.card), ["b-card"]);
  assert.deepEqual(askSince([{ card: "a-card", role: "Builder" }], { asks: [{ card: "a-card", since: T + 9e9 }] }, T).asks[0].since, T, "a time in the future is none");
});

test("the wake watch prints ASK once per card, and again when it comes back", () => {
  const dir = mkdtempSync(join(tmpdir(), "asks-"));
  const file = (asks) => writeFileSync(join(dir, "owner-asks.json"), JSON.stringify({ at: T, asks }));
  assert.equal(tick(dir, T), null);
  file([{ card: "a-card", role: "Builder", since: T }, { card: "bad id", role: "Ops", since: T }]);
  assert.equal(tick(dir, T + 1000), askLine({ card: "a-card", role: "Builder" }));
  assert.match(askLine({ card: "a-card", role: "Builder" }), /^ASK Builder a-card: /);
  assert.equal(tick(dir, T + 2000), null, "printed once");
  file([]);
  assert.equal(tick(dir, T + 3000), null);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "owner-asks-seen.json"), "utf8")), { asks: {} }, "the item was written: forgotten");
  file([{ card: "a-card", role: "Builder", since: T + 5000 }]);
  assert.equal(tick(dir, T + 6000), askLine({ card: "a-card", role: "Builder" }), "back with a new time: asked again");
  assert.deepEqual(asksPending({ asks: [{ card: "a-card", role: "Builder", since: 5 }] }, asksSeen({ asks: [{ card: "a-card", role: "Builder", since: 5 }] })), []);
});

test("a reply that asks the owner for something names a card or #T item, or is refused", () => {
  const no = ["Pat needs to approve the font download.", "Waiting on Pat.", "Needs Pat to install v3.44 first.", "Pat, please confirm the sitting.", "pat should decide A or B."];
  for (const r of no) assert.equal(asksOwnerWithoutItem(r, "Pat"), true, r);
  // Manager's all-clear lines (Checker on 46d97a0): a negated mention is a status, not a request.
  const clear = ["Nothing is waiting on Pat.", "Stack 1 is signed; nothing needs Pat now.", "Release ships it; no need for Pat to approve anything.", "No one is waiting on Pat. Pat doesn't need to approve it.", "Pat has not been asked to decide."];
  for (const r of clear) assert.equal(asksOwnerWithoutItem(r, "Pat"), false, r);
  assert.equal(asksOwnerWithoutItem("Nothing else is open. Builder needs Pat to approve the font.", "Pat"), true, "a negation in an earlier sentence clears nothing");
  // A negation far from the request clears nothing (Checker on 650d96f).
  for (const r of ["Not urgent, but waiting on Pat.", "No rush at all, but Builder needs Pat to approve the font.", "Not blocked on the build; still waiting on Pat to decide."]) assert.equal(asksOwnerWithoutItem(r, "Pat"), true, r);
  const fine = ["Pat needs to approve the font download (#T1401).", "Waiting on Pat: #C591 is live.", "Stack 1 is READY; Pat's sitting installs it.", "Done.", "Pat chose B on #T1353.", "Pat needs to approve it: Needs-you item t-1793164285052."];
  for (const r of fine) assert.equal(asksOwnerWithoutItem(r, "Pat"), false, r);
  assert.equal(asksOwnerWithoutItem("", "Pat"), false);
  assert.equal(asksOwnerWithoutItem("Pat needs to approve it.", ""), false);
});

test("the lead's Stop hook refuses such a reply, and lets a plain one through", () => {
  const config = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", owner: "Pat" });
  const turn = (text) => [
    { type: "custom-title", customTitle: "Manager" },
    { type: "user", timestamp: new Date(T - MIN).toISOString(), message: { content: [{ type: "text", text: "status?" }] } },
    { type: "assistant", message: { content: [{ type: "text", text }] } },
  ];
  const run = (text) => stopRun(turn(text), { config, now: T, since: T - 864e5, view: { docs: { messages: [], waiting: [] }, at: T - 30 * MIN, atBy: {} } }).errs;
  assert.match(run("Builder needs Pat to approve the font download.").join("\n"), /asks Pat for something but names no card or #T item/);
  assert.deepEqual(run("Builder needs Pat to approve the font download (#T1401)."), []);
  assert.deepEqual(run("All quiet."), []);
});
