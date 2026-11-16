// #C1106 part B, Checker 2's M1 on f852543d: seven push settings were wired but no test moved them off the default, so each of these mutants survived the full suite:
// ownerWordWindowSec (the store's owner-word query window), promptSec in Manager's line and in the night hold, silentPushSec, shipWindowSec, the phone text's minutes
// (ownerPushSec) and the owner-word reminder spacing (ownerWordRepeatSec, ownerWordSlowRepeatSec). Each test moves the setting to a NON-default value and keeps the default as
// the control, so a wiring that falls back to the default fails; the three that the store reads (B9, B13, B14) go through the store.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, postMessage, wakeAsk, takeInbox } from "../worker/board-store.mjs";
import { beat, wakeAsk as beatingWakeAsk, takeInbox as beatingTakeInbox } from "./helpers/beating-store.mjs";
import { pushesDue, ownerWordWakes, pushLimits } from "../worker/push-rules.mjs";

const MIN = 60e3, DAY = 864e5, T = 1_800_000_000_000;
const put = (db, key, value, at) => db.prepare("INSERT OR REPLACE INTO evidence (key, value, read_at) VALUES (?, ?, ?)").bind(key, JSON.stringify(value), at).run();
const knobs = (values) => ({ values, ignored: [] });

// B9: ownerWordWindowSec is the window of the query that reads the owner's last words, not only the rule's own age check.
test("through the store: a posted ownerWordWindowSec moves how old an owner's word the board still reads (both ways)", async () => {
  const run = async (values, ageDays) => {
    const db = makeDb();
    if (values) await put(db, "knobs", knobs(values), T);
    await createCard(db, T, "Manager", { id: "c1", title: "C", owner_role: "Boardsmith" });
    await postMessage(db, T + MIN, "owner", { thread_id: "c1", body: "please change the heading to something clearer" });
    const at = T + MIN + ageDays * DAY;
    await beat(db, at);
    await beatingWakeAsk(db, at);
    return (await beatingTakeInbox(db, at + 1000)).stalls.map((s) => s.reason).filter((r) => /ends on the owner's word/.test(r));
  };
  assert.equal((await run(undefined, 8)).length, 0, "default 7 days: an 8-day-old word is not read");
  assert.equal((await run({ ownerWordWindowSec: 864000 }, 8)).length, 1, "posted 10 days: read at 8");
  assert.equal((await run(undefined, 2)).length, 1, "default: read at 2 days");
  assert.equal((await run({ ownerWordWindowSec: 86400 }, 2)).length, 0, "posted 1 day: not read at 2");
});

// B13: promptSec reaches Manager's line (the words say the setting too).
const NOON = Date.UTC(2026, 10, 12, 19, 0);
const user = (since) => ({ Builder: { kind: "user", card: "a-card", since } });
const promptLines = (inbox) => inbox.stalls.filter((s) => /waited on a prompt/.test(s.reason ?? ""));
test("through the store: a posted promptSec moves how soon a role stopped on a prompt wakes Manager, in its words", async () => {
  const run = async (values) => {
    const db = makeDb();
    await put(db, "board", { boardId: "flight-board", at: NOON }, NOON);
    if (values) await put(db, "knobs", knobs(values), NOON);
    await put(db, "stuck", user(NOON - 12 * MIN), NOON);
    await wakeAsk(db, NOON);
    return promptLines(await takeInbox(db, NOON + MIN));
  };
  assert.equal((await run()).length, 0, "default 30 min: not at 12");
  const posted = await run({ promptSec: 600 });
  assert.equal(posted.length, 1, "posted 10 min: at 12");
  assert.match(posted[0].reason, /\(10\+ min\)/);
});

// B14: the night hold keeps back the row the DAY inserted with the posted words; a hold that read the default would call it over.
test("a prompt row made by day with a posted promptSec survives the night and is told once after 7 am", async () => {
  const AT_2150 = Date.UTC(2026, 10, 13, 4, 50), AT_2201 = Date.UTC(2026, 10, 13, 5, 1), AT_0700 = Date.UTC(2026, 10, 13, 14, 0);
  const since = AT_2150 - 90 * MIN, db = makeDb();
  await put(db, "board", { boardId: "flight-board", at: AT_2150 }, AT_2150);
  await put(db, "knobs", knobs({ promptSec: 600 }), AT_2150);
  await put(db, "stuck", user(since), AT_2150);
  await wakeAsk(db, AT_2150);
  await put(db, "stuck", user(since), AT_2201);
  await wakeAsk(db, AT_2201);
  await put(db, "stuck", user(since), AT_0700);
  await wakeAsk(db, AT_0700);
  const lines = promptLines(await takeInbox(db, AT_0700 + MIN));
  assert.equal(lines.length, 1, "still pending after the night, in the words the posted setting made");
  assert.match(lines[0].reason, /\(10\+ min\)/);
});

// B24, B25, B29: pushesDue.
const pushNow = T + 40 * DAY;
test("pushesDue: a posted silentPushSec moves when the phone is told the Mac may be down", () => {
  const last = pushNow - 6 * MIN, base = { asks: [], ships: [], sent: new Set(), now: pushNow, lastEvidenceAt: last };
  assert.equal(pushesDue(base).silent, null, "default 15 min: not at 6");
  assert.equal(pushesDue({ ...base, lim: pushLimits({ values: { silentPushSec: 300 } }) }).silent, last, "posted 5 min: at 6");
  assert.equal(pushesDue({ ...base, lastEvidenceAt: pushNow - 20 * MIN, lim: pushLimits({ values: { silentPushSec: 1800 } }) }).silent, null, "posted 30 min: not at 20");
  assert.equal(pushesDue({ ...base, lastEvidenceAt: pushNow - 20 * MIN }).silent, pushNow - 20 * MIN, "default: at 20");
});

test("pushesDue: a posted shipWindowSec moves how long an unacknowledged ship is still pushed (both ways)", () => {
  const ship = (days) => ({ version: "v1.2.3", shipped_at: pushNow - days * DAY, acked_at: null });
  const run = (days, values) => pushesDue({ asks: [], ships: [ship(days)], sent: new Set(), now: pushNow, lim: values ? pushLimits({ values }) : undefined }).ships.length;
  assert.equal(run(10), 0, "default 7 days: not at 10");
  assert.equal(run(10, { shipWindowSec: 1209600 }), 1, "posted 14 days: at 10");
  assert.equal(run(2), 1, "default: at 2 days");
  assert.equal(run(2, { shipWindowSec: 86400 }), 0, "posted 1 day: not at 2");
});

test("pushesDue: the phone's words say the posted ownerPushSec, not the default", () => {
  const asks = [{ id: "a1", num: 5, type: "Decision", created_at: pushNow - 20 * MIN, closed_at: null, answered_at: null, withdrawn_at: null }];
  const body = (values) => JSON.parse(pushesDue({ asks, ships: [], sent: new Set(), now: pushNow, lim: values ? pushLimits({ values }) : undefined }).payload).body;
  assert.equal(pushesDue({ asks, ships: [], sent: new Set(), now: pushNow }).payload, null, "default 30 min: not due at 20");
  assert.equal(body({ ownerPushSec: 900 }), "an ask has waited 15+ min (#T5).");
});

// B30: the reminder spacing reaches the owner-word line.
test("ownerWordWakes: a posted ownerWordRepeatSec and ownerWordSlowRepeatSec space the reminders", () => {
  const rows = (ageMin) => [{ thread_id: "t1", at: pushNow - ageMin * MIN, body: "please fix the heading", card_num: 7 }];
  const reason = (ageMin, values) => ownerWordWakes({ rows: rows(ageMin), now: pushNow, lim: values ? pushLimits({ values }) : {} })[0]?.reason ?? "";
  const lim = { ownerWordSec: 600, ownerWordRepeatSec: 300, ownerWordSlowRepeatSec: 1800 };
  assert.doesNotMatch(reason(25), /reminder/, "default: no reminder yet at 25 min");
  assert.match(reason(25, lim), /\(reminder 3\)/, "posted 5 min spacing: 3 reminders by 25");
  assert.match(reason(100, lim), /\(reminder 6\)/, "after four reminders the posted 30 min spacing: reminder 6 at 100");
  assert.doesNotMatch(reason(100), /\(reminder 6\)/, "default spacing is not that");
});
