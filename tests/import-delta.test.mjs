// The C5 delta import (#C741): which cards the store lacks, which are the board's own (from git), and the SQL for them.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idsOf, boardIdsFromGit, planDelta, planAsks, deltaSql, report } from "../collector/import-delta.mjs";

const card = (num, extra = {}) => ({ num, name: `Card ${num}`, summary: "s", size: "S", level: "Full", who: "Boardsmith", status: "active", createdAt: 1000 + num, ...extra });

test("Board-Id lines are read from the whole message, a trailer block or not; other lines and ids are not", () => {
  const text = "Subject\n\nbody\nBoard-Id: c1-a\n\nCo-Authored-By: x\n---\nBoard-Id: c2-b  \nBoard-Id: UPPER\nBoard-Id:\n  Board-Id: c3-indented\nsee Board-Id: c4-inline";
  assert.deepEqual([...idsOf(text)].sort(), ["c1-a", "c2-b"]);
});

test("the board's cards are the ones with a Board-Id on origin/main or on the tip of an origin build/ branch", () => {
  const calls = [];
  const git = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "log" && args[1] === "origin/main") return "x\n\nBoard-Id: on-main\n";
    if (args[0] === "for-each-ref") return "refs/remotes/origin/build/branch-a\nrefs/remotes/origin/build/branch-b-v2\n";
    return args.at(-1).endsWith("branch-a") ? "Board-Id: not-landed\n" : "no id here\n";
  };
  assert.deepEqual([...boardIdsFromGit(git)].sort(), ["not-landed", "on-main"]);
  assert.ok(calls.some((c) => c.startsWith("for-each-ref") && c.includes("refs/remotes/origin/build/")));
});

test("real git: a commit message with the id (even after a blank line) counts, and nothing else does", () => {
  const dir = mkdtempSync(join(tmpdir(), "delta-"));
  const g = (...a) => execFileSync("git", ["-C", dir, "-c", "user.email=t@e.x", "-c", "user.name=t", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  g("init", "-q", "-b", "main"); writeFileSync(join(dir, "f"), "1"); g("add", "f");
  g("commit", "-q", "-m", "a change\n\nBoard-Id: real-card\n\nCo-Authored-By: someone");
  g("update-ref", "refs/remotes/origin/main", "HEAD");
  assert.deepEqual([...boardIdsFromGit((args) => g(...args))], ["real-card"]);
});

test("a card the store lacks is inserted with its number and, if it is the board's, the repo word; a team card gets none", () => {
  const p = planDelta({ "c730-x": card(730), "c722-y": card(722) }, { boardIds: new Set(["c730-x"]) });
  assert.deepEqual(p.insert.map((r) => [r.id, r.num, r.repo]), [["c722-y", 722, undefined], ["c730-x", 730, "flight-board"]]);
  assert.deepEqual(p.teamCards.map((c) => c.id), ["c722-y"]);
  assert.equal(p.counterC, 731);
});

test("a card the store holds only gets the repo word, if it is the board's; nothing else is touched", () => {
  const p = planDelta({ "c719-a": card(719), "c722-y": card(722) }, { boardIds: new Set(["c719-a"]), storeIds: new Set(["c719-a", "c722-y"]) });
  assert.deepEqual(p.insert, []);
  assert.deepEqual(p.setRepo, [{ id: "c719-a", repo: "flight-board" }]);
  const sql = deltaSql(p);
  assert.match(sql, /UPDATE cards SET repo = 'flight-board' WHERE id = 'c719-a' AND repo IS NULL;/);
  assert.doesNotMatch(sql, /INSERT/);
  assert.doesNotMatch(sql, /c722-y/);
});

test("cards below the starting number are left alone; a done card is a history row, not a card; a refused card is listed", () => {
  const docs = { "old-one": card(100), "done-one": card(740, { status: "done", doneAt: 5000 }), "bad id!": card(745), "no-title": { ...card(746), name: "" } };
  const p = planDelta(docs, {});
  assert.equal(p.skipped.belowNum, 1);
  assert.deepEqual(p.history.map((h) => h.id), ["done-one"]);
  assert.deepEqual(p.insert, []);
  assert.deepEqual(p.refused.map((r) => r.id).sort(), ["bad id!", "no-title"]);
  assert.equal(planDelta({ "done-one": docs["done-one"] }, { historyIds: new Set(["done-one"]) }).history.length, 0);
});

test("a dropped card is never a history row, even when its status says done (Checker)", () => {
  const p = planDelta({ "gone-one": card(740, { status: "done", doneAt: 5000, dropped: true }) }, {});
  assert.deepEqual(p.history, []);
  assert.deepEqual(p.insert, []);
});

test("run as a script from a path with a space in it, the dry run still starts (it asks for its arguments, exit 64)", async () => {
  const { symlinkSync, mkdirSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const dir = join(mkdtempSync(join(tmpdir(), "delta space ")), "a b");
  mkdirSync(dir);
  const link = join(dir, "import-delta.mjs");
  symlinkSync(fileURLToPath(new URL("../collector/import-delta.mjs", import.meta.url)), link);
  const r = spawnSync(process.execPath, [link], { encoding: "utf8" });
  assert.equal(r.status, 64, r.stderr);
  assert.match(r.stderr, /pass --export/);
});

test("the SQL is by old id and idempotent in form: INSERT OR IGNORE, a guarded repo UPDATE, and a counter that only goes up; quotes are escaped", () => {
  const p = planDelta({ "c730-x": card(730, { name: "It's a card", summary: "O'Neil" }) }, { boardIds: new Set(["c730-x"]) });
  const sql = deltaSql(p);
  assert.match(sql, /^INSERT OR IGNORE INTO cards \(/m);
  assert.match(sql, /'It''s a card'/);
  assert.match(sql, /UPDATE counters SET next = MAX\(next, 731\) WHERE name = 'C';/);
  assert.equal(report(p).insert[0].repo, "flight-board");
});

test("a bad repo word is refused before anything is planned", () => {
  assert.throws(() => planDelta({}, { repoWord: "Flight Board" }), /repo word/);
});

test("a number that is not an integer from 1 to 1e6 is refused, never inserted, never counted (Security 1)", () => {
  const docs = { "huge-one": card(1e300), "frac-one": card(740.5), "neg-one": card(-5), "zero-one": card(0), "edge-one": card(1e6), "over-one": card(1e6 + 1), "none-one": { ...card(741), num: undefined } };
  const p = planDelta(docs, { storeIds: new Set(["huge-one", "over-one"]), boardIds: new Set(["huge-one", "over-one"]) });
  assert.deepEqual(p.refused.map((r) => r.id).sort(), ["frac-one", "huge-one", "neg-one", "over-one", "zero-one"]);
  assert.ok(p.refused.every((r) => r.detail === "number out of range"));
  assert.deepEqual(p.insert.map((r) => r.id), ["edge-one"]);
  assert.deepEqual(p.setRepo, []);
  assert.equal(p.skipped.belowNum, 1);
  assert.equal(p.counterC, 1e6 + 1);
  assert.doesNotMatch(deltaSql(p), /e\+/);
  const hist = planDelta({ "huge-done": card(1e300, { status: "done", doneAt: 5000 }) }, {});
  assert.deepEqual(hist.history, []);
  assert.equal(hist.refused.length, 1);
  assert.equal(hist.counterC, 0);
});

test("a control character other than tab and newline never reaches the SQL: the card is refused, and q() throws as a backstop (Security 2)", () => {
  const p = planDelta({ "nul-one": card(740, { name: "a\u0000b" }), "esc-one": card(741, { summary: "x\u001b[0m" }), "ok-one": card(742, { name: "tab\there\nline" }), "nul-done": card(743, { status: "done", doneAt: 5000, name: "d\u0000" }) }, {});
  assert.deepEqual(p.refused.map((r) => r.id).sort(), ["esc-one", "nul-done", "nul-one"]);
  assert.deepEqual(p.insert.map((r) => r.id), ["ok-one"]);
  assert.deepEqual(p.history, []);
  assert.doesNotThrow(() => deltaSql(p));
  assert.throws(() => deltaSql({ insert: [{ id: "x", title: "a\u0000b" }], history: [], setRepo: [], counterC: 1 }), /control character/);
  assert.throws(() => deltaSql({ insert: [], history: [], setRepo: [{ id: "x", repo: "a\u007f" }], counterC: 1 }), /control character/);
});

test("a done card's file-name id passes the card-id rule too (Security 3)", () => {
  const p = planDelta({ "h'); DELETE FROM cards; --": card(740, { status: "done", doneAt: 5000 }), "fine-done": card(741, { status: "done", doneAt: 5000 }) }, {});
  assert.deepEqual(p.history.map((h) => h.id), ["fine-done"]);
  assert.deepEqual(p.refused.map((r) => r.rule), ["card-id"]);
});

// The asks and threads still open on the old board (#C744).
const ROSTER = ["Builder", "Manager", "Checker"];
const docsOf = (extra = {}) => ({
  initiatives: {}, threads: { "t-a": { num: 900, title: "A" }, "t-b": { num: 901, title: "B" }, "t-res": { num: 902, title: "R" } },
  messages: { m1: { thread: "t-a", from: "Manager", text: "hello", at: 5000 }, m2: { thread: "t-res", from: "Owner", text: "done", at: 6000, resolved: true }, m3: { thread: "t-a", from: "Owner", text: "ok", at: 7000 } },
  waiting: {
    "w-open": { kind: "later", thread: "t-a", text: "wait for it", who: "Builder", eta: 4_000_000_000_000 },
    "w-new": { kind: "action", thread: "t-b", steps: ["s"], expect: "e" },
    "w-done": { kind: "action", done: true },
    "w-res": { kind: "later", thread: "t-res", text: "x", eta: 4_000_000_000_000 },
    "w-bad": { kind: "decision", thread: "t-b", question: "q" },
  }, ...extra,
});

test("asks: only open items come in, with their #T numbers, their thread messages, and the lead as the asker where none is named; a refused item is listed, never patched", () => {
  const a = planAsks(docsOf(), { owner: "Owner", roster: ROSTER, lead: "Manager", liveT: 0, storeAsks: [] });
  assert.deepEqual(a.asks.map((r) => r.id).sort(), ["w-new", "w-open"]);
  assert.equal(a.asks.find((r) => r.id === "w-open").num, 900);
  assert.equal(a.asks.find((r) => r.id === "w-open").asked_by, "Builder");
  assert.equal(a.asks.find((r) => r.id === "w-new").asked_by, "Manager");
  assert.deepEqual(a.messages.map((m) => m.id).sort(), ["m1", "m3"]);
  assert.deepEqual(a.skipped, { doneAsks: 1, resolvedAsks: 1 });
  assert.deepEqual(a.refused.map((r) => [r.kind, r.id]), [["ask", "w-bad"]]);
  assert.equal(a.counterT, 903);
  assert.deepEqual([a.counts.needs, a.counts.later, a.counts.lead], [1, 1, 0]);
});

test("asks: a second run with asks already in the store lists them as held, imports nothing twice (INSERT OR IGNORE), and closes nothing", () => {
  const a = planAsks(docsOf(), { owner: "Owner", roster: ROSTER, lead: "Manager", storeAsks: [{ id: "w-open", closed_at: null }, { id: "w-done", closed_at: null }] });
  assert.deepEqual(a.heldAlready, ["w-open"]);
  assert.deepEqual(a.newAsks, ["w-new"]);
  assert.deepEqual(a.stillOpenInStoreButClosedOld, ["w-done"]);
  const sql = deltaSql({ insert: [], history: [], setRepo: [], counterC: 745 }, a);
  assert.equal(sql.split("\n").filter((l) => l.startsWith("INSERT OR IGNORE INTO asks")).length, 2);
  assert.equal(sql.split("\n").filter((l) => l.startsWith("INSERT OR IGNORE INTO messages")).length, 2);
  assert.match(sql, /UPDATE counters SET next = MAX\(next, 903\) WHERE name = 'T';/);
  assert.doesNotMatch(sql, /UPDATE asks|DELETE|DROP/);
});

test("#C748: asks the first import stored without a Later's steps, expect and where, an Action's where, or as a Later when they hold options, are fixed by a guarded UPDATE; once, and not an answered or closed ask", async () => {
  const { makeDb } = await import("./helpers/d1-sqlite.mjs");
  const docs = docsOf({ waiting: {
    "l-steps": { kind: "later", text: "first look", eta: 4_000_000_000_000, steps: ["open it", "note it"], expect: "a few pages", where: "around 2026-10-22" },
    "a-where": { kind: "action", title: "do it", steps: ["s"], expect: "e", where: "Laptop" },
    "l-price": { kind: "later", text: "keep them?", eta: 4_000_000_000_000, options: [{ key: "A", label: "Keep", recommended: true }, { key: "B", label: "Match" }] },
    "l-plain": { kind: "later", text: "plain", eta: 4_000_000_000_000 },
  } });
  const a = planAsks(docs, { owner: "Owner", roster: ROSTER, lead: "Manager", storeAsks: [] });
  assert.deepEqual(a.refused, []);
  const row = (id) => a.asks.find((r) => r.id === id);
  assert.equal(row("l-price").type, "Decision");
  assert.deepEqual(JSON.parse(row("l-price").body), { question: "keep them?", options: ["Keep", "Match"], recommended: "Keep" });
  assert.equal(row("l-price").eta_at, 4000000000000, "#C823: the old ETA is kept as the Decision's not-before (it was dropped before)");
  assert.deepEqual(JSON.parse(row("l-steps").body), { text: "first look", steps: ["open it", "note it"], expect: "a few pages", where: "around 2026-10-22" });
  const db = makeDb();
  // What the store holds from the first import: the same asks as it kept them then (text only, the options one a Later).
  const was = { "l-steps": { text: "first look" }, "a-where": { steps: ["s"], expect: "e" }, "l-price": { text: "keep them?" }, "l-plain": { text: "plain" } };
  for (const r of a.asks) {
    const old = { ...r, type: r.id === "l-price" ? "Later" : r.type, body: JSON.stringify(was[r.id]), eta_at: r.id === "l-price" ? 4_000_000_000_000 : r.eta_at };
    await db.prepare(`INSERT INTO asks (${Object.keys(old).join(", ")}) VALUES (${Object.keys(old).map(() => "?").join(", ")})`).bind(...Object.values(old)).run();
  }
  const sql = deltaSql({ insert: [], history: [], setRepo: [], counterC: 745 }, a);
  const fixes = sql.split("\n").filter((l) => l.startsWith("UPDATE asks"));
  assert.equal(fixes.length, 4, "the plain Later needs none; the Decision has two lines (#C823: the conversion, and the date for one already converted)");
  for (const f of fixes) await db.prepare(f).run();
  const get = async (id) => (await db.prepare("SELECT type, body, eta_at FROM asks WHERE id = ?").bind(id).first());
  assert.deepEqual(JSON.parse((await get("l-steps")).body), { text: "first look", steps: ["open it", "note it"], expect: "a few pages", where: "around 2026-10-22" });
  assert.deepEqual(JSON.parse((await get("a-where")).body), { steps: ["s"], expect: "e", where: "Laptop" });
  const price = await get("l-price");
  assert.equal(price.type, "Decision");
  assert.equal(price.eta_at, 4_000_000_000_000, "#C823: the Later's ETA is kept as the Decision's not-before (it was set to NULL before)");
  assert.deepEqual(JSON.parse(price.body).options, ["Keep", "Match"]);
  assert.deepEqual(JSON.parse((await get("l-plain")).body), { text: "plain" });
  // A second run changes nothing; an ask answered or closed since is left as it is.
  const before = JSON.stringify([await get("l-steps"), await get("a-where"), price]);
  for (const f of fixes) assert.equal((await db.prepare(f).run()).meta.changes, 0);
  assert.equal(JSON.stringify([await get("l-steps"), await get("a-where"), await get("l-price")]), before);
  await db.prepare("UPDATE asks SET body = '{\"text\":\"first look\"}', closed_at = 5 WHERE id = 'l-steps'").run();
  assert.equal((await db.prepare(fixes.find((f) => f.includes("'l-steps'"))).run()).meta.changes, 0);
});

test("#C748 (Checker F2, F3, remark 3): an ask answered since is not patched; a Decision made from a Later is not rewritten by a later run from an edited export; an item already answered on the old board is not converted", async () => {
  const { makeDb } = await import("./helpers/d1-sqlite.mjs");
  const mk = (extra = {}, opts = [{ key: "A", label: "Keep", recommended: true }, { key: "B", label: "Match" }]) => planAsks(docsOf({ waiting: {
    "l-steps": { kind: "later", text: "first look", eta: 4_000_000_000_000, steps: ["open it"], expect: "pages", where: "Laptop" },
    "l-price": { kind: "later", text: "keep them?", eta: 4_000_000_000_000, options: opts, ...extra },
  } }), { owner: "Owner", roster: ROSTER, lead: "Manager", storeAsks: [] });
  const fixOf = (a, id) => deltaSql({ insert: [], history: [], setRepo: [], counterC: 745 }, a).split("\n").find((l) => l.startsWith("UPDATE asks") && l.includes(`'${id}'`));
  const a = mk();
  const db = makeDb();
  for (const r of a.asks) {
    const old = { ...r, type: "Later", body: JSON.stringify({ text: r.id === "l-steps" ? "first look" : "keep them?" }), eta_at: 4_000_000_000_000 };
    await db.prepare(`INSERT INTO asks (${Object.keys(old).join(", ")}) VALUES (${Object.keys(old).map(() => "?").join(", ")})`).bind(...Object.values(old)).run();
  }
  // F2: the owner answered l-steps since: its fix changes nothing.
  await db.prepare("UPDATE asks SET answered_at = 5, answer = 'done' WHERE id = 'l-steps'").run();
  assert.equal((await db.prepare(fixOf(a, "l-steps")).run()).meta.changes, 0);
  assert.deepEqual(JSON.parse((await db.prepare("SELECT body FROM asks WHERE id = 'l-steps'").first()).body), { text: "first look" });
  // F3: the price Later becomes a Decision once; a run from an export with other options then changes nothing.
  assert.equal((await db.prepare(fixOf(a, "l-price")).run()).meta.changes, 1);
  const again = mk({}, [{ key: "A", label: "Other", recommended: true }, { key: "B", label: "Another" }]);
  assert.equal((await db.prepare(fixOf(again, "l-price")).run()).meta.changes, 0);
  assert.deepEqual(JSON.parse((await db.prepare("SELECT body FROM asks WHERE id = 'l-price'").first()).body).options, ["Keep", "Match"]);
  // Remark 3: an item the owner answered on the old board is not converted at all (no fix line).
  const answered = mk({ response: { choice: "A", at: 9_000 } });
  assert.equal(fixOf(answered, "l-price"), undefined);
});

test("#C748: --clear-check lifts the check date of the named finished cards only, by a guarded UPDATE; a bad id throws", async () => {
  const { clearCheckSql } = await import("../collector/import-delta.mjs");
  const { makeDb } = await import("./helpers/d1-sqlite.mjs");
  const { createCard } = await import("../worker/board-store.mjs");
  const db = makeDb();
  const T = 1_800_000_000_000;
  await createCard(db, T, "Manager", { id: "c719-done", title: "A", check_at: T + 1000 });
  await createCard(db, T, "Manager", { id: "c800-open", title: "B", check_at: T + 1000 });
  const sql = deltaSql({ insert: [], history: [], setRepo: [], counterC: 745 }, null, clearCheckSql("c719-done"));
  for (const l of sql.split("\n").filter((x) => x.startsWith("UPDATE cards SET check_at"))) await db.prepare(l).run();
  const at = async (id) => (await db.prepare("SELECT check_at FROM cards WHERE id = ?").bind(id).first()).check_at;
  assert.equal(await at("c719-done"), null);
  assert.equal(await at("c800-open"), T + 1000);
  assert.equal(clearCheckSql(""), "");
  assert.throws(() => clearCheckSql("ok-id,Bad Id'; DROP"), /not a card id/);
});

test("asks: a thread number outside 1 to 1e6 is dropped and the ask gets the next number above the counters; a control character refuses the item (Security's rules)", () => {
  const d = docsOf({ threads: { "t-a": { num: 1e300 }, "t-b": { num: 901 } } });
  d.messages.m1.text = "a\u0000b";
  const a = planAsks(d, { owner: "Owner", roster: ROSTER, lead: "Manager" });
  assert.deepEqual(a.droppedThreadNums, ["t-a"]);
  assert.ok(a.asks.every((r) => Number.isInteger(r.num) && r.num < 1e6));
  assert.deepEqual(a.refused.filter((r) => r.rule === "control-char").map((r) => [r.kind, r.id]), [["message", "m1"]]);
  assert.ok(!a.messages.some((m) => m.id === "m1"));
  const e = planAsks(docsOf({ waiting: { "w-nul": { kind: "later", text: "a\u0000b", eta: 4_000_000_000_000 } } }), { owner: "Owner", roster: ROSTER, lead: "Manager" });
  assert.deepEqual(e.refused.map((r) => [r.kind, r.id, r.rule]), [["ask", "w-nul", "control-char"]]);
});

test("asks the store holds that the old board closed since are listed whether the item is done or its thread is resolved (Checker F1), and one the store already closed is not (F3)", () => {
  const storeAsks = [{ id: "w-open", closed_at: null }, { id: "w-res", closed_at: null }, { id: "w-done", closed_at: null }, { id: "w-gone", closed_at: null }];
  const a = planAsks(docsOf({ messages: { m2: { thread: "t-res", from: "Owner", text: "done", at: 6000, resolved: true }, m9: { thread: "t-a", from: "Owner", text: "closed", at: 9000, resolved: true } } }), { owner: "Owner", roster: ROSTER, lead: "Manager", storeAsks });
  assert.deepEqual(a.stillOpenInStoreButClosedOld.sort(), ["w-done", "w-open", "w-res"]);
  assert.deepEqual(a.notOnOldBoard, ["w-gone"]);
  const b = planAsks(docsOf(), { owner: "Owner", roster: ROSTER, lead: "Manager", storeAsks: [{ id: "w-done", closed_at: 5 }, { id: "w-res", closed_at: 6 }] });
  assert.deepEqual(b.stillOpenInStoreButClosedOld, []);
});

test("asks: an ask id, a message id and a message's thread id pass the card-id rule, else the item is refused (Checker F2)", () => {
  const d = docsOf({ waiting: { "W Bad/../id": { kind: "action", thread: "t-b", steps: ["s"], expect: "e" }, "w-ok": { kind: "action", thread: "t-b", steps: ["s"], expect: "e" } }, messages: { "M 1/x": { thread: "t-b", from: "Manager", text: "x", at: 100 }, m5: { thread: "T B/../x", from: "Manager", text: "x", at: 200 }, m6: { thread: "t-b", from: "Manager", text: "y", at: 300 } }, threads: { "t-b": { num: 901, title: "B" }, "T B/../x": { num: 950, title: "X" } } });
  const a = planAsks(d, { owner: "Owner", roster: ROSTER, lead: "Manager" });
  assert.deepEqual(a.asks.map((r) => r.id), ["w-ok"]);
  assert.deepEqual(a.refused.map((r) => [r.kind, r.id, r.rule]).sort(), [["ask", "W Bad/../id", "ask-id"], ["message", "M 1/x", "message-id"]]);
  assert.deepEqual(a.messages.map((m) => m.id), ["m6"]);
});

test("asks: a kept thread whose own id fails the card-id rule refuses its messages as message-id (Checker F4)", () => {
  const d = docsOf({ waiting: { "w-ok": { kind: "action", thread: "T B/../x", steps: ["s"], expect: "e" } }, messages: { m5: { thread: "T B/../x", from: "Manager", text: "x", at: 200 } }, threads: { "T B/../x": { num: 950, title: "X" } } });
  const a = planAsks(d, { owner: "Owner", roster: ROSTER, lead: "Manager" });
  assert.deepEqual(a.asks.map((r) => r.id), ["w-ok"]);
  assert.deepEqual(a.messages, []);
  assert.deepEqual(a.refused.map((r) => [r.kind, r.id, r.rule]), [["message", "m5", "message-id"]]);
});

test("an item deleted on the old board ({ deleted: true, updatedAt }) is gone: not an ask, a thread, a message or a card, and not counted open (Manager)", () => {
  const d = docsOf();
  d.waiting["w-del"] = { deleted: true, updatedAt: 9000 };
  d.threads["t-del"] = { deleted: true, updatedAt: 9000 };
  d.messages["m-del"] = { deleted: true, updatedAt: 9000 };
  d.waiting["w-new"] = { ...d.waiting["w-new"], deleted: true };
  const a = planAsks(d, { owner: "Owner", roster: ROSTER, lead: "Manager", storeAsks: [{ id: "w-del", closed_at: null }] });
  assert.deepEqual(a.asks.map((r) => r.id), ["w-open"]);
  assert.ok(!a.messages.some((m) => m.id === "m-del"));
  assert.deepEqual([a.counts.needs, a.counts.later, a.counts.lead], [0, 1, 0]);
  assert.deepEqual(a.refused.map((r) => r.id), ["w-bad"]);
  assert.deepEqual(a.notOnOldBoard, ["w-del"]);
  const p = planDelta({ "c750-gone": { deleted: true, updatedAt: 9000 }, "c751-here": card(751) }, {});
  assert.deepEqual(p.insert.map((r) => r.id), ["c751-here"]);
  assert.equal(p.skipped.deleted, 1);
  assert.deepEqual(p.refused, []);
});

test("a deleted thread or message keeps its fields on the old board but counts for nothing: no #T from it, no message from it, no closing by it (Checker F5)", () => {
  const d = docsOf();
  d.threads["t-del"] = { num: 800, title: "D", deleted: true, updatedAt: 9000 };
  d.waiting["w-dt"] = { kind: "action", thread: "t-del", title: "Own title", steps: ["s"], expect: "e" };
  d.messages["m-del"] = { thread: "t-a", from: "Manager", text: "zzz", at: 8000, deleted: true, updatedAt: 9000 };
  d.messages["m-del-res"] = { thread: "t-a", from: "Owner", text: "closed", at: 9500, resolved: true, deleted: true, updatedAt: 9600 };
  const a = planAsks(d, { owner: "Owner", roster: ROSTER, lead: "Manager", storeAsks: [{ id: "w-open", closed_at: null }] });
  assert.ok(a.asks.some((r) => r.id === "w-open"), "an ask whose only resolving message is deleted stays open and is imported");
  assert.deepEqual(a.messages.map((m) => m.id).sort(), ["m1", "m3"]);
  assert.notEqual(a.asks.find((r) => r.id === "w-dt").num, 800);
  assert.equal(a.asks.find((r) => r.id === "w-dt").num, 903);
  assert.deepEqual(a.stillOpenInStoreButClosedOld, []);
  assert.equal(a.counterT, 904);
});

test("appended lines: only a single guarded UPDATE of ships or cards is taken, after everything else; anything else throws", () => {
  const p = { insert: [], history: [], setRepo: [], counterC: 745 };
  const line = "UPDATE ships SET shipped_at = 1794260477000 WHERE version = '1.209.1' AND shipped_at > 1794260477000;";
  const sql = deltaSql(p, null, `${line}\nUPDATE cards SET repo = 'flight-board' WHERE id = 'c743-deploy-pc13' AND repo IS NULL;\n`);
  assert.equal(sql.split("\n").at(-2), line);
  assert.match(sql.split("\n").at(-1), /^UPDATE cards SET repo/);
  for (const bad of ["UPDATE cards SET owner_role = 'x';", "UPDATE ships SET shipped_at = 1 WHERE ;", "DELETE FROM cards;", "UPDATE counters SET next = 1;", "UPDATE ships SET a = 1; DELETE FROM ships;", "UPDATE ships SET a = 'x\u0000';"]) assert.throws(() => deltaSql(p, null, bad), /appended line|control character/);
});
