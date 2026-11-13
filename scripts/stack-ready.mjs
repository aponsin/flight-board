// The builder's push command for a card of a stack-mode repository (#C914). With the stack switch on, reviewers are not woken for a card that has
// a declared stack partner (a later card of the same builder that depends on it and has nothing pushed yet) until a signal covers it. The signal is
// a git note on the commit pushed, in refs/notes/stack-ready (one line `stack-ready` and an ISO time); the collector fetches every notes ref.
//   node scripts/stack-ready.mjs [--config <board.config.json>]
// It pushes the branch, then decides BY ITSELF whether cards are still queued behind this one: it reads <stateDir>/<board>/stack-queue.json (the
// probe's dispatch job writes it each minute: ids only), finds this card by the Board-Id trailer of HEAD, and
//   - when an unstarted card of the same builder and repository depends on this card: prints "more queued" and writes NO note;
//   - otherwise (the last card, a lone card, a card the file does not list): writes the note on HEAD and pushes the notes ref.
// A queue file that is missing, unreadable or older than 15 minutes means no wait is possible: the note is written and the line says so. Never a
// deadlock. There is no flag to remember. Run it inside your checkout, on the build branch, with a clean tree and HEAD's message carrying a Board-Id
// trailer. It refuses, changing nothing, printing `STACK-READY FAILED: <why>` and exiting 1. It also refuses (#C1047) a tip that would undo main: a file
// the branch changes that main changed after the branch's base, where the tip's version is not main's (the list is printed; rebase onto origin/main).
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SIGNAL_REF = "refs/notes/stack-ready";
export const QUEUE_FRESH_MS = 15 * 60e3;

class Refusal extends Error {}
const fail = (why) => { throw new Refusal(why); };

// #C1047: the files this branch changes that main has also changed since the branch left it (their merge base), where the tip's version is not main's:
// the tip's version is older than main's, so taking the tip would undo main. Deletes and renames count as a path gone and a path added (--no-renames);
// the mode counts with the blob (ls-tree), so a lost exec bit is a difference too. Not a file the branch leaves alone, however far behind main it is;
// not a branch cut on main (its base is main, nothing changed after it), nor a rebase onto main; not a file both sides changed to the same thing.
// With no origin/main to compare against, or no common base, nothing is judged (never a deadlock). tryOut(args) -> text, or { error } on a failure.
export const STALE_LISTED = 20;
export const MAIN_REF = "origin/main";
export function staleFiles(tryOut) {
  tryOut(["fetch", "-q", "origin", "main"]);
  const main = tryOut(["rev-parse", "--verify", "-q", `${MAIN_REF}^{commit}`]);
  if (typeof main !== "string" || !main) return [];
  const base = tryOut(["merge-base", "HEAD", main]);
  if (typeof base !== "string") return [];
  const names = (a, b) => { const r = tryOut(["diff", "--name-only", "--no-renames", "-z", a, b]); return typeof r === "string" ? r.split("\0").filter(Boolean) : []; };
  const theirs = new Set(names(base, main));
  const entry = (rev, path) => { const r = tryOut(["ls-tree", rev, "--", path]); return typeof r === "string" ? r.split("\t")[0] : null; };
  return names(base, "HEAD").filter((f) => theirs.has(f) && entry("HEAD", f) !== entry(main, f));
}

// queue: the parsed stack-queue.json ({ at, cards: [{ id, owner_role, repo, dependsOn, started }] }) or null.
// run(args) -> trimmed stdout; throws on a non-zero exit. Injectable so a test can point it at a temp repo. now() -> an ISO time.
export function stackReady({ run, queue = null, now = () => new Date().toISOString() }) {
  const out = (args) => String(run(args)).trim();
  const tryOut = (args) => { try { return out(args); } catch (e) { return { error: String(e?.stderr ?? e?.message ?? e).trim().split("\n")[0] }; } };
  if (tryOut(["rev-parse", "--is-inside-work-tree"]) !== "true") fail("not inside a git checkout");
  const dirty = tryOut(["status", "--porcelain"]);
  if (typeof dirty === "object") fail(`cannot read the tree: ${dirty.error}`);
  if (dirty) fail("the working tree is not clean: commit or stash first");
  const branch = tryOut(["symbolic-ref", "-q", "--short", "HEAD"]);
  if (typeof branch === "object" || !branch) fail("HEAD is not a branch (detached): check out the build branch first");
  const trailer = tryOut(["log", "-1", "--format=%(trailers:key=Board-Id,valueonly)"]);
  if (typeof trailer === "object" || !trailer.trim()) fail("HEAD's message has no Board-Id: trailer in its last paragraph");
  const id = trailer.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  const sha = out(["rev-parse", "HEAD"]);
  // #C1047: a tip that carries an older version of a file main has changed since the branch left it would undo main's work if it were taken as it is
  // (G4 v1 went to review with a pre-#C1008 tree: Pull out, the group rows and the store route were gone). Refused before anything is pushed.
  const stale = staleFiles(tryOut);
  if (stale.length) {
    const shown = stale.slice(0, STALE_LISTED).join(", ") + (stale.length > STALE_LISTED ? ` and ${stale.length - STALE_LISTED} more` : "");
    fail(`the tip does not carry main's change to ${stale.length} file${stale.length === 1 ? "" : "s"} this branch also changes, so landing it would undo main: ${shown}. Rebase onto origin/main (git fetch origin, git rebase origin/main), run the suite again and push`);
  }
  const pushed = tryOut(["push", "origin", "HEAD"]);
  if (typeof pushed === "object") fail(`git push failed: ${pushed.error}`);
  const at12 = sha.slice(0, 12);
  // The queue file, if it is fresh and lists this card.
  const nowMs = Date.parse(now());
  const fresh = !!queue && typeof queue === "object" && Array.isArray(queue.cards) && Number.isFinite(queue.at) && Number.isFinite(nowMs)
    && nowMs - queue.at <= QUEUE_FRESH_MS && queue.at - nowMs <= 60e3;
  let why = "";
  if (!fresh) why = " (the queue file was missing or stale: no wait was possible)";
  else {
    const me = queue.cards.find((k) => k && k.id === id);
    const queued = me ? queue.cards.filter((k) => k && k.id !== id && k.started === false && k.owner_role === me.owner_role && k.repo === me.repo
      && Array.isArray(k.dependsOn) && k.dependsOn.includes(id)).map((k) => String(k.id)) : [];
    if (queued.length) return { branch, sha, signal: false, queued, line: `STACK-READY OK: pushed ${branch} at ${at12}, more queued (${queued.join(", ")}): no signal` };
    // #C1021: a card of a batch (a group) is ready only when every open card of that batch is built: the batch is one review and one pack. Any builder,
    // the same repository. The lead pulls a card out of its batch (clears the batch) to send it alone.
    const batch = typeof me?.batch === "string" ? me.batch : "";
    const waiting = batch ? queue.cards.filter((k) => k && k.id !== id && k.batch === batch && k.repo === me.repo && k.started === false && k.held !== true).map((k) => String(k.id)) : [];
    if (waiting.length) return { branch, sha, signal: false, queued: waiting, line: `STACK-READY OK: pushed ${branch} at ${at12}, waiting for its group ${batch} (${waiting.join(", ")} not built): no signal` };
  }
  // The notes ref is shared by every READY: take what the remote has first, or this checkout's fresh ref would be refused as not a fast-forward.
  // A remote with no such ref yet is fine (nothing to take).
  tryOut(["fetch", "-q", "origin", `+${SIGNAL_REF}:${SIGNAL_REF}`]);
  const noted = tryOut(["notes", `--ref=${SIGNAL_REF}`, "add", "-f", "-m", `stack-ready\n${now()}`, "HEAD"]);
  if (typeof noted === "object") fail(`the branch is pushed but the signal note failed: ${noted.error}`);
  const sent = tryOut(["push", "origin", `${SIGNAL_REF}:${SIGNAL_REF}`]);
  if (typeof sent === "object") fail(`the branch is pushed but the signal could not be pushed: ${sent.error}`);
  return { branch, sha, signal: true, queued: [], line: `STACK-READY OK: pushed ${branch} at ${at12}, signal written${why}` };
}

// The board config: --config <file> (the same path as in your wake-watch line), else $BOARD_CONFIG. Nothing else is read to find it (the user's
// Claude settings are not opened). null when none: the queue is then missing (the note is written, and the line says so).
export function findConfigPath({ args = [], env = {} }) {
  const at = args.indexOf("--config");
  if (at >= 0 && args[at + 1]) return args[at + 1];
  if (env.BOARD_CONFIG) return env.BOARD_CONFIG;
  return null;
}

// <stateDir>/<board>/stack-queue.json as the probe's dispatch job wrote it, or null (no config, no file, unreadable).
export async function readQueue({ configPath }) {
  try {
    if (!configPath) return null;
    const { checkConfig, fullConfig, boardId } = await import("./config.mjs");
    const { home } = await import("../gate/gate.mjs");
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    if (checkConfig(raw).length) return null;
    const config = fullConfig(raw), id = boardId(config);
    if (!id) return null;
    const q = JSON.parse(readFileSync(join(home(config.gate.stateDir), id, "stack-queue.json"), "utf8"));
    return q && typeof q === "object" ? q : null;
  } catch { return null; }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const ci = args.indexOf("--config");
  if (args.some((a, n) => a !== "--config" && !(ci >= 0 && n === ci + 1 && a && !a.startsWith("--")))) { console.error("Usage: node scripts/stack-ready.mjs [--config <board.config.json>]"); process.exit(2); }
  if (ci >= 0 && !args[ci + 1]) { console.error("Usage: node scripts/stack-ready.mjs [--config <board.config.json>]"); process.exit(2); }
  const run = (a) => execFileSync("git", a, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  const queue = await readQueue({ configPath: findConfigPath({ args, env: process.env }) });
  try { console.log(stackReady({ run, queue }).line); } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    console.log(`STACK-READY FAILED: ${e.message}`); process.exit(1);
  }
}
