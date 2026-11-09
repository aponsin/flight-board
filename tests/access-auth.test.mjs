import test from "node:test";
import assert from "node:assert/strict";
import { verifyJwt, authenticate, resetKeyCache } from "../worker/access-auth.mjs";

const TEAM = "https://team.example.test", AUD = "app-aud-1", NOW = 1_800_000_000_000;
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
const jwks = { keys: [jwk] };

async function sign(claims, { alg = "RS256", kid = "k1", key = pair.privateKey } = {}) {
  const head = `${enc({ alg, kid, typ: "JWT" })}.${enc(claims)}`;
  const sig = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head))).toString("base64url");
  return `${head}.${sig}`;
}
// A logged-in person's claim: Access puts the login name in the token's "email" field (fixtures here are plain names).
const asUser = (name) => Object.fromEntries([["email", name]]);
const good = { iss: TEAM, aud: [AUD], exp: NOW / 1000 + 600, ...asUser("owner-user") };
const opts = { jwks, issuer: TEAM, aud: AUD, now: NOW };

test("a well-formed token verifies", async () => {
  assert.equal((await verifyJwt(await sign(good), opts)).email, "owner-user");
});

test("every way of being wrong is refused", async () => {
  const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  assert.equal(await verifyJwt(await sign(good, { key: other.privateKey }), opts), null, "wrong key");
  assert.equal(await verifyJwt(await sign({ ...good, exp: NOW / 1000 - 1 }), opts), null, "expired");
  assert.equal(await verifyJwt(await sign({ ...good, aud: ["other"] }), opts), null, "wrong audience");
  assert.equal(await verifyJwt(await sign({ ...good, iss: "https://evil.test" }), opts), null, "wrong issuer");
  assert.equal(await verifyJwt(await sign(good, { kid: "nope" }), opts), null, "unknown key id");
  assert.equal(await verifyJwt(await sign(good, { alg: "none" }), opts), null, "alg none");
  assert.equal(await verifyJwt(await sign(good, { alg: "HS256" }), opts), null, "alg HS256");
  assert.equal(await verifyJwt("a.b", opts), null);
  assert.equal(await verifyJwt(null, opts), null);
  const t = await sign(good);
  const [h, p, s] = t.split(".");
  assert.equal(await verifyJwt(`${h}.${enc({ ...good, ...asUser("attacker-user") })}.${s}`, opts), null, "tampered claims");
});

const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ROLES: JSON.stringify({ users: { "owner-user": "owner" }, tokens: { "probe-token": { who: "probe", role: "probe" }, "mgr-token": { who: "Manager", role: "agent" } } }) };
const fetchJwks = async () => ({ ok: true, json: async () => jwks });
const req = (t) => new Request("https://board.test/api/view", { headers: t ? { "cf-access-jwt-assertion": t } : {} });

test("identity comes from our mapping: owner email, service tokens by name, nobody else", async () => {
  resetKeyCache();
  assert.deepEqual(await authenticate(req(await sign(good)), env, fetchJwks, NOW), { who: "owner", role: "owner" });
  assert.deepEqual(await authenticate(req(await sign({ ...good, email: undefined, common_name: "probe-token" })), env, fetchJwks, NOW), { who: "probe", role: "probe" });
  assert.deepEqual(await authenticate(req(await sign({ ...good, email: undefined, common_name: "mgr-token" })), env, fetchJwks, NOW), { who: "Manager", role: "agent" });
  assert.equal(await authenticate(req(await sign({ ...good, ...asUser("stranger-user") })), env, fetchJwks, NOW), null, "valid Access login, no role");
  assert.equal(await authenticate(req(await sign({ ...good, email: undefined, common_name: "unknown-token" })), env, fetchJwks, NOW), null);
  assert.equal(await authenticate(req(null), env, fetchJwks, NOW), null, "no header");
  assert.equal(await authenticate(req(await sign(good)), { ...env, ROLES: "{bad json" }, fetchJwks, NOW), null);
});
