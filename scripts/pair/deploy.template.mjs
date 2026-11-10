// Run by the owner in Terminal (@@CARD@@, @@WHAT@@), the DELTA deploy: the board store to @@SHORT@@. Made from scripts/pair/deploy.template.mjs by
// scripts/pair/make-pair.mjs; the owner runs the file, not the template. FORWARD ONLY (#C734): the signed commit may be behind main's tip
// (it only has to be ON main, an ancestor of what is fetched), and the checkout is moved to exactly the signed commit; but it is refused
// when the commit the checkout is at now (the last deploy) is not an ancestor of the signed one, so an older pair run late can never roll
// the Worker back behind migrations already applied. It works whether or not the earlier deltas ran: step (2) applies only the D1
// migrations not yet applied (additive). It works in its OWN checkout (board-store-pa), never in board-store-v4, which the three launchd
// jobs run from. Then: (1) it builds the old board page from the team's board.config.json into worker/store-assets (git-ignored); (2)
// applies the unapplied migrations; (3) redeploys the Worker (no route change, no new secret). Wrangler is pinned. It reads no secret and
// writes none. It prints one success or failure line. It does NOT import anything and touches no data.
// Undo: the Worker's previous version stays in Cloudflare: `npx wrangler@4.150.0 rollback --config <board-store-pa>/worker/wrangler.board.toml`
// (new columns stay, empty and unused by the older code).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
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

function main() {
  // The folder this file sits in (the owner's board folder, where board.config.json and the checkouts are).
  const HERE = dirname(fileURLToPath(import.meta.url));
  const TREE = `${HERE}/board-store-pa`;
  const CONFIG = `${TREE}/worker/wrangler.board.toml`;
  const BOARD_CONFIG = `${HERE}/board.config.json`;
  const fail = (why) => { console.log(`DEPLOY FAILED: ${why}. Nothing further was run. Paste this line to Manager.`); process.exit(1); };
  if (!existsSync(BOARD_CONFIG)) fail("board.config.json is not in the folder this file is in");
  const p = prepareCheckout({ tree: TREE });
  if (!p.ok) fail(`${p.why}; nothing was changed`);

  const build = spawnSync("node", [`${TREE}/scripts/build-store-page.mjs`, BOARD_CONFIG], { encoding: "utf8" });
  if (build.status !== 0) fail(`the page build exited ${build.status}: ${(build.stderr ?? "").slice(-200).replace(/\s+/g, " ")}`);

  // The migration may ask you to confirm: answer y.
  const mig = spawnSync("npx", ["--yes", WRANGLER, "d1", "migrations", "apply", "flight-board-store", "--remote", "--config", CONFIG], { stdio: "inherit" });
  if (mig.status !== 0) fail(`migration exited ${mig.status ?? mig.error?.message}`);

  const dep = spawnSync("npx", ["--yes", WRANGLER, "deploy", "--config", CONFIG], { encoding: "utf8" });
  const said = (dep.stdout ?? "") + (dep.stderr ?? "") + (dep.error?.message ?? "");
  if (dep.status !== 0) fail(`deploy exited ${dep.status}: ${said.slice(-200).replace(/\s+/g, " ")}`);
  const id = /Current Version ID:\s*([0-9a-f-]{36})/i.exec(said)?.[1];
  if (!id) fail("deployed, but no version id was printed");
  console.log(`DEPLOY OK: ${SUCCESS.replace("<version>", id).replace("<sha>", SIGNED.slice(0, 8))}`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
