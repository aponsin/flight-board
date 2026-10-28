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
//       Neither is ever printed. --rotate makes new ones: the old token and URL stop working at once. It first checks the
//       Worker is deployed (else: run deploy). Over SSH (SSH_CONNECTION or SSH_TTY) the clipboard is the remote Mac's, so
//       it stops and asks for --show, which prints the URL once instead of copying it (#C426).
//   Every step ends with the next one's command, and a STOPPED line names what to run next.
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

// Why a step stopped and the command to run next, in one line (#C426: the owner's first secrets run stopped with no
// reason he could see). next is a whole command, ready to paste.
export class Stop extends Error { constructor(message, next = null) { super(message); this.next = next; } }
export const stopLine = (e) => `state: STOPPED: ${String(e.message).split("\n")[0]}${e.next ? `. Next: ${e.next}` : ""}`;
const q = (s) => /^[\w@%+=:,./~-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, "'\\''")}'`;
// The command for one of this copy's steps, written out in full (README: a pack's steps never hold one in a variable).
export const stepCommand = (code, config) => (step, extra = "") => `node ${q(join(code, "scripts", "state-install.mjs"))} ${step} --config ${q(config)}${extra}`;
// Over SSH, pbcopy fills the clipboard of the Mac the script runs on, not the one the owner pastes from (#C426).
export const overSsh = (env) => Boolean(env.SSH_CONNECTION || env.SSH_TTY);
const URL_RE = /^https:\/\/[A-Za-z0-9.-]{1,200}$/;

// The secrets step. Everything that can stop it is checked before anything is made; wrangler runs with its own output
// on the terminal (a question it asks is never hidden), and no question it asks can be answered from a pipe: the deploy
// check gets no stdin, and the secret put is only reached once the Worker exists, where wrangler asks none.
// run(args, opts): wrangler; copy(text): the clipboard; ask(): resolves on Return (or stdin closing); log(line).
export async function secretsStep({ id, dir, toml, url, rotate = false, show = false, env = {}, run, copy, ask, log, cmd, bytes }) {
  const again = (extra = "") => cmd("secrets", ` --url ${q(url ?? "https://flight-board-state.<you>.workers.dev")}${extra}`);
  if (!existsSync(toml)) throw new Stop("no wrangler config for the Worker yet", cmd("worker", " --kv <the KV namespace id> --account <the account id>"));
  if (!URL_RE.test(String(url))) throw new Stop("--url: the Worker's https address, with no path", again(rotate ? " --rotate" : ""));
  // --show prints a bearer secret into the terminal: only where the clipboard can't carry it (Security's LOW on 3b053838).
  if (show && !overSsh(env)) throw new Stop("--show is only for a terminal on the Mac over SSH; here the URL goes to the clipboard", again(rotate ? " --rotate" : ""));
  if (overSsh(env) && !show)
    throw new Stop("this terminal is on the Mac over SSH, so the connector URL would go to the Mac's clipboard, not the one you paste from; --show prints it here once instead", again(`${rotate ? " --rotate" : ""} --show`));
  try { run(["deployments", "list", "--config", toml], { stdio: ["ignore", "ignore", "ignore"] }); }
  catch { throw new Stop(`wrangler finds no deployed Worker "${WORKER_NAME}" on this login (not deployed yet, or logged in to another account); nothing was made`, cmd("deploy")); }
  const s = makeSecrets(dir, url, { rotate, ...(bytes ? { bytes } : {}) });
  try { run(["secret", "put", secretName(id), "--config", toml], { input: workerSecret(s.token, s.path), stdio: ["pipe", "inherit", "inherit"] }); }
  catch { throw new Stop(`wrangler did not take the Worker's secret (its reason is above); the ${s.made ? "new " : ""}token is kept for the next run`, again(show ? " --show" : "")); }
  const connector = `${url}/mcp/${s.path}`;
  if (show) {
    log(`state: token ${s.made ? "made" : "kept"} and written; the Worker has its hash. The connector URL, shown once (it is a bearer secret: don't screenshot it or paste it anywhere but claude.ai's connector):`);
    log(connector);
    log(`state: paste it in claude.ai, Settings, Connectors, as "Flight Board State", then press Return here`);
  } else {
    copy(connector);
    log(`state: token ${s.made ? "made" : "kept"} and written; the Worker has its hash; the connector URL is on the clipboard: paste it in claude.ai, Settings, Connectors, as "Flight Board State", then press Return here`);
  }
  // The URL is a bearer secret: the clipboard is cleared once it is pasted, or when stdin closes (no terminal,
  // Ctrl-D) before Return (Security).
  await ask();
  if (show) log("state: done; clear this terminal's scrollback now (Cmd-K): the URL is in it");
  else { copy(""); log("state: clipboard cleared (a clipboard manager or Universal Clipboard may still hold it: clear it there too)"); }
  log(`state: next: ${cmd("launchd")}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [step, ...args] = process.argv.slice(2);
  const opt = (n) => { const k = args.indexOf(n); return k >= 0 ? args[k + 1] : undefined; };
  const cmdLine = `node ${process.argv.slice(1).map(q).join(" ")}`;
  try {
    let raw;
    try { raw = JSON.parse(readFileSync(opt("--config") ?? "", "utf8")); }
    catch { throw new Stop("--config: no board.config.json there, or it isn't JSON", "the same command with --config <the board.config.json path the pack's steps give>"); }
    const problems = checkConfig(raw);
    if (problems.length) throw new Stop(problems.join("; "), "fix board.config.json, then run the same command again");
    const config = fullConfig(raw), id = boardId(config);
    if (!id) throw new Stop("the config has no board link", "fix board.config.json, then run the same command again");
    const root = resolve(home(config.gate.stateDir), "install");
    try { pinnedSha(CODE, root); } catch (e) { throw new Stop(e.message, "the command exactly as the pack's steps give it (node ~/.flight-board/install/<signed commit>/scripts/state-install.mjs …)"); }
    const toml = join(home(config.gate.stateDir), "worker", "wrangler.toml");
    const cmd = stepCommand(CODE, realpathSync(opt("--config")));
    if (step === "whoami") {
      wrangler(WHOAMI, { stdio: "inherit" });
      console.log(`state: check the account above is yours; next: ${cmd("kv")}`);
    } else if (step === "kv") {
      wrangler(["kv", "namespace", "create", WORKER_NAME], { stdio: "inherit" });
      console.log(`state: next: ${cmd("worker", " --kv <the id printed above> --account <the account id whoami showed>")}`);
    } else if (step === "worker") {
      mkdirSync(dirname(toml), { recursive: true });
      atomic(toml, wranglerToml({ main: join(CODE, "worker", "state-worker.mjs"), kv: opt("--kv"), account: opt("--account") ?? null, writes: opt("--writes") === undefined ? 2000 : Number(opt("--writes")) }));
      console.log(`state: wrangler config written (${toml}); next: ${cmd("deploy")}`);
    } else if (step === "deploy") {
      if (!existsSync(toml)) throw new Stop("no wrangler config for the Worker yet", cmd("worker", " --kv <the KV namespace id> --account <the account id>"));
      wrangler(["deploy", "--config", toml], { stdio: "inherit" });
      console.log(`state: deployed; next: ${cmd("secrets", " --url https://flight-board-state.<you>.workers.dev")} (the address wrangler printed above)`);
    } else if (step === "secrets") {
      await secretsStep({
        id, dir: join(home(config.gate.stateDir), id, "state-secrets"), toml, url: opt("--url"),
        rotate: args.includes("--rotate"), show: args.includes("--show"), env: process.env, run: wrangler, cmd,
        copy: (text) => execFileSync("pbcopy", [], { input: text }),
        ask: () => { const rl = createInterface({ input: process.stdin, output: process.stdout }); return new Promise((done) => { rl.on("close", done); rl.question("", () => rl.close()); }); },
        log: (line) => console.log(line),
      });
    } else if (step === "launchd") {
      const agents = join(homedir(), "Library", "LaunchAgents"), file = join(agents, `${plistLabel(id)}.plist`);
      mkdirSync(agents, { recursive: true });
      atomic(file, plist({ id, node: process.execPath, script: join(CODE, "collector", "state.mjs"), config: realpathSync(opt("--config")), log: join(home(config.gate.stateDir), id, "state.log") }));
      try { execFileSync("launchctl", ["bootout", `gui/${process.getuid()}/${plistLabel(id)}`], { stdio: "ignore" }); } catch { /* not loaded yet */ }
      execFileSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, file], { stdio: "inherit" });
      console.log(`state: the probe runs every minute from ${CODE.slice(-40, -28)} (${file})`);
    } else throw new Stop("usage: state-install.mjs whoami|kv|worker|deploy|secrets|launchd --config <board.config.json> [--kv <id>] [--account <id>] [--writes <n>] [--url <https address>] [--rotate] [--show]", cmd("whoami"));
  } catch (e) {
    // Every stop names what to run next; one this script didn't foresee (wrangler's own, printed above) is a re-run.
    console.error(stopLine(e instanceof Stop ? e : new Stop(e.message, `fix what is printed above, then run the same command again: ${cmdLine}`)));
    process.exit(1);
  }
}
