// The landing job (#C967): a program lands a flight-board commit that is signed, dry-run clean and not held; Release takes only what it refuses.
//   node ~/.flight-board/current/scripts/board-land.mjs --config <board.config.json> [--dry-run]
// Run from the signed linked copy, or (#C1140, once the pack's land step has moved the LaunchAgent) from the owner's pinned install ~/.flight-board/install/<commit>/scripts (selfRefusal). It calls the release tool of the owner's INSTALLED copy (#C1058, pinnedReleaseTool: <install root>/<the commit his hooks pin>/scripts/
// board-release.mjs, not the linked copy's, which moves with every release, and never a checkout's), so a changed release tool runs only after his pack moves the pin.
// That tool does every check and the push
// (Checker's PASS and Security's SECURE on the exact tip, a fast-forward of origin/main, no newer -vN of the card, nothing the owner's install
// pins, the Board-Id trailers, the page). This job adds three things around it:
//   1. which tips to try: origin's build/* branches that continue main, carry a Checker PASS and a Security SECURE on the exact tip (the first
//      line of each note), and whose cards are all free. A tip with a note that says anything else (STOP, FINDINGS, a withdrawn PASS) is not
//      tried. A line of several commits lands as its tip, in one fast-forward; the branches under it are then on main and drop out.
//   2. holds: the probe's dispatch job writes <stateDir>/<board>/land-holds.json each minute ({ at, cards: { id: "" | "paused" | "dropped" |
//      "blocked" | "waiting_on" }, groups: { id: [the other members of its group still to land] }}). A tip lands only when every card it carries (the Board-Id trailers
//      of main..tip) is listed with no hold, and carries every other member of each card's group still to land (#C1138: only a group's head lands a group, never one
//      member alone). A file that is missing, unreadable or older than 10 minutes, or a card it does not list, lands nothing: Release lands by hand as before.
//   3. the refusals: the release tool's dry run (and then its real run) decides; a refusal is written to <stateDir>/<board>/land-report.json
//      ({ at, landed, refused: [{ branch, sha, cards, reasons }], waiting }) and printed, for Release to take. The job never retries a refused tip
//      in the same run, never forces, never touches a branch, a note or a hold.
//   4. #C1146, the group check: a head that carries two or more cards lands only with Checker's READ note (refs/notes/group-check, on the exact head) naming every file two or more
//      of its cards touch, and after ONE run of the full suite on a snapshot of the head, kept per sha in <stateDir>/<board>/group-check.json. scripts/group-check.mjs holds the rules.
// Flight-board only: the release tool lands into the flight-board repository, and a product ship stays with Release.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Checker 2's F2 LOW on 81d976c4: a static import, so importClosure pins worker/probe-jobs.mjs with this RELEASE_ENTRY (the land numbers are the owner's).
import { JOBS, LAND_TIP_SEC, LAND_MARGIN_SEC, LAND_SUITE_SEC } from "../worker/probe-jobs.mjs";
import { pinnedCommit } from "./current.mjs";
import { isSignoff } from "../collector/signoff.mjs";
// #C1146: the group check (Checker's read of the files two or more cards touch, and one suite run on the head) before a head of two or more cards lands.
import { GROUP_NOTE_REF, groupFacts, groupVerdict, runGroupSuite, suiteOnSnapshot } from "./group-check.mjs";

// #C1058 (the owner chose A on #T1992): the release tool this job starts is the one in the owner's installed copy, <install root>/<the commit his hooks pin>/scripts/,
// never the one beside this file (the linked copy moves with every release) and never a checkout's. So a changed release tool runs only after his install moves the pin.
// Returns { file } or { why } (no pin in his settings, or the pinned copy has no release tool).
export function pinnedReleaseTool(settingsText, installRoot, exists = existsSync) {
  const pin = pinnedCommit(settingsText);
  if (!pin) return { why: "the owner's settings name no single pinned commit for the hooks" };
  const file = join(installRoot, pin, "scripts", "board-release.mjs");
  return exists(file) ? { file, pin } : { why: `the owner's installed copy ${pin.slice(0, 12)} has no scripts/board-release.mjs` };
}

export const NOTES = { security: "refs/notes/security", checker: "refs/notes/checker" };
export const HOLDS_FRESH_MS = 10 * 60e3, MAX_ROUNDS = 10;
const CARD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
// #C1090: a card writes its dated "Changes" line to docs/DATA.d/<card id>.md, never to the end of docs/DATA.md (every landing conflicted every waiting branch
// there). A tip that ADDS a dated line ("- YYYY-MM-DD: ...") to docs/DATA.md is refused, unless every card it carries is the fold card (a Board-Id starting
// "fold-data-fragments"), which runs `node scripts/data-fragments.mjs --write` and is signed like any card. Any other edit of the file (a row, a principle, a
// reworded line) still lands: Checker 2's F1 on v3, which refused every edit. The fold is a card, not a commit this job makes: the Worker's self-deploy gate
// wants a Checker PASS and a Security SECURE on every commit it would deploy, and this job cannot sign.
export const DATA_FILE = "docs/DATA.md", FOLD_CARD = /^fold-data-fragments(-[a-z0-9-]{1,40})?$/, FOLD_DUE = 5;
export const DATA_FRAGMENT_DIR = "docs/DATA.d/", DATED_LINE = /^\+- \d{4}-\d{2}-\d{2}: /;
// The git reads, as arguments (tested as data): three dots, the line's own changes against the merge base with main; --no-renames so a moved file is an add and a delete.
export const dataDiffArgs = (main, sha) => ["diff", "-U0", "--no-renames", `${main}...${sha}`, "--", DATA_FILE];
export const fragmentListArgs = (main) => ["ls-tree", "--name-only", main, DATA_FRAGMENT_DIR];
// How many dated lines the diff adds to docs/DATA.md: null when the diff could not be read (git failed), never 0 for that.
export const addedDatedLines = (diff) => (typeof diff === "string" ? diff.split("\n").filter((l) => DATED_LINE.test(l)).length : null);
// How many fragments the tree listing holds: docs/DATA.d/<card id>.md, the README and anything else not a card file not counted.
export const fragmentCount = (listing) => (typeof listing === "string" ? listing.split("\n").filter((p) => /^docs\/DATA\.d\/[a-z0-9][a-z0-9-]*\.md$/.test(p)).length : 0); // lower case only: README.md is not a card file
export const signed = (notes) => isSignoff(notes?.checker, "checker") && isSignoff(notes?.security, "security"); // #C1163: collector/signoff.mjs, the one reading of "signed"

// The tips to try, from the facts only. heads: [{ branch, sha, notes: { checker, security }, cards: [ids], onMain, forward, ahead }]
// (onMain: already an ancestor of main; forward: main is an ancestor of it; ahead: commits it adds to main; dataLines: how many dated lines the line adds
// to docs/DATA.md, null when that could not be read, #C1090). holds: the parsed land-holds.json or
// null. Returns { try: [head, ...] (the biggest line first), waiting: [{ branch, sha, why }], blocked: [{ branch, sha, cards, reasons }] }.
// waiting is quiet (not signed, held, no fresh holds); blocked is a refusal Release must see (signed and free, but not a fast-forward of main).
export function landPlan({ heads, holds, now }) {
  const out = { try: [], waiting: [], blocked: [] };
  const fresh = !!holds && typeof holds === "object" && holds.cards && typeof holds.cards === "object" && Number.isFinite(holds.at) && now - holds.at <= HOLDS_FRESH_MS && holds.at - now <= 60e3;
  for (const h of Array.isArray(heads) ? heads : []) {
    if (!h || h.onMain) continue; // landed already (a branch under a line that went out)
    if (!signed(h.notes)) { out.waiting.push({ branch: h.branch, sha: h.sha, why: "not signed by Checker and Security on this exact commit" }); continue; }
    if (!fresh) { out.waiting.push({ branch: h.branch, sha: h.sha, why: "the holds file is missing or older than 10 minutes" }); continue; }
    const all = Array.isArray(h.cards) ? h.cards : [], cards = all.filter((c) => CARD_ID.test(String(c))), bad = all.filter((c) => !CARD_ID.test(String(c)));
    // Security LOW1: a Board-Id that is no card id is never dropped quietly (its card's hold would go unread): the tip waits, naming it in plain words.
    if (bad.length) { out.waiting.push({ branch: h.branch, sha: h.sha, why: `a Board-Id is not a card id (${String(bad[0]).replace(/[^\x20-\x7e]/g, "").slice(0, 40)}): its hold cannot be read` }); continue; }
    const unknown = cards.filter((c) => !Object.hasOwn(holds.cards, c)), held = cards.filter((c) => Object.hasOwn(holds.cards, c) && holds.cards[c]);
    if (!cards.length) { out.waiting.push({ branch: h.branch, sha: h.sha, why: "no Board-Id trailer names a card, so no hold can be read" }); continue; }
    if (unknown.length) { out.waiting.push({ branch: h.branch, sha: h.sha, why: `the holds file does not list ${unknown.join(", ")}` }); continue; }
    if (held.length) { out.waiting.push({ branch: h.branch, sha: h.sha, why: `held: ${held.map((c) => `${c} (${holds.cards[c]})`).join(", ")}` }); continue; }
    // #C1138 (11-16 late: #C1126 landed alone at 32438ae1 once every card of G10 that existed was signed, before the group's head was built): groups land whole, so a tip carrying a card
    // of a group lands only when it carries EVERY other member of that group still to land (the file's `groups`: card id -> the other members that are open and not on main). A group's
    // head carries them all; a single card's tip does not and waits for it. A file with no `groups` (a probe from before this) asks nothing more.
    const groups = holds.groups && typeof holds.groups === "object" && !Array.isArray(holds.groups) ? holds.groups : {};
    const lacking = [...new Set(cards.flatMap((c) => (Array.isArray(groups[c]) ? groups[c] : []).filter((p) => typeof p === "string" && CARD_ID.test(p) && !cards.includes(p))))];
    if (lacking.length) { out.waiting.push({ branch: h.branch, sha: h.sha, why: `its group is not whole: this tip lacks ${lacking.slice(0, 6).join(", ")}${lacking.length > 6 ? ` and ${lacking.length - 6} more` : ""}, which land with it as the group's head` }); continue; }
    if (h.dataLines === null) { out.waiting.push({ branch: h.branch, sha: h.sha, why: `its change to ${DATA_FILE} could not be read` }); continue; }
    if (Number.isInteger(h.dataLines) && h.dataLines > 0 && !cards.every((c) => FOLD_CARD.test(c))) { out.blocked.push({ branch: h.branch, sha: h.sha, cards, reasons: [`it adds a dated line to ${DATA_FILE}: write the card's line to docs/DATA.d/<card id>.md instead (only the fold card, a Board-Id starting fold-data-fragments, adds dated lines there; a row or a principle may still be edited in the file)`] }); continue; }
    if (!h.forward) { out.blocked.push({ branch: h.branch, sha: h.sha, cards, reasons: ["it doesn't continue origin/main: rebase it on main and sign it again"] }); continue; }
    // #C1146: a head of two or more cards also needs the group check on this exact commit: Checker's read of the files two or more cards touch (a note), then one suite run (the
    // job makes it before the release tool's dry run, once per sha). Facts that were not read (no `group`) are a wait, never a pass.
    const g = groupVerdict({ cards, ...(h.group ?? {}) });
    if (g.state === "wait") { out.waiting.push({ branch: h.branch, sha: h.sha, why: g.why }); continue; }
    if (g.state === "fail") { out.blocked.push({ branch: h.branch, sha: h.sha, cards, reasons: [g.why] }); continue; }
    out.try.push(g.state === "run" ? { ...h, needSuite: true } : h);
  }
  out.try.sort((a, b) => (b.ahead - a.ahead) || String(a.branch).localeCompare(String(b.branch)));
  return out;
}

// The reasons in the release tool's refusal ("- <reason>" lines under "Not released"), or its first line.
export function refusalReasons(text) {
  const lines = String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const dashes = lines.filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
  return (dashes.length ? dashes : lines.slice(0, 1)).slice(0, 12).map((r) => r.slice(0, 300));
}

// One run. readFacts() -> { heads } (a fresh read of origin each time), readHolds() -> the parsed file or null, release(sha, dry) -> { code, text }.
// Tries the biggest line first; a tip whose dry run is clean is released for real; after a landing the facts are read again (what went out and
// what sat under it drop out, a sibling that no longer continues main is reported). A refused tip is not tried again in this run.
// #C975 (Checker 2's F1 on e03bb4be): run on a schedule, a run must never be cut by its alarm in the middle of a landing (the alarm ends node, not the
// release tool it spawned, which would push on as an orphan while the next run starts). So a tip is started only while a whole landing still fits:
// clock() - start + tipMs <= budgetMs. tipMs is one tip's worst case (a carried sign-off runs the suite in the dry run AND the real run); the rest
// wait for the next run, in the report's `waiting`. With no budget (a hand run) every tip is tried, as before.
// #C1090: readFragments() -> how many docs/DATA.d fragments wait on origin/main; FOLD_DUE or more is reported (foldDue) and logged as FOLD DUE, which
// Release and Manager read with the run's other lines: cut the fold card.
// #C1146: a tip the plan marks needSuite (a head of two or more cards, Checker's read in place) gets runSuite(sha) -> { ok, line } once, before the dry run; the result is kept by
// recordSuite(sha, result) so no later run repeats it, and a red one is a refusal Release reads. suiteMs is that run's worst case, added to the tip's before it is started.
export function landRun({ readFacts, readHolds, release, now = Date.now(), dry = false, log = () => {}, clock = Date.now, budgetMs = Infinity, tipMs = 0, readFragments = () => 0, runSuite = null, recordSuite = () => {}, suiteMs = 0 }) {
  const landed = [], refused = [], held = [], seen = new Set(), start = clock();
  let waiting = [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const plan = landPlan({ heads: readFacts().heads.filter((h) => !seen.has(h.sha)), holds: readHolds(), now });
    waiting = plan.waiting;
    for (const b of plan.blocked) if (!seen.has(b.sha)) { seen.add(b.sha); refused.push(b); }
    const next = plan.try[0];
    if (!next) break;
    if (clock() - start + tipMs + (next.needSuite ? suiteMs : 0) > budgetMs) {
      waiting = [...waiting, ...plan.try.map((h) => ({ branch: h.branch, sha: h.sha, why: "no time left in this run for a whole landing: the next run tries it" }))];
      log(`time: ${plan.try.length} tip(s) wait for the next run`);
      break;
    }
    seen.add(next.sha);
    if (next.needSuite) {
      if (typeof runSuite !== "function") { held.push({ branch: next.branch, sha: next.sha, why: "group check: this run has no way to run the suite" }); continue; }
      let res;
      try { res = runSuite(next.sha); } catch (e) { res = { ok: false, line: `the suite run failed to start: ${String(e?.message ?? e).split("\n")[0].slice(0, 120)}` }; }
      if (!res || typeof res.ok !== "boolean") res = { ok: false, line: "the suite run gave no verdict" };
      try { recordSuite(next.sha, { at: now, ok: res.ok, line: String(res.line ?? "").slice(0, 200) }); } catch { /* the next run runs it again */ }
      if (!res.ok) { refused.push({ branch: next.branch, sha: next.sha, cards: next.cards, reasons: [`the full suite on the group head was red: ${String(res.line ?? "no detail").slice(0, 200)}`] }); log(`group check: suite red on ${next.branch} ${next.sha.slice(0, 12)}`); continue; }
      log(`group check: suite green on ${next.branch} ${next.sha.slice(0, 12)}`);
    }
    const check = release(next.sha, true);
    if (check.code !== 0) { refused.push({ branch: next.branch, sha: next.sha, cards: next.cards, reasons: refusalReasons(check.text) }); log(`refused ${next.branch} ${next.sha.slice(0, 12)}`); continue; }
    if (dry) { landed.push({ branch: next.branch, sha: next.sha, dry: true }); log(`would land ${next.branch} ${next.sha.slice(0, 12)}`); continue; }
    const real = release(next.sha, false);
    if (real.code !== 0) { refused.push({ branch: next.branch, sha: next.sha, cards: next.cards, reasons: refusalReasons(real.text) }); log(`refused on the real run ${next.branch} ${next.sha.slice(0, 12)}`); continue; }
    landed.push({ branch: next.branch, sha: next.sha, cards: next.cards });
    log(`landed ${next.branch} ${next.sha.slice(0, 12)}`);
  }
  let dataFragments = 0;
  try { dataFragments = Number(readFragments()) || 0; } catch { dataFragments = 0; }
  const foldDue = dataFragments >= FOLD_DUE;
  if (foldDue) log(`FOLD DUE: ${dataFragments} DATA fragments wait in docs/DATA.d on origin/main: cut the fold card (a Board-Id starting fold-data-fragments; node scripts/data-fragments.mjs --write)`);
  return { at: now, landed, refused, waiting: [...waiting, ...held], dataFragments, foldDue };
}

// #C1318: once a landing is done, each landed card's folder is removed (a builder's worktree of this repository: `git worktree list`), so ~/Documents/Code stops
// filling with folders of work that is on main. A folder is removed only when ALL of these hold: it is a linked worktree (never the repository's own folder or the
// one this job runs in), it is on a branch named for a landed card (the landed branch itself, or `[build/]<card id>[-vN]`), and its HEAD is an ancestor of origin/main
// (onMain). The removal is plain `git worktree remove`, never --force, so git itself refuses a dirty or locked folder; a refusal prints its reason and one ready line
// for the owner, and never fails the land. Returns { removed: [path], kept: [{ path, why }] }.
export const parseWorktrees = (text) => String(text ?? "").split(/\n\n+/).map((b) => {
  const f = Object.fromEntries(b.split("\n").filter(Boolean).map((l) => { const i = l.indexOf(" "); return i < 0 ? [l, true] : [l.slice(0, i), l.slice(i + 1)]; }));
  return f.worktree ? { path: f.worktree, head: f.HEAD ?? null, branch: typeof f.branch === "string" ? f.branch.replace(/^refs\/heads\//, "") : null, locked: f.locked !== undefined, bare: f.bare === true } : null;
}).filter(Boolean);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function landedFolders({ landed, worktrees, onMain, remove, repo, cwd = null, log = () => {} }) {
  const out = { removed: [], kept: [] };
  const cards = new Set((landed ?? []).flatMap((l) => (Array.isArray(l.cards) ? l.cards : [])).filter((c) => CARD_ID.test(String(c))));
  const branches = new Set((landed ?? []).map((l) => l.branch).filter(Boolean));
  const named = (b) => !!b && (branches.has(b) || [...cards].some((c) => new RegExp(`^(build/)?${escapeRe(c)}(-v\\d+)?$`).test(b)));
  for (const w of (worktrees ?? []).slice(1)) { // the first entry is the repository's own folder
    if (w.bare || w.path === repo || (cwd && w.path === cwd) || !named(w.branch)) continue;
    const keep = (why) => { out.kept.push({ path: w.path, why }); log(`folder kept ${w.path}: ${why}. To remove it yourself: git -C ${repo} worktree remove ${w.path}`); };
    if (w.locked) { keep("it is locked"); continue; }
    if (!w.head || !onMain(w.head)) { keep("its work is not on origin/main"); continue; }
    try { remove(w.path); out.removed.push(w.path); log(`folder removed ${w.path}`); } catch (e) { keep(String(e?.stderr ?? e?.message ?? e).split("\n").map((l) => l.trim()).filter(Boolean)[0]?.split(w.path).join("the folder").slice(0, 160) ?? "git refused"); } // git's line names the folder first: the path is dropped so the reason is what is read
  }
  return out;
}

// #C1140 (Security's F1 on 768c18d0): where this job may run from. Once the LaunchAgent starts the owner's pinned install (the pack's land step), the job's own folder is
// ~/.flight-board/install/<40 hex>/scripts, not the folder the `current` link names, so the old "must be the linked copy" check would have stopped every run: NOT RUN, nothing landed.
// Accepted: the folder the link `~/.flight-board/current/scripts` resolves to (a hand run through the link, and the copy the link names), or a folder that is exactly
// <real ~/.flight-board/install>/<40 lower-case hex>/scripts after symbolic links are resolved. Never a checkout, and never a pinned-looking name whose real place is elsewhere.
// Returns null, or the NOT RUN line. `realpath` and `exists` are injectable for the tests.
export function selfRefusal({ self, home, realpath = realpathSync, exists = existsSync }) {
  const refusal = "NOT RUN: this is neither the signed linked copy (~/.flight-board/current) nor a pinned install (~/.flight-board/install/<commit>): run it from one of those";
  let real;
  try { real = realpath(self); } catch { return refusal; }
  const link = join(home, ".flight-board", "current", "scripts");
  try { if (exists(link) && realpath(link) === real) return null; } catch { /* not the link */ }
  try {
    const root = realpath(join(home, ".flight-board", "install"));
    if (real.startsWith(`${root}/`) && /^[0-9a-f]{40}\/scripts$/.test(real.slice(root.length + 1))) return null;
  } catch { /* no install folder */ }
  return refusal;
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const readText = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2), dry = args.includes("--dry-run"), ci = args.indexOf("--config");
  const configPath = ci >= 0 ? args[ci + 1] : null;
  if (!configPath || args.some((a, n) => a !== "--dry-run" && a !== "--config" && n !== ci + 1)) { console.error("Usage: node ~/.flight-board/current/scripts/board-land.mjs --config <board.config.json> [--dry-run]"); process.exit(2); }
  const notRun = selfRefusal({ self: dirname(fileURLToPath(import.meta.url)), home: homedir() });
  if (notRun) { console.log(notRun); process.exit(1); }
  const repo = process.env.FLIGHT_BOARD_REPO || join(homedir(), "Documents/Code/flight-board");
  const git = (a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
  const quiet = (a) => { try { return git(a); } catch { return null; } };
  const { checkConfig, fullConfig, boardId, home } = await import("./config.mjs");
  const raw = readJson(configPath);
  if (!raw || checkConfig(raw).length) { console.log("NOT RUN: the board config is missing or invalid"); process.exit(1); }
  const config = fullConfig(raw), id = boardId(config);
  if (!id) { console.log("NOT RUN: the config names no board"); process.exit(1); }
  const dir = join(home(config.gate.stateDir), id);
  const readFacts = () => {
    quiet(["fetch", "-q", "origin"]);
    for (const [who, ref] of Object.entries(NOTES)) quiet(["fetch", "-q", "origin", `+${ref}:refs/notes/board-release/${who}`]);
    quiet(["fetch", "-q", "origin", `+${GROUP_NOTE_REF}:refs/notes/board-release/group`]);
    const suites = readJson(join(dir, "group-check.json")) ?? {};
    const main = git(["rev-parse", "origin/main"]);
    const heads = (quiet(["for-each-ref", "refs/remotes/origin/build", "--format=%(refname:lstrip=3) %(objectname)"]) ?? "").split("\n").filter(Boolean).map((l) => {
      const [branch, sha] = l.split(" ");
      const notes = Object.fromEntries(Object.keys(NOTES).map((who) => [who, quiet(["notes", `--ref=board-release/${who}`, "show", sha])]));
      const cards = [...new Set((quiet(["log", "--format=%(trailers:key=Board-Id,valueonly,separator=%x2c)", `${main}..${sha}`]) ?? "").split(/[\n,]/).map((x) => x.trim()).filter(Boolean))];
      const dataLines = addedDatedLines(quiet(dataDiffArgs(main, sha)));
      // #C1146: only a head of two or more cards is read for the group check (the git read is skipped for the rest).
      const group = groupFacts({ cards, quiet, main, sha, suites });
      return { branch, sha, notes, cards, dataLines, group, onMain: quiet(["merge-base", "--is-ancestor", sha, main]) !== null, forward: quiet(["merge-base", "--is-ancestor", main, sha]) !== null, ahead: Number(quiet(["rev-list", "--count", `${main}..${sha}`]) ?? 0) };
    });
    return { main, heads };
  };
  const tool = pinnedReleaseTool(readText(join(homedir(), ".claude", "settings.json")), join(homedir(), ".flight-board", "install"));
  if (!tool.file) { console.log(`NOT RUN: ${tool.why}: the landing job starts only the release tool of the owner's installed copy`); process.exit(1); }
  const release = (sha, dryRun) => {
    const r = spawnSync(process.execPath, [tool.file, sha, ...(dryRun ? ["--dry-run"] : [])], { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { code: r.status ?? 1, text: `${r.stderr ?? ""}\n${r.stdout ?? ""}` };
  };
  // #C975: the scheduled run's time budget (worker/probe-jobs.mjs: the land cadence's limit less a margin, and one tip's worst case).
  const readFragments = () => fragmentCount(quiet(fragmentListArgs("origin/main")));
  // #C1146: the group check's one suite run, on a snapshot of the head (a detached worktree, removed after), its own TMPDIR; the verdict is kept per sha in group-check.json.
  const runSuite = (sha) => suiteOnSnapshot({
    sha, mkdtemp: () => mkdtempSync(join(tmpdir(), "board-land-suite-")), run: git, remove: (d) => { quiet(["worktree", "remove", "--force", d]); rmSync(d, { recursive: true, force: true }); },
    // the snapshot's own scripts/test-run.mjs (what npm test runs), no stdin, an empty temporary HOME, killed after LAND_SUITE_SEC in all (runGroupSuite)
    suite: (d) => runGroupSuite({ dir: d, spawn: spawnSync, mkdtemp: () => mkdtempSync(join(tmpdir(), "board-land-tmp-")), remove: (x) => rmSync(x, { recursive: true, force: true }), totalMs: LAND_SUITE_SEC * 1000 }),
  });
  const recordSuite = (sha, result) => {
    const file = join(dir, "group-check.json"), have = readJson(file) ?? {};
    const keep = Object.entries({ ...have, [sha]: result }).sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0)).slice(0, 20);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const part = `${file}.${process.pid}.part`;
    writeFileSync(part, JSON.stringify(Object.fromEntries(keep)), { mode: 0o600 }); renameSync(part, file);
  };
  const report = landRun({ readFragments, readFacts, readHolds: () => readJson(join(dir, "land-holds.json")), release, dry, log: (s) => console.log(`land: ${s}`), budgetMs: (JOBS.land.limitSec - LAND_MARGIN_SEC) * 1000, tipMs: LAND_TIP_SEC * 1000, runSuite: dry ? null : runSuite, recordSuite, suiteMs: LAND_SUITE_SEC * 1000 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "land-report.json"), part = `${file}.${process.pid}.part`;
  writeFileSync(part, JSON.stringify(report), { mode: 0o600 }); renameSync(part, file);
  console.log(`land: ${report.landed.length} landed${dry ? " (dry run)" : ""}, ${report.refused.length} refused, ${report.waiting.length} waiting`);
  for (const r of report.refused) console.log(`REFUSED ${r.branch} ${r.sha.slice(0, 12)}: ${r.reasons.join("; ")}`);
  // #C1318: the landed cards' folders, after the report is written; nothing here can fail the land.
  if (!dry && report.landed.length) {
    try {
      quiet(["fetch", "-q", "origin"]);
      landedFolders({
        landed: report.landed, worktrees: parseWorktrees(quiet(["worktree", "list", "--porcelain"])), repo, cwd: process.cwd(), log: (s) => console.log(`land: ${s}`),
        onMain: (sha) => quiet(["merge-base", "--is-ancestor", sha, "origin/main"]) !== null,
        remove: (p) => git(["worktree", "remove", p]),
      });
    } catch (e) { console.log(`land: folders not cleaned: ${String(e?.message ?? e).split("\n")[0].slice(0, 120)}`); }
  }
}
