// The gate of the board Worker's self-deploy (#C968; the owner chose B on #T1837 and accepted change 4 on #T1779; Security's design note is
// c968-credential-design.md, in the owner's shared folder). It runs in Cloudflare's own Git build (Workers Builds), the only place the deploy token lives, as the
// FIRST thing the build command does, and the build command checks this file's sha256 against a hash the owner typed in the dashboard before it runs it:
//   [ "$(sha256sum scripts/self-deploy-gate.mjs | cut -c1-64)" = <hash> ] && node scripts/self-deploy-gate.mjs && node scripts/self-deploy-run.mjs
// so a commit to main cannot weaken the gate: changing it means the owner updates one hash in the dashboard.
// It refuses (exit 1, nothing deployed, one line per reason, the token never printed) unless:
//   - the build's commit (WORKERS_CI_COMMIT_SHA, or --commit) is origin/main's tip;
//   - it carries a Security note whose first line starts SECURE and a Checker note whose first line starts PASS (git notes are keyed by the commit,
//     so they name that exact sha);
//   - the Worker's current BUILD_SHA (read from Cloudflare with the build's token) is an ancestor of it: forward only, as the pairs are. A BUILD_SHA it
//     cannot read, or that is not a full sha, refuses (a first deploy is the owner's, by a pair).
// When the commit IS the current BUILD_SHA nothing is to be deployed: it says so, exits 0 and writes no marker; self-deploy-run.mjs then does nothing.
// When all hold it prints GATE OK and writes .self-deploy-ok (the commit) for self-deploy-run.mjs, which refuses to run without it.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const NOTES = { security: "refs/notes/security", checker: "refs/notes/checker" };
export const MARKER = ".self-deploy-ok";
const FULL = /^[0-9a-f]{40}$/;
const first = (t) => String(t ?? "").split("\n")[0].trim();

// The verdict, from the facts only. commit, tip, current: shas (current null/"" when unreadable); notes { checker, security }: the note texts or null;
// descends: the current BUILD_SHA is an ancestor of commit. Returns { ok, same, refusals }.
export function gateVerdict({ commit, tip, notes, current, descends }) {
  const r = [];
  if (!FULL.test(String(commit))) return { ok: false, same: false, refusals: ["the build's commit is not a full sha"] };
  if (!FULL.test(String(tip))) r.push("origin/main's tip could not be read");
  else if (commit !== tip) r.push(`the build's commit ${commit.slice(0, 12)} is not main's tip ${tip.slice(0, 12)}`);
  if (!/^SECURE\b/.test(first(notes?.security))) r.push("no SECURE from Security on this commit");
  if (!/^PASS\b/.test(first(notes?.checker))) r.push("no PASS from Checker on this commit");
  if (!FULL.test(String(current ?? ""))) r.push("the Worker's current BUILD_SHA could not be read as a full sha (a first deploy is the owner's, by a pair)");
  const same = FULL.test(String(current ?? "")) && current === commit;
  if (FULL.test(String(current ?? "")) && !same && !descends) r.push(`the commit does not descend from the Worker's current BUILD_SHA ${current.slice(0, 12)}: forward only`);
  return { ok: r.length === 0, same: same && r.length === 0, refusals: r };
}

// The Worker's deployed BUILD_SHA from Cloudflare: GET /accounts/<id>/workers/scripts/<name>/settings, the plain_text binding BUILD_SHA. null on anything
// else (no token, a failed call, no such binding). Nothing here is printed.
export async function currentBuildSha({ accountId, token, script, fetchFn = fetch }) {
  try {
    if (!/^[0-9a-f]{32}$/.test(String(accountId)) || !token || !/^[A-Za-z0-9._-]{1,100}$/.test(String(script))) return null;
    const res = await fetchFn(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${script}/settings`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const body = await res.json();
    const b = (body?.result?.bindings ?? []).find((x) => x && x.name === "BUILD_SHA" && x.type === "plain_text");
    return typeof b?.text === "string" && FULL.test(b.text) ? b.text : null;
  } catch { return null; }
}

// The Worker's script name from the wrangler config's first `name = "..."` line.
export function scriptName(toml) { return /^name\s*=\s*"([A-Za-z0-9._-]{1,100})"/m.exec(String(toml ?? ""))?.[1] ?? null; }

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2), ci = args.indexOf("--commit");
  const commit = String((ci >= 0 ? args[ci + 1] : process.env.WORKERS_CI_COMMIT_SHA) ?? "").trim();
  const git = (a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const quiet = (a) => { try { return git(a); } catch { return null; } };
  const refuse = (lines) => { console.log(`GATE REFUSED: nothing was deployed\n- ${lines.join("\n- ")}`); process.exit(1); };
  if (!FULL.test(commit)) refuse(["the build's commit is not a full sha (WORKERS_CI_COMMIT_SHA or --commit)"]);
  quiet(["fetch", "-q", "origin", "main"]);
  const tip = quiet(["rev-parse", "FETCH_HEAD"]);
  for (const [, ref] of Object.entries(NOTES)) quiet(["fetch", "-q", "origin", `+${ref}:${ref}`]);
  const notes = Object.fromEntries(Object.entries(NOTES).map(([who, ref]) => [who, quiet(["notes", `--ref=${ref.replace(/^refs\/notes\//, "")}`, "show", commit])]));
  const toml = existsSync("worker/wrangler.board.toml") ? readFileSync("worker/wrangler.board.toml", "utf8") : "";
  const current = await currentBuildSha({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN, script: scriptName(toml) });
  const descends = FULL.test(String(current)) && quiet(["merge-base", "--is-ancestor", current, commit]) !== null;
  const v = gateVerdict({ commit, tip, notes, current, descends });
  if (!v.ok) refuse(v.refusals);
  if (v.same) { console.log(`GATE SKIP: the Worker already carries ${commit.slice(0, 12)}; nothing to deploy`); process.exit(0); }
  writeFileSync(MARKER, `${commit}\n`);
  console.log(`GATE OK: ${commit.slice(0, 12)} is main's tip, signed, and ahead of the Worker's ${current.slice(0, 12)}`);
}
