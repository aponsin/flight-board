#!/usr/bin/env node
// #C1056: put a file that is already on this Mac into the board's file store, and print its id, so an agent can attach it to a post or an ask
// (screenshots: ["<id>"]) without typing the bytes through a model (file_put takes base64: a 15 KB picture failed or cost about 20k tokens, and agents gave up).
//   node scripts/put-file.mjs --config <the board config> --env <the probe's env file> <path> [--name <name>]
//   (--config and --env may instead be the BOARD_CONFIG and BOARD_ENV_FILE environment variables)
// It uses the probe's own Access service token (BOARD_SERVICE_TOKEN_ID and BOARD_SERVICE_TOKEN_SECRET in that env file, which must be readable by its owner only),
// the one credential this Mac already holds for the board, and posts to POST /api/probe/file, which only stores a file and returns its id. Nothing is printed of the
// token, and nothing is read from anywhere but the path given.
//
// What may be uploaded is narrow on purpose, because a stored file is readable by every agent and person past Access and the owner's folder also holds secrets
// (the env file, board.private.json): the real path (symlinks resolved) must be inside a root (rootsFor); no part of it below the root may start with a dot or look like a
// secret (SECRET_NAME); it must be a plain file, not owner-only (mode 0600 marks a secret on this Mac), not empty, no bigger than the store's cap, and of a type
// that is a picture or plain text (no JSON). The Worker sniffs the bytes against the type again.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_FILE_BYTES } from "../worker/file-store.mjs";
import { loadEnv, accessHeaders, FETCH_TIMEOUT_MS } from "../collector/probe-board.mjs";
import { runnableText } from "./hooks-check.mjs";

export const TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv" };
// A name part that says "secret". secret, token, password, passwd, credential, apikey and the ssh key file names are refused anywhere in the name (so mytoken.txt, passwords.txt,
// apikey.txt and ssh_id_rsa.txt are refused); private, env, key and cookie only as a whole word (so keyboard.png is fine and my-key.png is not).
export const SECRET_NAME = /(secret|token|password|passwd|credential|api[-_ ]?key|id_rsa|id_ed25519|id_ecdsa|id_dsa)|(^|[^a-z])(private|env|key|keys|cookie|cookies)([^a-z]|$)/i;

const no = (reason) => ({ ok: false, reason });

// The folders a file may come from: the folder that holds the board config (the owner's board folder, where the designs and mockups are kept), and any folders the
// config lists under fileRoots (up to 5, absolute or "~/"). Nothing is named here, and the command line has no way to add a folder: only the owner's own config does.
// Never a repository checkout. Returns { ok, roots } or why not.
const ROOT_SHAPE = /^(\/|~\/)[^\0<>{}\n]{1,300}$/;
export function rootsFor(configPath, { realpath = realpathSync, read = (p) => readFileSync(p, "utf8"), home = homedir(), exists = existsSync } = {}) {
  if (!configPath) return no("--config <the board config> is needed: the folder that holds it is where a file may come from");
  let real; try { real = realpath(configPath); } catch { return no("the board config cannot be read"); }
  let extra = [];
  try {
    const v = JSON.parse(read(real)).fileRoots;
    if (v !== undefined) {
      if (!Array.isArray(v) || v.length > 5 || !v.every((p) => typeof p === "string" && ROOT_SHAPE.test(p) && !p.split("/").some((s) => s === ".." || s === "."))) return no("fileRoots in the board config is not a list of up to 5 absolute folders");
      extra = v.map((p) => (p.startsWith("~/") ? join(home, p.slice(2)) : p));
      // Judged by where each folder really is: never the whole disk, the home folder itself, or a repository checkout (it holds source and settings). A folder that does not exist yet is unused.
      let homeReal = home; try { homeReal = realpath(home); } catch { /* keep home as given */ }
      for (const p of extra) {
        let rr; try { rr = realpath(p); } catch { continue; }
        if (rr === "/" || rr === homeReal) return no("fileRoots may not be the whole disk or the home folder itself");
        if (exists(join(rr, ".git"))) return no("fileRoots may not be a repository checkout (a folder with .git)");
      }
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
  if (st.nlink > 1) return no("the file has another hard link, so it may be the same file as one outside the folders");
  if (st.size === 0) return no("the file is empty");
  if (st.size > MAX_FILE_BYTES) return no(`over the store's ${MAX_FILE_BYTES} byte cap`);
  const type = TYPES[extname(real).toLowerCase()];
  if (!type) return no(`a ${extname(real) || "no-extension"} file: only ${Object.keys(TYPES).join(" ")}`);
  return { ok: true, real, type, size: st.size, name: basename(real) };
}

// #C1170 (11-17: Mainsite could not put four screenshots on the board: no env file on this Mac had a BOARD_BASE_URL line, so the upload had never worked for an agent): the board's address is
// the one the board config already holds for the probe and the other scripts, its storeUrl. Read from the config the command names (--config), never from the command line itself. Returns
// { ok: true, base, file } (base null when the config names none), or a reason that names the file it read. Only https://<host> (and an optional port) is an address.
const HTTPS_HOST = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/;
// Security's S1 on 46a8da4a: --config is a command-line choice, so a config an agent wrote could name any host and the token would go there. The address is therefore read only from a board
// config the OWNER's hooks name: the --config paths in the hook commands of ~/.claude/settings.json (real paths). Any other config's storeUrl is ignored, and the token then goes only
// to a BOARD_BASE_URL the owner wrote beside it in the env file, or nowhere.
export function ownerConfigs(settingsText, { home = homedir(), real = realpathSync } = {}) {
  const out = new Set();
  let doc = null; try { doc = JSON.parse(String(settingsText ?? "")); } catch { return out; } // a settings file is JSON; anything else names no owner config
  if (!doc || typeof doc !== "object" || !doc.hooks) return out; // and only its hooks run something: a permission rule that mentions a path is not the owner's config
  for (const m of runnableText(settingsText).matchAll(/--config\s+(?:'([^']+)'|"([^"]+)"|(\S+))/g)) {
    let p = m[1] ?? m[2] ?? m[3];
    if (p.startsWith("~/")) p = join(home, p.slice(2));
    try { out.add(real(p)); } catch { /* a path that does not resolve names nothing */ }
  }
  return out;
}
const readSettings = () => { try { return readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"); } catch { return ""; } };
export function configAddress(configPath, { read = (p) => readFileSync(p, "utf8"), settingsText = readSettings(), real = realpathSync } = {}) {
  if (!configPath) return { ok: true, base: null, file: null };
  let url; try { url = JSON.parse(read(configPath))?.storeUrl; } catch { return no(`the board config ${configPath} cannot be read as JSON`); }
  if (url === undefined || url === null || url === "") return { ok: true, base: null, file: configPath };
  let owners = false; try { owners = ownerConfigs(settingsText, { real }).has(real(configPath)); } catch { owners = false; }
  if (!owners) return { ok: true, base: null, file: configPath, ignored: true };
  const base = String(url).replace(/\/+$/, "");
  if (!HTTPS_HOST.test(base)) return no(`storeUrl in ${configPath} must be https://<host>`);
  return { ok: true, base, file: configPath };
}

// The env file's credentials, only when the file is readable by its owner alone. Returns { headers, base } or a reason.
// The address is the board config's storeUrl (`address`, from configAddress); a BOARD_BASE_URL line in the env file is still accepted, and the two must agree when both are there.
export function credentials(envFile, { read = (p) => loadEnv(p), stat = statSync, address = null } = {}) {
  if (!envFile) return no("--env <the probe's env file> is needed");
  let st; try { st = stat(envFile); } catch { return no("the env file cannot be read"); }
  if (!st.isFile() || (st.mode & 0o077) !== 0) return no("the env file must be a plain file readable by its owner only (chmod 600)");
  let env; try { env = read(envFile); } catch { return no("the env file cannot be read"); }
  if (!env.BOARD_SERVICE_TOKEN_ID || !env.BOARD_SERVICE_TOKEN_SECRET) return no("the env file has no BOARD_SERVICE_TOKEN_ID and BOARD_SERVICE_TOKEN_SECRET");
  // The address is only ever one the owner wrote in a file (the board config's storeUrl, or BOARD_BASE_URL in the env file with the token): the command line cannot name a host, so the token cannot be sent to one.
  const fromEnv = String(env.BOARD_BASE_URL ?? "").replace(/\/+$/, ""), fromConfig = address?.base ?? "";
  if (fromEnv && fromConfig && fromEnv !== fromConfig) return no(`the board's address differs: BOARD_BASE_URL in ${envFile} and storeUrl in ${address.file} name different hosts: keep one`);
  const base = fromConfig || fromEnv;
  if (!HTTPS_HOST.test(base)) return no(`the board's address must be https://<host>: set storeUrl in the board config the owner's hooks name${address?.file ? ` (${address.file}${address.ignored ? " is not one of them, so its storeUrl was not used" : ""})` : " (--config)"}, or BOARD_BASE_URL in the env file ${envFile}`);
  return { ok: true, headers: accessHeaders(env), base };
}

// Send it. Returns { ok, id, name, type, size } or { ok: false, reason } (the reason is the Worker's rule word, never the token or the response body).
export async function putLocalFile({ path, envFile, configPath, name, fetchImpl = fetch, roots, read, settingsText }) {
  let folders = roots; // a test names them; otherwise they come from the board config
  if (!folders) { const r = rootsFor(configPath); if (!r.ok) return r; folders = r.roots; }
  const p = checkPath(path, { roots: folders });
  if (!p.ok) return p;
  const address = configAddress(configPath, settingsText === undefined ? {} : { settingsText }); // settingsText is for the tests: the command line has no way to set it
  if (!address.ok) return address;
  const c = credentials(envFile, { ...(read ? { read } : {}), address });
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
  // No --base: the token goes only to the address in the env file. Any other flag that names a host is refused before the env file is read.
  if (argv.some((a) => a === "--base" || a.startsWith("--base="))) { err("PUT FAILED: there is no --base: the board's address is storeUrl in the board config (or BOARD_BASE_URL in the env file)"); return exit(1); }
  const flags = new Set(["--env", "--config", "--name"]);
  const path = argv.find((a, i) => !a.startsWith("--") && !flags.has(argv[i - 1]));
  const r = await putLocalFile({ path, envFile: get("--env") ?? process.env.BOARD_ENV_FILE, configPath: get("--config") ?? process.env.BOARD_CONFIG, name: get("--name"), fetchImpl, roots });
  if (!r.ok) { err(`PUT FAILED: ${r.reason}`); return exit(1); }
  out(`FILE ${r.id} ${r.name} ${r.type} ${r.size}`);
  out(`Attach it: screenshots: ["${r.id}"] in a post or an ask, or "${r.id} A: label" under a Decision option.`);
  return exit(0);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main(process.argv.slice(2));
