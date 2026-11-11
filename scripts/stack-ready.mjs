// The builder's push command for a stack (#C914). With the stack switch on, reviewers are not woken for a card until a signal covers it, so a base
// card pushed alone is never sent to Checker before the stack's next card exists. The signal is a git note on the stack tip commit, in
// refs/notes/stack-ready (one line `stack-ready` and an ISO time); the collector fetches every notes ref and reads it.
//   node scripts/stack-ready.mjs --more   push the branch only: cards are still queued for the stack (no signal)
//   node scripts/stack-ready.mjs          push the branch and write the signal on HEAD: this is the READY (the last queued card)
// Run it inside your checkout, on the build branch, with a clean tree and HEAD's message carrying a Board-Id trailer. Forgetting --more errs toward
// an early review, never a deadlock. It refuses, changing nothing, printing `STACK-READY FAILED: <why>` and exiting 1.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SIGNAL_REF = "refs/notes/stack-ready";

class Refusal extends Error {}
const fail = (why) => { throw new Refusal(why); };

// run(args) -> trimmed stdout; throws on a non-zero exit. Injectable so a test can point it at a temp repo.
export function stackReady({ run, more = false, now = () => new Date().toISOString() }) {
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
  const sha = out(["rev-parse", "HEAD"]);
  const pushed = tryOut(["push", "origin", "HEAD"]);
  if (typeof pushed === "object") fail(`git push failed: ${pushed.error}`);
  if (more) return { branch, sha, signal: false, line: `STACK-READY OK: pushed ${branch} at ${sha.slice(0, 12)}, more queued (no signal)` };
  // The notes ref is shared by every READY: take what the remote has first, or this checkout's fresh ref would be refused as not a fast-forward.
  // A remote with no such ref yet is fine (nothing to take).
  tryOut(["fetch", "-q", "origin", `+${SIGNAL_REF}:${SIGNAL_REF}`]);
  const noted = tryOut(["notes", `--ref=${SIGNAL_REF}`, "add", "-f", "-m", `stack-ready\n${now()}`, "HEAD"]);
  if (typeof noted === "object") fail(`the branch is pushed but the signal note failed: ${noted.error}`);
  const sent = tryOut(["push", "origin", `${SIGNAL_REF}:${SIGNAL_REF}`]);
  if (typeof sent === "object") fail(`the branch is pushed but the signal could not be pushed: ${sent.error}`);
  return { branch, sha, signal: true, line: `STACK-READY OK: pushed ${branch} at ${sha.slice(0, 12)}, signal written` };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== "--more")) { console.error("Usage: node scripts/stack-ready.mjs [--more]"); process.exit(2); }
  const run = (a) => execFileSync("git", a, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  try { console.log(stackReady({ run, more: args.includes("--more") }).line); } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    console.log(`STACK-READY FAILED: ${e.message}`); process.exit(1);
  }
}
