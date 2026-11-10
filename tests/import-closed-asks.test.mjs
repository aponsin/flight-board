// #C824: the asks closed in the window come in as closed asks (so Resolved reads what the old page does), the old images become the
// store's screenshot names (#T1701 read "[object Object]"), and the dry run compares the tab counts with the old page. Real migrations.
import test from "node:test";
import assert from "node:assert/strict";
import { planHistory, historySql } from "../collector/import-history.mjs";
import { shotsOf, askRow } from "../collector/import-mirror.mjs";
import { shotsFixSql, deltaSql } from "../collector/import-delta.mjs";
import { compareTabs, oldResolved } from "../collector/import-compare.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";

const NOW = 1_794_336_590_090, DAY = 86_400_000;
const have = (extra = {}) => ({ usageDays: new Set(), shipVersions: new Set(), historyCardIds: new Set(), cardIds: new Set(), messageIds: new Set(), threadIds: new Set(), cardsByNum: new Map(), askIds: new Set(), askNums: new Set(), ...extra });
const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`);
const run = async (db, h) => { let changes = 0; for (const l of historySql(h, q)) changes += (await db.prepare(l).run()).meta.changes; return changes; };
const plan = (docs, extra = {}) => planHistory(docs, { now: NOW, days: 30, roster: ["Manager", "Builder"], lead: "Manager", owner: "Owner", have: have(), ...extra });

const docs = () => ({
  waiting: {
    "ans-one": { done: true, kind: "answer", question: "Why?", text: "Because.", response: { at: NOW - 2 * DAY, note: "ok", status: "ack" }, since: NOW - 3 * DAY, doneAt: NOW - 2 * DAY, who: "Builder" },
    "dec-noopts": { done: true, kind: "decision", question: "Which one?", text: "Pick.", response: { at: NOW - DAY, choice: "a" }, since: NOW - 2 * DAY },
    "later-noeta": { done: true, kind: "later", text: "Do it sometime.", since: NOW - 4 * DAY, doneAt: NOW - 3 * DAY },
    "act-noexpect": { done: true, kind: "action", text: "Run it.", steps: ["one"], since: NOW - 4 * DAY, doneAt: NOW - 3 * DAY },
    "old-one": { done: true, kind: "answer", text: "ancient", since: NOW - 90 * DAY, doneAt: NOW - 89 * DAY },
    "no-thread": { done: true, kind: "answer", text: "x", since: NOW - DAY, doneAt: NOW - DAY },
    "still-open": { kind: "answer", text: "open", since: NOW - DAY },
    "gone": { deleted: true, done: true },
    "held-one": { done: true, kind: "answer", text: "held", since: NOW - DAY, doneAt: NOW - DAY },
    "same-num": { done: true, kind: "answer", text: "num clash", since: NOW - DAY, doneAt: NOW - DAY },
  },
  threads: { "ans-one": { num: 800, title: "One" }, "dec-noopts": { num: 801, title: "Dec" }, "later-noeta": { num: 802, title: "Later" }, "act-noexpect": { num: 803, title: "Act" }, "old-one": { num: 804 }, "held-one": { num: 805 }, "same-num": { num: 806 } },
  messages: {
    m1: { thread: "ans-one", from: "Manager", text: "the answer", at: NOW - 3 * DAY },
    m2: { thread: "ans-one", from: "Owner", text: "thanks", at: NOW - 2 * DAY }, // last word NOT flagged resolved: the closed ask resolves it
    m3: { thread: "dec-noopts", from: "Manager", text: "which", at: NOW - 2 * DAY },
  },
});

test("a closed ask in the window comes in closed (closed_at its time, closed_by import) with its answer, and its thread comes whatever its last message says", () => {
  const h = plan(docs());
  const a = h.asks.find((r) => r.id === "ans-one");
  assert.equal(a.closed_at, NOW - 2 * DAY);
  assert.equal(a.closed_by, "import");
  assert.equal(a.num, 800, "the old #T number");
  assert.equal(a.type, "Answer");
  assert.equal(a.asked_by, "Builder", "the item's who when it names a roster agent");
  assert.equal(a.answered_at, NOW - 2 * DAY);
  assert.match(a.answer, /ack/);
  assert.deepEqual(h.messages.filter((m) => m.thread_id === "ans-one").map((m) => m.id).sort(), ["m1", "m2"]);
  assert.equal(h.threads.length, 0, "a closed ask carries its #T itself: no thread row");
  assert.equal(h.report.closedAsks.withAnswer >= 2, true);
});

test("asks the store's open-ask rules would refuse still come in closed (a Decision with no options, a Later with no ETA, an Action with no expect)", () => {
  const h = plan(docs());
  assert.equal(h.report.closedAsks.refused, 0);
  const ids = h.asks.map((r) => r.id).sort();
  assert.ok(["act-noexpect", "dec-noopts", "later-noeta"].every((i) => ids.includes(i)));
  assert.equal(h.asks.find((r) => r.id === "later-noeta").eta_at, NOW - 3 * DAY, "a Later with no ETA is given its closing time (the table needs one)");
});

test("outside the window, deleted, still open, already in the store, with no thread or a number the store uses: counted, not written", () => {
  const h = plan(docs(), { have: have({ askIds: new Set(["held-one"]), askNums: new Set([806]) }) });
  const ids = h.asks.map((r) => r.id);
  for (const id of ["old-one", "gone", "still-open", "held-one", "no-thread", "same-num"]) assert.equal(ids.includes(id), false, id);
  const r = h.report.closedAsks;
  assert.deepEqual([r.outsideWindow, r.held, r.noThread, r.numTaken], [1, 1, 1, 1]);
});

test("the SQL closes the ask in the store, keeps the answer, and a second run changes nothing", async () => {
  const db = makeDb();
  const h = plan(docs());
  const first = await run(db, h);
  assert.ok(first > 0);
  const row = await db.prepare("SELECT closed_at, closed_by, answered_at, answered_by, num FROM asks WHERE id = 'ans-one'").first();
  assert.deepEqual(row, { closed_at: NOW - 2 * DAY, closed_by: "import", answered_at: NOW - 2 * DAY, answered_by: "owner", num: 800 });
  assert.equal(await run(db, h), 0, "INSERT OR IGNORE by id: nothing changes");
  const open = await db.prepare("SELECT COUNT(*) AS n FROM asks WHERE closed_at IS NULL").first();
  assert.equal(open.n, 0, "no closed ask lands open");
});

test("shotsOf: an old image object becomes the store's screenshot name; a string of that shape stays; anything else is dropped, never [object Object]", () => {
  const id = "4961499e18cc5c9ef0be12beb542884b";
  assert.deepEqual(shotsOf([{ label: "New board, laptop", option: "A", url: `/_blob/${id}` }, { url: `/_blob/${id}`, option: "B" }, { label: "no option", url: `/_blob/${id}` }]), [`${id} A: New board, laptop`, id, `${id} no option`]);
  assert.deepEqual(shotsOf([`${id} A: kept`, "[object Object]", "short", { url: "https://elsewhere.test/x.png" }, null, 7]), [`${id} A: kept`]);
  assert.deepEqual(shotsOf(undefined), []);
  assert.equal(shotsOf(Array.from({ length: 12 }, () => id)).length, 8, "at most 8, the store's cap");
  const r = askRow("x-ask", { kind: "answer", question: "q", text: "t", images: [{ label: "L", option: "A", url: `/_blob/${id}` }], since: 1 }, { thread: { num: 5 }, askedBy: "Manager" });
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(r.row.body).screenshots, [`${id} A: L`]);
});

test("shotsFixSql repairs only a body that still holds [object Object], and a second run changes nothing", async () => {
  const id = "4961499e18cc5c9ef0be12beb542884b";
  const db = makeDb();
  const bad = JSON.stringify({ question: "q", screenshots: ["[object Object]", "[object Object]"] });
  await db.prepare("INSERT INTO asks (id, num, type, title, asked_by, body, created_at) VALUES ('t1701', 1701, 'Answer', 't', 'Manager', ?, 1)").bind(bad).run();
  await db.prepare("INSERT INTO asks (id, num, type, title, asked_by, body, created_at) VALUES ('fine', 1702, 'Answer', 't', 'Manager', ?, 1)").bind(JSON.stringify({ question: "q", screenshots: [id] })).run();
  const mk = (aid) => ({ id: aid, body: JSON.stringify({ question: "q", screenshots: [`${id} A: L`, `${id} B: M`] }) });
  assert.equal((await db.prepare(shotsFixSql(mk("t1701"))).run()).meta.changes, 1);
  assert.equal((await db.prepare(shotsFixSql(mk("t1701"))).run()).meta.changes, 0);
  assert.equal((await db.prepare(shotsFixSql(mk("fine"))).run()).meta.changes, 0, "a good ask is not touched");
  const b = JSON.parse((await db.prepare("SELECT body FROM asks WHERE id = 't1701'").first()).body);
  assert.deepEqual(b, { question: "q", screenshots: [`${id} A: L`, `${id} B: M`] });
  assert.equal(shotsFixSql({ id: "z", body: JSON.stringify({ screenshots: ["[object Object]"] }) }), null, "nothing to fix with is nothing written");
  assert.equal(shotsFixSql({ id: "z", body: JSON.stringify({}) }), null);
});

// The comparison with the old page.
const view = (extra = {}) => ({ cards: [{ id: "c1" }, { id: "c2" }], asks: [], threads: { messages: [], threads: [] }, ...extra });
const tabDocs = () => ({
  waiting: { "a-closed": { done: true, kind: "answer", text: "x", doneAt: NOW - DAY }, "a-held": { done: true, kind: "answer", text: "y", doneAt: NOW - DAY } },
  messages: { m1: { thread: "a-closed", from: "Manager", text: "hi", at: NOW - DAY }, m2: { thread: "a-held", from: "Manager", text: "hi", at: NOW - DAY }, m3: { thread: "t-1", from: "Owner", text: "bye", at: NOW - DAY, resolved: true } },
  threads: {}, initiatives: { c1: { status: "active" }, c2: { status: "active" }, c3: { status: "active" }, done1: { status: "done" } },
});

test("the old page's resolved rule: a thread whose last message is resolved, or whose item is done, within 7 days", () => {
  const r = oldResolved(tabDocs(), NOW);
  assert.deepEqual([...r.keys()].sort(), ["a-closed", "a-held", "t-1"]);
  const old = tabDocs(); old.messages.m3.at = NOW - 9 * DAY;
  assert.equal(oldResolved(old, NOW).has("t-1"), false, "older than 7 days");
});

test("compareTabs: counts against the expected ones, and a reason for each difference (a closed ask the store holds open, a card below #C719)", () => {
  const h = { messages: [{ thread_id: "a-closed", created_at: NOW - DAY, resolved: 0 }, { thread_id: "t-1", created_at: NOW - DAY, resolved: 1 }], asks: [{ id: "a-closed", closed_at: NOW - DAY }], askOutcome: { "a-held": "numTaken" }, report: { closedAsks: { refusedBy: {} } } };
  const t = compareTabs({ docs: tabDocs(), view: view({ asks: [{ id: "a-held", closed_at: null }] }), p: { insert: [] }, a: { counts: { needs: 1, later: 4, lead: 2, todo: 0, ideas: 3 } }, h, now: NOW, expect: { needs: 1, later: 4, lead: 1, resolved: 3, inflight: 3 } });
  assert.deepEqual([t.needs.difference, t.later.difference, t.lead.difference], [undefined, undefined, 1], "only the tab that differs says so");
  assert.equal(t.todo.note.startsWith("unchecked"), true);
  assert.equal(t.resolved.oldPage, 3);
  assert.equal(t.resolved.ours, 2);
  assert.equal(t.resolved.difference, -1);
  assert.equal(t.resolved.inOldNotAfter.length, 1);
  assert.match(t.resolved.inOldNotAfter[0].reason, /numTaken/, "the reason is what became of that ask");
  assert.deepEqual(t.resolved.inOldNotAfter[0].sample, ["a-held"]);
  assert.equal(t.resolved.unexplained, 0, "the page's number minus ours is fully accounted for");
  assert.equal(t.inflight.ours, 2);
  assert.equal(t.inflight.oldPage, 3);
  assert.equal(t.inflight.difference, -1);
  assert.deepEqual(t.inflight.inOldNotInStore.sample, ["c3"]);
  assert.match(t.inflight.inOldNotInStore.reason, /719/);
});

// ---- #C824 v2: the Checker's findings G1-G10 and remarks (c), (e), (f); the guarded close of an ask the store holds open ----
const w = (id, extra = {}, thread = id) => ({ [id]: { done: true, kind: "answer", text: `t-${id}`, ...extra } });
const th = (id, num, extra = {}) => ({ [id]: { num, ...extra } });

test("G1 the close time: doneAt, else response.at, else respondedAt, else updatedAt, else none (outside the window)", () => {
  const D = NOW - 2 * DAY;
  const waiting = { ...w("r-done", { doneAt: D, response: { at: NOW - 5 * DAY } }), ...w("r-resp", { response: { at: D - 1000 } }), ...w("r-responded", { respondedAt: D - 2000 }), ...w("r-updated", { updatedAt: D - 3000 }), ...w("r-none", {}) };
  const threads = { ...th("r-done", 910), ...th("r-resp", 911), ...th("r-responded", 912), ...th("r-updated", 913), ...th("r-none", 914) };
  const h = plan({ waiting, threads, messages: {} });
  const at = Object.fromEntries(h.asks.map((a) => [a.id, a.closed_at]));
  assert.deepEqual(at, { "r-done": D, "r-resp": D - 1000, "r-responded": D - 2000, "r-updated": D - 3000 });
  assert.equal(h.askOutcome["r-none"], "outsideWindow");
});

test("G2 two closed asks on one thread take one #T number: the second is counted numTaken, not silently dropped", () => {
  const h = plan({ waiting: { ...w("a1", { thread: "shared", doneAt: NOW - DAY }), ...w("a2", { thread: "shared", doneAt: NOW - DAY }) }, threads: th("shared", 920), messages: {} });
  assert.deepEqual(h.asks.map((a) => a.id), ["a1"]);
  assert.equal(h.report.closedAsks.numTaken, 1);
  assert.equal(h.askOutcome.a2, "numTaken");
});

test("(e) a #T number a free thread of the store already uses is taken", () => {
  const h = plan({ waiting: w("e1", { doneAt: NOW - DAY }), threads: th("e1", 930), messages: {} }, { have: have({ threadNums: new Set([930]) }) });
  assert.equal(h.asks.length, 0);
  assert.equal(h.askOutcome.e1, "numTaken");
});

test("G3 an ask id the store's card-id rule refuses is refused, G4 a thread id with odd characters is not brought, G5 the #T number is 1 to 1e6", () => {
  const h = plan({
    waiting: { ...w("Bad_ID", { thread: "ok-thread", doneAt: NOW - DAY }), ...w("g4", { thread: "bad thread!", doneAt: NOW - DAY }), ...w("g5-zero", { doneAt: NOW - DAY }), ...w("g5-big", { doneAt: NOW - DAY }), ...w("g5-max", { doneAt: NOW - DAY }) },
    threads: { "ok-thread": { num: 940 }, "bad thread!": { num: 941 }, "g5-zero": { num: 0 }, "g5-big": { num: 1_000_001 }, "g5-max": { num: 1_000_000 } }, messages: {},
  });
  assert.equal(h.askOutcome["Bad_ID"], "refused:ask-id");
  assert.equal(h.askOutcome.g4, "noThread");
  assert.equal(h.askOutcome["g5-zero"], "noThread");
  assert.equal(h.askOutcome["g5-big"], "noThread");
  assert.equal(h.askOutcome["g5-max"], "new");
  assert.deepEqual(h.asks.map((a) => a.id), ["g5-max"]);
});

test("G6 a control character in the title or in the answer refuses the ask", () => {
  const h = plan({
    waiting: {
      ...w("c-title", { title: "bad\u0001title", doneAt: NOW - DAY }),
      c1: { done: true, kind: "decision", question: "which", text: "x", options: [{ key: "a", label: "bad\u0002label" }, { key: "b", label: "fine" }], response: { at: NOW - DAY, choice: "a" }, doneAt: NOW - DAY },
    },
    threads: { ...th("c-title", 950), c1: { num: 951 } }, messages: {},
  });
  assert.equal(h.askOutcome["c-title"], "refused:control-char");
  assert.equal(h.askOutcome.c1, "refused:control-char");
  assert.equal(h.asks.length, 0);
});

test("G7 the asker: the item's who only when it names a roster agent other than the owner; the old item's `from` never wins", () => {
  const h = plan({
    waiting: { ...w("w-owner", { who: "Owner", doneAt: NOW - DAY }), ...w("w-stranger", { who: "Stranger", doneAt: NOW - DAY }), ...w("w-builder", { who: "Builder", doneAt: NOW - DAY }), ...w("w-from", { from: "Intruder", doneAt: NOW - DAY }) },
    threads: { ...th("w-owner", 960), ...th("w-stranger", 961), ...th("w-builder", 962), ...th("w-from", 963) }, messages: {},
  }, { roster: ["Manager", "Builder", "Owner"] }); // the owner is on the roster here: only the owner rule keeps him from being the asker
  const by = Object.fromEntries(h.asks.map((a) => [a.id, a.asked_by]));
  assert.deepEqual(by, { "w-owner": "Manager", "w-stranger": "Manager", "w-builder": "Builder", "w-from": "Manager" });
});

test("G8 a closed ask with no title anywhere is refused (the table needs one), not silently dropped by INSERT OR IGNORE", () => {
  const h = plan({ waiting: { t0: { done: true, kind: "answer", doneAt: NOW - DAY } }, threads: th("t0", 970), messages: {} });
  assert.equal(h.askOutcome.t0, "refused:ask-title");
  assert.equal(h.report.closedAsks.refused, 1);
  assert.equal(h.asks.length, 0);
});

test("G9 shotsOf: an odd url, a label with a newline, a long label and an option outside A-D", () => {
  const id = "4961499e18cc5c9ef0be12beb542884b";
  assert.deepEqual(shotsOf([{ url: `/_blob/${id}?x=1` }, { url: `/_blob/${id}/extra` }, { url: `/x/_blob/${id}` }, { url: "/_blob/short" }]), []);
  assert.deepEqual(shotsOf([{ url: `/_blob/${id}`, label: "line one\nline two\u0007" }]), [`${id} line one line two`]);
  assert.equal(shotsOf([{ url: `/_blob/${id}`, label: "x".repeat(500) }])[0], `${id} ${"x".repeat(200)}`);
  assert.deepEqual(shotsOf([{ url: `/_blob/${id}`, option: "Z", label: "L" }, { url: `/_blob/${id}`, option: "AB", label: "M" }]), [`${id} L`, `${id} M`]);
});

test("G10 deltaSql carries #T1701's screenshot repair end to end", () => {
  const id = "4961499e18cc5c9ef0be12beb542884b";
  const row = { id: "t1701", num: 1701, type: "Answer", title: "t", asked_by: "Manager", card_id: null, body: JSON.stringify({ question: "q", screenshots: [`${id} A: L`] }), eta_at: null, eta_precondition: null, created_at: 1, answered_at: null, answer: null, answered_by: null, answer_taken_at: null, closed_at: null };
  const sql = deltaSql({ insert: [], history: [], setRepo: [], counterC: 1 }, { asks: [row], messages: [], counterT: 5 });
  assert.ok(sql.split("\n").some((l) => l.startsWith("UPDATE asks SET body = json_patch(body,") && l.includes("[object Object]") && l.includes("'t1701'")));
});

test("(c) each missing closed ask is explained by what became of it, not by any refusal in the run", () => {
  const D = { waiting: { ...w("m-taken", { doneAt: NOW - DAY }), ...w("m-refused", { doneAt: NOW - DAY }), ...w("m-old", { doneAt: NOW - 40 * DAY, updatedAt: NOW - DAY }) }, messages: { x1: { thread: "m-taken", from: "M", text: "t", at: NOW - DAY }, x2: { thread: "m-refused", from: "M", text: "t", at: NOW - DAY } }, threads: {}, initiatives: {} };
  const h = { messages: [], asks: [], askOutcome: { "m-taken": "numTaken", "m-refused": "refused:ask-title" }, report: { closedAsks: { refusedBy: { "ask-title": 1 } } } };
  const t = compareTabs({ docs: D, view: view(), p: { insert: [] }, a: { counts: {} }, h, now: NOW, expect: {} });
  const why = Object.fromEntries(t.resolved.inOldNotAfter.map((g) => [g.sample[0], g.reason]));
  assert.match(why["m-taken"], /already uses/);
  assert.doesNotMatch(why["m-taken"], /refuse/);
  assert.match(why["m-refused"], /ask rules refuse \(ask-title/);
});

test("(f) an ask whose thread has another id counts once, not once missing and once extra", () => {
  const D = { waiting: w("ask-x", { thread: "thr-y", doneAt: NOW - DAY }), threads: th("thr-y", 980), messages: { z1: { thread: "thr-y", from: "Manager", text: "hi", at: NOW - DAY } }, initiatives: {} };
  const h = plan(D);
  const t = compareTabs({ docs: D, view: view(), p: { insert: [] }, a: { counts: {} }, h, now: NOW, expect: { resolved: 1 } });
  assert.equal(t.resolved.ours, 1);
  assert.equal(t.resolved.oldPageByRule, 1);
  assert.deepEqual(t.resolved.inOldNotAfter, []);
  assert.equal(t.resolved.afterNotInOld, undefined);
  assert.equal(t.resolved.unexplained, 0);
});

test("an ask the store holds OPEN that the old board closed is closed by a guarded UPDATE; the store's own answer is kept; a second run changes nothing", async () => {
  const db = makeDb();
  const ins = (id, num, extra = "") => db.prepare(`INSERT INTO asks (id, num, type, title, asked_by, body, created_at${extra ? ", answered_at, answer" : ""}) VALUES ('${id}', ${num}, 'Answer', 't', 'Manager', '{}', 1${extra})`).run();
  await ins("open-new", 990); await ins("open-answered", 991, ", 5, 'mine'"); await ins("already-closed", 992);
  await db.prepare("UPDATE asks SET closed_at = 7, closed_by = 'owner' WHERE id = 'already-closed'").run();
  const D = {
    waiting: { ...w("open-new", { doneAt: NOW - DAY, response: { at: NOW - DAY, note: "ok", status: "ack" } }), ...w("open-answered", { doneAt: NOW - DAY, response: { at: NOW - DAY, note: "old" } }), ...w("already-closed", { doneAt: NOW - DAY }) },
    threads: { ...th("open-new", 990), ...th("open-answered", 991), ...th("already-closed", 992) }, messages: {},
  };
  const h = plan(D, { have: have({ askIds: new Set(["open-new", "open-answered", "already-closed"]), openAskIds: new Set(["open-new", "open-answered"]) }) });
  assert.deepEqual(h.closeOpen.map((c) => c.id).sort(), ["open-answered", "open-new"]);
  assert.equal(h.askOutcome["already-closed"], "held");
  assert.equal(h.asks.length, 0);
  assert.equal(h.report.closedAsks.closedOpen, 2);
  assert.ok(await run(db, h) >= 2);
  const row = (id) => db.prepare(`SELECT closed_at, closed_by, answered_at, answer, answered_by, answer_taken_at FROM asks WHERE id = '${id}'`).first();
  const n = await row("open-new"), a = await row("open-answered"), c = await row("already-closed");
  assert.equal(n.closed_at, NOW - DAY); assert.equal(n.closed_by, "import"); assert.equal(n.answered_at, NOW - DAY); assert.match(n.answer, /ack/); assert.equal(n.answered_by, "owner"); assert.equal(n.answer_taken_at, NOW - DAY);
  assert.equal(a.closed_at, NOW - DAY); assert.equal(a.answered_at, 5, "the store's own answer time is kept"); assert.equal(a.answer, "mine", "the store's own answer is kept");
  assert.deepEqual(c, { closed_at: 7, closed_by: "owner", answered_at: null, answer: null, answered_by: null, answer_taken_at: null }, "an ask the store closed is not touched");
  assert.equal(await run(db, h), 0, "a second run changes nothing");
});

test("an ask closed by the import counts in Resolved (by its thread id), so the comparison does not blame it", () => {
  const D = { waiting: w("open-one", { thread: "open-thr", doneAt: NOW - DAY }), threads: th("open-thr", 995), messages: { y: { thread: "open-thr", from: "Manager", text: "hi", at: NOW - DAY } }, initiatives: {} };
  const h = plan(D, { have: have({ askIds: new Set(["open-one"]), openAskIds: new Set(["open-one"]) }) });
  const t = compareTabs({ docs: D, view: view({ asks: [{ id: "open-one", closed_at: null }] }), p: { insert: [] }, a: { counts: {} }, h, now: NOW, expect: { resolved: 1 } });
  assert.equal(t.resolved.ours, 1);
  assert.deepEqual(t.resolved.inOldNotAfter, []);
});
