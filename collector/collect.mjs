// The collector's run: node collector/collect.mjs --config <board.config.json> [--no-fetch]
// Reads the board's mirror (<stateDir>/<board>/mirror, exported just before by the scheduled task), fetches the team's
// repository and its sign-off notes, works out each open card's phase (collector/derive.mjs), and writes
// <stateDir>/<board>/out/derived-all.json: the one document the task then writes to the board as derived/all.
// It prints one line per conflict (a card's declared phase against its evidence), the cards live by the evidence but
// still open, and the nudges (collector/nudges.mjs), for the lead. It never writes the board itself: only a Claude session can (collector/TASK.md).
import { realpathSync } from "node:fs";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, renameSync, readdirSync, lstatSync, cpSync, readlinkSync } from "node:fs";
import { sep, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { checkConfig, fullConfig, boardId } from "../scripts/config.mjs";
import { readMirror, home } from "../gate/gate.mjs";
import { headsFor, derivePhase, conflict, staleLive, closed, boardIdOf } from "./derive.mjs";
import { remoteHeads, mainLine, deployRuns, factsFor, shippedHeads, mainVersion, liveBuild } from "./facts.mjs";
import { evidenceTimes } from "./timings.mjs";
import { nudges } from "./nudges.mjs";
import { derivePlan } from "./plan-state.mjs";
import { idText, lineText } from "./text.mjs";
import { planReadings, writeContext } from "./context.mjs";
import { runMark, localMain, localShips } from "./refresh.mjs";
import { allocate } from "../scripts/thread-ids.mjs";

// The folder this run's code really lives in (the current link resolved, by Node, to a pinned copy).
const CODE = dirname(dirname(fileURLToPath(import.meta.url)));
// Step 2 runs only the code step 1 ran: a mark without code (an older --prepare) passes once.
export const sameCode = (mark, code) => mark?.code === undefined || mark.code === code;

// The steps the export takes: the last 7 days' (older ones can't hold an open step worth a nudge, and there are many).
export const STEPS_DAYS = 7;

// Sign-off notes are fetched into a namespace of our own (refs/notes/flight-board/, where git notes can read them), so a
// local notes ref the team is writing is never overwritten.
export const localNotes = (notes) => Object.fromEntries(Object.entries(notes).map(([p, ref]) => [p, `refs/notes/flight-board/${ref.slice("refs/notes/".length)}`]));

// The board is exported into a fresh folder next to the mirror (--prepare makes it), and the run swaps it into place, so
// the gate never reads a half-written mirror. Both refuse any path but <stateDir>/<board id>/mirror(.next), so a wrong
// stateDir can never make the run remove another folder.
const guard = (path, id, name) => {
  if (!id || !path.endsWith(`${sep}${id}${sep}${name}`)) throw new Error(`refusing to clear ${path}: not <stateDir>/<board id>/${name}`);
};
export function prepareMirror(dir, id) {
  const next = join(dir, "mirror.next");
  guard(next, id, "mirror.next");
  if (existsSync(next)) rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true });
  return next;
}
export function swapMirror(dir, id) {
  const next = join(dir, "mirror.next"), mirror = join(dir, "mirror");
  guard(next, id, "mirror.next"); guard(mirror, id, "mirror");
  if (!existsSync(next)) return false;
  const old = join(dir, "mirror.old");
  if (existsSync(old)) rmSync(old, { recursive: true, force: true });
  if (existsSync(mirror)) renameSync(mirror, old);
  renameSync(next, mirror);
  rmSync(old, { recursive: true, force: true });
  return true;
}

// A scheduled run saves its export (ArtifactData out_dir) without a prompt only inside its session's scratchpad, so
// the board is exported there, into a folder named EXPORT_NAME, and step 2 takes it from there: the newest one made since
// --prepare, found under the scratchpads of runs in this working folder. The run never types a path the permission
// rules would have to match.
export { EXPORT_NAME } from "./export.mjs";
// The collections a complete export holds (collector/TASK.md, step 1).
export { EXPORT_COLLECTIONS } from "./export.mjs";
import { EXPORT_NAME, EXPORT_COLLECTIONS } from "./export.mjs";
// The ones a complete export must hold: an empty collection exports no folder, and a board may have no plan yet (v3)
// or no numbered thread yet.
export const REQUIRED_COLLECTIONS = EXPORT_COLLECTIONS.filter((c) => c !== "plan" && c !== "threads");

// Threads with no number yet (a waiting item, or a thread its messages open, with no threads/<id> {num}): the owner's
// own new threads come in through the page, and only the lead numbers. One NUDGE line, every run until they're numbered,
// so a new thread never sits without its #T (#C227). The lead runs scripts/thread-ids.mjs; the collector writes nothing.
export function unnumberedThreads(docs) {
  const { batches } = allocate({ threads: docs.threads ?? [], messages: docs.messages ?? [], waiting: docs.waiting ?? [], seq: null });
  return batches.flat().filter((w) => w.collection === "threads" && Number.isInteger(w.data?.num)).map((w) => w.doc_id);
}
export function unnumberedLine(docs) {
  const loose = unnumberedThreads(docs);
  return loose.length ? `NUDGE ${loose.length} thread(s) with no number: ${loose.map(idText).join(", ")}. Number them now (scripts/thread-ids.mjs, meta/threadSeq pinned).` : null;
}
// Where sessions working in `cwd` keep their scratchpads: <root>/<cwd, every character but a letter or digit as "-">/
// <session>/scratchpad. One root only, links resolved (/tmp is /private/tmp on a Mac): never a wider search (Security).
export function scratchRoot(cwd, uid, base = "/private/tmp") {
  const enc = String(cwd).replace(/[^A-Za-z0-9]/g, "-");
  const root = join(base, `claude-${uid}`, enc);
  try { return realpathSync(root); } catch { return root; }
}
// This run's export: the newest <root>/<session>/scratchpad/EXPORT_NAME made after --prepare (`since`, ms), a real
// folder of this user's whose resolved path stays under the root, holding every collection. Null when there is none.
export function findExport(root, since, uid) {
  let best = null, sessions = [];
  try { sessions = readdirSync(root); } catch { return null; }
  for (const s of sessions) {
    const p = join(root, s, "scratchpad", EXPORT_NAME);
    let st, real;
    try { st = lstatSync(p); real = realpathSync(p); } catch { continue; }
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || !real.startsWith(root + sep)) continue;
    if (Math.max(st.birthtimeMs || 0, st.ctimeMs) < since) continue;
    if (!REQUIRED_COLLECTIONS.every((c) => { try { const cs = lstatSync(join(p, c)); return cs.isDirectory() && !cs.isSymbolicLink(); } catch { return false; } })) continue;
    if (!best || st.mtimeMs > best.at) best = { path: real, at: st.mtimeMs };
  }
  return best?.path ?? null;
}
// Moves an export into place as mirror.next (a rename, so the next run can't take it again; a copy and remove only
// across disks), then keeps only <collection>/<doc>.json regular files: anything else (a link, a deeper folder) goes.
// Returns the number of documents kept.
export function takeExport(src, dir, id) {
  const next = prepareMirror(dir, id);
  rmSync(next, { recursive: true, force: true });
  try { renameSync(src, next); } catch (e) {
    if (e.code !== "EXDEV") throw e;
    cpSync(src, next, { recursive: true, verbatimSymlinks: true });
    rmSync(src, { recursive: true, force: true });
  }
  let n = 0;
  for (const c of readdirSync(next)) {
    const cp = join(next, c), cs = lstatSync(cp);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(c) || !cs.isDirectory() || cs.isSymbolicLink()) { rmSync(cp, { recursive: true, force: true }); continue; }
    for (const f of readdirSync(cp)) {
      const fp = join(cp, f);
      if (f.endsWith(".json") && lstatSync(fp).isFile()) n++;
      else rmSync(fp, { recursive: true, force: true });
    }
  }
  return n;
}

// The nudges, with the last run's state next to the mirror (<dir>/nudges.json: what was sent when, and since when each
// card is unchanged). Returns the NUDGE lines to print.
export function runNudges(dir, config, docs, now, waiting = new Set(), derived = {}) {
  const path = join(dir, "nudges.json");
  let before = {};
  try { before = JSON.parse(readFileSync(path, "utf8")); } catch { /* first run, or a broken file: start afresh */ }
  const { lines, state } = nudges({ config, docs, now, state: before && typeof before === "object" ? before : {}, waiting, derived });
  writeFileSync(path, JSON.stringify(state));
  return lines;
}

// plan, waiting: the board's plan nodes and asks (v3): the plan's states go out with the cards' phases.
// The ship runs on now: [{ branch, names: [{ branch, sha }] }], from each candidate branch's last few commit subjects.
export function shipping(git, heads, c) {
  if (!c.candidatePattern || !c.shippedPattern) return [];
  const isRun = new RegExp(c.candidatePattern);
  return heads.filter((h) => h.message !== "" && isRun.test(h.branch)).map((h) => {
    let subjects = [];
    try { subjects = git(["log", "-5", "--format=%s", h.sha]).split("\n"); } catch { /* none */ }
    const names = [];
    for (const s of subjects) for (const m of s.matchAll(new RegExp(c.shippedPattern, "g"))) if (m[1] && /^[0-9a-f]{7,40}$/.test(m[2] ?? "")) names.push({ branch: m[1], sha: m[2] });
    return { branch: h.branch, names };
  });
}

// A branch's current tip, never an older commit of it the main line once shipped (#C237: a card read live from its
// first ship while its newer tip waited): a shipped head counts only for a branch gone from the remote.
export function tipsOnly(remote, shipped) {
  const there = new Set(remote.map((h) => h.branch));
  return shipped.filter((h) => !there.has(h.branch));
}

// The card's phase from each of its branches' tips: the least advanced one (live only when every tip is deployed),
// naming the branch behind when there are several. derive(head) is derivePhase for that head.
export function leastAdvanced(card, tips, derive, config) {
  if (tips.length <= 1) return derive(tips[0] ?? null);
  const order = config.phases.map((p) => p[0]);
  const all = tips.map((h) => ({ h, d: derive(h) }));
  const { h, d } = all.reduce((a, b) => (order.indexOf(b.d.phase) < order.indexOf(a.d.phase) ? b : a));
  return { ...d, branches: tips.map((t) => t.branch), behind: h.branch, evidence: `${d.evidence}; ${tips.length} branches, ${lineText(h.branch, 60)} is behind` };
}

// The repository a card lives in (#C278): one of collector.repos by the card's own repo field, else the first whose id
// prefix the card carries; null for the team's own repository (collector.repoPath).
export function repoOf(card, config) {
  const repos = config.collector.repos ?? [];
  if (card.repo) return repos.find((r) => r.name === card.repo) ?? null;
  return repos.find((r) => (r.idPrefixes ?? []).some((p) => String(card.id).startsWith(p))) ?? null;
}

// The newest commit on a repository's main line (its last 400) whose Board-Id trailer is exactly the card's id, as a
// head { branch: main, sha, at, message }, or null. The id goes to git as a fixed string, never a pattern or an option.
export function trailerOnMain(git, remote, main, id) {
  let out = "";
  try { out = git(["log", "-400", "--fixed-strings", `--grep=Board-Id: ${id}`, "--format=%H%x1f%ct%x1f%B%x1e", `${remote}/${main}`]); } catch { return null; }
  for (const r of out.split("\x1e")) {
    const [sha, at, message] = r.replace(/^\n/, "").split("\x1f");
    if (/^[0-9a-f]{40}$/.test(sha ?? "") && boardIdOf(message) === id) return { branch: main, sha, at: Number(at) * 1000, message };
  }
  return null;
}

// A card in another repository, by the same derivation from its branch's current tip (#C237), with that repository's
// notes and main branch, and "deployed" meaning installed: on main and inside the commit the repository's
// installedLink points at. Every review signed is then a wait with a known cause, never a stall: "release" (not on main
// yet: queued for a board release) or "install" (on main, not installed yet). use: { git, installed }, or nothing when
// the repository couldn't be read, which leaves the card as declared.
export function inRepo(card, r, use, config, now) {
  const c = config.collector;
  if (!use?.git) return { phase: null, evidence: `${r.name}: its repository was not read this run`, repo: r.name, at: now };
  const remote = r.remote ?? "origin", main = r.mainBranch ?? "main";
  const cfg = { ...config, collector: { ...c, remote, mainBranch: main, notes: localNotes(r.notes) } };
  let heads = [];
  try { heads = remoteHeads(use.git, remote); } catch { /* an empty clone */ }
  const live = headsFor(card.id, heads.filter((h) => h.branch !== main));
  // A branch deleted after it merged leaves only its Board-Id trailer on main (#C281).
  const tips = live.length ? live : [trailerOnMain(use.git, remote, main, card.id)].filter(Boolean);
  const derive = (h) => {
    const facts = factsFor(use.git, h, { config: cfg, line: [], deployed: use.installed ?? null });
    const d = derivePhase(card, facts, cfg);
    return d.phase === c.shipPhase ? { ...d, wait: facts.onMain ? "install" : "release" } : d;
  };
  return { ...leastAdvanced(card, tips, derive, config), repo: r.name, at: now };
}

// live: liveBuild()'s answer for this run (null when there is no liveUrl or it couldn't be read). repos: { name: { git,
// installed } } for the collector.repos read this run.
export function collect({ config, cards, git, gh, now, plan = [], waiting = [], live = null, repos = {} }) {
  const c = config.collector;
  const cfg = { ...config, collector: { ...c, notes: localNotes(c.notes) } };
  const line = mainLine(git, c.remote, c.mainBranch);
  const remote = remoteHeads(git, c.remote);
  const heads = [...remote, ...tipsOnly(remote, shippedHeads(git, line, c.shippedPattern))];
  const runs = deployRuns(gh, c.deployWorkflow, c.mainBranch);
  const deployed = runs[0]?.headSha ?? null;
  const open = cards.filter((k) => !closed(k));
  const derived = {}, split = [], tipsOf = {};
  const work = heads.filter((h) => h.branch !== c.mainBranch && !(c.candidatePattern && new RegExp(c.candidatePattern).test(h.branch)));
  const phaseOf = (card) => {
    const tips = tipsOf[card.id] = headsFor(card.id, work);
    return { ...leastAdvanced(card, tips, (h) => derivePhase(card, factsFor(git, h, { config: cfg, line, deployed }), cfg), config), at: now };
  };
  for (const card of open) {
    const r = repoOf(card, config);
    if (r) { derived[card.id] = inRepo(card, r, repos[r.name], config, now); continue; }
    derived[card.id] = phaseOf(card);
    const tips = tipsOf[card.id];
    if (tips.length > 1) split.push(`${idText(card.id)}: ${tips.length} branches (${tips.map((h) => lineText(h.branch, 60)).join(", ")}): one card is one branch; split the rework into a sub-card`);
  }
  // A ship run on now: the cards its candidate branch names (branch@sha in one of its last commits) are shipping now.
  const ships = shipping(git, heads, c);
  for (const s of ships) for (const id of Object.keys(derived)) {
    const h = derived[id].head;
    if (h && s.names.some((n) => String(h).startsWith(n.sha))) derived[id].shipping = true; // never the branch's name (Security)
  }
  // Each phase's times from the evidence (#C235), for open cards and those closed in the last STEPS_DAYS days.
  const times = {};
  const recent = cards.filter((k) => closed(k) && Number.isFinite(k.doneAt) && k.doneAt > now - STEPS_DAYS * 864e5);
  for (const card of [...open, ...recent]) {
    if (repoOf(card, config)) continue; // the evidence times read the team's repository only
    const d = derived[card.id] ?? phaseOf(card);
    const head = tipsOf[card.id].find((h) => h.sha === d.head);
    if (!head) continue;
    const run = ships.find((s) => s.names.some((n) => head.sha.startsWith(n.sha)));
    const candidate = run ? heads.find((h) => h.branch === run.branch)?.sha ?? null : null;
    const t = evidenceTimes(git, { card, derived: d, head, line, runs, config: cfg, notes: cfg.collector.notes, candidate });
    if (Object.keys(t).length) times[card.id] = t;
  }
  const conflicts = [...open.map((k) => conflict(k, derived[k.id], config)).filter(Boolean), ...split];
  const doc = { at: now, cards: derived, times, conflicts, liveButOpen: staleLive(open, derived, config) };
  // "Live now" from the build the site serves, never from main; main's newest version shows beside it while it deploys.
  if (c.liveUrl) doc.live = { ...(live ?? {}), mainVersion: mainVersion(line, c.versionPattern), at: now };
  if (Array.isArray(plan) && plan.length) doc.plan = derivePlan({ nodes: plan, cards, derived, waiting, config, now });
  return { doc, conflicts };
}

// Its one output, in collector.outDir when set: a folder outside the state folder, so the scheduled run (whose working
// folder is the state folder) is denied every read there and allowed this one file (Security). dir: the state folder.
export function outPath(config, dir) {
  return join(config.collector.outDir ? home(config.collector.outDir) : join(dir, "out"), "derived-all.json");
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const at = process.argv.indexOf("--config");
  let config;
  try {
    const raw = JSON.parse(readFileSync(process.argv[at + 1], "utf8"));
    const problems = checkConfig(raw);
    if (at < 0 || problems.length) throw new Error(problems.join("; ") || "no --config");
    config = fullConfig(raw);
    if (!config.collector.repoPath) throw new Error("collector.repoPath is empty");
  } catch (e) { console.error(`Collector: ${e.message}`); process.exit(1); }
  const repo = home(config.collector.repoPath);
  const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const gh = (args) => execFileSync("gh", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const dir = join(home(config.gate.stateDir), boardId(config) ?? "no-board");
  if (process.argv.includes("--prepare")) {
    try {
      mkdirSync(dir, { recursive: true });
      // With the refresh repos' origin/main now: the baseline the lead's refresh check compares against (collector/refresh.mjs).
      // With the code this run started with (the current link resolved): step 2 must run the same (#C223).
      writeFileSync(join(dir, "export-since.json"), JSON.stringify({ ...runMark(Date.now(), config.collector.refresh.repos, localMain, localShips(config.collector.candidatePattern)), code: CODE }));
      console.log(`Export the board into: your scratchpad folder + /${EXPORT_NAME}`);
      console.log(`Steps since: ${Date.now() - STEPS_DAYS * 864e5}`);
      for (const line of planReadings(dir, config, Date.now())) console.log(line);
      process.exit(0);
    } catch (e) { console.error(`Collector: ${e.message}`); process.exit(1); }
  }
  try {
    let since = Infinity, mark = {};
    try { mark = JSON.parse(readFileSync(join(dir, "export-since.json"), "utf8")); since = mark.at; } catch { /* no --prepare yet */ }
    if (!sameCode(mark, CODE)) throw new Error("the collector's code changed between step 1 and step 2 (the current link moved): run step 1 again");
    // Only this run's export: none since --prepare is an error, never an old mirror passed off as fresh (Security).
    const found = Number.isFinite(since) ? findExport(scratchRoot(process.cwd(), process.getuid()), since, process.getuid()) : null;
    if (!found) throw new Error("no complete board export since --prepare in this run's scratchpad: run step 1 again");
    takeExport(found, dir, boardId(config));
    swapMirror(dir, boardId(config));
  } catch (e) { console.error(`Collector: ${e.message}`); process.exit(1); }
  const mirror = readMirror(join(dir, "mirror"));
  if (!mirror?.docs.initiatives) { console.error(`Collector: no mirror at ${join(dir, "mirror")}: export the board first (collector/TASK.md, step 1).`); process.exit(1); }
  if (!process.argv.includes("--no-fetch")) {
    git(["fetch", "-q", config.collector.remote]);
    git(["fetch", "-q", config.collector.remote, "+refs/notes/*:refs/notes/flight-board/*"]);
  }
  // The other repositories (#C278), each from its own clone: fetched like the team's, and what's installed read from its
  // link (the commit folder it points at). One that can't be read leaves its cards as declared.
  const repos = {};
  for (const r of config.collector.repos) {
    try {
      const at = home(r.path);
      if (!existsSync(at)) continue;
      const rgit = (args) => execFileSync("git", args, { cwd: at, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
      if (!process.argv.includes("--no-fetch")) {
        rgit(["fetch", "-q", r.remote ?? "origin"]);
        rgit(["fetch", "-q", r.remote ?? "origin", "+refs/notes/*:refs/notes/flight-board/*"]);
      }
      let installed = null;
      try { const sha = basename(readlinkSync(home(r.installedLink ?? ""))); installed = /^[0-9a-f]{40}$/.test(sha) ? sha : null; } catch { /* no link: nothing installed */ }
      repos[r.name] = { git: rgit, installed };
    } catch (e) { console.error(`Collector: ${r.name}: ${String(e.message).split("\n")[0]}`); }
  }
  const now = Date.now();
  const live = await liveBuild(fetch, config.collector.liveUrl, config.collector.liveTag);
  const { doc, conflicts } = collect({ config, cards: mirror.docs.initiatives, git, gh, now, plan: mirror.docs.plan ?? [], waiting: mirror.docs.waiting ?? [], live, repos });
  const waits = new Set(Object.entries(doc.cards).filter(([, d]) => d.wait).map(([id]) => id));
  const nudged = { lines: runNudges(dir, config, mirror.docs, now, waits, doc.cards) };
  const out = outPath(config, dir);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(doc, null, 2));
  console.log(`Derived ${Object.keys(doc.cards).length} open card(s) into ${out}.`);
  for (const line of conflicts) console.log(`CONFLICT ${line}`);
  if (doc.liveButOpen.length) console.log(`LIVE BUT OPEN (${doc.liveButOpen.length}): ${doc.liveButOpen.map(idText).join(", ")}`);
  for (const line of nudged.lines) console.log(line);
  const loose = unnumberedLine(mirror.docs);
  if (loose) console.log(loose);
  for (const line of writeContext(dir, dirname(out), config, Date.now())) console.log(line);
}
