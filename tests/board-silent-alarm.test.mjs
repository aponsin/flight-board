// #C1016 (c-board-silent-alarm): the Worker tells the owner's phone when the Mac's board jobs go silent. On 11-12 a WindowServer crash logged the Mac out
// at 1:52 am and every launchd board job stopped for ~10 hours with nobody told. The alarm comes from the Worker (its cron), since the Mac is the thing
// that is down: when the newest evidence write (the probe's heartbeat; a run.* report is not one) is 15 minutes old, the phone is told once for that silence.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { pushesDue, pushWords, SILENT_PUSH_MIN } from "../worker/push-rules.mjs";
import { pushRun } from "../worker/push-store.mjs";
import { b64u } from "../worker/web-push.mjs";
import { mtDayTime } from "../worker/team-time.mjs";

const T = 1_800_000_000_000, MIN = 60e3;
const BODY = (since) => `board jobs silent since ${mtDayTime(since)}: the Mac may have crashed, log back in.`;

const UA_KEYS = new Map();
async function device(endpoint = "https://fcm.googleapis.com/fcm/send/dev1") {
  const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const d = { endpoint, keys: { p256dh: b64u.encode(await crypto.subtle.exportKey("raw", ua.publicKey)), auth: b64u.encode(crypto.getRandomValues(new Uint8Array(16))) } };
  UA_KEYS.set(endpoint, { privateKey: ua.privateKey, d });
  return d;
}
// The receiving side of the push (RFC 8291 / 8188, one record): the plaintext that was sealed, never an assertion on random bytes.
async function openPush(endpoint, body) {
  const { privateKey, d } = UA_KEYS.get(endpoint), b = new Uint8Array(body), enc = new TextEncoder();
  const salt = b.slice(0, 16), idlen = b[20], asPub = b.slice(21, 21 + idlen), sealed = b.slice(21 + idlen), uaPub = b64u.decode(d.keys.p256dh);
  const hkdf = async (s, ikm, info, n) => new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), n * 8));
  const as = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: as }, privateKey, 256));
  const ikm = await hkdf(b64u.decode(d.keys.auth), ecdh, new Uint8Array([...enc.encode("WebPush: info\0"), ...uaPub, ...asPub]), 32);
  const key = await crypto.subtle.importKey("raw", await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16), "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12) }, key, sealed));
  return new TextDecoder().decode(plain.slice(0, -1));
}
const jwkSecret = async () => JSON.stringify({ ...(await crypto.subtle.exportKey("jwk", (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])).privateKey)), sub: "https://board.example.invalid" });
const subscribe = async (db, env) => worker.fetch(new Request("https://b.test/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(await device()) }), { DB: db, ...env }, null, T, async () => ({ who: "owner", role: "owner" }));
const heartbeat = (db, key, at) => db.prepare("INSERT INTO evidence (key, value, read_at) VALUES (?, '{}', ?) ON CONFLICT (key) DO UPDATE SET read_at = excluded.read_at").bind(key, at).run();

test("pushesDue: a silence is due at 15 minutes, not 14; once per silence; a write ends it and the next is told again", () => {
  assert.equal(SILENT_PUSH_MIN, 15);
  const sent = new Set();
  assert.equal(pushesDue({ asks: [], ships: [], sent, now: T + 14 * MIN, lastEvidenceAt: T }).payload, null, "14 min");
  const due = pushesDue({ asks: [], ships: [], sent, now: T + 15 * MIN, lastEvidenceAt: T });
  assert.equal(due.silent, T);
  assert.equal(JSON.parse(due.payload).body, BODY(T));
  assert.equal(pushesDue({ asks: [], ships: [], sent: new Set([`ship:silent:${T}`]), now: T + 99 * MIN, lastEvidenceAt: T }).payload, null, "told once, however long it lasts");
  assert.equal(pushesDue({ asks: [], ships: [], sent: new Set([`ship:silent:${T}`]), now: T + 60 * MIN, lastEvidenceAt: T + 30 * MIN }).silent, T + 30 * MIN, "after a write, the next silence is told");
});

test("pushesDue: a fresh heartbeat is quiet; no evidence at all, and any value that is not a time, is not a silence", () => {
  assert.equal(pushesDue({ asks: [], ships: [], sent: new Set(), now: T + MIN, lastEvidenceAt: T }).payload, null, "fresh");
  for (const bad of [undefined, null, 0, -5, "5", `${T}`, 1.5, NaN, Infinity, {}, [T]]) {
    assert.equal(pushesDue({ asks: [], ships: [], sent: new Set(), now: T + 999 * MIN, lastEvidenceAt: bad }).payload, null, String(bad));
  }
});

test("pushWords: the silence reads first, with the time in Mountain Time, never UTC Z; beside a deploy and an ask it stays one push", () => {
  const w = JSON.parse(pushWords([{ num: 7 }], [], "a".repeat(40), T));
  assert.deepEqual(Object.keys(w).sort(), ["body", "tag", "title", "url"]);
  assert.ok(w.body.startsWith(`board jobs silent since ${mtDayTime(T)}: the Mac may have crashed, log back in. `), w.body);
  assert.match(w.body, / MT:/);
  assert.doesNotMatch(w.body, /\dZ\b/);
  assert.match(w.body, /board deployed aaaaaaa/);
  for (const bad of [null, 0, "x", 1.5]) assert.doesNotMatch(pushWords([], [], null, bad), /silent/, `${bad}`);
});

test("the cron: silent for 15 minutes pushes the phone once, not again until the board recovers and goes silent again", async () => {
  const db = makeDb(), env = { PUSH_VAPID_JWK: await jwkSecret() };
  await subscribe(db, env);
  await heartbeat(db, "agents", T);
  await heartbeat(db, "cards.some-card", T - 5 * MIN);
  const sent = [];
  const fetchFn = async (url, init) => { sent.push({ url, init }); return { status: 201 }; };
  await worker.scheduled({}, { DB: db, ...env }, null, T + 14 * MIN, fetchFn);
  assert.equal(sent.length, 0, "14 minutes: quiet");
  await worker.scheduled({}, { DB: db, ...env }, null, T + 15 * MIN, fetchFn);
  assert.equal(sent.length, 1, "15 minutes: told");
  const p = JSON.parse(await openPush(sent[0].url, sent[0].init.body));
  assert.deepEqual(Object.keys(p).sort(), ["body", "tag", "title", "url"]);
  assert.equal(p.body, BODY(T));
  for (const at of [20, 25, 600]) await worker.scheduled({}, { DB: db, ...env }, null, T + at * MIN, fetchFn);
  assert.equal(sent.length, 1, "not again while it lasts, ten hours included");
  // The board recovers (a write), stays fresh, then goes silent again: told again, with the new time.
  const back = T + 640 * MIN;
  await heartbeat(db, "agents", back);
  await worker.scheduled({}, { DB: db, ...env }, null, back + 5 * MIN, fetchFn);
  assert.equal(sent.length, 1, "recovered: quiet");
  await worker.scheduled({}, { DB: db, ...env }, null, back + 15 * MIN, fetchFn);
  assert.equal(sent.length, 2, "a second silence is told");
  assert.equal(JSON.parse(await openPush(sent[1].url, sent[1].init.body)).body, BODY(back));
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM push_sent WHERE kind = 'ship' AND ref LIKE 'silent:%'").first()).n, 2);
});

test("the cron: a run.* report is not a heartbeat; a board with no evidence yet is quiet; a failed send keeps the silence due; with no device it is marked", async () => {
  const env = { PUSH_VAPID_JWK: await jwkSecret() };
  // A timed-out run's own report, written every few minutes, must not hide the silence (the page's chip ignores it the same way).
  const db = makeDb();
  await subscribe(db, env);
  await heartbeat(db, "agents", T);
  await heartbeat(db, "run.evidence", T + 14 * MIN);
  const sent = [];
  await worker.scheduled({}, { DB: db, ...env }, null, T + 16 * MIN, async (url, init) => { sent.push({ url, init }); return { status: 201 }; });
  assert.equal(sent.length, 1, "told although a run report is fresh");
  // No evidence at all: a board that has not started.
  const empty = makeDb();
  await subscribe(empty, env);
  await pushRun(empty, T + 600 * MIN, env, async () => assert.fail("no evidence, no push"));
  // A failed send: still due next run; marked only when a device took it.
  const flaky = makeDb();
  await subscribe(flaky, env);
  await heartbeat(flaky, "agents", T);
  let status = 500;
  await pushRun(flaky, T + 15 * MIN, env, async () => ({ status }));
  assert.equal((await flaky.prepare("SELECT COUNT(*) AS n FROM push_sent").first()).n, 0, "a 500: still due");
  status = 201;
  const again = [];
  await pushRun(flaky, T + 20 * MIN, env, async (url, init) => { again.push(url); return { status }; });
  assert.equal(again.length, 1);
  assert.equal((await flaky.prepare("SELECT ref FROM push_sent").first()).ref, `silent:${T}`);
  // No device: marked, so a device added later gets no backlog.
  const bare = makeDb();
  await heartbeat(bare, "agents", T);
  await pushRun(bare, T + 15 * MIN, env, async () => assert.fail("no device, no fetch"));
  assert.equal((await bare.prepare("SELECT ref FROM push_sent").first()).ref, `silent:${T}`, "marked with no device");
});
