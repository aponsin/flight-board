// Run by the owner in Terminal (@@CARD@@, @@WHAT@@), the DELTA deploy: the board store to @@SHORT@@. Made from scripts/pair/deploy.template.mjs by
// scripts/pair/make-pair.mjs; the owner runs the file, not the template. FORWARD ONLY (#C734): the signed commit may be behind main's tip
// (it only has to be ON main, an ancestor of what is fetched), and the checkout is moved to exactly the signed commit; but it is refused
// when the commit the checkout is at now (the last deploy) is not an ancestor of the signed one, so an older pair run late can never roll
// the Worker back behind migrations already applied. It works whether or not the earlier deltas ran: step (2) applies only the D1
// migrations not yet applied (additive). It works in its OWN checkout (board-store-pa), never in board-store-v4, which the three launchd
// jobs run from. Then: (1) it builds the old board page from the team's board.config.json into worker/store-assets (git-ignored); (2)
// applies the unapplied migrations; (3) redeploys the Worker with BUILD_SHA set to the signed commit (no route change, no new secret), then writes @@DEPLOYDONE@@ beside this file. Wrangler is pinned. It reads one private
// settings file (see #C924 below) and writes no secret. It prints one success or failure line. It does NOT import anything and touches no data.
// #C924: when the owner's private settings file board.private.json (in this folder, outside any repository, mode 600) holds cloudflareApiToken
// and cloudflareAccountId, each wrangler call gets them as CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in its environment, so nothing opens a
// browser (works over SSH). They are never an argument, never written anywhere and never printed. Without the file: the browser login, as before.
// Undo: the Worker's previous version stays in Cloudflare: `node <this file> rollback` (#C928: the same token, so it works over SSH; see
// rollbackRun), or by hand `npx wrangler@4.150.0 rollback --config <board-store-pa>/worker/wrangler.board.toml` (new columns stay, empty and
// unused by the older code).
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIGNED = "@@SIGNED@@", REF = "main";
const REPO = "https://github.com/aponsin/flight-board.git";
const WRANGLER = "wrangler@4.150.0";
const SUCCESS = "@@SUCCESS@@";

// @@GUARD-START@@
// The forward-only rule, over a git runner git(...args) -> { status, stdout }: the signed commit is on the fetched main (an ancestor of its
// tip, or the tip itself) and the commit now checked out, if there is one, is an ancestor of it (or it). Moves nothing.
export function forwardOnly(git, signed, ref = "main") {
  if (!/^[0-9a-f]{40}$/.test(String(signed))) return { ok: false, why: "the signed commit is not a full sha" };
  const f = git("fetch", "origin", ref);
  if (f.status !== 0) return { ok: false, why: `git fetch exited ${f.status}` };
  const tip = String(git("rev-parse", "FETCH_HEAD").stdout ?? "").trim();
  if (!/^[0-9a-f]{40}$/.test(tip)) return { ok: false, why: "the fetched main has no commit" };
  if (git("cat-file", "-e", `${signed}^{commit}`).status !== 0) return { ok: false, why: `the signed commit (${signed.slice(0, 8)}) is not in the repository` };
  if (git("merge-base", "--is-ancestor", signed, tip).status !== 0) return { ok: false, why: `the signed commit (${signed.slice(0, 8)}) is not on main` };
  const cur = git("rev-parse", "--verify", "-q", "HEAD^{commit}");
  // A checkout never checked out (a fresh --no-checkout clone, or one a failed run left) has an empty index and no floor: its HEAD is only
  // where the clone found main, not a deploy.
  const files = git("ls-files");
  const current = cur.status === 0 && files.status === 0 && String(files.stdout).trim() !== "" ? String(cur.stdout).trim() : null;
  if (current && git("merge-base", "--is-ancestor", current, signed).status !== 0) return { ok: false, why: `the checkout is at ${current.slice(0, 8)}, which is not behind the signed commit (${signed.slice(0, 8)}): an older pair run after a newer one` };
  return { ok: true, tip, current };
}
// @@GUARD-END@@

// The checkout: cloned if missing, the guard run, then exactly the signed commit checked out, clean. { ok, why }.
export function prepareCheckout({ tree, repo = REPO, signed = SIGNED, ref = REF }) {
  const git = (...a) => spawnSync("git", ["-C", tree, ...a], { encoding: "utf8" });
  if (!existsSync(tree)) {
    const c = spawnSync("git", ["clone", "--no-checkout", repo, tree], { encoding: "utf8" });
    if (c.status !== 0) return { ok: false, why: `git clone exited ${c.status}` };
  }
  const g = forwardOnly(git, signed, ref);
  if (!g.ok) return g;
  // A checkout that has been deployed from must be clean before it moves (a never-checked-out clone shows every file as deleted).
  if (g.current) {
    const before = git("status", "--porcelain");
    if (before.status !== 0 || String(before.stdout).trim() !== "") return { ok: false, why: "the checkout has local changes or untracked files" };
  }
  const co =git("checkout", "--detach", signed);
  if (co.status !== 0) return { ok: false, why: `git checkout exited ${co.status}` };
  if (String(git("rev-parse", "HEAD").stdout).trim() !== signed) return { ok: false, why: "the checkout is not at the signed commit" };
  const dirty = git("status", "--porcelain");
  if (dirty.status !== 0 || String(dirty.stdout).trim() !== "") return { ok: false, why: "the checkout has local changes or untracked files" };
  return { ok: true, tip: g.tip };
}

// #C924: the owner's private settings file, in the folder this file sits in (the folder board.config.json is in). It is only ever read from
// there, never from a repository, and only when it is mode 600. { ok, creds, file, why }: creds is null when the file is absent (the browser
// login, as before) or holds neither value. Nothing it holds is ever in `why`. fs: { lstatSync, existsSync, readFileSync }.
export const PRIVATE_FILE = "board.private.json";
export function loadCloudflare({ dir, fs }) {
  const file = join(dir, PRIVATE_FILE);
  const no = (why) => ({ ok: false, creds: null, file, why });
  let st;
  try { st = fs.lstatSync(file); } catch { return { ok: true, creds: null, file }; }
  if (!st.isFile()) return no(`${file} is not a plain file (a link or a folder is refused)`);
  // Outside any repository: no folder from here up holds a .git, so a settings file can never be committed or pushed by accident.
  for (let d = dir; ; d = dirname(d)) {
    if (fs.existsSync(join(d, ".git"))) return no(`${file} is inside a git repository (${d}); move it to a folder that is not one`);
    if (dirname(d) === d) break;
  }
  if ((st.mode & 0o077) !== 0) return no(`${file} can be read by other users (mode ${(st.mode & 0o777).toString(8)}); run: chmod 600 ${file} (its contents were not read)`);
  let data;
  try { data = JSON.parse(String(fs.readFileSync(file, "utf8"))); } catch { return no(`${file} is not valid JSON (its contents are not shown)`); }
  if (!data || typeof data !== "object" || Array.isArray(data)) return no(`${file} must be a JSON object with cloudflareApiToken and cloudflareAccountId`);
  const token = data.cloudflareApiToken, account = data.cloudflareAccountId;
  const set = (v) => v !== undefined && v !== null && v !== "";
  if (!set(token) && !set(account)) return { ok: true, creds: null, file };
  if (!set(token) || !set(account)) return no(`${file} needs both cloudflareApiToken and cloudflareAccountId, or neither`);
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{8,200}$/.test(token)) return no(`cloudflareApiToken in ${file} is not a Cloudflare API token (letters, digits, - and _ only; its value is not shown)`);
  if (typeof account !== "string" || !/^[0-9a-f]{32}$/.test(account)) return no(`cloudflareAccountId in ${file} is not an account id (32 hex digits; its value is not shown)`);
  return { ok: true, creds: { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account }, file };
}
// Text with the token (and the account id) taken out: every line this file prints, and every error text, goes through it.
export function redact(text, creds) {
  let t = String(text ?? "");
  for (const v of Object.values(creds ?? {})) if (v) t = t.split(v).join("[hidden]");
  return t;
}
// The spawn options with the two variables added to the environment (only when there are creds: without them the options are left as they were).
const withCreds = (opts, creds) => (creds ? { ...opts, env: { ...process.env, ...creds } } : opts);

// #C982: this deploy's result, kept beside this file as board-deploy-last.json { ok, at, line } (plain text, up to 160 characters, the failure's reason
// after the token and account were taken out), overwritten by every run, so a later success replaces an earlier failure. The board's probe reads it from
// this folder and the page header shows "Deploy failed: <reason>" until a deploy succeeds. A result that cannot be written never stops or fails the deploy.
export const LAST_FILE = "board-deploy-last.json";
export function recordLast({ fs, here, ok, line, now = Date.now() }) {
  try { fs.writeFileSync(join(here, LAST_FILE), JSON.stringify({ ok, at: now, line: String(line ?? "").replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) })); } catch { /* never stops the deploy */ }
}

// The deploy over injectable spawn, fs and output: { ok, line }. `say` gets each line printed; nothing here exits the process.
export function deployRun({ here, spawn = spawnSync, fs = { existsSync, lstatSync, readFileSync, writeFileSync }, say = console.log, prepare = prepareCheckout, signed = SIGNED, success = SUCCESS }) {
  const TREE = `${here}/board-store-pa`;
  const CONFIG = `${TREE}/worker/wrangler.board.toml`;
  const BOARD_CONFIG = `${here}/board.config.json`;
  let creds = null, file = join(here, PRIVATE_FILE);
  const stop = (why) => { const line = `DEPLOY FAILED: ${redact(why, creds)}. Nothing further was run. Paste this line to Manager.`; say(line); recordLast({ fs, here, ok: false, line: redact(why, creds) }); return { ok: false, line }; };
  // Without the token the failure line names the file and the two values to fill, not only the login.
  const hint = () => (creds ? "" : `. If wrangler is not signed in: fill cloudflareApiToken and cloudflareAccountId in ${file} (chmod 600), or run npx ${WRANGLER} login`);
  try {
    if (!fs.existsSync(BOARD_CONFIG)) return stop("board.config.json is not in the folder this file is in");
    const c = loadCloudflare({ dir: here, fs });
    file = c.file;
    if (!c.ok) return stop(`${c.why}; nothing was run`);
    creds = c.creds;
    if (creds) say(`Cloudflare: the token and account in ${file} are used (never shown).`);
    const p = prepare({ tree: TREE });
    if (!p.ok) return stop(`${p.why}; nothing was changed`);

    const build = spawn("node", [`${TREE}/scripts/build-store-page.mjs`, BOARD_CONFIG], { encoding: "utf8" });
    if (build.status !== 0) return stop(`the page build exited ${build.status}: ${(build.stderr ?? "").slice(-200).replace(/\s+/g, " ")}`);

    // The migration may ask you to confirm: answer y.
    const mig = spawn("npx", ["--yes", WRANGLER, "d1", "migrations", "apply", "flight-board-store", "--remote", "--config", CONFIG], withCreds({ stdio: "inherit" }, creds));
    if (mig.status !== 0) return stop(`migration exited ${mig.status ?? mig.error?.message}${hint()}`);

    // #C737: the Worker is told which commit it was deployed from (BUILD_SHA); the probe reads it to decide when a board card is live.
    // The value is the commit the checkout is at (read back from git, and the same as the signed one or the run stops): never an argument.
    const checkedOut = String(spawn("git", ["-C", TREE, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout ?? "").trim();
    if (checkedOut !== signed) return stop("the checkout is not at the signed commit; nothing was deployed");
    const dep = spawn("npx", ["--yes", WRANGLER, "deploy", "--config", CONFIG, "--var", `BUILD_SHA:${checkedOut}`], withCreds({ encoding: "utf8" }, creds));
    const said = redact((dep.stdout ?? "") + (dep.stderr ?? "") + (dep.error?.message ?? ""), creds);
    if (dep.status !== 0) return stop(`deploy exited ${dep.status}: ${said.slice(-200).replace(/\s+/g, " ")}${hint()}`);
    const id = /Current Version ID:\s*([0-9a-f-]{36})/i.exec(said)?.[1];
    if (!id) return stop("deployed, but no version id was printed");
    // #C737: the tree step of this pair refuses to move the tree until this file says the Worker carries the signed commit, so the new probe
    // code never runs against a Worker that reports nothing.
    fs.writeFileSync(`${here}/@@DEPLOYDONE@@`, `${signed}\n`);
    const line = `DEPLOY OK: ${success.replace("<version>", id).replace("<sha>", signed.slice(0, 8))}`;
    say(line);
    recordLast({ fs, here, ok: true, line });
    return { ok: true, line };
  } catch (e) {
    return stop(`unexpected error: ${String(e?.message ?? e).slice(0, 200)}`);
  }
}

// #C928: the undo, with the same token. `node <this file> rollback` puts the Worker back on its previous version (wrangler's rollback, pinned,
// against the deploy checkout's own config) with the credentials from the private settings file, so it opens no browser and works over SSH, as the
// deploy does. wrangler asks you to confirm: answer y. It rolls back the Worker only: D1 migrations stay applied (new columns stay, unused by the older
// code) and the tree step is not undone (that has its own `back`). It then removes @@DEPLOYDONE@@ (the marker that says the Worker carries the signed
// commit), so the tree step of this pair refuses until line 1 runs again; a marker that was not there is no failure. { ok, line }; `say` gets each line.
export function rollbackRun({ here, spawn = spawnSync, fs = { existsSync, lstatSync, readFileSync, unlinkSync }, say = console.log }) {
  const CONFIG = `${here}/board-store-pa/worker/wrangler.board.toml`;
  let creds = null, file = join(here, PRIVATE_FILE);
  const stop = (why) => { const line = `ROLLBACK FAILED: ${redact(why, creds)}. Nothing further was run. Paste this line to Manager.`; say(line); return { ok: false, line }; };
  try {
    if (!fs.existsSync(CONFIG)) return stop("this folder has no deploy checkout (board-store-pa), so there is nothing to roll back from here");
    const c = loadCloudflare({ dir: here, fs });
    file = c.file;
    if (!c.ok) return stop(`${c.why}; nothing was run`);
    creds = c.creds;
    if (creds) say(`Cloudflare: the token and account in ${file} are used (never shown).`);
    else say(`No token in ${file}: wrangler uses its own login (run npx ${WRANGLER} login first if it is not signed in).`);
    const r = spawn("npx", ["--yes", WRANGLER, "rollback", "--config", CONFIG], withCreds({ stdio: "inherit" }, creds));
    if (r.status !== 0) return stop(`wrangler rollback exited ${r.status ?? (redact(r.error?.message, creds) || "none")}${creds ? "" : `. If wrangler is not signed in: fill cloudflareApiToken and cloudflareAccountId in ${file} (chmod 600), or run npx ${WRANGLER} login`}`);
    const marker = `${here}/@@DEPLOYDONE@@`;
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
    const line = `ROLLBACK OK: the Worker is back on its previous version; @@DEPLOYDONE@@ is removed, so the tree step refuses until line 1 runs again. The database keeps any new columns.`;
    say(line);
    return { ok: true, line };
  } catch (e) {
    return stop(`unexpected error: ${String(e?.message ?? e).slice(0, 200)}`);
  }
}

// The one argument: none runs the deploy, the word rollback runs the undo; anything else (a typo included) is refused and runs nothing, so a
// mistyped undo can never start a full deploy. "deploy" | "rollback" | null.
export function pickMode(arg) {
  if (arg === undefined) return "deploy";
  return arg === "rollback" ? "rollback" : null;
}

function main() {
  // The folder this file sits in (the owner's board folder, where board.config.json and the checkouts are).
  const here = dirname(fileURLToPath(import.meta.url));
  const mode = pickMode(process.argv[2]);
  if (mode === null) {
    console.log("NOT RUN: the only argument this file takes is the word rollback (or none, to deploy). Nothing was run.");
    process.exit(1);
  }
  const r = mode === "rollback" ? rollbackRun({ here }) : deployRun({ here });
  if (!r.ok) process.exit(1);
}
// #C929: run only when this file is the one node was started with. Both sides go through realpath, so a folder reached through a link (macOS
// /var -> /private/var, say) still runs; and a file started under its own name that still does not match says so and exits 1, never silently nothing.
const real = (p) => { try { return realpathSync(p); } catch { return null; } };
const selfFile = fileURLToPath(import.meta.url);
if (process.argv[1] && real(process.argv[1]) !== null && real(process.argv[1]) === real(selfFile)) main();
else if (process.argv[1] && basename(process.argv[1]) === basename(selfFile)) { console.log("NOT RUN: could not tell that this is the file node was started with (its folder path does not resolve to the same place). Nothing was run. Paste this line to Manager."); process.exit(1); }
