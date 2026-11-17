// #C1113 slice 3: three Worker-side windows that were bare constants are settings the probe posts: stuckFreshSec (how fresh the stuck reading must be for the phone's
// push), stuckWindowSec (how long a refused write stays on the page's stuck line) and threadWindowSec (how recent an owner thread must be to block a Decision
// that names the same card or ask). Each test moves the setting off its default, both ways, and keeps the default as the control, so a wiring that falls back to
// the default (or a window that ignores the setting) fails.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { KNOBS, resolveKnobs } from "../worker/knobs.mjs";
import { stuckDoc, compatView, STUCK_WINDOW_MS } from "../worker/compat-view.mjs";
import { pushRun } from "../worker/push-store.mjs";
import { createCard, askFromTool, THREAD_WINDOW_MS } from "../worker/board-store.mjs";

const MIN = 60e3, HOUR = 3_600_000, T = 1_800_000_000_000;
const knobs = (values) => ({ values, ignored: [] });

test("the three settings exist with the old constants as their defaults, and the exported constants are those defaults", () => {
  assert.equal(KNOBS.stuckFreshSec.default, 900);
  assert.equal(KNOBS.stuckWindowSec.default, 86400);
  assert.equal(KNOBS.threadWindowSec.default, 7200);
  assert.equal(STUCK_WINDOW_MS, 24 * HOUR);
  assert.equal(THREAD_WINDOW_MS, 2 * HOUR);
  // stuckFreshSec must outlast one evidence cycle: a value under interval plus limit is ignored, and the default stands.
  const r = resolveKnobs({ stuckFreshSec: 200 });
  assert.equal(r.values.stuckFreshSec, 900);
  assert.ok(r.ignored.some((i) => i.key === "stuckFreshSec"));
});

// stuckWindowSec: the page's stuck line.
const refusal = (at) => ({ card_id: "c1", who: "Manager", rule: "look-needs-screenshots", at });
const view = (at) => ({ now: T, cards: [{ id: "c1", updated_at: 0 }], refusals: [refusal(at)] });
test("stuckDoc: a posted stuckWindowSec moves how old a refusal still shows, both ways", () => {
  assert.equal(stuckDoc(view(T - 30 * HOUR)), null, "default 24 h: 30 h is gone");
  assert.notEqual(stuckDoc(view(T - 30 * HOUR), knobs({ stuckWindowSec: 48 * 3600 })), null, "posted 48 h: shown at 30 h");
  assert.notEqual(stuckDoc(view(T - 10 * HOUR)), null, "default: shown at 10 h");
  assert.equal(stuckDoc(view(T - 10 * HOUR), knobs({ stuckWindowSec: 3600 })), null, "posted 1 h: gone at 10 h");
});
test("the compat view hands the posted settings to the stuck line (evidence key knobs)", () => {
  const v = (values) => compatView({ ...view(T - 30 * HOUR), evidence: values ? { knobs: { value: knobs(values), readAt: T } } : {} });
  const has = (c) => (c.collections.meta ?? []).some((d) => d.id === "stuck");
  assert.equal(has(v()), false, "default: 30 h old is not shown");
  assert.equal(has(v({ stuckWindowSec: 48 * 3600 })), true, "posted 48 h: shown");
});

// stuckFreshSec: the phone's stuck push.
const put = (db, key, value, at) => db.prepare("INSERT OR REPLACE INTO evidence (key, value, read_at) VALUES (?, ?, ?)").bind(key, JSON.stringify(value), at).run();
const jwkSecret = async () => JSON.stringify({ ...(await crypto.subtle.exportKey("jwk", (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])).privateKey)), sub: "https://board.example.invalid" });
const NOON = Date.UTC(2026, 10, 12, 19, 0);
test("pushRun: a posted stuckFreshSec moves how old the stuck reading may be and still push, both ways", async () => {
  const env = { PUSH_VAPID_JWK: await jwkSecret() };
  const told = async (values, ageMin) => {
    const db = makeDb();
    await put(db, "board", { boardId: "flight-board", at: NOON }, NOON);
    if (values) await put(db, "knobs", knobs(values), NOON);
    await put(db, "stuck", { Builder: { kind: "step", card: "a-card", since: NOON - 60 * MIN } }, NOON - ageMin * MIN);
    await pushRun(db, NOON, env, async () => assert.fail("no device, no fetch"));
    return (await db.prepare("SELECT ref FROM push_sent").all()).results.filter((r) => r.ref.startsWith("stuck:")).length;
  };
  assert.equal(await told(undefined, 20), 0, "default 15 min: a 20 min old reading is dropped");
  assert.equal(await told({ stuckFreshSec: 1800 }, 20), 1, "posted 30 min: pushed at 20");
  assert.equal(await told(undefined, 10), 1, "default: pushed at 10");
  assert.equal(await told({ stuckFreshSec: 300 }, 10), 0, "posted 5 min: dropped at 10");
});

// threadWindowSec: the Decision-in-an-open-thread refusal.
test("askFromTool: a posted threadWindowSec moves how recent an owner thread must be to block a Decision, both ways", async () => {
  const run = async (values, ageMin) => {
    const db = makeDb();
    if (values) await put(db, "knobs", knobs(values), T);
    await createCard(db, T, "Manager", { id: "card-a", title: "A card" });
    const num = (await db.prepare("SELECT num FROM cards WHERE id = 'card-a'").first()).num;
    await db.prepare("INSERT INTO threads (id, num, title, created_at) VALUES ('t-1', 900, 'Order', ?)").bind(T - ageMin * MIN).run();
    await db.prepare("INSERT INTO messages (id, thread_id, author, body, created_at) VALUES ('m-1', 't-1', 'owner', ?, ?)").bind(`what about #C${num}?`, T - ageMin * MIN).run();
    const r = await askFromTool(db, T, "Manager", { type: "Decision", title: `#C${num}: go?`, asked_by: "Manager", question: "Go?", options: ["Yes", "No"], recommended: "Yes", related_thread: "none" });
    return r.refused?.rule === "decision-belongs-in-thread";
  };
  assert.equal(await run(undefined, 150), false, "default 2 h: a 150 min old thread does not block");
  assert.equal(await run({ threadWindowSec: 14400 }, 150), true, "posted 4 h: blocks at 150 min");
  assert.equal(await run(undefined, 60), true, "default: blocks at 60 min");
  assert.equal(await run({ threadWindowSec: 1800 }, 60), false, "posted 30 min: does not block at 60");
});
