// The builder's push command for a card of a stack-mode repository (#C914). With the stack switch on, reviewers are not woken for a card that has
// a declared stack partner (a later card of the same builder that depends on it and has nothing pushed yet) until a signal covers it. The signal is
// a git note on the commit pushed, in refs/notes/stack-ready (one line `stack-ready` and an ISO time); the collector fetches every notes ref.
//   node scripts/stack-ready.mjs [--config <board.config.json>]
// It pushes the branch, then decides BY ITSELF whether cards are still queued behind this one: it reads <stateDir>/<board>/stack-queue.json (the
// probe's dispatch job writes it each minute: ids only), finds this card by the Board-Id trailer of HEAD, and
//   - when an unstarted card of the same builder and repository depends on this card: prints "more queued" and writes NO note;
//   - otherwise (the last card, a lone card, a card the file does not list): writes the note on HEAD and pushes the notes ref.
// #C1066: the signal also notes the head of every started member of the group or stack (same batch, or a declared partner either way, same repository) that declared READY (a
// waiting note in refs/notes/stack-ready-waiting, written when it was told to wait), so a member built before the group was whole is covered at that head; a start push, a later
// push of it, or a card that joins later, waits for its own signal.
// A queue file that is missing, unreadable or older than 15 minutes means no wait is possible: the note is written and the line says so. Never a
// deadlock. There is no flag to remember. Run it inside your checkout, on the build branch, with a clean tree and HEAD's message carrying a Board-Id
// trailer. It refuses, changing nothing, printing `STACK-READY FAILED: <why>` and exiting 1. It also refuses (#C1047) a tip that would undo main: a file
// the branch changes that main changed after the branch's base, where the tip's version is not main's (the list is printed; rebase onto origin/main).
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_FILE, FOLD_CARD, dataDiffArgs, addedDatedLines } from "./board-land.mjs";
import { stageRank, sameRepo } from "../worker/group-rule.mjs"; // #C1391: the one group stage (the queue file carries each card's `stage`)

export const SIGNAL_REF = "refs/notes/stack-ready";
// #C1066 (Checker 2's M1 on 34f1dbaa): a card that ran stack-ready and was told to wait ("more queued" or "waiting for its group") leaves a note on that head in this ref. The probe
// does not read it as a signal; the final signal of the group notes a member's head only when that exact head carries one, so a member that only made a WIP start push, or pushed
// again after it waited, is never noted as READY.
export const WAITING_REF = "refs/notes/stack-ready-waiting";
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

// #C1166 (5): the landing job's rule, over every card in origin/main..HEAD (a stacked branch carries the cards below its tip): when the range adds a dated line to docs/DATA.md, every card
// it carries must be the fold card. Returns null when the rule holds (or git could not give the log or the diff: no origin/main here, the landing job reads it again), else
// { sha, card } naming the commit that adds the line and the card its Board-Id trailer names (or, when no single commit shows it, the first card that is not the fold card).
// tryOut(args) -> text, or { error }.
export function dataLineOffender(tryOut) {
  const total = tryOut(dataDiffArgs(MAIN_REF, "HEAD"));
  if (typeof total !== "string" || !(addedDatedLines(total) > 0)) return null;
  const log = tryOut(["log", "--no-merges", "--reverse", "--format=%H%x1f%(trailers:key=Board-Id,valueonly,separator=%x2c)%x1e", `${MAIN_REF}..HEAD`]);
  if (typeof log !== "string") return null;
  const commits = log.split("\x1e").map((r) => r.trim()).filter(Boolean).map((rec) => {
    const [sha, ids = ""] = rec.split("\x1f");
    return { sha, cards: ids.split(/[\n,]/).map((x) => x.trim()).filter(Boolean) };
  });
  const cards = new Set(commits.flatMap((c) => c.cards));
  if (cards.size && [...cards].every((c) => FOLD_CARD.test(c))) return null;
  for (const c of commits) {
    const diff = tryOut(["show", "-U0", "--no-renames", "--format=", c.sha, "--", DATA_FILE]);
    if (typeof diff === "string" && addedDatedLines(diff) > 0) {
      // A fold card's own line is no fault; what the landing job refuses is the non-fold card on the same head, so that one is named (Checker 2's LOW): its fragment file is the way out.
      const card = c.cards.at(-1) ?? null;
      return { sha: c.sha, card: card && FOLD_CARD.test(card) ? [...cards].find((x) => !FOLD_CARD.test(x)) ?? card : card };
    }
  }
  return { sha: null, card: [...cards].find((c) => !FOLD_CARD.test(c)) ?? null };
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
  // #C1161 (11-17: #C1128 put its dated line straight into docs/DATA.md and only Security's read caught that the landing job would refuse it): the landing job's own check, run before
  // the push. A card that is not the fold card (a Board-Id starting fold-data-fragments) must not ADD a dated line to docs/DATA.md; its line goes in docs/DATA.d/<card id>.md.
  // A diff git could not give (no origin/main in this checkout) is not read as a refusal: the landing job reads it again.
  // #C1166 (5): the check is per card, as the landing job's is over every card in origin/main..HEAD, naming the card whose commit adds the line (a stacked branch carries the cards below it too).
  const offender = dataLineOffender(tryOut);
  if (offender) fail(`${!offender.sha || offender.sha === sha ? "this branch" : `commit ${offender.sha.slice(0, 12)}`} adds a dated line to ${DATA_FILE} for ${offender.card ? `card ${offender.card}` : "a commit with no Board-Id"}, which the landing job refuses: write it to docs/DATA.d/${offender.card ?? id}.md and take it out of ${DATA_FILE} (only the fold card, a Board-Id starting fold-data-fragments, adds dated lines there; a row or a principle may still be edited in the file)`);
  const pushed = tryOut(["push", "origin", "HEAD"]);
  if (typeof pushed === "object") fail(`git push failed: ${pushed.error}`);
  const at12 = sha.slice(0, 12);
  // The queue file, if it is fresh and lists this card.
  const nowMs = Date.parse(now());
  const fresh = !!queue && typeof queue === "object" && Array.isArray(queue.cards) && Number.isFinite(queue.at) && Number.isFinite(nowMs)
    && nowMs - queue.at <= QUEUE_FRESH_MS && queue.at - nowMs <= 60e3;
  let why = "", members = [];
  if (!fresh) why = " (the queue file was missing or stale: no wait was possible)";
  else {
    const me = queue.cards.find((k) => k && k.id === id);
    // #C1066 (Checker 2's M1): the signal on this head is READY for the whole group or stack that waited for it, so the heads of the members already pushed are noted
    // too (below): a card of the same batch, or one this card depends on or that depends on it, same repository, started. A later push of a member is a new head the
    // note does not cover, and a card that joins the group later has no note either: both wait for their own signal.
    members = me ? queue.cards.filter((k) => k && k.id !== id && k.started === true && k.repo === me.repo
      && ((typeof me.batch === "string" && me.batch !== "" && k.batch === me.batch) || (Array.isArray(k.dependsOn) && k.dependsOn.includes(id)) || (Array.isArray(me.dependsOn) && me.dependsOn.includes(k.id)))).map((k) => String(k.id)) : [];
    const queued = me ? queue.cards.filter((k) => k && k.id !== id && k.started === false && k.owner_role === me.owner_role && k.repo === me.repo
      && Array.isArray(k.dependsOn) && k.dependsOn.includes(id)).map((k) => String(k.id)) : [];
    const wait = () => { tryOut(["fetch", "-q", "origin", `+${WAITING_REF}:${WAITING_REF}`]); const w = tryOut(["notes", `--ref=${WAITING_REF}`, "add", "-f", "-m", `stack-ready-waiting\n${now()}`, "HEAD"]); if (typeof w !== "object") tryOut(["push", "origin", `${WAITING_REF}:${WAITING_REF}`]); };
    if (queued.length) { wait(); return { branch, sha, signal: false, queued, line: `STACK-READY OK: pushed ${branch} at ${at12}, more queued (${queued.join(", ")}): no signal` }; }
    // #C1021, #C1391: a card of a batch (a group) is ready only when every OTHER counted member of the batch (open, any builder, the same repository, a paused or blocked one included) is
    // `built` or later: the batch is one review and one pack. The stage is the queue file's (worker/group-rule.mjs stageOf); a queue file with no stage gives the waiting note, never a signal.
    // The lead pulls a card out of its batch (clears the batch) to send it alone.
    const batch = typeof me?.batch === "string" ? me.batch : "";
    const waiting = batch ? queue.cards.filter((k) => k && k.id !== id && k.batch === batch && sameRepo(k.repo, me.repo) && !(stageRank(k.stage) >= stageRank("built"))).map((k) => String(k.id)) : [];
    if (waiting.length) { wait(); return { branch, sha, signal: false, queued: waiting, line: `STACK-READY OK: pushed ${branch} at ${at12}, waiting for its group ${batch} (${waiting.join(", ")} not built): no signal` }; }
  }
  // The notes ref is shared by every READY: take what the remote has first, or this checkout's fresh ref would be refused as not a fast-forward.
  // A remote with no such ref yet is fine (nothing to take).
  tryOut(["fetch", "-q", "origin", `+${SIGNAL_REF}:${SIGNAL_REF}`]);
  const noted = tryOut(["notes", `--ref=${SIGNAL_REF}`, "add", "-f", "-m", `stack-ready\n${now()}`, "HEAD"]);
  if (typeof noted === "object") fail(`the branch is pushed but the signal note failed: ${noted.error}`);
  // The newest remote tip carrying each member's Board-Id trailer (a stale -vN branch of the card is older); a member with no such tip is left out.
  const noted12 = [];
  if (members.length) {
    tryOut(["fetch", "-q", "origin"]);
    tryOut(["fetch", "-q", "origin", `+${WAITING_REF}:${WAITING_REF}`]);
    const refs = tryOut(["for-each-ref", "--sort=-committerdate", "--format=%(objectname)", "refs/remotes/origin"]);
    const tips = typeof refs === "string" ? refs.split("\n").map((l) => l.trim()).filter((l) => /^[0-9a-f]{40}$/.test(l)) : [];
    for (const m of members) {
      const tip = tips.find((t) => { const tr = tryOut(["log", "-1", "--format=%(trailers:key=Board-Id,valueonly)", t]); return typeof tr === "string" && tr.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) === m; });
      if (!tip || tip === sha) continue;
      if (typeof tryOut(["notes", `--ref=${WAITING_REF}`, "show", tip]) !== "string") continue;
      // only a head its builder declared READY: it ran stack-ready on exactly this head and was told to wait (a start push, or a push after the wait, carries no such note)
      const n = tryOut(["notes", `--ref=${SIGNAL_REF}`, "add", "-f", "-m", `stack-ready\n${now()}\nmember of ${id}`, tip]);
      if (typeof n === "object") fail(`the branch is pushed but the member head ${tip.slice(0, 12)} could not be noted: ${n.error}`);
      noted12.push(tip.slice(0, 12));
    }
  }
  const sent = tryOut(["push", "origin", `${SIGNAL_REF}:${SIGNAL_REF}`]);
  if (typeof sent === "object") fail(`the branch is pushed but the signal could not be pushed: ${sent.error}`);
  return { branch, sha, signal: true, queued: [], noted: noted12, line: `STACK-READY OK: pushed ${branch} at ${at12}, signal written${noted12.length ? `, member heads noted (${noted12.join(", ")})` : ""}${why}` };
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
    const { checkConfig, fullConfig, boardId, home } = await import("./config.mjs");
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
