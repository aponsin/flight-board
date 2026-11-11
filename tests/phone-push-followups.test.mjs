// #C922, the three LOWs on #C904's phone push: (1) a send never follows a redirect (Security); (2) a device failing 5 sends in a
// row is dropped, and the page shows "on" only for a device the board still has (Checker LOW1); (3) Manager's 10-minute line
// promises no push (Checker LOW2).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { createAsk } from "../worker/board-store.mjs";
import { sendPush, b64u } from "../worker/web-push.mjs";
import { pushRun, MAX_FAILS } from "../worker/push-store.mjs";
import { askWakes } from "../worker/push-rules.mjs";

const T = 1_800_000_000_000, MIN = 60e3;
const jwk = async () => ({ ...(await crypto.subtle.exportKey("jwk", (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])).privateKey)), sub: "https://board.example.invalid" });
async function device(endpoint = "https://fcm.googleapis.com/fcm/send/dev1") {
  const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return { endpoint, keys: { p256dh: b64u.encode(await crypto.subtle.exportKey("raw", ua.publicKey)), auth: b64u.encode(crypto.getRandomValues(new Uint8Array(16))) } };
}
const call = (db, path, body, role = "owner") => worker.fetch(new Request(`https://b.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { DB: db }, null, T, async () => ({ who: role, role }));

test("(1) a send never follows a redirect; a 3xx is a failed send, not gone", async () => {
  const d = await device();
  let init;
  const r = await sendPush({ subscription: { endpoint: d.endpoint, p256dh: d.keys.p256dh, auth: d.keys.auth }, payload: "{}", jwk: await jwk(), subject: "https://board.example.invalid", now: T, fetchFn: async (_u, i) => { init = i; return { status: 307 }; } });
  assert.equal(init.redirect, "manual");
  assert.deepEqual({ ok: r.ok, gone: r.gone }, { ok: false, gone: false });
});

test("(2) a device failing 5 sends in a row is dropped; a success in between starts the count again", async () => {
  const db = makeDb(), env = { PUSH_VAPID_JWK: JSON.stringify(await jwk()) };
  assert.equal((await createAsk(db, T, { type: "Action", title: "x", asked_by: "Manager", steps: ["one"], expect: "ok" })).ok, true);
  await call(db, "/api/push/subscribe", await device());
  const count = async () => (await db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first()).n;
  let status = 403;
  const fetchFn = async () => ({ status });
  for (let i = 1; i < MAX_FAILS; i++) await pushRun(db, T + (30 + i) * MIN, env, fetchFn);
  assert.equal(await count(), 1, `${MAX_FAILS - 1} fails: kept`);
  status = 201;
  await pushRun(db, T + 40 * MIN, env, fetchFn);
  assert.equal((await db.prepare("SELECT fails FROM push_subscriptions").first()).fails, 0, "a success resets it");
  // Something new due, so the cron sends again.
  assert.equal((await createAsk(db, T + 40 * MIN, { type: "Action", title: "y", asked_by: "Manager", steps: ["one"], expect: "ok" })).ok, true);
  status = 403;
  for (let i = 1; i <= MAX_FAILS; i++) await pushRun(db, T + (70 + i) * MIN, env, fetchFn);
  assert.equal(await count(), 0, `${MAX_FAILS} fails in a row: dropped`);
});

test("(2) /api/push/known: the owner's page asks whether its device is still the board's; never anyone else", async () => {
  const db = makeDb(), d = await device();
  assert.equal((await call(db, "/api/push/known", { endpoint: d.endpoint }, "agent")).status, 403);
  assert.deepEqual(await (await call(db, "/api/push/known", { endpoint: d.endpoint })).json(), { ok: true, known: false });
  await call(db, "/api/push/subscribe", d);
  assert.deepEqual(await (await call(db, "/api/push/known", { endpoint: d.endpoint })).json(), { ok: true, known: true });
  assert.equal((await call(db, "/api/push/known", {})).status, 422);
  const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.match(page, /subscribed:!!sub&&known/, "the switch says on only for a known device");
  assert.match(page, /if\(PUSH\.sub\)\{try\{await PUSH\.sub\.unsubscribe\(\)\}catch\(_\)\{\}\}\n      const sub=await PUSH\.reg\.pushManager\.subscribe\(/, "turning on drops a stale subscription first");
});

test("(3) Manager's 10-minute line promises no push: it says the push comes only if phone pushes are on, in one fixed wording", () => {
  const [w] = askWakes({ asks: [{ id: "a1", num: 7, type: "Action", eta_at: null, created_at: T, answered_at: null, closed_at: null, withdrawn_at: null }], now: T + 10 * MIN });
  assert.equal(w.reason, "ask #T7 has waited 10 min for the owner: make it clearer or answer what you can; at 30 min it goes to the owner's phone, if phone pushes are on");
});
