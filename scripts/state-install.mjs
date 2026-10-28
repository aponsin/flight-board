// The owner's install of the board state probe (#C420), run only from the pinned copy of a signed commit, in the
// owner's own terminal (an install pack's steps give the exact commands). Every wrangler call is this script's, at
// WRANGLER_VERSION, from this copy's folder.
//   node ~/.flight-board/install/<sha>/scripts/state-install.mjs whoami --config <board.config.json>
//       the account wrangler is logged in to; kv: makes the Worker's own KV namespace (flight-board-state).
//   node … state-install.mjs worker --config <board.config.json> --kv <namespace id> [--account <account id>]
//       [--writes <KV writes a day, 2000>]
//       writes ~/.flight-board/worker/wrangler.toml (the Worker = this copy's worker/state-worker.mjs, its own name, one
//       workers.dev address, no route, no preview addresses, only the KV namespace the owner made for it); deploy: deploys it.
//   node … state-install.mjs secrets --config <board.config.json> --url https://<worker address> [--rotate]
//       makes the board's token and MCP path (32 and 16 random bytes) into <stateDir>/<board>/state-secrets/secrets.json
//       (0600 in a 0700 folder), hands the Worker their hashes (wrangler secret put, on its stdin) and copies the connector
//       URL to the clipboard for claude.ai's connector settings, then clears the clipboard once the owner presses Return.
//       Neither is ever printed. --rotate makes new ones: the old token and URL stop working at once.
//   node … state-install.mjs launchd --config <board.config.json>
//       writes ~/Library/LaunchAgents/com.flight-board.state.<board>.plist, running THIS copy's collector/state.mjs every
//       60 s (condition A: pinned, never the current link), and loads it.
import { realpathSync, existsSync, mkdirSync, chmodSync, lstatSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { checkConfig, fullConfig, boardId } from "./config.mjs";

const CODE = dirname(dirname(fileURLToPath(import.meta.url)));
const home = (p) => String(p).replace(/^~(?=\/|$)/, homedir());
const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
export const WORKER_NAME = "flight-board-state";

// The signed commit this copy is: its folder must be <install root>/<40 hex>, really (no link). Throws otherwise.
export function pinnedSha(code, root) {
  const sha = basename(code);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("run it from the pinned copy (~/.flight-board/install/<signed commit>), not a checkout");
  let real = null;
  try { real = realpathSync(join(root, sha)); } catch { /* not there */ }
  if (real !== realpathSync(code)) throw new Error("this copy is not the one in the install folder");
  return sha;
}

// The folder for the board's secrets: 0700, this user's, not a link (made so when missing).
export function secretsFolder(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid()) throw new Error("the secrets folder is not a folder of yours");
  chmodSync(dir, 0o700);
  return dir;
}

// The board's token and MCP path: kept when there and well formed (unless rotate), else new. Written 0600 by a fresh
// temp file and a rename. Returns { token, path, made }.
export function makeSecrets(dir, url, { rotate = false, bytes = randomBytes } = {}) {
  if (!/^https:\/\/[A-Za-z0-9.-]{1,200}$/.test(String(url))) throw new Error("--url: the Worker's https address, with no path");
  secretsFolder(dir);
  const file = join(dir, "secrets.json");
  let old = null;
  try { old = JSON.parse(readFileSync(file, "utf8")); } catch { /* none */ }
  const keep = !rotate && /^[0-9a-f]{64}$/.test(old?.token ?? "") && /^[0-9a-f]{32}$/.test(old?.path ?? "");
  const s = keep ? { url, token: old.token, path: old.path } : { url, token: bytes(32).toString("hex"), path: bytes(16).toString("hex") };
  const tmp = `${file}.${process.pid}.part`;
  writeFileSync(tmp, JSON.stringify(s) + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return { token: s.token, path: s.path, made: !keep };
}

// What the Worker holds for the board: hashes only.
export const workerSecret = (token, path) => JSON.stringify({ token: sha256(token), path: sha256(path) });
export const secretName = (id) => `BOARD_${sha256(id).slice(0, 16)}`;

const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
export const plistLabel = (id) => `com.flight-board.state.${id}`;
// The launchd job: the pinned copy's state.mjs, every 60 s, its one line per run to a log in the board's state folder.
export function plist({ id, node, script, config, log }) {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new Error("not a board id");
  if (!/\/install\/[0-9a-f]{40}\/collector\/state\.mjs$/.test(script)) throw new Error("the job must run a pinned copy's collector/state.mjs");
  const args = [node, script, "--config", config].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(plistLabel(id))}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

// The Worker's wrangler config: this copy's Worker under its own name, one workers.dev address and no route (so never
// on another product's zone), no preview addresses, its own KV namespace and nothing else bound (Security, same account
// as other Workers). account: the account id wrangler whoami shows, when given (a login with several accounts then
// can't deploy it elsewhere). writes: the Worker's KV writes a day (the account's are shared).
export function wranglerToml({ main, kv, account = null, writes = 2000 }) {
  if (!/^[0-9a-f]{32}$/.test(String(kv))) throw new Error("--kv: the KV namespace id wrangler printed (32 hex)");
  if (account !== null && !/^[0-9a-f]{32}$/.test(String(account))) throw new Error("--account: the account id wrangler whoami shows (32 hex)");
  if (!(Number.isInteger(writes) && writes >= 50 && writes <= 100000)) throw new Error("--writes: a whole number from 50 to 100000");
  return `name = "${WORKER_NAME}"
main = ${JSON.stringify(main)}
${account ? `account_id = "${account}"\n` : ""}compatibility_date = "2026-10-01"
workers_dev = true
preview_urls = false

[vars]
WRITES_PER_DAY = "${writes}"

[[kv_namespaces]]
binding = "STATE"
id = "${kv}"
`;
}
// wrangler at one exact version (Security: npx would otherwise take the newest from npm, on a terminal logged in to
// Cloudflare), always run from this pinned copy's folder, so no project's own wrangler or config is picked up.
export const WRANGLER_VERSION = "4.150.0";
export const WRANGLER = ["--yes", `wrangler@${WRANGLER_VERSION}`];
export const wrangler = (args, opts = {}) => execFileSync("npx", [...WRANGLER, ...args], { cwd: CODE, ...opts });
// The account wrangler is on, for the owner to read before anything is made there.
const WHOAMI = ["whoami"];

const atomic = (file, text, mode = 0o644) => { const tmp = `${file}.${process.pid}.part`; writeFileSync(tmp, text, { mode, flag: "wx" }); renameSync(tmp, file); };

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [cmd, ...args] = process.argv.slice(2);
  const opt = (n) => { const k = args.indexOf(n); return k >= 0 ? args[k + 1] : undefined; };
  try {
    const raw = JSON.parse(readFileSync(opt("--config") ?? "", "utf8"));
    const problems = checkConfig(raw);
    if (problems.length) throw new Error(problems.join("; "));
    const config = fullConfig(raw), id = boardId(config);
    if (!id) throw new Error("the config has no board link");
    const root = resolve(home(config.gate.stateDir), "install");
    pinnedSha(CODE, root);
    const toml = join(home(config.gate.stateDir), "worker", "wrangler.toml");
    if (cmd === "whoami") {
      wrangler(WHOAMI, { stdio: "inherit" });
    } else if (cmd === "kv") {
      wrangler(["kv", "namespace", "create", WORKER_NAME], { stdio: "inherit" });
    } else if (cmd === "worker") {
      mkdirSync(dirname(toml), { recursive: true });
      atomic(toml, wranglerToml({ main: join(CODE, "worker", "state-worker.mjs"), kv: opt("--kv"), account: opt("--account") ?? null, writes: opt("--writes") === undefined ? 2000 : Number(opt("--writes")) }));
      console.log(`state: wrangler config written (${toml}); deploy it with this script's deploy step`);
    } else if (cmd === "deploy") {
      if (!existsSync(toml)) throw new Error("no wrangler config: run the worker step first");
      wrangler(["deploy", "--config", toml], { stdio: "inherit" });
    } else if (cmd === "secrets") {
      if (!existsSync(toml)) throw new Error("no wrangler config: run the worker step first");
      const s = makeSecrets(join(home(config.gate.stateDir), id, "state-secrets"), opt("--url"), { rotate: args.includes("--rotate") });
      wrangler(["secret", "put", secretName(id), "--config", toml], { input: workerSecret(s.token, s.path), stdio: ["pipe", "ignore", "inherit"] });
      execFileSync("pbcopy", [], { input: `${opt("--url")}/mcp/${s.path}` });
      console.log(`state: token ${s.made ? "made" : "kept"} and written; the Worker has its hash; the connector URL is on the clipboard: paste it in claude.ai, Settings, Connectors, as "Flight Board State", then press Return here`);
      // The URL is a bearer secret: the clipboard is cleared once it is pasted (Security).
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      await new Promise((done) => rl.question("", () => { rl.close(); done(); }));
      execFileSync("pbcopy", [], { input: "" });
      console.log("state: clipboard cleared (a clipboard manager or Universal Clipboard may still hold it: clear it there too)");
    } else if (cmd === "launchd") {
      const agents = join(homedir(), "Library", "LaunchAgents"), file = join(agents, `${plistLabel(id)}.plist`);
      mkdirSync(agents, { recursive: true });
      atomic(file, plist({ id, node: process.execPath, script: join(CODE, "collector", "state.mjs"), config: realpathSync(opt("--config")), log: join(home(config.gate.stateDir), id, "state.log") }));
      try { execFileSync("launchctl", ["bootout", `gui/${process.getuid()}/${plistLabel(id)}`], { stdio: "ignore" }); } catch { /* not loaded yet */ }
      execFileSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, file], { stdio: "inherit" });
      console.log(`state: the probe runs every minute from ${CODE.slice(-40, -28)} (${file})`);
    } else throw new Error("usage: state-install.mjs whoami|kv|worker|deploy|secrets|launchd --config <board.config.json> [--kv <id>] [--account <id>] [--writes <n>] [--url <https address>] [--rotate]");
  } catch (e) { console.error(`state: STOPPED: ${String(e.message).split("\n")[0]}`); process.exit(1); }
}
