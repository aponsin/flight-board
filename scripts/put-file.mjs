#!/usr/bin/env node
// #C1056: put a file that is already on this Mac into the board's file store, and print its id, so an agent can attach it to a post or an ask
// (screenshots: ["<id>"]) without typing the bytes through a model (file_put takes base64: a 15 KB picture failed or cost about 20k tokens, and agents gave up).
//   node scripts/put-file.mjs --config <the board config> --env <the probe's env file> <path> [--name <name>] [--base <the board's address>]
//   (--config and --env may instead be the BOARD_CONFIG and BOARD_ENV_FILE environment variables)
// It uses the probe's own Access service token (BOARD_SERVICE_TOKEN_ID and BOARD_SERVICE_TOKEN_SECRET in that env file, which must be readable by its owner only),
// the one credential this Mac already holds for the board, and posts to POST /api/probe/file, which only stores a file and returns its id. Nothing is printed of the
// token, and nothing is read from anywhere but the path given.
//
// What may be uploaded is narrow on purpose, because a stored file is readable by every agent and person past Access and the owner's folder also holds secrets
// (the env file, board.private.json): the real path (symlinks resolved) must be inside a root (rootsFor); no part of it below the root may start with a dot or look like a
// secret (SECRET_NAME); it must be a plain file, not owner-only (mode 0600 marks a secret on this Mac), not empty, no bigger than the store's cap, and of a type
// that is a picture or plain text (no JSON). The Worker sniffs the bytes against the type again.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_FILE_BYTES } from "../worker/file-store.mjs";
import { loadEnv, accessHeaders, FETCH_TIMEOUT_MS } from "../collector/probe-board.mjs";

export const TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv" };
// A name part that says "secret": private, secret, token, credential, password, env, key, as a whole word (so keyboard.png is fine and my-key.png is not).
export const SECRET_NAME = /(^|[^a-z])(private|secret|secrets|token|tokens|credential|credentials|password|passwd|env|key|keys|cookie|cookies)([^a-z]|$)/i;

const no = (reason) => ({ ok: false, reason });

// The folders a file may come from: the folder that holds the board config (the owner's board folder, where the designs and mockups are kept), and any folders the
// config lists under fileRoots (up to 5, absolute or "~/"). Nothing is named here, and the command line has no way to add a folder: only the owner's own config does.
// Never a repository checkout. Returns { ok, roots } or why not.
const ROOT_SHAPE = /^(\/|~\/)[^\0<>{}\n]{1,300}$/;
export function rootsFor(configPath, { realpath = realpathSync, read = (p) => readFileSync(p, "utf8"), home = homedir() } = {}) {
  if (!configPath) return no("--config <the board config> is needed: the folder that holds it is where a file may come from");
  let real; try { real = realpath(configPath); } catch { return no("the board config cannot be read"); }
  let extra = [];
  try {
    const v = JSON.parse(read(real)).fileRoots;
    if (v !== undefined) {
      if (!Array.isArray(v) || v.length > 5 || !v.every((p) => typeof p === "string" && ROOT_SHAPE.test(p) && !p.split("/").includes(".."))) return no("fileRoots in the board config is not a list of up to 5 absolute folders");
      extra = v.map((p) => (p.startsWith("~/") ? join(home, p.slice(2)) : p));
    }
  } catch { return no("the board config cannot be read as JSON"); }
  return { ok: true, roots: [dirname(real), ...extra] };
}

// Pure apart from the file system calls passed in (so a test can drive it): the real path of `input`, or why not.
export function checkPath(input, { roots, realpath = realpathSync, stat = statSync } = {}) {
  if (typeof input !== "string" || !input || input.includes("\0")) return no("give the path of one file");
  if (!isAbsolute(input)) return no("the path must be absolute");
  if (!Array.isArray(roots) || !roots.length) return no("no folder to take a file from");
  let real;
  try { real = realpath(input); } catch { return no("no such file"); }
  let root = null;
  for (const r of roots) {
    let rr; try { rr = realpath(r); } catch { continue; }
    const rel = relative(rr, real);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) { root = { rr, rel }; break; }
  }
  if (!root) return no(`outside the folders a file may come from (${roots.map((r) => r.replace(homedir(), "~")).join(", ")})`);
  const parts = root.rel.split(sep);
  if (parts.some((p) => p.startsWith("."))) return no("a name below the folder starts with a dot");
  if (parts.some((p) => SECRET_NAME.test(p))) return no("a name below the folder looks like a secret (private, secret, token, credential, password, env, key, cookie)");
  const st = stat(real);
  if (!st.isFile()) return no("not a plain file");
  if ((st.mode & 0o077) === 0) return no("the file is readable by its owner only, which marks a secret on this Mac");
  if (st.size === 0) return no("the file is empty");
  if (st.size > MAX_FILE_BYTES) return no(`over the store's ${MAX_FILE_BYTES} byte cap`);
  const type = TYPES[extname(real).toLowerCase()];
  if (!type) return no(`a ${extname(real) || "no-extension"} file: only ${Object.keys(TYPES).join(" ")}`);
  return { ok: true, real, type, size: st.size, name: basename(real) };
}

// The env file's credentials, only when the file is readable by its owner alone. Returns { headers, base } or a reason.
export function credentials(envFile, { read = (p) => loadEnv(p), stat = statSync, baseOverride } = {}) {
  if (!envFile) return no("--env <the probe's env file> is needed");
  let st; try { st = stat(envFile); } catch { return no("the env file cannot be read"); }
  if (!st.isFile() || (st.mode & 0o077) !== 0) return no("the env file must be a plain file readable by its owner only (chmod 600)");
  let env; try { env = read(envFile); } catch { return no("the env file cannot be read"); }
  if (!env.BOARD_SERVICE_TOKEN_ID || !env.BOARD_SERVICE_TOKEN_SECRET) return no("the env file has no BOARD_SERVICE_TOKEN_ID and BOARD_SERVICE_TOKEN_SECRET");
  const base = String(baseOverride ?? env.BOARD_BASE_URL ?? "").replace(/\/+$/, "");
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(base)) return no("the board's address must be https://<host> (BOARD_BASE_URL or --base)");
  return { ok: true, headers: accessHeaders(env), base };
}

// Send it. Returns { ok, id, name, type, size } or { ok: false, reason } (the reason is the Worker's rule word, never the token or the response body).
export async function putLocalFile({ path, envFile, configPath, name, base, fetchImpl = fetch, roots, read }) {
  let folders = roots; // a test names them; otherwise they come from the board config
  if (!folders) { const r = rootsFor(configPath); if (!r.ok) return r; folders = r.roots; }
  const p = checkPath(path, { roots: folders });
  if (!p.ok) return p;
  const c = credentials(envFile, { baseOverride: base, ...(read ? { read } : {}) });
  if (!c.ok) return c;
  let res;
  try {
    res = await fetchImpl(`${c.base}/api/probe/file`, { method: "POST", headers: c.headers, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 4),
      body: JSON.stringify({ name: name ?? p.name, type: p.type, data: readFileSync(p.real).toString("base64") }) });
  } catch (e) { return no(`the board could not be reached (${String(e?.name ?? "error").slice(0, 40)})`); }
  let body = null; try { body = await res.json(); } catch { /* not JSON */ }
  if (res.ok && body?.ok === true && typeof body.id === "string") return { ok: true, id: body.id, name: body.name, type: body.contentType ?? p.type, size: body.sizeBytes ?? p.size };
  // The Worker's refusal is { ok: false, refused: { rule, detail } }; only the rule word is said (the detail can name a type or a size, never worth the line).
  const word = body?.refused?.rule ?? body?.rule ?? body?.error;
  const rule = typeof word === "string" && /^[a-z0-9 -]{1,60}$/i.test(word) ? word : "";
  return no(`the board answered ${res.status}${rule ? ` (${rule})` : ""}`);
}

// roots is for the tests only: the command line has no way to name other folders, only the board config does.
export async function main(argv, { fetchImpl = fetch, out = (l) => console.log(l), err = (l) => console.error(l), exit = (c) => process.exit(c), roots } = {}) {
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const flags = new Set(["--env", "--config", "--name", "--base"]);
  const path = argv.find((a, i) => !a.startsWith("--") && !flags.has(argv[i - 1]));
  const r = await putLocalFile({ path, envFile: get("--env") ?? process.env.BOARD_ENV_FILE, configPath: get("--config") ?? process.env.BOARD_CONFIG, name: get("--name"), base: get("--base"), fetchImpl, roots });
  if (!r.ok) { err(`PUT FAILED: ${r.reason}`); return exit(1); }
  out(`FILE ${r.id} ${r.name} ${r.type} ${r.size}`);
  out(`Attach it: screenshots: ["${r.id}"] in a post or an ask, or "${r.id} A: label" under a Decision option.`);
  return exit(0);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main(process.argv.slice(2));
