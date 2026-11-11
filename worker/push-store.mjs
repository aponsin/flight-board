// The phone push's store side (#C904): the owner's subscriptions, and the cron run that sends what is due (push-rules.mjs).
// Only the owner adds or removes a subscription (the Worker's routes check the role); the cron runs with no identity at all.
import { endpointAllowed, b64u, sendPush, vapidJwk, publicPoint } from "./web-push.mjs";
import { pushesDue } from "./push-rules.mjs";

export const MAX_SUBSCRIPTIONS = 5;
// #C922 (Checker's LOW1 on #C904): a device that fails this many sends in a row without a 404 or 410 (a 403 after the key
// was replaced, say) is removed, so it is not retried forever and the page stops saying "on" for it.
export const MAX_FAILS = 5;
const RESULT_MAX = 200;

// #C922: whether this endpoint is one of the owner's devices, so the page shows "on" only for a device the board still has.
export async function pushKnown(db, endpoint) {
  if (typeof endpoint !== "string") return refused("push-endpoint", "the endpoint to look up");
  const row = await db.prepare("SELECT 1 AS k FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).first();
  return { ok: true, known: !!row };
}

const refused = (rule, detail) => ({ ok: false, refused: { rule, detail } });
function decodes(text, bytes, first) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]+$/.test(text)) return false;
  let b;
  try { b = b64u.decode(text); } catch { return false; }
  return b.length === bytes && (first === undefined || b[0] === first);
}

// { endpoint, keys: { p256dh, auth } }: the shape PushSubscription.toJSON() gives.
export async function subscribePush(db, now, body) {
  const endpoint = body?.endpoint, p256dh = body?.keys?.p256dh, auth = body?.keys?.auth;
  if (!endpointAllowed(endpoint)) return refused("push-endpoint", "an https address on a known push service (Apple, Google, Mozilla, Microsoft)");
  if (!decodes(p256dh, 65, 4) || !decodes(auth, 16)) return refused("push-keys", "keys.p256dh is a P-256 point and keys.auth 16 bytes, base64url");
  const have = await db.prepare("SELECT endpoint FROM push_subscriptions").all();
  const known = have.results.some((r) => r.endpoint === endpoint);
  if (!known && have.results.length >= MAX_SUBSCRIPTIONS) return refused("push-too-many", `at most ${MAX_SUBSCRIPTIONS} devices; turn one off first`);
  await db.prepare("INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, fails = 0, fail_at = NULL")
    .bind(endpoint, p256dh, auth, now).run();
  return { ok: true };
}

export async function unsubscribePush(db, endpoint) {
  if (typeof endpoint !== "string") return refused("push-endpoint", "the endpoint to turn off");
  await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run();
  return { ok: true };
}

// The page's facts: whether the board can push (its key is set), how many devices, the last run. Never an endpoint.
export async function pushFacts(db, env) {
  const jwk = vapidJwk(env.PUSH_VAPID_JWK);
  const n = await db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first();
  const s = await db.prepare("SELECT run_at, sent_at, result FROM push_state WHERE id = 1").first();
  return { ready: !!jwk, publicKey: jwk ? b64u.encode(publicPoint(jwk)) : null, devices: n.n, runAt: s?.run_at || null, sentAt: s?.sent_at ?? null, result: s?.result ?? null };
}

const record = (db, now, result, sent) => db.prepare("UPDATE push_state SET run_at = ?, result = ?, sent_at = COALESCE(?, sent_at) WHERE id = 1").bind(now, String(result).slice(0, RESULT_MAX), sent ? now : null).run();

// One cron run: what is due, one push per subscription, each item marked sent once a device took it (or when there is no
// device: nothing would ever deliver it, and a new device must not get a backlog). A device the push service calls gone is
// removed. Missing key: nothing is sent, and the page says why.
export async function pushRun(db, now, env, fetchFn = fetch) {
  const jwk = vapidJwk(env.PUSH_VAPID_JWK);
  if (!jwk) { await record(db, now, "no key: PUSH_VAPID_JWK is not set", false); return { ok: false, reason: "no key" }; }
  const asks = (await db.prepare("SELECT id, num, type, eta_at, created_at, answered_at, closed_at, withdrawn_at FROM asks WHERE closed_at IS NULL AND answered_at IS NULL AND withdrawn_at IS NULL").all()).results;
  const ships = (await db.prepare("SELECT version, shipped_at, acked_at FROM ships WHERE acked_at IS NULL").all()).results;
  const sent = new Set((await db.prepare("SELECT kind, ref FROM push_sent").all()).results.map((r) => `${r.kind}:${r.ref}`));
  const due = pushesDue({ asks, ships, sent, now });
  if (!due.payload) { await record(db, now, "nothing due", false); return { ok: true, sent: 0 }; }
  const subs = (await db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions").all()).results;
  let delivered = 0, gone = 0, failed = 0;
  for (const subscription of subs) {
    let r;
    try { r = await sendPush({ subscription, payload: due.payload, jwk, subject: typeof jwk.sub === "string" ? jwk.sub : "https://flight-board.invalid", now, fetchFn }); } catch { r = { ok: false, gone: false }; }
    if (r.ok) { delivered++; await db.prepare("UPDATE push_subscriptions SET ok_at = ?, fails = 0 WHERE endpoint = ?").bind(now, subscription.endpoint).run(); }
    else if (r.gone) { gone++; await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(subscription.endpoint).run(); }
    else {
      failed++;
      await db.prepare("UPDATE push_subscriptions SET fail_at = ?, fails = fails + 1 WHERE endpoint = ?").bind(now, subscription.endpoint).run();
      await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND fails >= ?").bind(subscription.endpoint, MAX_FAILS).run();
    }
  }
  if (delivered || !subs.length) {
    for (const a of due.asks) await db.prepare("INSERT OR IGNORE INTO push_sent (kind, ref, at) VALUES ('ask', ?, ?)").bind(a.id, now).run();
    for (const s of due.ships) await db.prepare("INSERT OR IGNORE INTO push_sent (kind, ref, at) VALUES ('ship', ?, ?)").bind(s.version, now).run();
  }
  const what = `${due.asks.length} ask(s), ${due.ships.length} ship(s)`;
  await record(db, now, subs.length ? `${what}: ${delivered} device(s) took it, ${gone} gone, ${failed} failed` : `${what}: no device subscribed`, delivered > 0);
  return { ok: true, sent: delivered, gone, failed };
}
