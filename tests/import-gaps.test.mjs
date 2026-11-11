// #C901: what the switch import lost (pictures, the owner's note on an answer, messages after the export, old thread titles), closed by one additive delta.
// Every test runs the generated SQL on a real SQLite with the real migrations, over the shapes Designer found (#T384, #T1701).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { planGaps, gapsSql, putCommands, imageTypeOf, readBlobs, report, missingList, messagePictures } from "../collector/import-gaps.mjs";

const PNG = (n = 1) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(n).fill(7)]);
const ID_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1", ID_B = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2", ID_C = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3", ID_D = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4";
const T384_OPTS = [{ key: "A", label: "OK. Linguist saves the wording", recommended: true }, { key: "B", label: "OK. Linguist saves both" }, { key: "C", label: "Shorter or different wording (say what in the note)" }];

const ask = (db, a) => db.prepare("INSERT INTO asks (id, num, type, title, asked_by, card_id, body, eta_at, eta_precondition, created_at, answered_at, answer, answered_by, answer_taken_at, closed_at, closed_by) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)")
  .bind(a.id, a.num, "Decision", a.title, "Manager", JSON.stringify(a.body), a.created_at, a.answered_at ?? null, a.answer ?? null, a.answered_at ? "owner" : null, a.answered_at ?? null, a.closed_at ?? null, a.closed_at ? "import" : null).run();
const msg = (db, id, thread, at, extra = {}) => db.prepare("INSERT INTO messages (id, thread_id, author, body, created_at, kind, resolved, delivered_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)").bind(id, thread, extra.author ?? "Manager", extra.body ?? "hello", at, extra.resolved ?? 0, at).run();

async function viewOf(db) {
  const asks = (await db.prepare("SELECT * FROM asks").all()).results;
  const messages = (await db.prepare("SELECT * FROM messages").all()).results;
  const threads = (await db.prepare("SELECT * FROM threads").all()).results;
  const images = (await db.prepare("SELECT id, name, type, size FROM files").all()).results;
  return { asks, cards: [], threads: { threads, messages }, files: { images } };
}
const runSql = async (db, sql) => { for (const line of sql.split("\n").filter(Boolean)) await db.prepare(line).run(); };

// The store as the switch left it (Designer's findings), and the old board's export of the same items.
async function seeded() {
  const db = makeDb();
  await ask(db, { id: "ans-privacy-look", num: 384, title: "Where the new privacy promise appears", created_at: 1792615726327, answered_at: 1792616201612, closed_at: 1792616201612, answer: T384_OPTS[2].label,
    body: { question: "Where?", options: T384_OPTS.map((o) => o.label), recommended: T384_OPTS[0].label, screenshots: [`${ID_A} A: Laptop: the section, close-up`, `${ID_B} A: Laptop: where it sits on the page`] } });
  await ask(db, { id: "switch-go-differences-1794341236469", num: 1701, title: "Switch to the new board? (7 differences to accept)", created_at: 1794341236469, answered_at: 1794341554610, closed_at: 1794348768659, answer: "Accept",
    body: { question: "The new board is ready", options: ["Accept", "Fix first"], recommended: "Accept", screenshots: ["[object Object]", "[object Object]"] } });
  await msg(db, "manager-switch-go-ack-1794341664529", "switch-go-differences-1794341236469", 1794341234000, { body: "The new board is ready to switch to. Designer compared both…" });
  const docs = {
    waiting: {
      "ans-privacy-look": { done: true, kind: "decision", options: T384_OPTS, response: { at: 1792616201612, choice: "C", note: "ok this is too details… let's rework this", status: "chose" }, images: [{ label: "Laptop: the section, close-up", option: "A", url: `/_blob/${ID_A}` }, { label: "Laptop: where it sits on the page", option: "A", url: `/_blob/${ID_B}` }] },
      "switch-go-differences-1794341236469": { done: true, doneAt: 1794342562503, kind: "decision", options: [{ key: "A", label: "Accept", recommended: true }, { key: "B", label: "Fix first" }], response: { at: 1794341554610, choice: "A", note: "", status: "chose" },
        images: [{ label: "New board after pc16, laptop, light", option: "A", url: `/_blob/${ID_C}` }, { label: "Old board, same view", option: "B", url: `/_blob/${ID_D}` }] },
    },
    threads: { "switch-go-differences-1794341236469": { num: 1701, title: "Switch to the new board? (7 differences to accept)", updatedAt: 1794341236469 } },
    messages: {
      "manager-switch-go-ack-1794341664529": { thread: "switch-go-differences-1794341236469", from: "Manager", text: "The new board is ready to switch to. Designer compared both…", at: 1794341234000 },
      "m1794342483518-9e4b9g": { thread: "switch-go-differences-1794341236469", from: "Owner", text: "ok go", at: 1794342483518 },
      "manager-switch-waiting-1794342513368": { thread: "switch-go-differences-1794341236469", from: "Manager", text: "Waiting for Security", at: 1794342513368 },
      "m1794342562503-slstxe": { thread: "switch-go-differences-1794341236469", from: "Owner", text: "done", at: 1794342562503, resolved: true },
      "an-unrelated-thread-msg": { thread: "not-in-the-store", from: "Manager", text: "x", at: 5 },
    },
  };
  return { db, docs };
}
const plan = async (db, docs, blobs = {}) => planGaps(docs, await viewOf(db), { blobs, now: 1794400000000 });
const one = async (db, sql) => (await db.prepare(sql).first());

test("gap 2: the owner's note on an answered Decision comes back, only on the answer the import made, and a second run changes nothing", async () => {
  const { db, docs } = await seeded();
  const p = await plan(db, docs);
  assert.deepEqual(p.notes.map((n) => n.id), ["ans-privacy-look"]);
  const sql = gapsSql(p);
  await runSql(db, sql);
  const a = await one(db, "SELECT answer, answer_status, answer_note FROM asks WHERE id = 'ans-privacy-look'");
  assert.equal(a.answer, T384_OPTS[2].label, "the answer stays the option's label");
  assert.equal(a.answer_status, "chose");
  assert.match(a.answer_note, /this is too details/);
  const before = JSON.stringify(await db.prepare("SELECT * FROM asks ORDER BY id").all());
  await runSql(db, sql);
  assert.equal(JSON.stringify(await db.prepare("SELECT * FROM asks ORDER BY id").all()), before, "the second run changes nothing");
  assert.equal((await plan(db, docs)).notes.length, 0, "and the plan finds it held");
  assert.equal((await plan(db, docs)).held.notes, 1);
});

test("gap 2 never overwrites: a note or status the store has, a different answer time or a different option is left alone and said", async () => {
  const { db, docs } = await seeded();
  await db.prepare("UPDATE asks SET answer_status = 'chose', answer_note = 'written in the store' WHERE id = 'ans-privacy-look'").run();
  let p = await plan(db, docs);
  assert.equal(p.notes.length, 0);
  assert.equal(p.held.notes, 1);
  await runSql(db, gapsSql(p));
  assert.equal((await one(db, "SELECT answer_note AS n FROM asks WHERE id = 'ans-privacy-look'")).n, "written in the store");
  // Another answer time (the owner answered again in the store): not the import's answer.
  const s2 = await seeded();
  await s2.db.prepare("UPDATE asks SET answered_at = answered_at + 5 WHERE id = 'ans-privacy-look'").run();
  p = await plan(s2.db, s2.docs);
  assert.equal(p.notes.length, 0);
  assert.deepEqual(p.refused.map((r) => [r.gap, r.rule]), [["note", "answer-differs"]]);
  // The store's answer is another option than the one the old response chose.
  const s3 = await seeded();
  await s3.db.prepare("UPDATE asks SET answer = ? WHERE id = 'ans-privacy-look'").bind(T384_OPTS[0].label).run();
  p = await plan(s3.db, s3.docs);
  assert.equal(p.notes.length, 0);
  // Even a hand-written statement run late changes nothing the guard forbids.
  await runSql(s3.db, `UPDATE asks SET answer_status = 'chose', answer_note = 'late' WHERE id = 'ans-privacy-look' AND answered_at = 1 AND answer_note IS NULL AND answer_status IS NULL;`);
  assert.equal((await one(s3.db, "SELECT answer_note AS n FROM asks WHERE id = 'ans-privacy-look'")).n, null);
  // A note over the store's limit is refused and listed.
  const s4 = await seeded();
  s4.docs.waiting["ans-privacy-look"].response.note = "x".repeat(2001);
  p = await plan(s4.db, s4.docs);
  assert.deepEqual(p.refused.map((r) => [r.gap, r.rule]), [["note", "answer-shape"]]);
});

test("gap 1: #T1701's \"[object Object]\" screenshots are replaced by the old pictures' ids, and a list the store already has is kept", async () => {
  const { db, docs } = await seeded();
  const p = await plan(db, docs);
  assert.deepEqual(p.shots.map((s) => s.id), ["switch-go-differences-1794341236469"], "#T384's list is fine, so only #T1701's is patched");
  assert.equal(p.held.shots, 1);
  await runSql(db, gapsSql(p));
  const body = JSON.parse((await one(db, "SELECT body FROM asks WHERE id = 'switch-go-differences-1794341236469'")).body);
  assert.deepEqual(body.screenshots, [`${ID_C} A: New board after pc16, laptop, light`, `${ID_D} B: Old board, same view`]);
  assert.equal(body.question, "The new board is ready", "the rest of the body is untouched");
  const t384 = JSON.parse((await one(db, "SELECT body FROM asks WHERE id = 'ans-privacy-look'")).body);
  assert.equal(t384.screenshots.length, 2);
  // Run twice: nothing changes, and a list the owner's page has since written is not patched.
  const once = JSON.stringify(await db.prepare("SELECT * FROM asks ORDER BY id").all());
  await runSql(db, gapsSql(p));
  assert.equal(JSON.stringify(await db.prepare("SELECT * FROM asks ORDER BY id").all()), once);
});

test("the SQL's own guards hold when the store changes after the plan: a note, a picture list or an answer written meanwhile is not overwritten", async () => {
  const { db, docs } = await seeded();
  const sql = gapsSql(await plan(db, docs));
  await db.prepare("UPDATE asks SET answer_status = 'chose', answer_note = 'owner wrote this today' WHERE id = 'ans-privacy-look'").run();
  const good = JSON.stringify({ question: "q", options: ["Accept", "Fix first"], recommended: "Accept", screenshots: [`${ID_A} A: written since the switch`] });
  await db.prepare("UPDATE asks SET body = ? WHERE id = 'switch-go-differences-1794341236469'").bind(good).run();
  await runSql(db, sql);
  assert.equal((await one(db, "SELECT answer_note AS n FROM asks WHERE id = 'ans-privacy-look'")).n, "owner wrote this today");
  assert.equal((await one(db, "SELECT body FROM asks WHERE id = 'switch-go-differences-1794341236469'")).body, good);
  // The answer re-made in the store at another time: the note guard on answered_at holds too.
  const s2 = await seeded();
  const sql2 = gapsSql(await plan(s2.db, s2.docs));
  await s2.db.prepare("UPDATE asks SET answered_at = answered_at + 1 WHERE id = 'ans-privacy-look'").run();
  await runSql(s2.db, sql2);
  assert.equal((await one(s2.db, "SELECT answer_note AS n FROM asks WHERE id = 'ans-privacy-look'")).n, null);
});

test("gap 1: the pictures' bytes become files under the old ids, checked by the store's own rules; ones with no bytes are listed, never invented", async () => {
  const { db, docs } = await seeded();
  const p = await plan(db, docs, { [ID_A]: PNG(5), [ID_C]: PNG(9), [ID_D]: new TextEncoder().encode("<html>not a picture</html>") });
  assert.deepEqual(p.files.map((f) => f.id).sort(), [ID_A, ID_C].sort());
  assert.deepEqual(p.missingBlobs.map((m) => m.id), [ID_B], "no bytes given for it");
  assert.deepEqual(p.refused.map((r) => [r.gap, r.id, r.rule]), [["file", ID_D, "file-type"]], "HTML named as a picture is refused");
  assert.deepEqual(p.puts.map((f) => f.id).sort(), [ID_A, ID_C].sort());
  await runSql(db, gapsSql(p));
  const f = await one(db, `SELECT id, name, type, size, sha256, added_by, added_at FROM files WHERE id = '${ID_A}'`);
  assert.equal(f.type, "image/png"); assert.equal(f.size, 13); assert.equal(f.added_by, "import"); assert.equal(f.added_at, 1794400000000);
  assert.match(f.sha256, /^[0-9a-f]{64}$/);
  assert.equal(f.name, "Laptop: the section, close-up");
  // The page's reading of the view now finds the picture (readFiles looks up the ids the asks list).
  const again = await plan(db, docs, { [ID_A]: PNG(5) });
  assert.equal(again.files.length, 0, "a picture the store holds is not stored again");
  const sql = gapsSql(p);
  await runSql(db, sql);
  assert.equal((await one(db, "SELECT COUNT(*) AS n FROM files")).n, 2, "a second run adds nothing (INSERT OR IGNORE)");
});

test("gap 1: the object-store commands name each picture with bytes, once, with its type; a bad bucket name is refused", async () => {
  const { db, docs } = await seeded();
  const dir = mkdtempSync(join(tmpdir(), "gaps-blobs-"));
  writeFileSync(join(dir, `${ID_A}.png`), PNG(5)); writeFileSync(join(dir, ID_C), PNG(9)); writeFileSync(join(dir, "notes.txt"), "ignored");
  const { blobs, ext } = readBlobs(dir);
  assert.deepEqual(Object.keys(blobs).sort(), [ID_A, ID_C].sort());
  const p = await plan(db, docs, blobs);
  const cmds = putCommands(p, { bucket: "board-files", dir, ext }).split("\n");
  assert.equal(cmds.length, 2);
  assert.ok(cmds.some((c) => c.includes(`board-files/${ID_A} --file '${join(dir, `${ID_A}.png`)}' --content-type image/png --remote`)), cmds.join("\n"));
  assert.throws(() => putCommands(p, { bucket: "x; rm -rf /", dir }), /bucket/);
  assert.equal(imageTypeOf(new Uint8Array([0xff, 0xd8, 0xff, 0])), "image/jpeg");
  assert.equal(imageTypeOf(new Uint8Array([1, 2, 3])), null);
});

test("gap 3: the messages the export held and the store lacks come back on the thread the store holds; a thread the store lacks gets none", async () => {
  const { db, docs } = await seeded();
  const p = await plan(db, docs);
  assert.deepEqual(p.messages.map((m) => m.id), ["m1794342483518-9e4b9g", "manager-switch-waiting-1794342513368", "m1794342562503-slstxe"], "the three it lacks, oldest first; the held one and the unknown thread's are not planned");
  assert.equal(p.held.messages, 1);
  await runSql(db, gapsSql(p));
  const rows = (await db.prepare("SELECT id, author, resolved, delivered_at, created_at FROM messages WHERE thread_id = 'switch-go-differences-1794341236469' ORDER BY created_at").all()).results;
  assert.equal(rows.length, 4);
  assert.equal(rows.find((r) => r.id === "m1794342562503-slstxe").resolved, 1, "the old resolving message is flagged, because the store's ask is closed");
  assert.ok(rows.every((r) => r.delivered_at === r.created_at), "delivered at its own time: no wake is handed old messages");
  assert.equal((await one(db, "SELECT COUNT(*) AS n FROM messages WHERE id = 'an-unrelated-thread-msg'")).n, 0);
  await runSql(db, gapsSql(p));
  assert.equal((await one(db, "SELECT COUNT(*) AS n FROM messages")).n, 4, "a second run adds nothing");
});

test("gap 3: a resolved flag is not carried onto an ask the store holds open, and a bad message is refused by name", async () => {
  const { db, docs } = await seeded();
  await db.prepare("UPDATE asks SET closed_at = NULL, closed_by = NULL WHERE id = 'switch-go-differences-1794341236469'").run();
  docs.messages["m-bad-ctrl"] = { thread: "switch-go-differences-1794341236469", from: "Owner", text: "a\u0000b", at: 9 };
  docs.messages["m-no-from"] = { thread: "switch-go-differences-1794341236469", text: "x", at: 9 };
  docs.messages["m-gone"] = { deleted: true, thread: "switch-go-differences-1794341236469", from: "Owner", text: "x", at: 9 };
  const p = await plan(db, docs);
  assert.ok(p.messages.every((m) => m.resolved === 0), "the thread is open in the store, so nothing resolves it");
  assert.deepEqual(p.refused.filter((r) => r.gap === "message").map((r) => [r.id, r.rule]).sort(), [["m-bad-ctrl", "control-char"], ["m-no-from", "message-shape"]]);
});

test("gap 4: the old thread title is kept as the owner's rename row, only while the store's thread has no title", async () => {
  const { db, docs } = await seeded();
  const p = await plan(db, docs);
  assert.deepEqual(p.titles.map((t) => [t.id, t.title]), [["switch-go-differences-1794341236469", "Switch to the new board? (7 differences to accept)"]]);
  await runSql(db, gapsSql(p));
  const t = await one(db, "SELECT id, num, title, created_at FROM threads WHERE id = 'switch-go-differences-1794341236469'");
  assert.equal(t.title, "Switch to the new board? (7 differences to accept)");
  assert.equal(t.num, null, "the ask keeps the #T number; the row only carries the title");
  assert.equal(t.created_at, 1794341234000, "the thread's first message time (the old thread doc has no createdAt)");
  // The owner renames it in the store: a later run leaves his title.
  await db.prepare("UPDATE threads SET title = 'My own name' WHERE id = 'switch-go-differences-1794341236469'").run();
  const again = await plan(db, docs);
  assert.equal(again.titles.length, 0);
  assert.equal(again.held.titles, 1);
  await runSql(db, gapsSql(p));
  assert.equal((await one(db, "SELECT title FROM threads WHERE id = 'switch-go-differences-1794341236469'")).title, "My own name", "even the earlier plan's SQL does not overwrite a title");
  // A title of 121 characters is refused by name; a thread the store lacks is not planned.
  const s2 = await seeded();
  s2.docs.threads["switch-go-differences-1794341236469"].title = "y".repeat(121);
  s2.docs.threads["not-in-the-store"] = { num: 5, title: "Lost" };
  const p2 = await plan(s2.db, s2.docs);
  assert.equal(p2.titles.length, 0);
  assert.deepEqual(p2.refused.map((r) => [r.gap, r.rule]), [["title", "thread-title"]]);
});

// ---- #C913: the pictures of old messages (gap 5) ----
const TID = "switch-go-differences-1794341236469";
const ID_E = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5", ID_F = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6";
const imgs = (...ids) => ids.map((id, i) => ({ label: `pic ${i + 1}`, option: "A", url: `/_blob/${id}` }));
const shotsOfRow = async (db, id) => (await one(db, `SELECT screenshots FROM messages WHERE id = '${id}'`)).screenshots;

test("gap 5: a message the store holds gets the old message's picture list, only while it has none, and a second run changes nothing", async () => {
  const { db, docs } = await seeded();
  docs.messages["manager-switch-go-ack-1794341664529"].images = imgs(ID_E, ID_F);
  const p = await plan(db, docs);
  assert.deepEqual(p.msgShots, [{ id: "manager-switch-go-ack-1794341664529", screenshots: [`${ID_E} A: pic 1`, `${ID_F} A: pic 2`] }]);
  await runSql(db, gapsSql(p));
  assert.deepEqual(JSON.parse(await shotsOfRow(db, "manager-switch-go-ack-1794341664529")), [`${ID_E} A: pic 1`, `${ID_F} A: pic 2`]);
  const again = await plan(db, docs);
  assert.equal(again.msgShots.length, 0);
  assert.equal(again.held.msgShots, 1, "a list the store has is held, and said");
  // A list the store gets after the plan is never overwritten by the earlier plan's SQL.
  await db.prepare("UPDATE messages SET screenshots = ? WHERE id = 'manager-switch-go-ack-1794341664529'").bind(JSON.stringify([`${ID_A} mine`])).run();
  await runSql(db, gapsSql(p));
  assert.deepEqual(JSON.parse(await shotsOfRow(db, "manager-switch-go-ack-1794341664529")), [`${ID_A} mine`]);
});

test("gap 5: a message the store lacks comes back with its pictures, and a message of pictures alone is let through with an empty body", async () => {
  const { db, docs } = await seeded();
  docs.messages["m1794342483518-9e4b9g"].images = imgs(ID_E);
  docs.messages["m-only-pictures"] = { thread: TID, from: "Designer", text: "", at: 1794342500000, images: imgs(ID_F) };
  docs.messages["m-nothing"] = { thread: TID, from: "Designer", text: "", at: 1794342500001 };
  docs.messages["m-only-bad-image"] = { thread: TID, from: "Designer", text: "  ", at: 1794342500002, images: [{ label: "x", url: "https://elsewhere/x.png" }] };
  const p = await plan(db, docs);
  const by = Object.fromEntries(p.messages.map((m) => [m.id, m]));
  assert.equal(by["m1794342483518-9e4b9g"].body, "ok go");
  assert.deepEqual(JSON.parse(by["m1794342483518-9e4b9g"].screenshots), [`${ID_E} A: pic 1`]);
  assert.equal(by["m-only-pictures"].body, "");
  assert.deepEqual(JSON.parse(by["m-only-pictures"].screenshots), [`${ID_F} A: pic 1`]);
  assert.equal(by["manager-switch-waiting-1794342513368"].screenshots, null, "a message with no picture carries none");
  assert.deepEqual(p.refused.filter((r) => r.gap === "message").map((r) => [r.id, r.rule]).sort(), [["m-nothing", "message-shape"], ["m-only-bad-image", "message-shape"]], "no text and no picture is still refused");
  await runSql(db, gapsSql(p));
  assert.deepEqual(JSON.parse(await shotsOfRow(db, "m-only-pictures")), [`${ID_F} A: pic 1`]);
  assert.equal(await shotsOfRow(db, "manager-switch-waiting-1794342513368"), null);
  assert.equal((await one(db, "SELECT body FROM messages WHERE id = 'm-only-pictures'")).body, "");
  await runSql(db, gapsSql(p));
  assert.equal((await one(db, "SELECT COUNT(*) AS n FROM messages WHERE id = 'm-only-pictures'")).n, 1, "a second run adds nothing");
});

test("gap 5: the owner's attachments (assets) are pictures too: image types only, no repeat of an image, eight at most; a picture-only message of assets is let through", async () => {
  const asset = (id, type = "image/png", name = "Monosnap shot.png") => ({ id, name, size: 10, type });
  assert.deepEqual(messagePictures({ assets: [asset(ID_E), asset(ID_F, "application/pdf", "plan.pdf"), asset("short"), null, { id: ID_A }] }), [`${ID_E} Monosnap shot.png`], "a pdf, a bad id, a null and an asset with no type are not pictures");
  assert.deepEqual(messagePictures({ images: imgs(ID_E), assets: [asset(ID_E), asset(ID_F, "image/jpeg", "b.jpg")] }), [`${ID_E} A: pic 1`, `${ID_F} b.jpg`], "an asset an image already names is not listed twice");
  assert.equal(messagePictures({ assets: Array.from({ length: 12 }, (_, i) => asset(`bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb${String(i).padStart(2, "0")}`)) }).length, 8);
  assert.deepEqual(messagePictures({}), []);
  const { db, docs } = await seeded();
  docs.messages["m-asset-only"] = { thread: TID, from: "Owner", text: "", at: 1794342500000, assets: [asset(ID_E)] };
  docs.messages["manager-switch-go-ack-1794341664529"].assets = [asset(ID_F, "image/png", "other.png")];
  const p = await plan(db, docs);
  assert.deepEqual(p.msgShots, [{ id: "manager-switch-go-ack-1794341664529", screenshots: [`${ID_F} other.png`] }]);
  const row = p.messages.find((m) => m.id === "m-asset-only");
  assert.equal(row.body, "");
  assert.deepEqual(JSON.parse(row.screenshots), [`${ID_E} Monosnap shot.png`]);
  assert.deepEqual(p.missingBlobs.filter((b) => b.for === "message").map((b) => b.id).sort(), [ID_E, ID_F]);
});

test("gap 5: a thread the store lacks gets nothing and a deleted message none, and their pictures are not asked for", async () => {
  const { db, docs } = await seeded();
  docs.messages["m-elsewhere"] = { thread: "not-in-the-store", from: "Designer", text: "x", at: 7, images: imgs(ID_E) };
  docs.messages["m-gone"] = { deleted: true, thread: TID, from: "Designer", text: "x", at: 8, images: imgs(ID_F) };
  const p = await plan(db, docs);
  assert.ok(!p.messages.some((m) => m.id === "m-elsewhere" || m.id === "m-gone"));
  assert.ok(![...p.missingBlobs].some((b) => b.id === ID_E || b.id === ID_F), "a picture only an unplanned message points at is not asked for");
});

test("gap 5: the pictures of messages follow gap 1's rules: bytes become files under the old id, the rest are listed with who points at them", async () => {
  const { db, docs } = await seeded();
  docs.messages["manager-switch-go-ack-1794341664529"].images = imgs(ID_E, ID_A);
  docs.messages["m1794342483518-9e4b9g"].images = imgs(ID_F);
  const p = await plan(db, docs, { [ID_E]: PNG(3), [ID_F]: new Uint8Array([1, 2, 3]) });
  assert.deepEqual(p.files.map((f) => f.id), [ID_E], "only the picture with real bytes becomes a file");
  assert.deepEqual(p.refused.filter((r) => r.gap === "file").map((r) => [r.id, r.rule]), [[ID_F, "file-type"]]);
  const miss = Object.fromEntries(p.missingBlobs.map((b) => [b.id, b.for]));
  assert.equal(miss[ID_A], "both", "the ask and the message both point at it");
  assert.equal(miss[ID_B], "ask");
  assert.equal(miss[ID_E], undefined);
  const list = missingList(p).split("\n").map((l) => l.split("\t"));
  assert.deepEqual(list.find((r) => r[0] === ID_A), [ID_A, "Laptop: the section, close-up", "both"]);
  assert.ok(list.every((r) => r.length === 3 && ["ask", "message", "both"].includes(r[2])));
  await runSql(db, gapsSql(p));
  assert.equal((await one(db, `SELECT COUNT(*) AS n FROM files WHERE id = '${ID_E}'`)).n, 1);
});

test("the whole delta is additive: the SQL holds only guarded INSERT OR IGNORE, UPDATE ... WHERE and the one title upsert; its report names every part", async () => {
  const { db, docs } = await seeded();
  const p = await plan(db, docs, { [ID_A]: PNG(2) });
  for (const line of gapsSql(p).split("\n")) {
    assert.ok(/^INSERT OR IGNORE INTO (files|messages) /.test(line) || /^UPDATE (asks|messages) SET .* WHERE id = '.*' AND /.test(line) || /^INSERT INTO threads .* ON CONFLICT \(id\) DO UPDATE SET title = excluded\.title WHERE threads\.title IS NULL;$/.test(line), line.slice(0, 80));
  }
  assert.ok(!/DELETE|DROP|TRUNCATE/i.test(gapsSql(p)));
  const r = report(p);
  assert.deepEqual(Object.keys(r).sort(), ["files", "held", "messages", "missingBlobs", "msgShots", "notes", "refused", "shots", "titles"]);
  // A value with a control character never reaches the SQL text.
  p.titles.push({ id: "t", title: "a\u0000b", created_at: 1 });
  assert.throws(() => gapsSql(p), /control character/);
});
