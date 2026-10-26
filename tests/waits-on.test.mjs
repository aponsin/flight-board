// Who an item waits on comes from one function, waitsOn, and both its badge and its section follow it (#C236: an
// answered ask under "Waiting on Manager" still said "waiting on you").
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames, renderWaitingHtml } from "./harness.mjs";

const T = 1_800_000_000_000;
const NAMES = ["waitsOn", "badge", "threadsHtml", "threadRows", "resolvedHtml", "initRow", "enrich"];
const board = (st = {}) => { const b = loadNames(NAMES); Object.assign(b.state, st); return b; };
const msg = (thread, from, text, at, extra = {}) => ({ id: `m${at}`, thread, from, text, at, ...extra });
const badgeOf = (html, id) => (html.match(new RegExp(`data-id="(?:th-)?${id}"[\\s\\S]*?<span class="t-badge[^"]*">([^<]*)</span>`)) ?? [])[1];

test("waitsOn: an open ask is you, then the lead once answered; a thread is the lead, answered or resolved by its last word", () => {
  const ask = { id: "a1", kind: "action", text: "Do it", since: T };
  const answered = { ...ask, id: "a2", response: { status: "help", note: "step 2 fails", at: 1000 } };
  // A bare Done, or one that only acknowledges, settles the ask (#C268): nothing waits on anyone.
  const doneBare = { ...ask, id: "a4", response: { status: "done", at: 1000 } }, doneOk = { ...ask, id: "a5", response: { status: "done", note: "done.", at: 1000 } };
  const b = board({ waiting: [ask, answered, { ...ask, id: "a3", done: true }, doneBare, doneOk], messages: [
    msg("t-1", "Owner", "a question", T), msg("t-2", "Owner", "q", T), msg("t-2", "Manager", "an answer", T + 1),
    msg("t-3", "Owner", "q", T), msg("t-3", "Manager", "done", T + 1, { resolved: true }), msg("a3", "Manager", "thanks", T + 1),
  ] });
  assert.equal(b.waitsOn("a1", T), "you");
  assert.equal(b.waitsOn("a2", T), "lead");
  assert.equal(b.waitsOn("a4", T), null, "a bare Done: settled, no thread");
  assert.equal(b.waitsOn("a5", T), null, "Done with \"done.\": settled too");
  assert.equal(b.waitsOn("t-1", T), "lead", "the owner's word is the last");
  assert.equal(b.waitsOn("t-2", T), "answered", "Manager's word is the last");
  assert.equal(b.waitsOn("t-3", T), "resolved");
  assert.equal(b.waitsOn("a3", T), "resolved", "a done ask's thread");
  assert.equal(b.waitsOn("nothing", T), null);
  assert.equal(b.badge(null), "");
});

test("the badge always matches the section: Needs you says waiting on you, Waiting on Manager says waiting on Manager", () => {
  const ask = { id: "ask-pics", kind: "action", text: "Send the pictures", since: T };
  assert.equal(badgeOf(renderWaitingHtml([ask]), "ask-pics"), "waiting on you");
  const b = board({ waiting: [{ ...ask, response: { status: "done", note: "here", at: 1000 } }], messages: [msg("ask-pics", "Owner", "here", T), msg("t-9", "Owner", "a new thread", T)] });
  const lead = b.threadsHtml(T);
  assert.equal(badgeOf(lead, "ask-pics"), "waiting on Manager", "the answered ask, under Waiting on Manager");
  assert.equal(badgeOf(lead, "t-9"), "waiting on Manager");
  assert.doesNotMatch(lead, /waiting on you/, "nothing in Waiting on Manager says it waits on the owner");
  const b2 = board({ messages: [msg("t-4", "Owner", "q", T), msg("t-4", "Manager", "an answer", T + 1)] });
  assert.equal(badgeOf(b2.threadRows(T).answered, "t-4"), "answered", "Manager answered: under Needs you, as answered");
  assert.equal(b2.threadRows(T).open, "");
});

test("page lint: the template writes a badge in one place only, badge()", () => {
  const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  const start = html.indexOf("function badge(");
  const body = html.slice(start, html.indexOf("\n", start));
  const rest = html.slice(0, start) + html.slice(start + body.length);
  assert.match(body, /waiting on you/);
  assert.doesNotMatch(rest, /class=\\?["']t-badge/, "no badge markup outside badge()");
  assert.doesNotMatch(rest, /t-badge \$\{/, "no badge class built from a caller's value");
});
