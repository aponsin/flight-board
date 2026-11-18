// Makes the whole deploy pair for a signed commit of main (#C856; principle 1, nothing rests on memory): the deploy file, the tree file
// and the steps file with the hash-checked lines, and lists what changed since the last pair. Usage:
//   node scripts/make-pair.mjs <40-hex sha on origin/main> <n> [--out <the folder the owner runs the files from>] [--repo <checkout>]
// It writes board-store-deploy-pc<n>.mjs, board-store-tree-pc<n>.mjs (made by scripts/pair/make-pair.mjs from the reviewed templates) and
// board-store-pc<n>-steps.md, and (#C924) copies scripts/pair/board-deploy.mjs byte for byte as board-deploy.mjs (the one command that runs lines 1 and
// 2 over SSH; its sha256 is the steps file's first command), and prints each file's sha256. The sha must be on the fetched origin main, else nothing is written. The last pair
// is the highest earlier board-store-deploy-pc<k>.mjs that has its .done marker (#C889: a pair nobody ran deployed nothing); its pinned commit
// is where "changed since" starts, and the steps say the new pair REPLACES each never-run pair after it. When a hook file changed since then
// (HOOK_PINNED) a board-store-hooks-pc<n>.mjs is written too, from the newest earlier hooks file, and the steps get a third line. The steps file lists
// the commits and the changed paths in groups (Worker, probe and gate, page, hooks, migrations, wrangler config, tests, docs). It cannot see a
// new secret: it says to check the Worker config and code diff for one.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makePair } from "./pair/make-pair.mjs";
import { OUTER_EXTRA_SEC } from "../collector/probe-run.mjs";

const FULL = /^[0-9a-f]{40}$/;
export const SAFE_FOLDER = /^\/[A-Za-z0-9._\/-]{0,500}$/;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const plain = (v) => String(v).replace(/[^\x20-\x7e]/g, " ").replace(/["\\`$]|@@/g, "").replace(/\s+/g, " ").trim();

// The groups of a changed path, in the order they are listed.
export const GROUPS = [
  ["Worker code", /^worker\/(?!migrations\/|wrangler)/],
  ["database migration", /(^|\/)migrations\//],
  ["Worker config (check for a new binding or secret)", /^worker\/wrangler/],
  ["page", /^page\//],
  ["probe and gate code", /^(collector|gate|scripts)\//],
  ["hooks", /^hooks\//],
  ["tests", /^tests\//],
  ["docs", /^(docs\/|README\.md$|CHANGELOG\.md$|CHANGELOG\.d\/[^/]+\.md$)/],
];
export function groupPaths(paths) {
  const out = new Map(GROUPS.map(([g]) => [g, []]));
  const other = [];
  for (const p of paths) {
    const hit = GROUPS.find(([, re]) => re.test(p));
    if (hit) out.get(hit[0]).push(p); else other.push(p);
  }
  if (other.length) out.set("other", other);
  return [...out].filter(([, v]) => v.length);
}

// The pairs before n in the folder, newest first: [{ n, sha, ran }]. ran is true when the deploy step left its board-store-deploy-pc<k>.done marker.
function pairsBefore(folder, n) {
  if (!existsSync(folder)) return [];
  const names = readdirSync(folder);
  const found = names.map((f) => /^board-store-deploy-pc(\d{1,6})\.mjs$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).filter((k) => k < n).sort((a, b) => b - a);
  const out = [];
  for (const k of found) {
    const m = /const SIGNED = "([0-9a-f]{40})"/.exec(readFileSync(join(folder, `board-store-deploy-pc${k}.mjs`), "utf8"));
    if (!m) continue; // a deploy file with no pin is no pair (Checker LOW on ab5355a)
    // ran: the marker exists AND holds this pair's own signed sha (the deploy step writes it), so a stray or empty file is not a deploy.
    const done = join(folder, `board-store-deploy-pc${k}.done`);
    out.push({ n: k, sha: m[1], ran: names.includes(`board-store-deploy-pc${k}.done`) && readFileSync(done, "utf8").trim() === m[1] });
  }
  return out;
}

// The last pair that RAN (#C889): the highest earlier pair with a .done marker, because a pair nobody ran deployed nothing and what it
// carried still has to go out. A folder where no pair has a marker (old ones) falls back to the highest earlier pair. { n, sha } or null.
export function lastPair(folder, n) {
  const all = pairsBefore(folder, n);
  const p = all.find((x) => x.ran) ?? all[0];
  return p ? { n: p.n, sha: p.sha } : null;
}

// #C1210 (Manager: pc87 changed the ask limit but wrote no plist, so a comparison with the last PACK would find no change in pc88 and the alarm would stay at 45 s): the newest earlier pair whose
// probes step RAN here (it leaves board-store-probes-pc<k>.done beside itself), { n, sha }, or null. What its step wrote is what the LaunchAgents hold, so that is the base to compare with.
export function lastProbesPair(folder, n) {
  if (!existsSync(folder)) return null;
  const names = readdirSync(folder);
  const p = pairsBefore(folder, n).find((x) => names.includes(`board-store-probes-pc${x.n}.mjs`) && names.includes(`board-store-probes-pc${x.n}.done`));
  return p ? { n: p.n, sha: p.sha } : null;
}

// The pairs between the last one that ran and n that were never run: the new pair replaces them. [{ n, sha }], newest first.
export function neverRun(folder, n) {
  const all = pairsBefore(folder, n);
  const last = all.find((x) => x.ran);
  return last ? all.filter((x) => x.n > last.n).map(({ n: k, sha }) => ({ n: k, sha })) : [];
}

// What the settings.json entries run from the pinned copy: the two gate scripts, and everything they import (Security R1 on 0f36fd0: a change to
// gate/tools.mjs or a file imported two levels down is enforced only once the hooks are re-pinned), plus the hook scripts and the installer.
// Security R1b on ab5355a: the entries are every script scripts/hooks.mjs can write into settings.json (cmd("...")), plus the scripts the gate tells every
// agent to run from the pinned copy (scripts/wake-watch.mjs, named in gate/wake.mjs) and the collector's fence; HOOK_READS are files the closure reads
// at run time without importing them (scripts/build-page.mjs reads page/board.template.html through import.meta.url). A name absent at the sha is skipped.
// #C1058: the release tool too. The landing job starts the copy in the owner's installed folder (the one his hooks pin), which moves only when the hooks step moves the pin,
// so a pack that carries a changed release tool, or a file it imports, needs that step.
// #C1140: the landing job too (scripts/board-land.mjs). It runs from the owner's pinned install, which exists only once the hooks step has run, so a pack that carries a changed land job,
// or a file it imports, needs that step and the land step after it (landText).
export const HOOK_ENTRIES = ["gate/stop.mjs", "gate/publish.mjs", "gate/first-push.mjs", "collector/fence.mjs", "scripts/wake-watch.mjs", "scripts/board-release.mjs", "scripts/board-land.mjs"];
export const LAND_ENTRIES = ["scripts/board-land.mjs"];
export const HOOK_READS = ["page/board.template.html"];
export const HOOK_PINNED = /^(hooks\/|scripts\/hooks\.mjs$)/;
// The files at `sha` the two entries import, relative imports followed (static and dynamic), entries included: a Set of repo paths.
export function importClosure(git, sha, entries = HOOK_ENTRIES) {
  const seen = new Set(), todo = [...entries];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    const r = git("show", `${sha}:${f}`);
    if (r.status !== 0) continue;
    seen.add(f);
    for (const m of String(r.stdout).matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) todo.push(posix.normalize(posix.join(posix.dirname(f), m[1])));
  }
  return seen;
}
// Which of the changed paths are hook-pinned at `sha`.
export function hookChanged(git, sha, paths) {
  const closure = importClosure(git, sha);
  return paths.filter((p) => HOOK_PINNED.test(p) || HOOK_READS.includes(p) || closure.has(p));
}

// #C1140: which of the changed paths the landing job runs: scripts/board-land.mjs and the files it imports, at `sha`.
export function landChanged(git, sha, paths) {
  const closure = importClosure(git, sha, LAND_ENTRIES);
  return paths.filter((p) => closure.has(p));
}
// The landing-job step of pair `name`, from scripts/pair/land.template.mjs: its only variables are the pair's name and the pinned main. A template that still holds a placeholder is refused.
export function landText({ name, sha, template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pair", "land.template.mjs"), "utf8") }) {
  if (!/^pc\d{1,6}$/.test(String(name)) || !FULL.test(String(sha))) throw new Error("the landing-job step needs a pair name (pc<n>) and a full sha");
  const text = template.split("@@NAME@@").join(name).split("@@SIGNED@@").join(sha);
  if (/@@[A-Z]+@@/.test(text)) throw new Error("the landing-job template has a placeholder this tool does not fill");
  return text;
}

// #C1210 (Security on pc87: the ask LaunchAgent kept its alarm of 45 s after #C1208 raised the ask job's limit to 65 s, and no pack step rewrote it): the probe jobs' numbers are read from
// worker/probe-jobs.mjs (JOBS) at a sha. The file is a plain literal that imports nothing, one `name: { intervalSec: N, limitSec: M }` per job; a file that is there but that this cannot read as that gives null, no file gives {}.
export function jobsAt(git, sha) {
  const r = git("show", `${sha}:worker/probe-jobs.mjs`);
  if (r.status !== 0) return {}; // no such file at that commit: no jobs to compare (a repository without a probe)
  const body = /export const JOBS = \{([\s\S]*?)\n\};/.exec(String(r.stdout))?.[1];
  if (body === undefined) return null;
  const out = {};
  for (const m of body.matchAll(/^\s*(\w+):\s*\{\s*(intervalSec|limitSec):\s*(\d+),\s*(intervalSec|limitSec):\s*(\d+)\s*\}/gm)) {
    if (m[2] === m[4]) return null;
    out[m[1]] = { [m[2]]: Number(m[3]), [m[4]]: Number(m[5]) };
  }
  // Security's INFO on #C1210: an entry in another form (two lines, a third key) must not just get no step: a body with more job lines than were read is a table this cannot read.
  if (Object.keys(out).length !== (body.match(/^\s*\w+:\s*\{/gm) ?? []).length) return null;
  return Object.keys(out).length ? out : null;
}
// The jobs whose limitSec or intervalSec at `sha` differs from `baseSha` (a job new at `sha` counts; no base, as when no probes step ever ran here, is every job), as { job: { intervalSec, limitSec } };
// {} when none changed. Either side unreadable: an error, never {}.
export function probesChanged(git, baseSha, sha) {
  const before = baseSha ? jobsAt(git, baseSha) : {}, after = jobsAt(git, sha);
  if (!before || !after) throw new Error("worker/probe-jobs.mjs cannot be read as the JOBS table at one of the two commits, so the probe jobs' limits cannot be compared");
  return Object.fromEntries(Object.entries(after).filter(([job, v]) => before[job]?.limitSec !== v.limitSec || before[job]?.intervalSec !== v.intervalSec));
}
// The probe-jobs step of pair `name`, from scripts/pair/probes.template.mjs: it names only the jobs given. A template that still holds a placeholder is refused.
export function probesText({ name, jobs, template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pair", "probes.template.mjs"), "utf8") }) {
  if (!/^pc\d{1,6}$/.test(String(name))) throw new Error("the probe-jobs step needs a pair name (pc<n>)");
  const entries = Object.entries(jobs ?? {});
  if (!entries.length || !entries.every(([job, v]) => /^[a-z]{1,20}$/.test(job) && Number.isInteger(v?.limitSec) && v.limitSec > 0 && Number.isInteger(v?.intervalSec) && v.intervalSec > 0)) throw new Error("the probe-jobs step needs at least one job with a whole limitSec and intervalSec");
  const text = template.split("@@NAME@@").join(name).split("@@MARGIN@@").join(String(OUTER_EXTRA_SEC)).split("@@JOBS@@").join(JSON.stringify(Object.fromEntries(entries.map(([job, v]) => [job, { intervalSec: v.intervalSec, limitSec: v.limitSec }]))));
  if (/@@[A-Z]+@@/.test(text)) throw new Error("the probe-jobs template has a placeholder this tool does not fill");
  return text;
}

// The newest board-store-hooks-pc<k>.mjs before n in the folder, or null.
function lastHooksFile(folder, n) {
  if (!existsSync(folder)) return null;
  const k = readdirSync(folder).map((f) => /^board-store-hooks-pc(\d{1,6})\.mjs$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).filter((x) => x < n).sort((a, b) => b - a)[0];
  return k === undefined ? null : { n: k, text: readFileSync(join(folder, `board-store-hooks-pc${k}.mjs`), "utf8") };
}

// #C1141 (Security's INFO on pc77): the steps file's heading and the hooks script's first comment named only the Stop hook after the hooks line began installing the first-push guard
// too. The words now come from the entries scripts/hooks.mjs at the pin writes (hookEntriesAt), not from a hand-typed list: "the Stop hook and the first-push guard". A hook this table
// does not know is named by its file ("the <file> hook"); no entries (a repository with no readable installer) keeps the old wording.
const HOOK_LABELS = { "stop.mjs": "Stop hook", "first-push.mjs": "first-push guard" };
export function hookNames(entries) {
  const files = Object.values(entries ?? {}).flatMap((e) => [].concat(e)).flatMap((e) => (e?.hooks ?? []).map((h) => /\/([A-Za-z0-9-]+\.mjs)(?:\s|'|$)/.exec(String(h?.command ?? ""))?.[1])).filter(Boolean);
  const words = [...new Set(files)].map((f) => `the ${HOOK_LABELS[f] ?? `${f.replace(/\.mjs$/, "")} hook`}`);
  if (!words.length) return "the Stop hook";
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

// The hooks file of pair n made from the earlier one: only the pin, the pc number and the first comment line change.
// cueSha is the sha256 of hooks/send-refused-cue.py at the new sha: the installer checks the cue against it, so a changed cue moves it too.
export function hooksText(prev, { name, sha, cueSha, hookWords = "the Stop hook" }) {
  const m = /const SIGNED = "([0-9a-f]{40})"/.exec(prev.text);
  if (!m) throw new Error(`board-store-hooks-pc${prev.n}.mjs has no const SIGNED pin to move`);
  if (!/const CUE_SHA = "[0-9a-f]{64}"/.test(prev.text)) throw new Error(`board-store-hooks-pc${prev.n}.mjs has no const CUE_SHA to move`);
  const old = m[1];
  const lines = prev.text.split("\n");
  lines[0] = "@@FIRST@@";
  // The pair number only as a whole number: pc2 is not the start of pc26.
  const body = lines.join("\n").replace(/const CUE_SHA = "[0-9a-f]{64}"/, `const CUE_SHA = "${cueSha}"`).split(old).join(sha).split(old.slice(0, 8)).join(sha.slice(0, 8)).split(old.slice(0, 7)).join(sha.slice(0, 7)).replace(new RegExp(`pc${prev.n}(?!\\d)`, "g"), name);
  return storeOnly(body.replace("@@FIRST@@", `// The hooks step of pair ${name} (pins ${hookWords} to this main), for flight-board main ${sha}. Made by scripts/make-pair.mjs from board-store-hooks-pc${prev.n}.mjs: the pin and the pair number changed${/two board entries|publish\.length !== 1/.test(prev.text) && !/first\.length/.test(prev.text) ? ", and its read-back now expects the one Stop entry the installer writes (the page-publish entry is retired, #C1054)" : ""}${/board\.length !== \d+ \|\| stop\.length/.test(prev.text) && !/first\.length/.test(prev.text) ? ", and its read-back now also expects the PreToolUse first-push guard entry (gate/first-push.mjs, #C1065)" : ""}. Run by the owner in Terminal AFTER the pair's two lines`));
}

// Security's RISKS on pc67 line 3 (11-16): the hooks file is made from the previous pair's, so when scripts/hooks.mjs stopped writing the page-publish entry
// (#C1054 b1) the copied read-back still required two board entries, and the step would have failed on the owner's Mac and sent them to undo. The old
// wording is rewritten here, string for string; a text that is already store-only is left as it is (no match, no change).
export const STORE_ONLY_FIXES = [
  ["That leaves exactly two board entries,\n//     Stop gate/stop.mjs --store and PreToolUse gate/publish.mjs on the page tools, both from the pinned copy of ", "That leaves exactly one board entry,\n//     Stop gate/stop.mjs --store, from the pinned copy of "],
  ["exactly two board entries, both from ", "exactly one board entry, from "],
  ["// Read it back: two board entries from the signed commit,", "// Read it back: one board entry (the Stop hook) from the signed commit,"],
  ["board.length !== 2 || stop.length !== 1 || publish.length !== 1 ||", "board.length !== 1 || stop.length !== 1 || publish.length !== 0 ||"],
  ["exactly two board entries (Stop stop.mjs --store, PreToolUse publish.mjs), both from ${SIGNED.slice(0, 8)};", "exactly one board entry (Stop stop.mjs --store; no page-publish entry) from ${SIGNED.slice(0, 8)};"],
];
export function storeOnly(text) {
  if (/first\.length/.test(text)) return text; // already moved to the first-push read-back (#C1065): its "two board entries" is the new wording, not the retired page-publish one
  let out = text;
  for (const [from, to] of STORE_ONLY_FIXES) out = out.split(from).join(to);
  if (/two board entries|publish\.length !== 1/.test(out)) throw new Error("the hooks file still expects two board entries (the page-publish entry): the template's read-back wording is not one this tool knows how to move; fix it by hand and add the wording to STORE_ONLY_FIXES");
  return firstPushToo(out);
}

// #C1065: scripts/hooks.mjs also writes the PreToolUse first-push guard (gate/first-push.mjs), so the hooks step's read-back expects two board entries: the Stop
// --store one and that one, both from the pin. The previous pair's hooks file says one; this moves its wording and its check, string for string. A text that already
// expects the first-push entry (it holds "first.length") is left as it is, and a text with no read-back line (a fixture) too.
export const FIRST_PUSH_FIXES = [
  ["That leaves exactly one board entry,\n//     Stop gate/stop.mjs --store, from the pinned copy of ", "That leaves exactly two board entries,\n//     Stop gate/stop.mjs --store and PreToolUse gate/first-push.mjs, both from the pinned copy of "],
  ["exactly one board entry, from ", "exactly two board entries, both from "],
  ["// Read it back: one board entry (the Stop hook) from the signed commit,", "// Read it back: two board entries (the Stop hook and the first-push guard) from the signed commit,"],
  ["const publish = board.filter((c) => c.includes(`/${SIGNED}/gate/publish.mjs`));", "const publish = board.filter((c) => c.includes(`/${SIGNED}/gate/publish.mjs`));\nconst first = board.filter((c) => c.includes(`/${SIGNED}/gate/first-push.mjs`));"],
  ["board.length !== 1 || stop.length !== 1 || publish.length !== 0 ||", "board.length !== 2 || stop.length !== 1 || publish.length !== 0 || first.length !== 1 ||"],
  ["(board entries ${board.length}, stop --store ${stop.length}, publish ${publish.length},", "(board entries ${board.length}, stop --store ${stop.length}, publish ${publish.length}, first-push ${first.length},"],
  ["exactly one board entry (Stop stop.mjs --store; no page-publish entry) from ${SIGNED.slice(0, 8)};", "exactly two board entries (Stop stop.mjs --store and PreToolUse first-push.mjs; no page-publish entry) from ${SIGNED.slice(0, 8)};"],
];
export function firstPushToo(text) {
  if (!/board\.length !== \d+ \|\| stop\.length !== \d+/.test(text) || /first\.length/.test(text)) return text;
  let out = text;
  for (const [from, to] of FIRST_PUSH_FIXES) out = out.split(from).join(to);
  // The read-back now names `first`: if the line that defines it did not land, the step would stop with a ReferenceError on the owner's Mac AFTER the installer wrote. Refuse here.
  if (!/const first = board\.filter/.test(out)) throw new Error("the hooks file has a read-back but no `const publish = board.filter(...)` line to put the first-push count beside: the template's wording is not one this tool knows how to move; fix it by hand and add the wording to FIRST_PUSH_FIXES");
  return out;
}

// What the hooks step expects of settings.json after the installer ran (its read-back line), and what scripts/hooks.mjs at the pin writes: the two must
// agree, or the step fails on the owner's Mac after the installer has already written (the pc67 case). The counts are { board, stop, publish }.
export function hooksExpectation(text) {
  const m = /board\.length !== (\d+) \|\| stop\.length !== (\d+) \|\| publish\.length !== (\d+)(?: \|\| first\.length !== (\d+))?/.exec(String(text));
  return m ? { board: Number(m[1]), stop: Number(m[2]), publish: Number(m[3]), first: Number(m[4] ?? 0) } : null; // a text with no first-push check expects none (#C1065)
}
export function hooksWritten(entries) {
  const commands = Object.values(entries ?? {}).flatMap((e) => [].concat(e)).flatMap((e) => (e?.hooks ?? []).map((h) => String(h?.command ?? "")));
  return { board: commands.length, stop: commands.filter((c) => c.includes("/gate/stop.mjs") && c.endsWith("--store")).length, publish: commands.filter((c) => c.includes("/gate/publish.mjs")).length, first: commands.filter((c) => c.includes("/gate/first-push.mjs")).length };
}
export function checkHooksExpectation(text, entries) {
  const want = hooksExpectation(text);
  if (!want) return { ok: true, skipped: true }; // a text with no read-back line (a fixture) has nothing to compare
  const got = hooksWritten(entries);
  const same = want.board === got.board && want.stop === got.stop && want.publish === got.publish && want.first === got.first;
  return same ? { ok: true } : { ok: false, why: `the hooks step expects ${want.board} board entr${want.board === 1 ? "y" : "ies"} (${want.stop} Stop --store, ${want.publish} publish, ${want.first} first-push) after the install, but scripts/hooks.mjs at the pin writes ${got.board} (${got.stop} Stop --store, ${got.publish} publish, ${got.first} first-push)` };
}
// The entries scripts/hooks.mjs at `sha` writes: that file read from git, run in a child with fixed arguments (it imports only node's own modules).
export function hookEntriesAt(git, sha) {
  const r = git("show", `${sha}:scripts/hooks.mjs`);
  if (r.status !== 0) return null;
  const dir = mkdtempSync(join(tmpdir(), "make-pair-hooks-"));
  try {
    writeFileSync(join(dir, "hooks.mjs"), String(r.stdout));
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", `import { hookEntries } from ${JSON.stringify(pathToFileURL(join(dir, "hooks.mjs")).href)}; process.stdout.write(JSON.stringify(hookEntries("/pin", "/board.config.json", "/bin/node")));`], { encoding: "utf8", timeout: 20_000 });
    return run.status === 0 ? JSON.parse(run.stdout) : null;
  } catch { return null; } finally { rmSync(dir, { recursive: true, force: true }); }
}

// The checks over a git runner git(...args) -> { status, stdout }: the sha is a commit on the fetched origin main. { ok, why }.
export function onMain(git, sha) {
  if (!FULL.test(String(sha))) return { ok: false, why: "the commit is not a full 40-hex sha" };
  const f = git("fetch", "origin", "main");
  if (f.status !== 0) return { ok: false, why: `git fetch origin main exited ${f.status}` };
  const tip = String(git("rev-parse", "FETCH_HEAD").stdout ?? "").trim();
  if (!FULL.test(tip)) return { ok: false, why: "the fetched main has no commit" };
  if (git("cat-file", "-e", `${sha}^{commit}`).status !== 0) return { ok: false, why: `${sha.slice(0, 8)} is not in the repository` };
  if (git("merge-base", "--is-ancestor", sha, tip).status !== 0) return { ok: false, why: `${sha.slice(0, 8)} is not on origin main` };
  return { ok: true, tip };
}

export function stepsText({ name, sha, prev, commits, paths, deploySha, treeSha, folder, skipped = [], hooksSha = null, hookPaths = [], boardDeploySha = null, landSha = null, landPaths = [], hookWords = "the Stop hook", probesSha = null, probeJobs = {} }) {
  const s8 = sha.slice(0, 8), s7 = sha.slice(0, 7);
  const cards = [...new Set(commits.flatMap((c) => c.match(/#C\d+/g) ?? []))];
  const groups = groupPaths(paths);
  const list = skipped.map((p) => `pc${p.n}`).reverse();
  const replaces = skipped.length
    ? `${name} REPLACES ${list.join(" and ")} (never run: no board-store-deploy-pc<n>.done marker): do not run ${skipped.length === 1 ? "it" : "them"}. It carries everything ${skipped.length === 1 ? "it" : "they"} carried, because the list below starts at ${prev.sha.slice(0, 8)} (pc${prev.n}), the last pair that ran.\n`
    : "";
  const changed = prev
    ? [`Changed since ${prev.sha.slice(0, 8)} (${`pc${prev.n}`}${skipped.length ? ", the last pair that ran" : ""}):`, ...(commits.length ? commits.map((c) => `- ${plain(c)}`) : ["- no commit"]), "", groups.length ? "Changed paths, by kind:" : "No path changed.", ...groups.map(([g, v]) => `- ${g}: ${v.join(", ")}`)]
    : ["There is no earlier pair in this folder, so nothing is compared: every path of the commit is new to this folder."];
  const migration = groups.some(([g]) => g === "database migration");
  const worker = groups.some(([g]) => g === "Worker code" || g === "database migration" || g === "Worker config (check for a new binding or secret)");
  return `# ${name}: ${cards.length ? cards.join(", ") : "main"} at ${s8}

Pinned to flight-board main ${sha}. Each line checks the file's SHA-256 first and prints CHECK FAILED instead of running a changed file. ${hooksSha ? (landSha ? "Four lines (the third installs the hooks, the fourth moves the landing job to the pinned install, both pinned to this main)" : "Three lines (the third installs the hooks, pinned to this main)") : "Two lines"}, in this order, one at a time, from any folder: every path is full (#C921).
${replaces}${worker ? "The Worker changes: deploy it first (line 1), then the tree (line 2)." : "No Worker code changes: line 1 only tells the Worker which commit it carries."} ${migration ? "A database migration is part of this deploy: answer y if it asks." : "No database migration."}${worker ? " A new secret cannot be seen from the diff: read the Worker code and Worker config lines below." : ""}
If wrangler is not signed in: fill cloudflareApiToken and cloudflareAccountId in ${folder}/board.private.json (mode 600, made once by you in Terminal, never in a chat; with it nothing opens a browser, so it works over SSH), or sign in once with a browser: npx wrangler@4.150.0 login.

${changed.join("\n")}

${boardDeploySha ? `
## One command: lines 1 and 2 together (works over SSH)

\`\`\`bash
if [ "$(shasum -a 256 ${folder}/board-deploy.mjs | cut -c1-64)" = ${boardDeploySha} ]; then node ${folder}/board-deploy.mjs ${name} ${deploySha} ${treeSha}; else echo 'CHECK FAILED: board-deploy.mjs is not the signed file. Paste this line to Manager.'; fi
\`\`\`

The line itself carries the deploy file's and the tree file's hashes, so what runs is bound to what was signed, not to a file on this disk. It checks the deploy file and the tree file against those two hashes first (CHECK FAILED, nothing run, if either differs, or if the hashes in this steps file disagree with them), runs line 1, then line 2, and stops at the first one that fails. It ends with the DEPLOY OK and TREE OK lines. The hooks step, when this pair has one, stays by hand: the command only reminds you of it and prints no line for it, so paste line 3 below from the pair's post. If you run this, skip the two lines below: they are the same two steps, by hand.

` : ""}## Line 1: deploy${boardDeploySha ? " (by hand)" : ""}

\`\`\`bash
if [ "$(shasum -a 256 ${folder}/board-store-deploy-${name}.mjs | cut -c1-64)" = ${deploySha} ]; then node ${folder}/board-store-deploy-${name}.mjs; else echo 'CHECK FAILED: board-store-deploy-${name}.mjs is not the signed file. Paste this line to Manager.'; fi
\`\`\`

Last line: \`DEPLOY OK: the Worker carries ${s8}; now run the tree step\`, and a new file \`board-store-deploy-${name}.done\`. On \`DEPLOY FAILED: ...\` stop and paste it to Manager. Undo: \`npx wrangler@4.150.0 rollback --config ${folder}/board-store-pa/worker/wrangler.board.toml\`.
${boardDeploySha ? `
### Undo line 1 in one command (the same token, works over SSH)

\`\`\`bash
if [ "$(shasum -a 256 ${folder}/board-deploy.mjs | cut -c1-64)" = ${boardDeploySha} ]; then node ${folder}/board-deploy.mjs rollback ${name} ${deploySha}; else echo 'CHECK FAILED: board-deploy.mjs is not the signed file. Paste this line to Manager.'; fi
\`\`\`

It checks the deploy file against the hash on the line (and against this steps file), then puts the Worker back on its previous version with the token from board.private.json; wrangler asks you to confirm: answer y. It ends with \`ROLLBACK OK\` or \`ROLLBACK FAILED\`. The database keeps its new columns, and the file \`board-store-deploy-${name}.done\` is removed, so the tree step refuses until line 1 runs again. The tree step has its own undo, below.
` : ""}
## Line 2: tree${boardDeploySha ? " (by hand)" : ""}

\`\`\`bash
if [ "$(shasum -a 256 ${folder}/board-store-tree-${name}.mjs | cut -c1-64)" = ${treeSha} ]; then node ${folder}/board-store-tree-${name}.mjs update; else echo 'CHECK FAILED: board-store-tree-${name}.mjs is not the signed file. Paste this line to Manager.'; fi
\`\`\`

Should print \`TREE OK: board-store-v4 is at ${s7}\`. Undo: \`node ${folder}/board-store-tree-${name}.mjs back\`. It refuses if line 1 has not run.
${hooksSha ? `
## Line 3: hooks (${hookWords}, pinned to this main)

\`\`\`bash
if [ "$(shasum -a 256 ${folder}/board-store-hooks-${name}.mjs | cut -c1-64)" = ${hooksSha} ]; then node ${folder}/board-store-hooks-${name}.mjs; else echo 'CHECK FAILED: board-store-hooks-${name}.mjs is not the signed file. Paste this line to Manager.'; fi
\`\`\`

It refuses unless line 2 has run (the tree is at ${s7}). Then quit the app and open it again: hooks load when a session starts. Undo: \`node ${folder}/board-store-hooks-${name}.mjs undo\`. Hook files changed since ${prev ? prev.sha.slice(0, 8) : "the start"}: ${hookPaths.join(", ")} (a hook script, the installer, or a file the two gate scripts import).
` : ""}${hooksSha && landSha ? `
## Line 4: landing job (moves the LaunchAgent to the pinned install)

\`\`\`bash
if [ "$(shasum -a 256 ${folder}/board-store-land-${name}.mjs | cut -c1-64)" = ${landSha} ]; then node ${folder}/board-store-land-${name}.mjs; else echo 'CHECK FAILED: board-store-land-${name}.mjs is not the signed file. Paste this line to Manager.'; fi
\`\`\`

The landing job (the LaunchAgent \`com.flight-board.store.land\`, every 10 minutes) runs scripts/board-land.mjs; this step points it at \`~/.flight-board/install/${sha}/scripts/board-land.mjs\`, the install line 3 made, instead of \`~/.flight-board/current\`, so a changed land job runs only after you install it. It refuses unless that file exists (line 3 has run), keeps a backup of the LaunchAgent's file, reloads the job and checks launchd has it. Last line: \`LAND OK: ...\`. Undo: \`node ${folder}/board-store-land-${name}.mjs undo\`. Land job files changed since ${prev ? prev.sha.slice(0, 8) : "the start"}: ${landPaths.join(", ")}.
` : ""}${probesSha ? `
## Probe jobs (moves the probe LaunchAgents to the new limits; run it after the lines above)

\`\`\`bash
if [ "$(shasum -a 256 ${folder}/board-store-probes-${name}.mjs | cut -c1-64)" = ${probesSha} ]; then node ${folder}/board-store-probes-${name}.mjs; else echo 'CHECK FAILED: board-store-probes-${name}.mjs is not the signed file. Paste this line to Manager.'; fi
\`\`\`

The jobs this step checks (the first time, every one; later, those whose limit or interval changed since the last pack whose probes step ran): ${Object.entries(probeJobs).map(([job, v]) => `${job} (limit ${v.limitSec} s, every ${v.intervalSec} s)`).join(", ")}. Each job is a LaunchAgent (\`com.flight-board.store.<job>\`) that the OS ends at its alarm; the pack changes the program, not the alarm, so this step rewrites the alarm (the limit plus ${OUTER_EXTRA_SEC} s) and the interval of those jobs only, keeps a backup of each file, checks it with plutil, reloads the job and reads the file back. The first time, a job whose installed alarm or interval differs from the table is moved to it even if no commit changed it (the line it prints names each job it moved, with the new alarm). A job with no file here is skipped and said so. Last line: \`PROBES OK: ...\`. Undo: \`node ${folder}/board-store-probes-${name}.mjs undo\`.
` : ""}
Full sha256: deploy ${deploySha}, tree ${treeSha}${boardDeploySha ? `, board-deploy ${boardDeploySha}` : ""}${hooksSha ? `, hooks ${hooksSha}` : ""}${landSha ? `, land ${landSha}` : ""}${probesSha ? `, probes ${probesSha}` : ""}.
`;
}

// Writes the three files into `out`. { ok, why, files: { name: sha256 } }; nothing is written unless ok.
export function makeAll({ repo, sha, n, out, git = (...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" }) }) {
  if (!Number.isInteger(n) || n < 1 || n > 999999) return { ok: false, why: "n is the pair's number, a whole number from 1" };
  // #C931 (Checker LOW 3 on #C921): every line names the folder unquoted (a quoted ~ would not expand), so a folder the shell would split or
  // read (a space, a quote, $, ;, &, a glob) is refused, and nothing is written.
  if (!SAFE_FOLDER.test(String(out))) return { ok: false, why: "the --out folder must be a plain path (letters, digits, / . _ - only; no space or quote): every line names it unquoted" };
  const m = onMain(git, sha);
  if (!m.ok) return m;
  const name = `pc${n}`;
  const prev = lastPair(out, n);
  let commits = [], paths = [];
  if (prev) {
    if (git("cat-file", "-e", `${prev.sha}^{commit}`).status !== 0) return { ok: false, why: `the last pair (pc${prev.n}) pins ${prev.sha.slice(0, 8)}, which is not in the repository` };
    if (git("merge-base", "--is-ancestor", prev.sha, sha).status !== 0) return { ok: false, why: `the last pair (pc${prev.n}) pins ${prev.sha.slice(0, 8)}, which is not behind ${sha.slice(0, 8)}: pairs go forward only` };
    commits = String(git("log", "--reverse", "--format=%s", `${prev.sha}..${sha}`).stdout).split("\n").filter(Boolean);
    paths = String(git("diff", "--name-only", prev.sha, sha).stdout).split("\n").filter(Boolean);
  }
  const cards = [...new Set(commits.flatMap((c) => c.match(/#C\d+/g) ?? []))].join(" and ") || "main"; // #C1014: every card the pair carries, never cut (a 120-character cut left "#C880 and," and dropped #C967)
  let files;
  try { files = makePair({ name, card: cards, what: `${commits.length} commit${commits.length === 1 ? "" : "s"}${prev ? ` since ${prev.sha.slice(0, 8)}` : ""}`, signed: sha, deployOk: `the Worker carries ${sha.slice(0, 8)}; now run the tree step`, treeOk: `board-store-v4 is at ${sha.slice(0, 7)}` }); }
  catch (e) { return { ok: false, why: `the pair's header cannot name every card it carries: ${e.message}` }; }
  // A hook file changed since the last pair that ran: the hooks step is written too, from the newest earlier hooks file in the folder.
  // "Hook file" = a hook script, the installer, or any file the two gate entries import (Security R1 on 0f36fd0), read at the new sha.
  let hooks = null, hookWords = "the Stop hook";
  const hookPaths = hookChanged(git, sha, paths);
  if (hookPaths.length) {
    const from = lastHooksFile(out, n);
    if (!from) return { ok: false, why: "a hook file changed since the last pair that ran, but the folder has no earlier board-store-hooks-pc<n>.mjs to make the hooks step from" };
    const cue = git("show", `${sha}:hooks/send-refused-cue.py`);
    if (cue.status !== 0) return { ok: false, why: `hooks/send-refused-cue.py is not in ${sha.slice(0, 8)}: its sha256 is pinned in the hooks step` };
    const entries = hookEntriesAt(git, sha); // #C1141: also names the hooks in the steps (hookWords), from what the installer writes
    hookWords = hookNames(entries);
    try { hooks = hooksText(from, { name, sha, cueSha: sha256(cue.stdout), hookWords }); } catch (e) { return { ok: false, why: e.message }; }
    // The step's read-back against what the installer at the pin writes (Security's RISKS on pc67): a disagreement writes nothing.
    if (hooksExpectation(hooks)) {
      if (!entries) return { ok: false, why: `scripts/hooks.mjs at ${sha.slice(0, 8)} cannot be read or run, so the hooks step's read-back cannot be checked against it` };
      const c = checkHooksExpectation(hooks, entries);
      if (!c.ok) return { ok: false, why: c.why };
    }
  }
  // #C1140: the landing job changed (scripts/board-land.mjs or a file it imports): its step moves the LaunchAgent to the pinned install. board-land.mjs is a hook entry, so the hooks step
  // (which creates that install) is always written with it; without a hooks step there is nothing to run the land step after, and the pack is refused rather than written half.
  let land = null;
  const landPaths = landChanged(git, sha, paths);
  if (landPaths.length) {
    if (!hooks) return { ok: false, why: "the landing job changed but the pack has no hooks step to create the pinned install it would run from" };
    try { land = landText({ name, sha }); } catch (e) { return { ok: false, why: e.message }; }
  }
  // #C1210: a probe job's limit or interval changed since the last pair: its LaunchAgent keeps the old alarm until a step rewrites it. The step needs no pinned install, so it has no hooks dependency.
  let probes = null, probeJobs = {};
  if (prev) {
    // The base is the last pair whose probes step RAN here, not the last pair: a pack that changed a job's limit without the step (pc87) would otherwise be the base, and the next pack would find nothing to do.
    // With no such pair, every job is named: the step compares each with the LaunchAgent actually installed and changes only a file that differs.
    const lastProbes = lastProbesPair(out, n);
    try { probeJobs = probesChanged(git, lastProbes?.sha ?? null, sha); } catch (e) { return { ok: false, why: e.message }; }
    if (Object.keys(probeJobs).length) { try { probes = probesText({ name, jobs: probeJobs }); } catch (e) { return { ok: false, why: e.message }; } }
  }
  const hashes = Object.fromEntries(Object.entries(files).map(([f, t]) => [f, sha256(t)]));
  const hooksName = `board-store-hooks-${name}.mjs`;
  // #C924: the generic one-command runner, copied byte for byte (the same file for every pair; its hash is in the steps file).
  const boardDeploy = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pair", "board-deploy.mjs"));
  const steps = stepsText({ name, sha, prev, commits, paths, deploySha: hashes[`board-store-deploy-${name}.mjs`], treeSha: hashes[`board-store-tree-${name}.mjs`], folder: out.startsWith(homedir() + "/") ? "~" + out.slice(homedir().length) : out, skipped: neverRun(out, n), hooksSha: hooks ? sha256(hooks) : null, hookPaths, boardDeploySha: sha256(boardDeploy), landSha: land ? sha256(land) : null, landPaths, hookWords, probesSha: probes ? sha256(probes) : null, probeJobs });
  const all = { ...files, ...(hooks ? { [hooksName]: hooks } : {}), ...(land ? { [`board-store-land-${name}.mjs`]: land } : {}), ...(probes ? { [`board-store-probes-${name}.mjs`]: probes } : {}), "board-deploy.mjs": boardDeploy, [`board-store-${name}-steps.md`]: steps };
  for (const [f, t] of Object.entries(all)) writeFileSync(join(out, f), t);
  return { ok: true, files: Object.fromEntries(Object.entries(all).map(([f, t]) => [f, sha256(t)])) };
}

import { isMain } from "./is-main.mjs";
if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  const pos = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
  const [sha, nText] = pos;
  const repo = resolve(flag("repo") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const out = resolve(flag("out") ?? process.cwd());
  const r = makeAll({ repo, sha, n: Number(nText), out });
  if (!r.ok) { console.log(`PAIR FAILED: ${r.why}. Nothing was written.`); process.exit(1); }
  for (const [f, h] of Object.entries(r.files)) console.log(`${h}  ${join(out, f)}`);
}
