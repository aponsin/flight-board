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
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { makePair } from "./pair/make-pair.mjs";

const FULL = /^[0-9a-f]{40}$/;
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
  ["docs", /^(docs\/|README\.md$|CHANGELOG\.md$)/],
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
export const HOOK_ENTRIES = ["gate/stop.mjs", "gate/publish.mjs", "gate/gate.mjs", "gate/commit.mjs", "gate/after.mjs", "gate/digest.mjs", "collector/refresh.mjs", "collector/fence.mjs", "scripts/wake-watch.mjs"];
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

// The newest board-store-hooks-pc<k>.mjs before n in the folder, or null.
function lastHooksFile(folder, n) {
  if (!existsSync(folder)) return null;
  const k = readdirSync(folder).map((f) => /^board-store-hooks-pc(\d{1,6})\.mjs$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).filter((x) => x < n).sort((a, b) => b - a)[0];
  return k === undefined ? null : { n: k, text: readFileSync(join(folder, `board-store-hooks-pc${k}.mjs`), "utf8") };
}

// The hooks file of pair n made from the earlier one: only the pin, the pc number and the first comment line change.
// cueSha is the sha256 of hooks/send-refused-cue.py at the new sha: the installer checks the cue against it, so a changed cue moves it too.
export function hooksText(prev, { name, sha, cueSha }) {
  const m = /const SIGNED = "([0-9a-f]{40})"/.exec(prev.text);
  if (!m) throw new Error(`board-store-hooks-pc${prev.n}.mjs has no const SIGNED pin to move`);
  if (!/const CUE_SHA = "[0-9a-f]{64}"/.test(prev.text)) throw new Error(`board-store-hooks-pc${prev.n}.mjs has no const CUE_SHA to move`);
  const old = m[1];
  const lines = prev.text.split("\n");
  lines[0] = "@@FIRST@@";
  // The pair number only as a whole number: pc2 is not the start of pc26.
  const body = lines.join("\n").replace(/const CUE_SHA = "[0-9a-f]{64}"/, `const CUE_SHA = "${cueSha}"`).split(old).join(sha).split(old.slice(0, 8)).join(sha.slice(0, 8)).split(old.slice(0, 7)).join(sha.slice(0, 7)).replace(new RegExp(`pc${prev.n}(?!\\d)`, "g"), name);
  return body.replace("@@FIRST@@", `// The hooks step of pair ${name} (pins the Stop hook and the page-publish hook to this main), for flight-board main ${sha}. Made by scripts/make-pair.mjs from board-store-hooks-pc${prev.n}.mjs: only the pin and the pair number changed. Run by the owner in Terminal AFTER the pair's two lines`);
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

export function stepsText({ name, sha, prev, commits, paths, deploySha, treeSha, folder, skipped = [], hooksSha = null, hookPaths = [], boardDeploySha = null }) {
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

Pinned to flight-board main ${sha}. Each line checks the file's SHA-256 first and prints CHECK FAILED instead of running a changed file. ${hooksSha ? "Three lines (the third installs the hooks, pinned to this main)" : "Two lines"}, in this order, one at a time.
${replaces}${worker ? "The Worker changes: deploy it first (line 1), then the tree (line 2)." : "No Worker code changes: line 1 only tells the Worker which commit it carries."} ${migration ? "A database migration is part of this deploy: answer y if it asks." : "No database migration."}${worker ? " A new secret cannot be seen from the diff: read the Worker code and Worker config lines below." : ""}
If wrangler is not signed in: fill cloudflareApiToken and cloudflareAccountId in ${folder}/board.private.json (mode 600, made once by you in Terminal, never in a chat; with it nothing opens a browser, so it works over SSH), or sign in once with a browser: npx wrangler@4.150.0 login.

${changed.join("\n")}

\`\`\`bash
cd ${folder}
\`\`\`
${boardDeploySha ? `
## One command: lines 1 and 2 together (works over SSH)

\`\`\`bash
if [ "$(shasum -a 256 board-deploy.mjs | cut -c1-64)" = ${boardDeploySha} ]; then node board-deploy.mjs ${name}; else echo 'CHECK FAILED: board-deploy.mjs is not the signed file. Paste this line to Manager.'; fi
\`\`\`

It checks the deploy file and the tree file against the hashes in this file first (CHECK FAILED, nothing run, if either differs), runs line 1, then line 2, and stops at the first one that fails. It ends with the DEPLOY OK and TREE OK lines. The hooks step, when this pair has one, stays by hand: it prints the line to paste. If you run this, skip the two lines below: they are the same two steps, by hand.

` : ""}## Line 1: deploy${boardDeploySha ? " (by hand)" : ""}

\`\`\`bash
if [ "$(shasum -a 256 board-store-deploy-${name}.mjs | cut -c1-64)" = ${deploySha} ]; then node board-store-deploy-${name}.mjs; else echo 'CHECK FAILED: board-store-deploy-${name}.mjs is not the signed file. Paste this line to Manager.'; fi
\`\`\`

Last line: \`DEPLOY OK: the Worker carries ${s8}; now run the tree step\`, and a new file \`board-store-deploy-${name}.done\`. On \`DEPLOY FAILED: ...\` stop and paste it to Manager. Undo: \`npx wrangler@4.150.0 rollback --config board-store-pa/worker/wrangler.board.toml\`.

## Line 2: tree${boardDeploySha ? " (by hand)" : ""}

\`\`\`bash
if [ "$(shasum -a 256 board-store-tree-${name}.mjs | cut -c1-64)" = ${treeSha} ]; then node board-store-tree-${name}.mjs update; else echo 'CHECK FAILED: board-store-tree-${name}.mjs is not the signed file. Paste this line to Manager.'; fi
\`\`\`

Should print \`TREE OK: board-store-v4 is at ${s7}\`. Undo: \`node board-store-tree-${name}.mjs back\`. It refuses if line 1 has not run.
${hooksSha ? `
## Line 3: hooks (the Stop hook and the page-publish hook, pinned to this main)

\`\`\`bash
if [ "$(shasum -a 256 board-store-hooks-${name}.mjs | cut -c1-64)" = ${hooksSha} ]; then node board-store-hooks-${name}.mjs; else echo 'CHECK FAILED: board-store-hooks-${name}.mjs is not the signed file. Paste this line to Manager.'; fi
\`\`\`

It refuses unless line 2 has run (the tree is at ${s7}). Then quit the app and open it again: hooks load when a session starts. Undo: \`node board-store-hooks-${name}.mjs undo\`. It is the last hooks file with only the pin and the pair number changed. Hook files changed since ${prev ? prev.sha.slice(0, 8) : "the start"}: ${hookPaths.join(", ")} (a hook script, the installer, or a file the two gate scripts import).
` : ""}
Full sha256: deploy ${deploySha}, tree ${treeSha}${boardDeploySha ? `, board-deploy ${boardDeploySha}` : ""}${hooksSha ? `, hooks ${hooksSha}` : ""}.
`;
}

// Writes the three files into `out`. { ok, why, files: { name: sha256 } }; nothing is written unless ok.
export function makeAll({ repo, sha, n, out, git = (...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" }) }) {
  if (!Number.isInteger(n) || n < 1 || n > 999999) return { ok: false, why: "n is the pair's number, a whole number from 1" };
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
  const cards = [...new Set(commits.flatMap((c) => c.match(/#C\d+/g) ?? []))].join(" and ").slice(0, 120) || "main";
  const files = makePair({ name, card: cards, what: `${commits.length} commit${commits.length === 1 ? "" : "s"}${prev ? ` since ${prev.sha.slice(0, 8)}` : ""}`, signed: sha, deployOk: `the Worker carries ${sha.slice(0, 8)}; now run the tree step`, treeOk: `board-store-v4 is at ${sha.slice(0, 7)}` });
  // A hook file changed since the last pair that ran: the hooks step is written too, from the newest earlier hooks file in the folder.
  // "Hook file" = a hook script, the installer, or any file the two gate entries import (Security R1 on 0f36fd0), read at the new sha.
  let hooks = null;
  const hookPaths = hookChanged(git, sha, paths);
  if (hookPaths.length) {
    const from = lastHooksFile(out, n);
    if (!from) return { ok: false, why: "a hook file changed since the last pair that ran, but the folder has no earlier board-store-hooks-pc<n>.mjs to make the hooks step from" };
    const cue = git("show", `${sha}:hooks/send-refused-cue.py`);
    if (cue.status !== 0) return { ok: false, why: `hooks/send-refused-cue.py is not in ${sha.slice(0, 8)}: its sha256 is pinned in the hooks step` };
    try { hooks = hooksText(from, { name, sha, cueSha: sha256(cue.stdout) }); } catch (e) { return { ok: false, why: e.message }; }
  }
  const hashes = Object.fromEntries(Object.entries(files).map(([f, t]) => [f, sha256(t)]));
  const hooksName = `board-store-hooks-${name}.mjs`;
  // #C924: the generic one-command runner, copied byte for byte (the same file for every pair; its hash is in the steps file).
  const boardDeploy = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pair", "board-deploy.mjs"));
  const steps = stepsText({ name, sha, prev, commits, paths, deploySha: hashes[`board-store-deploy-${name}.mjs`], treeSha: hashes[`board-store-tree-${name}.mjs`], folder: out.startsWith(homedir() + "/") ? "~" + out.slice(homedir().length) : out, skipped: neverRun(out, n), hooksSha: hooks ? sha256(hooks) : null, hookPaths, boardDeploySha: sha256(boardDeploy) });
  const all = { ...files, ...(hooks ? { [hooksName]: hooks } : {}), "board-deploy.mjs": boardDeploy, [`board-store-${name}-steps.md`]: steps };
  for (const [f, t] of Object.entries(all)) writeFileSync(join(out, f), t);
  return { ok: true, files: Object.fromEntries(Object.entries(all).map(([f, t]) => [f, sha256(t)])) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
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
