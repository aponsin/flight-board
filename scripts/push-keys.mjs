#!/usr/bin/env node
// The phone push's key (#C904), once, by the owner, after the deploy that brings the push:
//   node scripts/push-keys.mjs --subject https://<the board's address> [--config <board-store-pa>/worker/wrangler.board.toml]
// It makes a new P-256 key pair (VAPID: push services check that pushes come from us) and hands the private key straight to
// `wrangler secret put PUSH_VAPID_JWK` on its stdin. Nothing is printed or written: the key exists only as the Worker's
// secret. The public half is derived from it by the Worker (GET /api/push). Running it again replaces the key; every device
// must then turn pushes on again (old subscriptions belong to the old key).
// --subject is the contact the push services see (RFC 8292): the board's https address, or a mailto: address.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WRANGLER = "wrangler@4.150.0";

export function subjectOk(s) {
  return typeof s === "string" && s.length <= 200 && (/^https:\/\/[a-z0-9.-]+(?::\d+)?\/?$/i.test(s) || /^mailto:[^\s@<>"]+@[^\s@<>"]+$/.test(s));
}

// The secret's text: the private JWK (with x and y) and the subject. Exported for the test, which checks its shape.
export async function newSecret(subject) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const { kty, crv, d, x, y } = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return JSON.stringify({ kty, crv, d, x, y, sub: subject });
}

export function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--subject") out.subject = argv[++i];
    else if (argv[i] === "--config") out.config = argv[++i];
    else out.unknown = argv[i];
  }
  return out;
}

async function main() {
  const a = args(process.argv.slice(2));
  const config = a.config ?? fileURLToPath(new URL("../worker/wrangler.board.toml", import.meta.url));
  if (a.unknown) { console.log(`PUSH KEY NOT SET: unknown argument ${a.unknown}`); process.exit(2); }
  if (!subjectOk(a.subject)) { console.log("PUSH KEY NOT SET: --subject is the board's https address (https://board.example.com) or a mailto: address"); process.exit(2); }
  if (!existsSync(config)) { console.log(`PUSH KEY NOT SET: no ${config}`); process.exit(2); }
  const put = spawnSync("npx", ["--yes", WRANGLER, "secret", "put", "PUSH_VAPID_JWK", "--config", config], { input: await newSecret(a.subject), stdio: ["pipe", "inherit", "inherit"] });
  if (put.status !== 0) { console.log(`PUSH KEY NOT SET: wrangler exited ${put.status}. Nothing was changed on the board.`); process.exit(1); }
  console.log("PUSH KEY SET. Open the board and tap \"Turn on phone pushes\" (on an iPhone: from the Home Screen icon).");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
