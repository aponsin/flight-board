// #C904: Web Push from the Worker. The encryption is checked against RFC 8291's own worked example (section 5), byte for
// byte; the VAPID token verifies with our public key; the endpoint allowlist refuses anything but a known push service.
import test from "node:test";
import assert from "node:assert/strict";
import { b64u, encryptPayload, vapidToken, vapidJwk, endpointAllowed, publicPoint, sendPush, VAPID_HOURS } from "../worker/web-push.mjs";

// RFC 8291, section 5 (and Appendix A's intermediate values).
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};
const asKeys = () => {
  const point = b64u.decode(RFC.asPublic);
  return { publicPoint: point, privateJwk: { kty: "EC", crv: "P-256", d: RFC.asPrivate, x: b64u.encode(point.slice(1, 33)), y: b64u.encode(point.slice(33)) } };
};

test("encryptPayload: RFC 8291's worked example, byte for byte", async () => {
  const body = await encryptPayload({ p256dh: RFC.uaPublic, auth: RFC.auth, payload: RFC.plaintext, salt: b64u.decode(RFC.salt), keys: asKeys() });
  assert.equal(b64u.encode(body), RFC.body);
});

test("encryptPayload: a fresh salt and key pair each time; bad sizes refused", async () => {
  const a = await encryptPayload({ p256dh: RFC.uaPublic, auth: RFC.auth, payload: "x" });
  const b = await encryptPayload({ p256dh: RFC.uaPublic, auth: RFC.auth, payload: "x" });
  assert.notEqual(b64u.encode(a.slice(0, 16)), b64u.encode(b.slice(0, 16)), "salt");
  assert.notEqual(b64u.encode(a.slice(21, 86)), b64u.encode(b.slice(21, 86)), "the server's key");
  await assert.rejects(encryptPayload({ p256dh: RFC.uaPublic, auth: "AAAA", payload: "x" }), /16 bytes/);
  await assert.rejects(encryptPayload({ p256dh: "BAAA", auth: RFC.auth, payload: "x" }), /P-256 point/);
  await assert.rejects(encryptPayload({ p256dh: RFC.uaPublic, auth: RFC.auth, payload: "x".repeat(5000) }), /too long/);
});

const newJwk = async () => crypto.subtle.exportKey("jwk", (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])).privateKey);

test("vapidToken: ES256, the push service's origin, at most 12 hours, the contact; verifies with our public key", async () => {
  const jwk = await newJwk(), now = 1_800_000_000_000;
  const t = await vapidToken({ jwk, endpoint: "https://web.push.apple.com/QGuQyavXutnMH?x=1", subject: "https://board.example.invalid", now });
  const [h, c, s] = t.split(".");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(b64u.decode(h))), { typ: "JWT", alg: "ES256" });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(b64u.decode(c))), { aud: "https://web.push.apple.com", exp: now / 1000 + VAPID_HOURS * 3600, sub: "https://board.example.invalid" });
  assert.ok(VAPID_HOURS <= 24, "RFC 8292: at most 24 hours");
  const pub = await crypto.subtle.importKey("raw", publicPoint(jwk), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64u.decode(s), new TextEncoder().encode(`${h}.${c}`)));
});

test("vapidJwk: one private P-256 JWK with x and y; anything else is null", async () => {
  const jwk = await newJwk();
  assert.deepEqual(vapidJwk(JSON.stringify(jwk)), jwk);
  for (const bad of [undefined, "", "{", "null", JSON.stringify({ ...jwk, d: undefined }), JSON.stringify({ ...jwk, crv: "P-384" }), JSON.stringify({ ...jwk, x: "short" })]) assert.equal(vapidJwk(bad), null, String(bad));
});

test("endpointAllowed: https on a known push service only", () => {
  for (const ok of ["https://web.push.apple.com/abc", "https://api.push.apple.com/x", "https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/abc", "https://wns2-par02p.notify.windows.com/w/?token=x"]) assert.equal(endpointAllowed(ok), true, ok);
  for (const bad of ["http://web.push.apple.com/abc", "https://push.apple.com.evil.example/x", "https://evilpush.apple.com.example.com/", "https://.push.apple.com/x", "https://push.apple.com/x", "https://fcm.googleapis.com.example.com/x", "https://user:pw" + "@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "https://localhost/x", "https://127.0.0.1/x", "not a url", "", null, `https://fcm.googleapis.com/${"a".repeat(1100)}`]) assert.equal(endpointAllowed(bad), false, String(bad));
});

test("sendPush: one encrypted POST with the VAPID header; 404 and 410 mean gone", async () => {
  const jwk = await newJwk();
  const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: b64u.encode(await crypto.subtle.exportKey("raw", ua.publicKey)), auth: b64u.encode(crypto.getRandomValues(new Uint8Array(16))) };
  const calls = [];
  for (const [status, gone] of [[201, false], [410, true], [404, true], [500, false]]) {
    const r = await sendPush({ subscription, payload: '{"title":"t"}', jwk, subject: "https://board.example.invalid", now: 1_800_000_000_000, fetchFn: async (url, init) => { calls.push({ url, init }); return { status }; } });
    assert.equal(r.gone, gone, String(status));
    assert.equal(r.ok, status === 201, String(status));
  }
  const { url, init } = calls[0];
  assert.equal(url, subscription.endpoint);
  assert.equal(init.method, "POST");
  assert.equal(init.headers["content-encoding"], "aes128gcm");
  assert.match(init.headers.authorization, new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${b64u.encode(publicPoint(jwk))}$`));
  assert.ok(!new TextDecoder().decode(init.body).includes('"title"'), "the payload is never sent in the clear");
});
