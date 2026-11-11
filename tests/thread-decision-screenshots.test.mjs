// A decision posted in an owner's thread can carry a screenshot per option, shown inline (#C936: #C920 moved decisions into the thread,
// but the store's post had no screenshots and a decision with them was refused, so a look decision could only go in as links).
// The pictures are named as an ask's are ("<file id> A: label"), stored with the message (messages.screenshots, migration 0027),
// read into the view's images, and drawn by the page under the message text, grouped by option.
import test from "node:test";
import assert from "node:assert/strict";
import { askFromTool, postMessage } from "../worker/board-store.mjs";
import { readThreads, applyThreads } from "../worker/compat-threads.mjs";
import { readFiles, applyFiles } from "../worker/file-store.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { loadNames } from "./harness.mjs";

const NOW = 1_800_000_000_000;
const RED = "redredredredred01", BLUE = "blueblueblueblue02", TXT = "texttexttexttext03";
const decision = (extra = {}) => ({ type: "Decision", title: "Which look?", asked_by: "Manager", question: "Red or blue?", options: ["Red", "Blue"], recommended: "Red", related_thread: "t-100", ...extra });
const count = async (db) => (await db.prepare("SELECT COUNT(*) AS n FROM messages").first()).n;
async function seeded() {
  const db = makeDb();
  await db.prepare("INSERT INTO threads (id, num, title, created_at) VALUES ('t-100', 900, 'Look', ?)").bind(NOW - 1000).run();
  for (const [id, type] of [[RED, "image/png"], [BLUE, "image/png"], [TXT, "text/plain"]]) await db.prepare("INSERT INTO files (id, name, type, size, sha256, added_by, added_at) VALUES (?, ?, ?, 10, '', 'Manager', ?)").bind(id, `${id}.x`, type, NOW).run();
  return db;
}
const mine = (db) => db.prepare("SELECT * FROM messages WHERE thread_id = 't-100' AND author = 'Manager'").first();

test("a decision in a thread keeps its screenshots, one per option", async () => {
  const db = await seeded();
  const r = await askFromTool(db, NOW, "Manager", decision({ screenshots: [`${RED} A: red band`, `${BLUE} B: blue band`] }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.posted_in_thread, true);
  const m = await mine(db);
  assert.deepEqual(JSON.parse(m.screenshots), [`${RED} A: red band`, `${BLUE} B: blue band`]);
  assert.equal(m.kind, "decision");
});

test("screenshots are checked as an ask's are, and a picture's option is one the decision offers; nothing is posted on a refusal", async () => {
  const db = await seeded();
  const refused = async (shots) => (await askFromTool(db, NOW, "Manager", decision({ screenshots: shots }))).refused?.rule;
  assert.equal(await refused([`${RED} A: x`, "zzzzzzzzzzzzzzzzzzzz"]), "file-unknown");
  assert.equal(await refused([`${TXT} A: a log`]), "screenshots-shape", "not an image");
  assert.equal(await refused(["https://example.com/x.png"]), "screenshots-shape");
  assert.equal(await refused([`${RED} C: no such option`]), "screenshots-option", "two options: A and B");
  assert.equal(await refused(null), "screenshots-shape");
  assert.equal(await count(db), 0);
});

test("still allowed: a decision with no screenshots or an empty list, an unlettered picture, a plain agent post", async () => {
  const db = await seeded();
  assert.equal((await askFromTool(db, NOW, "Manager", decision())).ok, true);
  assert.equal((await askFromTool(db, NOW, "Manager", decision({ screenshots: [] }))).ok, true);
  assert.equal((await askFromTool(db, NOW, "Manager", decision({ screenshots: [`${RED} the whole page`] }))).ok, true);
  assert.equal((await postMessage(db, NOW, "Builder", { thread_id: "t-100", body: "done" })).ok, true);
  const rows = (await db.prepare("SELECT author, screenshots FROM messages ORDER BY created_at, rowid").all()).results;
  assert.deepEqual(rows.map((r) => r.screenshots), [null, null, JSON.stringify([`${RED} the whole page`]), null]);
});

test("post takes screenshots from an agent; a plain post cannot letter a picture; the owner's message takes none", async () => {
  const db = await seeded();
  const ok = await postMessage(db, NOW, "Manager", { thread_id: "t-100", body: "pick", kind: "decision", options: [{ key: "A", label: "Red" }, { key: "B", label: "Blue" }], screenshots: [`${RED} A: red`] });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal((await postMessage(db, NOW, "Manager", { thread_id: "t-100", body: "here", screenshots: [`${RED} the page`] })).ok, true);
  assert.equal((await postMessage(db, NOW, "Manager", { thread_id: "t-100", body: "here", screenshots: [`${RED} A: red`] })).refused.rule, "screenshots-option");
  assert.equal((await postMessage(db, NOW, "owner", { thread_id: "t-100", body: "mine", screenshots: [`${RED} A: red`] })).refused.rule, "message-shape");
  assert.equal(await count(db), 2);
});

test("the view carries the images: stored ones only, with their option and label", async () => {
  const db = await seeded();
  await askFromTool(db, NOW, "Manager", decision({ screenshots: [`${RED} A: red band`, `${BLUE} B: blue band`] }));
  await postMessage(db, NOW + 1, "Builder", { thread_id: "t-100", body: "no pictures" });
  const threads = await readThreads(db);
  const files = await readFiles(db, [], threads.messages);
  assert.deepEqual(files.images.map((f) => f.id).sort(), [BLUE, RED].sort());
  const c = { messages: [], waiting: [] };
  applyThreads(c, { threads, asks: [] });
  applyFiles(c, { files, asks: [] });
  const [withPics, plain] = c.messages;
  assert.deepEqual(withPics.images, [{ url: `/_blob/${RED}`, label: "red band", option: "A" }, { url: `/_blob/${BLUE}`, label: "blue band", option: "B" }]);
  assert.equal(withPics.screenshots, undefined, "the raw list is not left on the message");
  assert.equal(plain.images, undefined);
});

test("the page draws a message's pictures under its text, grouped by option; none without images", () => {
  const b = loadNames(["msgHtml"]);
  const html = b.msgHtml({ id: "m1", from: "Manager", text: "Red or blue?", at: NOW, images: [{ url: `/_blob/${RED}`, label: "red band", option: "A" }, { url: `/_blob/${BLUE}`, label: "blue band", option: "B" }] });
  assert.match(html, /Red or blue\?[\s\S]*Option A[\s\S]*src="\/_blob\/redredredredred01"[\s\S]*Option B[\s\S]*src="\/_blob\/blueblueblueblue02"/);
  assert.doesNotMatch(b.msgHtml({ id: "m2", from: "Manager", text: "plain", at: NOW }), /class="shots"/);
  assert.doesNotMatch(b.msgHtml({ id: "m3", from: "Manager", text: "x", at: NOW, images: [{ url: "javascript:alert(1)", option: "A" }] }), /javascript:/, "an unsafe address is never drawn");
});
