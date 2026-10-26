// The collector's run: node collector/collect.mjs --config <board.config.json> [--no-fetch]
// Reads the board's mirror (<stateDir>/<board>/mirror, exported just before by the scheduled task), fetches the team's
// repository and its sign-off notes, works out each open card's phase (collector/derive.mjs), and writes
// <stateDir>/<board>/out/derived-all.json: the one document the task then writes to the board as derived/all.
// It prints one line per conflict (a card's declared phase against its evidence), the cards live by the evidence but
// still open, and the nudges (collector/nudges.mjs), for the lead. It never writes the board itself: only a Claude session can (collector/TASK.md).
import { realpathSync } from "node:fs";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, renameSync, readdirSync, lstatSync, cpSync } from "node:fs";
import { sep } from "node:path";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { checkConfig, fullConfig, boardId } from "../scripts/config.mjs";
import { readMirror, home } from "../gate/gate.mjs";
import { headFor, derivePhase, conflict, staleLive, closed } from "./derive.mjs";
import { remoteHeads, mainLine, deployedSha, factsFor, shippedHeads } from "./facts.mjs";
import { nudges } from "./nudges.mjs";
import { idText } from "./text.mjs";
import { runMark, localMain } from "./refresh.mjs";

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
export const EXPORT_NAME = "flight-board-export";
// The collections a complete export holds (collector/TASK.md, step 1).
export const EXPORT_COLLECTIONS = ["initiatives", "waiting", "ideas", "messages", "derived", "ctx", "steps", "plan"];
// The ones a complete export must hold: an empty collection exports no folder, and a board may have no plan yet (v3).
export const REQUIRED_COLLECTIONS = EXPORT_COLLECTIONS.filter((c) => c !== "plan");
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
export function runNudges(dir, config, docs, now) {
  const path = join(dir, "nudges.json");
  let before = {};
  try { before = JSON.parse(readFileSync(path, "utf8")); } catch { /* first run, or a broken file: start afresh */ }
  const { lines, state } = nudges({ config, docs, now, state: before && typeof before === "object" ? before : {} });
  writeFileSync(path, JSON.stringify(state));
  return lines;
}

export function collect({ config, cards, git, gh, now }) {
  const c = config.collector;
  const cfg = { ...config, collector: { ...c, notes: localNotes(c.notes) } };
  const line = mainLine(git, c.remote, c.mainBranch);
  const heads = [...remoteHeads(git, c.remote), ...shippedHeads(git, line, c.shippedPattern)];
  const deployed = deployedSha(gh, c.deployWorkflow, c.mainBranch);
  const open = cards.filter((k) => !closed(k));
  const derived = {};
  for (const card of open) derived[card.id] = { ...derivePhase(card, factsFor(git, headFor(card.id, heads), { config: cfg, line, deployed }), cfg), at: now };
  const conflicts = open.map((k) => conflict(k, derived[k.id], config)).filter(Boolean);
  return { doc: { at: now, cards: derived, conflicts, liveButOpen: staleLive(open, derived, config) }, conflicts };
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
      writeFileSync(join(dir, "export-since.json"), JSON.stringify(runMark(Date.now(), config.collector.refresh.repos, localMain)));
      console.log(`Export the board into: your scratchpad folder + /${EXPORT_NAME}`);
      console.log(`Steps since: ${Date.now() - STEPS_DAYS * 864e5}`);
      process.exit(0);
    } catch (e) { console.error(`Collector: ${e.message}`); process.exit(1); }
  }
  try {
    let since = Infinity;
    try { since = JSON.parse(readFileSync(join(dir, "export-since.json"), "utf8")).at; } catch { /* no --prepare yet */ }
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
  const now = Date.now();
  const { doc, conflicts } = collect({ config, cards: mirror.docs.initiatives, git, gh, now });
  const nudged = { lines: runNudges(dir, config, mirror.docs, now) };
  const out = outPath(config, dir);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(doc, null, 2));
  console.log(`Derived ${Object.keys(doc.cards).length} open card(s) into ${out}.`);
  for (const line of conflicts) console.log(`CONFLICT ${line}`);
  if (doc.liveButOpen.length) console.log(`LIVE BUT OPEN (${doc.liveButOpen.length}): ${doc.liveButOpen.map(idText).join(", ")}`);
  for (const line of nudged.lines) console.log(line);
}
