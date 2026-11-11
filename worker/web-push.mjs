// Web Push from the Worker itself (#C904, the owner's pick B on #T1793): no model, no Mac, no package. WebCrypto only.
//   encryptPayload: RFC 8291 (Message Encryption for Web Push), content coding aes128gcm (RFC 8188), one record.
//   vapidToken:     RFC 8292 (VAPID), an ES256 JWT the push service checks against our public key.
//   endpointAllowed: a subscription's endpoint must be https on a known push service, so the Worker can be pointed at
//                    nothing else (it fetches that address).
// Pure apart from WebCrypto's randomness, which a test replaces (salt and the server's key pair are parameters).

const enc = new TextEncoder();

export const b64u = {
  encode(bytes) {
    let s = "";
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(text) {
    const s = String(text).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
};

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

// An uncompressed P-256 point (0x04 || x || y) as a JWK's x and y.
function pointJwk(point) {
  if (!(point instanceof Uint8Array) || point.length !== 65 || point[0] !== 4) throw new Error("not an uncompressed P-256 point");
  return { kty: "EC", crv: "P-256", x: b64u.encode(point.slice(1, 33)), y: b64u.encode(point.slice(33)) };
}
export const publicPoint = (jwk) => concat(Uint8Array.of(4), b64u.decode(jwk.x), b64u.decode(jwk.y));

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

// The server's one-off ECDH key pair for a message: { privateJwk, publicPoint }. A test passes RFC 8291's own.
export async function serverKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { privateJwk: jwk, publicPoint: publicPoint(jwk) };
}

// RFC 8291 section 3.4 and RFC 8188: salt(16) || rs(4) || idlen(1) || keyid (the server's public point) || ciphertext.
// One record, so the plaintext is followed by the last-record delimiter 0x02 and no padding.
export async function encryptPayload({ p256dh, auth, payload, salt = crypto.getRandomValues(new Uint8Array(16)), keys }) {
  const ua = typeof p256dh === "string" ? b64u.decode(p256dh) : p256dh;
  const secret = typeof auth === "string" ? b64u.decode(auth) : auth;
  if (secret.length !== 16) throw new Error("auth secret is 16 bytes");
  if (salt.length !== 16) throw new Error("salt is 16 bytes");
  const as = keys ?? await serverKeys();
  const priv = await crypto.subtle.importKey("jwk", { ...as.privateJwk, key_ops: ["deriveBits"], ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const pub = await crypto.subtle.importKey("jwk", { ...pointJwk(ua), ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256));
  const ikm = await hkdf(secret, ecdh, concat(enc.encode("WebPush: info\0"), ua, as.publicPoint), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const text = typeof payload === "string" ? enc.encode(payload) : payload;
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(text, Uint8Array.of(2))));
  const rs = 4096;
  if (text.length + 1 + 16 > rs) throw new Error("payload too long for one record");
  return concat(salt, Uint8Array.of(rs >>> 24, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255), Uint8Array.of(65), as.publicPoint, sealed);
}

// RFC 8292: an ES256 JWT for the push service's origin, at most 24 hours (we use 12), with a contact address.
export const VAPID_HOURS = 12;
export async function vapidToken({ jwk, endpoint, subject, now }) {
  const aud = new URL(endpoint).origin;
  const header = b64u.encode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u.encode(enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + VAPID_HOURS * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto's ECDSA signature is r || s, 64 bytes: exactly JWS's ES256 form.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64u.encode(sig)}`;
}

// The VAPID secret is one private JWK (with x and y, so the public key needs no second setting). null when unusable.
export function vapidJwk(secret) {
  let jwk;
  try { jwk = typeof secret === "string" ? JSON.parse(secret) : null; } catch { return null; }
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || ![jwk.d, jwk.x, jwk.y].every((v) => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v))) return null;
  return jwk;
}

// Known push services only (Security: the Worker fetches this address). Exact hosts, or a subdomain of the named ones.
const PUSH_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com"];
const PUSH_SUFFIXES = [".push.apple.com", ".notify.windows.com"];
export function endpointAllowed(endpoint) {
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || u.port || String(endpoint).length > 1024) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.includes(host) || PUSH_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
}

// One push: the encrypted body and its headers, sent with the given fetch. { ok, gone, status }: gone (404, 410) means the
// subscription is dead and goes from the store.
export async function sendPush({ subscription, payload, jwk, subject, now, fetchFn = fetch, ttl = 86400 }) {
  const body = await encryptPayload({ p256dh: subscription.p256dh, auth: subscription.auth, payload });
  const token = await vapidToken({ jwk, endpoint: subscription.endpoint, subject, now });
  const res = await fetchFn(subscription.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "content-encoding": "aes128gcm",
      ttl: String(ttl),
      urgency: "high",
      authorization: `vapid t=${token}, k=${b64u.encode(publicPoint(jwk))}`,
    },
    body,
    // #C922 (Security's LOW on #C904): never follow a redirect, so a push service's 3xx can't carry our signed POST elsewhere.
    // A 3xx is a failed send like any other non-2xx.
    redirect: "manual",
  });
  return { ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410, status: res.status };
}
