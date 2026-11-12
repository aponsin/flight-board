// #C904 (the owner's pick B on #T1793): the board pushes to the owner's phone itself. What is due and when (push-rules.mjs), the
// subscriptions (owner only, known push services only), the cron run (one push per device, each item once, a gone device removed),
// Manager's 10-minute line, the service worker and the manifest, and that no ask's text ever leaves in a push.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker, { oldPageCsp } from "../worker/board-worker.mjs";
import entry from "../worker/board-entry.mjs";
import { createAsk, answerAsk, wakeAsk, takeInbox } from "../worker/board-store.mjs";
import { askWaitsFrom, askWakes, pushesDue, pushWords, MANAGER_NUDGE_MIN, OWNER_PUSH_MIN } from "../worker/push-rules.mjs";
import { pushRun, MAX_SUBSCRIPTIONS } from "../worker/push-store.mjs";
import { b64u } from "../worker/web-push.mjs";
import { SW_SOURCE, MANIFEST } from "../worker/push-page.mjs";
import { loadNames } from "./harness.mjs";
import { storePage } from "../scripts/build-store-page.mjs";
import { newSecret, subjectOk, args } from "../scripts/push-keys.mjs";
import { vapidJwk } from "../worker/web-push.mjs";

test("push-keys: the secret is a private P-256 JWK the Worker accepts, with the subject; a new key each run; the subject checked", async () => {
  const a = await newSecret("https://board.example.invalid"), b = await newSecret("https://board.example.invalid");
  const jwk = vapidJwk(a);
  assert.ok(jwk, "the Worker's own check accepts it");
  assert.deepEqual(Object.keys(JSON.parse(a)).sort(), ["crv", "d", "kty", "sub", "x", "y"]);
  assert.equal(jwk.sub, "https://board.example.invalid");
  assert.notEqual(JSON.parse(a).d, JSON.parse(b).d);
  for (const ok of ["https://board.example.invalid", "https://board.example.invalid/", "mailto:someone" + "@example.invalid"]) assert.equal(subjectOk(ok), true, ok);
  for (const bad of ["http://board.example.invalid", "https://board.example.invalid/path?x", "board.example.invalid", "mailto:nobody", "", undefined]) assert.equal(subjectOk(bad), false, String(bad));
  assert.deepEqual(args(["--subject", "https://x.invalid", "--config", "w.toml"]), { subject: "https://x.invalid", config: "w.toml" });
  assert.equal(args(["--print"]).unknown, "--print");
  const src = readFileSync(new URL("../scripts/push-keys.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src.replace(/^\/\/.*$/gm, ""), /console\.log\([^)]*(secret|newSecret|jwk|\bd\b)/i, "the key is never printed");
  assert.match(src, /input: await newSecret\(a\.subject\)/, "it goes to wrangler on stdin");
});

const T = 1_800_000_000_000, MIN = 60e3, DAY = 864e5;
const ask = (over) => ({ id: "a1", num: 7, type: "Action", eta_at: null, created_at: T, answered_at: null, closed_at: null, withdrawn_at: null, ...over });

test("askWaitsFrom: from its creation; a Later ask from its date; a dated Decision from its date; answered, closed or withdrawn never", () => {
  assert.equal(askWaitsFrom(ask()), T);
  assert.equal(askWaitsFrom(ask({ type: "Later", eta_at: T + DAY })), T + DAY);
  assert.equal(askWaitsFrom(ask({ type: "Later", eta_at: null })), null);
  assert.equal(askWaitsFrom(ask({ type: "Decision", eta_at: T + DAY })), T + DAY);
  assert.equal(askWaitsFrom(ask({ type: "Decision", eta_at: T - DAY })), T, "a date before its creation is no wait");
  for (const k of ["answered_at", "closed_at", "withdrawn_at"]) assert.equal(askWaitsFrom(ask({ [k]: T })), null, k);
});

test("askWakes: Manager's line at 10 minutes, not 9; one stable reason per ask", () => {
  assert.deepEqual(askWakes({ asks: [ask()], now: T + (MANAGER_NUDGE_MIN - 1) * MIN }), []);
  const w = askWakes({ asks: [ask()], now: T + MANAGER_NUDGE_MIN * MIN });
  assert.deepEqual(w.map((x) => x.card_id), ["ask:a1"]);
  assert.match(w[0].reason, /^ask #T7 has waited 10 min for the owner: /);
  assert.deepEqual(askWakes({ asks: [ask()], now: T + 3 * DAY }), w, "the same reason later: told once");
});

test("pushesDue: an ask at 30 minutes, not 29; each item once; an unacknowledged ship of the last 7 days once", () => {
  const ship = (version, at, acked_at = null) => ({ version, shipped_at: at, acked_at });
  const none = new Set();
  assert.equal(pushesDue({ asks: [ask()], ships: [], sent: none, now: T + (OWNER_PUSH_MIN - 1) * MIN }).payload, null);
  const d = pushesDue({ asks: [ask(), ask({ id: "a2", num: 3 })], ships: [ship("1.2.0", T), ship("1.1.0", T - 8 * DAY), ship("1.3.0", T, T)], sent: none, now: T + OWNER_PUSH_MIN * MIN });
  assert.deepEqual(d.asks.map((a) => a.num), [3, 7], "oldest number first");
  assert.deepEqual(d.ships.map((s) => s.version), ["1.2.0"], "not older than 7 days, not acknowledged");
  assert.deepEqual(JSON.parse(d.payload), { title: "Flight board", body: "1.2.0 went live: acknowledge it. 2 asks have waited 30+ min (#T3, #T7).", url: "/", tag: "board" });
  const again = pushesDue({ asks: [ask()], ships: [ship("1.2.0", T)], sent: new Set(["ask:a1", "ship:1.2.0"]), now: T + DAY });
  assert.equal(again.payload, null, "sent once");
});

test("pushWords: counts, ask numbers and versions only; never an ask's title or text", () => {
  const words = pushWords([{ num: 1, title: "SECRET TITLE", body: "secret body" }, { num: 2 }, { num: 3 }, { num: 4 }], [{ version: "<script>" }]);
  assert.doesNotMatch(words, /SECRET|secret|<script>/);
  assert.match(JSON.parse(words).body, /^a version went live: acknowledge it\. 4 asks have waited 30\+ min \(#T1, #T2, #T3 and 1 more\)\.$/);
});

// A real browser subscription's shape: a P-256 point and a 16-byte secret.
const UA_KEYS = new Map(); // endpoint -> the device's private key, so a test can open what was sent to it
async function device(endpoint = "https://fcm.googleapis.com/fcm/send/dev1") {
  const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const d = { endpoint, keys: { p256dh: b64u.encode(await crypto.subtle.exportKey("raw", ua.publicKey)), auth: b64u.encode(crypto.getRandomValues(new Uint8Array(16))) } };
  UA_KEYS.set(endpoint, { privateKey: ua.privateKey, d });
  return d;
}
// RFC 8291 / 8188, one record: the receiving side of encryptPayload, so a test reads the plaintext that was sealed (#C950: no assertion on random bytes).
async function openPush(endpoint, body) {
  const { privateKey, d } = UA_KEYS.get(endpoint), b = new Uint8Array(body), enc = new TextEncoder();
  const salt = b.slice(0, 16), idlen = b[20], asPub = b.slice(21, 21 + idlen), sealed = b.slice(21 + idlen), uaPub = b64u.decode(d.keys.p256dh);
  const hkdf = async (s, ikm, info, n) => new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), n * 8));
  const as = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: as }, privateKey, 256));
  const ikm = await hkdf(b64u.decode(d.keys.auth), ecdh, new Uint8Array([...enc.encode("WebPush: info\0"), ...uaPub, ...asPub]), 32);
  const key = await crypto.subtle.importKey("raw", await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16), "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12) }, key, sealed));
  assert.equal(plain.at(-1), 2, "one record: the last-record delimiter");
  return new TextDecoder().decode(plain.slice(0, -1));
}
const call = (db, path, { role = "owner", who = role, body, method = body === undefined ? "GET" : "POST", env = {}, headers = {} } = {}) =>
  worker.fetch(new Request(`https://b.test${path}`, { method, headers: { ...(method === "POST" ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), { DB: db, ...env }, null, T, async () => ({ who, role }));
const jwkSecret = async () => JSON.stringify({ ...(await crypto.subtle.exportKey("jwk", (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])).privateKey)), sub: "https://board.example.invalid" });

test("subscribe and unsubscribe: the owner's alone; a known push service and real keys only; at most 5 devices", async () => {
  const db = makeDb(), d = await device();
  for (const role of ["agent", "probe"]) assert.equal((await call(db, "/api/push/subscribe", { role, who: "Builder", body: d })).status, 403, role);
  assert.equal((await call(db, "/api/push/subscribe", { body: d })).status, 200);
  assert.equal((await call(db, "/api/push/subscribe", { body: d })).status, 200, "again: the same device, updated");
  const bad = [{ ...d, endpoint: "https://evil.example/x" }, { ...d, endpoint: "http://fcm.googleapis.com/x" }, { ...d, keys: { ...d.keys, p256dh: "AAAA" } }, { ...d, keys: { ...d.keys, auth: "AAAA" } }, {}];
  for (const b of bad) {
    const r = await call(db, "/api/push/subscribe", { body: b });
    assert.equal(r.status, 422, JSON.stringify(b));
  }
  assert.ok((await db.prepare("SELECT COUNT(*) AS n FROM refusals WHERE rule LIKE 'push-%'").first()).n >= bad.length, "each refusal is logged");
  for (let i = 2; i <= MAX_SUBSCRIPTIONS; i++) assert.equal((await call(db, "/api/push/subscribe", { body: await device(`https://fcm.googleapis.com/fcm/send/dev${i}`) })).status, 200);
  const sixth = await call(db, "/api/push/subscribe", { body: await device("https://fcm.googleapis.com/fcm/send/dev6") });
  assert.equal((await sixth.json()).refused.rule, "push-too-many");
  assert.equal((await call(db, "/api/push/unsubscribe", { body: { endpoint: d.endpoint } })).status, 200);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first()).n, MAX_SUBSCRIPTIONS - 1);
  assert.equal((await call(db, "/api/push/subscribe", { body: d, headers: { origin: "https://evil.example" } })).status, 403, "cross-site: refused");
});

test("GET /api/push: the owner's facts (ready, public key, devices, last run); never an endpoint", async () => {
  const db = makeDb(), secret = await jwkSecret();
  await call(db, "/api/push/subscribe", { body: await device() });
  assert.equal((await call(db, "/api/push", { role: "agent", who: "Builder" })).status, 403);
  const none = await (await call(db, "/api/push")).json();
  assert.deepEqual({ ready: none.ready, publicKey: none.publicKey, devices: none.devices }, { ready: false, publicKey: null, devices: 1 });
  const ready = await (await call(db, "/api/push", { env: { PUSH_VAPID_JWK: secret } })).json();
  assert.equal(ready.ready, true);
  assert.equal(b64u.decode(ready.publicKey).length, 65);
  assert.doesNotMatch(JSON.stringify(ready), /fcm\.googleapis|"d"/, "no endpoint, no private key");
});

async function seeded() {
  const db = makeDb();
  const r = await createAsk(db, T, { type: "Action", title: "SECRET TITLE run the pair", asked_by: "Manager", steps: ["one"], expect: "ok" });
  assert.equal(r.ok, true, JSON.stringify(r));
  return { db, askId: r.id };
}

test("the cron: nothing before 30 minutes; at 30 one push per device, each item once; the payload is encrypted and holds no ask text", async () => {
  const { db } = await seeded(), env = { PUSH_VAPID_JWK: await jwkSecret() };
  await call(db, "/api/push/subscribe", { body: await device() });
  await call(db, "/api/push/subscribe", { body: await device("https://web.push.apple.com/dev2") });
  const sent = [];
  const fetchFn = async (url, init) => { sent.push({ url, init }); return { status: 201 }; };
  await worker.scheduled({}, { DB: db, ...env }, null, T + 29 * MIN, fetchFn);
  assert.equal(sent.length, 0, "29 min");
  await worker.scheduled({}, { DB: db, ...env }, null, T + 30 * MIN, fetchFn);
  assert.deepEqual(sent.map((s) => s.url).sort(), ["https://fcm.googleapis.com/fcm/send/dev1", "https://web.push.apple.com/dev2"]);
  // #C950: read the sealed plaintext instead of searching random ciphertext (which held "#T" by chance about 0.3% of runs). The payload is
  // exactly the four fields, names only the ask's number, and holds none of its text; a leaked title or another thread id fails here every time.
  const num = (await db.prepare("SELECT num FROM asks").first()).num;
  for (const s of sent) {
    const plain = await openPush(s.url, s.init.body), p = JSON.parse(plain);
    assert.deepEqual(Object.keys(p).sort(), ["body", "tag", "title", "url"]);
    assert.doesNotMatch(plain, /SECRET|run the pair/, "no ask text");
    assert.deepEqual(plain.match(/#T\d+/g), [`#T${Number(num)}`], "the only thread id is the waiting ask's own number");
    assert.ok(!Buffer.from(s.init.body).includes(Buffer.from(p.body)), "and what was sent is not the plaintext");
  }
  await worker.scheduled({}, { DB: db, ...env }, null, T + 35 * MIN, fetchFn);
  assert.equal(sent.length, 2, "once");
  const facts = await (await call(db, "/api/push", { env })).json();
  assert.equal(facts.sentAt, T + 30 * MIN);
  assert.equal(facts.runAt, T + 35 * MIN);
});

test("the cron: a gone device is removed; a failed one keeps the item due; no key or no device sends nothing", async () => {
  const { db } = await seeded(), env = { PUSH_VAPID_JWK: await jwkSecret() };
  assert.deepEqual(await pushRun(db, T + 31 * MIN, {}, async () => assert.fail("no key, no fetch")), { ok: false, reason: "no key" });
  assert.match((await (await call(db, "/api/push")).json()).result, /no key/);
  await call(db, "/api/push/subscribe", { body: await device() });
  let status = 500;
  const fetchFn = async () => ({ status });
  await pushRun(db, T + 31 * MIN, env, fetchFn);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM push_sent").first()).n, 0, "a 500: still due");
  assert.equal((await db.prepare("SELECT fails FROM push_subscriptions").first()).fails, 1);
  status = 410;
  await pushRun(db, T + 36 * MIN, env, fetchFn);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first()).n, 0, "gone: removed");
  await pushRun(db, T + 41 * MIN, env, async () => assert.fail("no device, no fetch"));
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM push_sent").first()).n, 1, "no device: marked, so a new device gets no backlog");
});

test("the deployed entry runs the cron: board-entry exports scheduled", async () => {
  assert.equal(typeof entry.scheduled, "function");
  assert.match(readFileSync(new URL("../worker/wrangler.board.toml", import.meta.url), "utf8"), /\n\[triggers\]\ncrons = \["\*\/5 \* \* \* \*"\]\n/);
});

test("Manager's line: an ask the owner left 10 minutes wakes Manager once; answered before, never", async () => {
  const { db, askId } = await seeded();
  assert.equal((await wakeAsk(db, T + 9 * MIN)).count, 0);
  assert.equal((await wakeAsk(db, T + 10 * MIN)).count, 1);
  const taken = await takeInbox(db, T + 11 * MIN);
  assert.deepEqual(taken.stalls.map((s) => s.card_id), [`ask:${askId}`]);
  assert.equal((await wakeAsk(db, T + 20 * MIN)).count, 0, "once");
  const other = await createAsk(db, T + 20 * MIN, { type: "Action", title: "another", asked_by: "Manager", steps: ["one"], expect: "ok" });
  assert.equal((await answerAsk(db, T + 25 * MIN, "owner", { id: other.id, status: "done" })).ok, true);
  await takeInbox(db, T + 26 * MIN); // Manager reads the answer
  assert.equal((await wakeAsk(db, T + 40 * MIN)).count, 0, "answered at 5 min: no line");
});

test("the service worker and the manifest: served to people behind Access, never to the probe; the page's CSP allows exactly them", async () => {
  const db = makeDb();
  for (const [path, type] of [["/sw.js", /^text\/javascript/], ["/manifest.webmanifest", /^application\/manifest\+json/]]) {
    const r = await call(db, path);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get("content-type"), type);
    assert.equal((await call(db, path, { role: "probe", who: "probe" })).status, 403, `${path}: the probe`);
  }
  assert.equal(await (await call(db, "/sw.js")).text(), SW_SOURCE);
  assert.equal(JSON.parse(MANIFEST).display, "standalone", "iPhone: Web Push only from the Home Screen");
  assert.match(oldPageCsp("n"), /; worker-src 'self'; manifest-src 'self'; /);
  assert.doesNotMatch(SW_SOURCE, /innerHTML|eval\(|importScripts|fetch\(/, "it shows text and opens the board, nothing else");
});

test("the page's switch: what it says and does in each state; hidden where there is no push at all", () => {
  const page = loadNames(["pushLabel"]), pushLabel = (s) => JSON.parse(JSON.stringify(page.pushLabel(s) ?? null)); // out of the page's own context
  const on = { supported: true, ready: true, permission: "default", subscribed: false };
  assert.deepEqual(pushLabel(on), { text: "Turn on phone pushes", act: "on" });
  assert.deepEqual(pushLabel({ ...on, subscribed: true, permission: "granted" }), { text: "Phone pushes: on", act: "off" });
  assert.deepEqual(pushLabel({ ...on, permission: "denied" }), { text: "Phone pushes: blocked in this browser. How to allow", act: "how" }, "#C972: blocked opens the steps");
  assert.deepEqual(pushLabel({ ...on, ready: false }), { text: "Phone pushes: not set up yet", act: null });
  assert.deepEqual(pushLabel({ supported: false, ios: true, standalone: false }), { text: "Phone pushes: add the board to your Home Screen, then open it there", act: null }, "an iPhone in a Safari tab");
  assert.equal(pushLabel({ supported: false, ios: false }), null, "a browser without push: no switch");
  assert.equal(pushLabel(null), null);
});

// #C972 (the owner, 11-11: "Phone pushes: blocked in this browser's settings" ... "how do we solve this?").
test("a blocked browser's steps are for the browser it is; an allowed browser shows no steps", () => {
  const page = loadNames(["pushLabel", "pushSteps", "pushHelpHtml", "esc"]), plain = (x) => JSON.parse(JSON.stringify(x));
  const UA = {
    iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    firefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.1; rv:132.0) Gecko/20100101 Firefox/132.0",
  };
  const iphone = plain(page.pushSteps(UA.iphone, true));
  assert.equal(iphone.browser, "iPhone");
  assert.match(iphone.steps[0], /^Open Settings, then Notifications\./, "from the Home Screen icon: Settings first");
  assert.match(plain(page.pushSteps(UA.iphone, false)).steps[0], /Home Screen icon/, "in a Safari tab: the Home Screen icon first");
  assert.equal(plain(page.pushSteps(UA.macChrome)).browser, "Chrome");
  assert.match(plain(page.pushSteps(UA.macChrome)).steps.join(" "), /Site settings.*Notifications to Allow/);
  assert.equal(plain(page.pushSteps(UA.macSafari)).browser, "Safari on Mac");
  assert.match(plain(page.pushSteps(UA.macSafari)).steps.join(" "), /Settings, then Websites.*Notifications/);
  assert.equal(plain(page.pushSteps(UA.android)).browser, "Chrome on Android");
  assert.equal(plain(page.pushSteps(UA.edge)).browser, "Edge");
  assert.equal(plain(page.pushSteps(UA.firefox)).browser, "Firefox");
  assert.equal(plain(page.pushSteps("SomethingNew/1.0")).browser, "this browser");
  const html = page.pushHelpHtml({ browser: "<b>x</b>", steps: ["a <i>b</i>"] });
  assert.doesNotMatch(html, /<b>x|<i>b/, "escaped");
  // Must still allow: an allowed (or not yet asked) browser has no "how" act, so no steps are shown.
  const on = { supported: true, ready: true, subscribed: false };
  for (const permission of ["granted", "default"]) assert.notEqual(plain(page.pushLabel({ ...on, permission })).act, "how", permission);
  // The page wires it: the steps box, the permission change and the return to the tab redraw the badge.
  const template = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.match(template, /<div class="pushhelp" id="pushhelp" role="region" aria-label="How to allow phone pushes" hidden><\/div>/);
  assert.match(template, /permissions\.query\(\{name:"notifications"\}\)\.then\(p=>\{p\.onchange=\(\)=>pushDraw\(\)\}\)/);
  assert.match(template, /visibilitychange",\(\)=>\{if\(document\.visibilityState==="visible"\)pushDraw\(\)\}/);
});

test("the store page carries the manifest and the Home Screen tags; the template (the artifact page) does not", () => {
  const html = storePage("<!--FONTS--><!--END_FONTS--><p>x</p>");
  assert.match(html, /<head>\n<meta charset="utf-8">\n<meta name="viewport"[^\n]*>\n<link rel="manifest" href="\/manifest\.webmanifest">\n<meta name="apple-mobile-web-app-capable" content="yes">\n/);
  const template = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.doesNotMatch(template, /rel="manifest"/);
  assert.match(template, /<button type="button" class="ackbtn pushbtn" id="pushbtn" hidden><\/button>/, "hidden until the store page draws it");
  assert.match(template, /\nif\(STORE\)pushDraw\(\);\n/, "drawn on the store only");
});

