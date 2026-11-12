// The deploy half of the board Worker's self-deploy (#C968), run in Cloudflare's Git build only AFTER scripts/self-deploy-gate.mjs passed (the build
// command is "<hash check of the gate> && node scripts/self-deploy-gate.mjs && node scripts/self-deploy-run.mjs"). It refuses to run without the
// gate's marker (.self-deploy-ok) naming the commit checked out; with no marker (the gate said "already deployed", or never ran) it does nothing and
// exits 0. Then, as the owner's pair does (scripts/pair/deploy.template.mjs): the board config from the build variable BOARD_CONFIG_JSON written
// outside the repository, the store page built from it, the D1 migrations applied (remote), and the Worker deployed with BUILD_SHA set to the commit.
// Wrangler is pinned. The token (CLOUDFLARE_API_TOKEN, a build secret) and the account (CLOUDFLARE_ACCOUNT_ID) are in the build's environment and
// are never an argument and never printed; every line printed goes through redact. The phone push "board deployed <short sha>" is the Worker's
// own (worker/push-rules.mjs, from its BUILD_SHA): nothing here sends it.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const WRANGLER = "wrangler@4.150.0", MARKER = ".self-deploy-ok", CONFIG = "worker/wrangler.board.toml";
const FULL = /^[0-9a-f]{40}$/;

export function redact(text, env) {
  let t = String(text ?? "");
  for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "BOARD_CONFIG_JSON"]) if (env?.[k] && String(env[k]).length >= 8) t = t.split(String(env[k])).join("[hidden]");
  return t;
}

// The run over injectable spawn, fs and output: { ok, skipped?, line }. Nothing here exits the process.
export function selfDeployRun({ env = process.env, spawn = spawnSync, fs = { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync }, say = console.log, tmp = tmpdir() } = {}) {
  const stop = (why) => { const line = `SELF-DEPLOY FAILED: ${redact(why, env)}. Nothing further was run.`; say(line); return { ok: false, line }; };
  let dir = null;
  try {
    if (!fs.existsSync(MARKER)) { const line = "SELF-DEPLOY SKIP: the gate left no marker (already deployed, or the gate did not run); nothing was deployed"; say(line); return { ok: true, skipped: true, line }; }
    const marked = String(fs.readFileSync(MARKER, "utf8")).trim();
    const head = String(spawn("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout ?? "").trim();
    if (!FULL.test(marked) || marked !== head) return stop("the gate's marker does not name the commit checked out");
    if (env.WORKERS_CI_COMMIT_SHA && env.WORKERS_CI_COMMIT_SHA !== head) return stop("the build's commit is not the commit checked out");
    if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) return stop("the build has no CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID");
    if (!env.BOARD_CONFIG_JSON) return stop("the build variable BOARD_CONFIG_JSON (the board config) is not set");
    try { JSON.parse(env.BOARD_CONFIG_JSON); } catch { return stop("BOARD_CONFIG_JSON is not valid JSON (its contents are not shown)"); }
    dir = fs.mkdtempSync(join(tmp, "self-deploy-"));
    const cfg = join(dir, "board.config.json");
    fs.writeFileSync(cfg, env.BOARD_CONFIG_JSON, { mode: 0o600 });
    const out = (r) => redact(`${r.stdout ?? ""}${r.stderr ?? ""}${r.error?.message ?? ""}`, env).slice(-200).replace(/\s+/g, " ");
    const build = spawn("node", ["scripts/build-store-page.mjs", cfg], { encoding: "utf8" });
    if (build.status !== 0) return stop(`the page build exited ${build.status}: ${out(build)}`);
    const mig = spawn("npx", ["--yes", WRANGLER, "d1", "migrations", "apply", "flight-board-store", "--remote", "--config", CONFIG], { encoding: "utf8", env: { ...env, CI: "true" } });
    if (mig.status !== 0) return stop(`migration exited ${mig.status}: ${out(mig)}`);
    const dep = spawn("npx", ["--yes", WRANGLER, "deploy", "--config", CONFIG, "--var", `BUILD_SHA:${head}`], { encoding: "utf8", env });
    if (dep.status !== 0) return stop(`deploy exited ${dep.status}: ${out(dep)}`);
    const id = /Current Version ID:\s*([0-9a-f-]{36})/i.exec(redact(`${dep.stdout ?? ""}${dep.stderr ?? ""}`, env))?.[1];
    if (!id) return stop("deployed, but no version id was printed");
    const line = `SELF-DEPLOY OK: the Worker carries ${head.slice(0, 12)} (version ${id}); the board's phone push will say so`;
    say(line);
    return { ok: true, line };
  } catch (e) {
    return stop(`unexpected error: ${String(e?.message ?? e).slice(0, 200)}`);
  } finally { if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the build's disk is thrown away */ } } }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const r = selfDeployRun();
  process.exit(r.ok ? 0 : 1);
}
