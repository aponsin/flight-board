// #C979: the store refuses a UTC "Z" time in an ask or in an agent's post in a thread the owner reads (Mountain Time only). Must still
// allow: a commit or an id with a Z in it, a Z time inside a code span or a Copy box (a step's cmd, Terminal commands, SessionStart words),
// agent-only threads, the word "Z" in prose, the owner's own words, and an import of an old ask.
import test from "node:test";
import assert from "node:assert/strict";
import { zTimeIn, zTimeRefusal, askRefusal } from "../worker/board-rules.mjs";
import { createCard, createAsk, postMessage, askFromTool } from "../worker/board-store.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";

const NOW = 1_800_000_000_000, DAY = 86_400_000;

test("zTimeIn: a time of day with Z is found; ids, shas, prose Z, code spans and MT times are not", () => {
  for (const [text, hit] of [["back at 03:45Z", "03:45Z"], ["at 3:45 Z.", "3:45 Z"], ["ran 03:45:09Z", "03:45:09Z"], ["since 2026-11-12T03:45Z", "2026-11-12T03:45Z"],
    ["(00:30Z)", "00:30Z"], ["2026-11-12 14:03Z, then", "2026-11-12 14:03Z"], ["at 03:45:09.123Z", "03:45:09.123Z"]]) assert.equal(zTimeIn(text), hit, text);
  for (const text of ["commit 9fZ3a1c and id t-1794Z0", "Plan Z, then plan Y", "the Z suffix means UTC", "`03:45Z` in the log", "```\nlast run 03:45Z\n```",
    "12:00 Zoom call", "8:45 pm MT", "v1.209.14", "ratio 3:45", "12:30Zulu", "a:03:45Z", "", null]) assert.equal(zTimeIn(text), null, String(text));
  const r = zTimeRefusal(["fine", "ran at 03:45Z"]);
  assert.equal(r.rule, "owner-reads-mountain-time");
  assert.match(r.detail, /"03:45Z" is a UTC time; the owner reads Mountain Time only/);
  assert.equal(zTimeRefusal(["8:45 pm MT", undefined]), null);
});

test("askRefusal: a Z time in what the owner reads is refused; his Copy boxes, an import and code spans are not", () => {
  const later = (extra) => ({ type: "Later", title: "Check the deploy", asked_by: "Manager", text: "after the run", eta_at: NOW + DAY, ...extra });
  assert.equal(askRefusal(later({ text: "after the 03:45Z run" }), NOW)?.rule, "owner-reads-mountain-time");
  assert.equal(askRefusal(later({ title: "Deploy at 14:00Z" }), NOW)?.rule, "owner-reads-mountain-time");
  assert.equal(askRefusal(later({ text: "after the `03:45Z` run (8:45 pm MT)" }), NOW), null, "a code span stays");
  assert.equal(askRefusal(later({ text: "after the 03:45Z run" }), null), null, "an import keeps the old words");
  const action = (steps) => ({ type: "Action", title: "Run it", asked_by: "Manager", steps, expect: "OK" });
  assert.equal(askRefusal(action([{ text: "Run the line", cmd: "node x.mjs --since 2026-11-12T03:45Z" }]), NOW), null, "a step's cmd is his Copy box");
  assert.equal(askRefusal(action([{ text: "Wait until 03:45Z, then run it", cmd: "node x.mjs" }]), NOW)?.rule, "owner-reads-mountain-time");
  assert.equal(askRefusal(action(["Wait until 03:45Z"]), NOW)?.rule, "owner-reads-mountain-time");
  assert.equal(askRefusal({ type: "Terminal", title: "Logs", asked_by: "Manager", commands: ["grep 03:45Z ~/log.txt"] }, NOW), null, "Terminal commands are pasted");
  assert.equal(askRefusal({ type: "SessionStart", title: "Wake", asked_by: "Manager", words: "/pickup Builder since 03:45Z" }, NOW), null, "SessionStart words are pasted");
  const decision = { type: "Decision", title: "When?", asked_by: "Manager", question: "Pick a time", options: ["03:00Z", "Later"], recommended: "Later" };
  assert.equal(askRefusal(decision, NOW)?.rule, "owner-reads-mountain-time", "an option is prose");
  assert.equal(askRefusal({ ...decision, options: ["8 pm MT", "Later"] }, NOW), null);
});

async function setup() {
  const db = makeDb();
  assert.equal((await createCard(db, NOW, "Manager", { id: "card-a", title: "A card" })).ok, true);
  return db;
}
const refusals = async (db) => (await db.prepare("SELECT rule FROM refusals").all()).results.map((r) => r.rule);

test("postMessage: an agent's Z time in a thread the owner reads is refused and logged; agent-only threads and the owner pass", async () => {
  const db = await setup();
  // a card thread only agents wrote in: theirs, Z times and all
  assert.equal((await postMessage(db, NOW, "Builder", { thread_id: "card-a", body: "pushed at 03:45Z" })).ok, true, "agent-only thread");
  // the owner writes in it: now he reads it
  assert.equal((await postMessage(db, NOW + 1, "owner", { thread_id: "card-a", body: "what time is 03:45Z for me?" })).ok, true, "the owner's own words pass");
  const r = await postMessage(db, NOW + 2, "Builder", { thread_id: "card-a", body: "it landed at 03:45Z" });
  assert.equal(r.ok, false);
  assert.equal(r.refused.rule, "owner-reads-mountain-time");
  assert.deepEqual(await refusals(db), ["owner-reads-mountain-time"], "logged in the refusals table");
  assert.equal((await postMessage(db, NOW + 3, "Builder", { thread_id: "card-a", body: "it landed at 8:45 pm MT (`03:45Z` in the log), commit 9fZ3a1c" })).ok, true);
  // an ask's thread and a free thread are the owner's
  const ask = await createAsk(db, NOW, { type: "Later", title: "Check it", asked_by: "Manager", text: "tomorrow", eta_at: NOW + DAY });
  assert.equal(ask.ok, true, JSON.stringify(ask));
  assert.equal((await postMessage(db, NOW + 4, "Manager", { thread_id: ask.id, body: "moved to 15:00Z" })).refused?.rule, "owner-reads-mountain-time");
  await db.prepare("INSERT INTO threads (id, num, title, created_at) VALUES (?, ?, ?, ?)").bind("t-500", 500, "A question", NOW).run();
  assert.equal((await postMessage(db, NOW + 5, "Manager", { thread_id: "t-500", body: "see you 2026-11-12T15:00Z" })).refused?.rule, "owner-reads-mountain-time");
  assert.equal((await postMessage(db, NOW + 6, "Manager", { thread_id: "t-500", body: "Plan Z: see you at 8 am MT" })).ok, true, "the word Z in prose");
  assert.equal((await postMessage(db, NOW + 7, "owner", { thread_id: "t-500", body: "the log says 15:00Z, is that right?" })).ok, true, "the owner's own words pass in his thread");
});

test("a Decision posted into the owner's thread is held to the same rule, its options too", async () => {
  const db = await setup();
  await db.prepare("INSERT INTO threads (id, num, title, created_at) VALUES (?, ?, ?, ?)").bind("t-600", 600, "When to ship", NOW).run();
  const d = (extra) => ({ type: "Decision", title: "Ship when?", asked_by: "Manager", question: "Pick one", options: ["Tonight", "Tomorrow"], recommended: "Tonight", related_thread: "t-600", ...extra });
  assert.equal((await askFromTool(db, NOW, "Manager", d({ question: "Tonight at 03:00Z or tomorrow?" }))).refused?.rule, "owner-reads-mountain-time");
  assert.equal((await askFromTool(db, NOW, "Manager", d({ options: ["03:00Z", "Tomorrow"], recommended: "Tomorrow" }))).refused?.rule, "owner-reads-mountain-time");
  assert.equal((await askFromTool(db, NOW, "Manager", d({ question: "Tonight at 8 pm MT or tomorrow?" }))).ok, true);
});
