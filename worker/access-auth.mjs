// Identity for the board Worker (#C719): the Cloudflare Access JWT, checked here and not only at the edge. A request is
// authenticated when Cf-Access-Jwt-Assertion is an RS256 token signed by a key in the team's JWKS, issued by the team domain,
// for this application (aud), not expired. The role comes from OUR mapping (env.ROLES, JSON), never from the token's
// say-so: { "users": { "<owner email>": "owner" }, "tokens": { "<service token common_name>": { "who": "probe", "role": "probe" } } }.
// An unknown identity gets no role, so no answer. env: ACCESS_TEAM_DOMAIN (https://<team>.cloudflareaccess.com), ACCESS_AUD, ROLES.

const b64urlToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

export async function verifyJwt(token, { jwks, issuer, aud, now = Date.now() }) {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) return null;
  let header, claims;
  try { header = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); } catch { return null; }
  if (header.alg !== "RS256") return null; // never "none", never HS256 with a public key
  const jwk = jwks?.keys?.find((k) => k.kid === header.kid && k.kty === "RSA");
  if (!jwk) return null;
  let key;
  try { key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]); } catch { return null; }
  const okSig = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!okSig) return null;
  if (claims.iss !== issuer) return null;
  if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(aud)) return null;
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now) return null;
  if (Number.isFinite(claims.nbf) && claims.nbf * 1000 > now + 60_000) return null;
  return claims;
}

let cache = { at: 0, jwks: null };
async function keys(env, fetchImpl, now) {
  if (cache.jwks && now - cache.at < 10 * 60_000) return cache.jwks;
  const r = await fetchImpl(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) return cache.jwks;
  cache = { at: now, jwks: await r.json() };
  return cache.jwks;
}
export const resetKeyCache = () => { cache = { at: 0, jwks: null }; };

// The Worker's authenticate hook: { who, role } or null.
export async function authenticate(request, env, fetchImpl = fetch, now = Date.now()) {
  const claims = await verifyJwt(request.headers.get("cf-access-jwt-assertion"), { jwks: await keys(env, fetchImpl, now).catch(() => null), issuer: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, now });
  if (!claims) return null;
  let roles;
  try { roles = JSON.parse(env.ROLES ?? "{}"); } catch { return null; }
  if (claims.email) {
    const role = roles.users?.[String(claims.email).toLowerCase()];
    return role ? { who: role === "owner" ? "owner" : String(claims.email), role } : null;
  }
  const t = claims.common_name ? roles.tokens?.[claims.common_name] : null; // a service token's name
  // The name "owner" is the owner's alone: a service token mapped to it with another role gets no identity (Security's nit 1).
  return t?.who && t?.role && (t.who !== "owner" || t.role === "owner") ? { who: t.who, role: t.role } : null;
}
