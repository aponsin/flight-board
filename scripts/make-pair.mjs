// Makes the whole deploy pair for a signed commit of main (#C856; principle 1, nothing rests on memory): the deploy file, the tree file
// and the steps file with the hash-checked lines, and lists what changed since the last pair. Usage:
//   node scripts/make-pair.mjs <40-hex sha on origin/main> <n> [--out <the folder the owner runs the files from>] [--repo <checkout>]
// It writes board-store-deploy-pc<n>.mjs, board-store-tree-pc<n>.mjs (made by scripts/pair/make-pair.mjs from the reviewed templates) and
// board-store-pc<n>-steps.md, and prints each file's sha256. The sha must be on the fetched origin main, else nothing is written. The last pair
// is the highest earlier board-store-deploy-pc<k>.mjs in the folder; its pinned commit is where "changed since" starts. The steps file lists
// the commits and the changed paths in groups (Worker, probe and gate, page, hooks, migrations, wrangler config, tests, docs). It cannot see a
// new secret: it says to check the Worker config and code diff for one.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

// The pinned commit of the highest pair before n in the folder, or null.
export function lastPair(folder, n) {
  if (!existsSync(folder)) return null;
  const found = readdirSync(folder).map((f) => /^board-store-deploy-pc(\d{1,6})\.mjs$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).filter((k) => k < n).sort((a, b) => b - a);
  for (const k of found) {
    const m = /const SIGNED = "([0-9a-f]{40})"/.exec(readFileSync(join(folder, `board-store-deploy-pc${k}.mjs`), "utf8"));
    if (m) return { n: k, sha: m[1] };
  }
  return null;
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

export function stepsText({ name, sha, prev, commits, paths, deploySha, treeSha, folder }) {
  const s8 = sha.slice(0, 8), s7 = sha.slice(0, 7);
  const cards = [...new Set(commits.flatMap((c) => c.match(/#C\d+/g) ?? []))];
  const groups = groupPaths(paths);
  const changed = prev
    ? [`Changed since ${prev.sha.slice(0, 8)} (${`pc${prev.n}`}):`, ...(commits.length ? commits.map((c) => `- ${plain(c).slice(0, 200)}`) : ["- no commit"]), "", groups.length ? "Changed paths, by kind:" : "No path changed.", ...groups.map(([g, v]) => `- ${g}: ${v.join(", ")}`)]
    : ["There is no earlier pair in this folder, so nothing is compared: every path of the commit is new to this folder."];
  const migration = groups.some(([g]) => g === "database migration");
  const worker = groups.some(([g]) => g === "Worker code" || g === "database migration" || g === "Worker config (check for a new binding or secret)");
  return `# ${name}: ${cards.length ? cards.join(", ") : "main"} at ${s8}

Pinned to flight-board main ${sha}. Each line checks the file's SHA-256 first and prints CHECK FAILED instead of running a changed file. Two lines, in this order, one at a time.
${worker ? "The Worker changes: deploy it first (line 1), then the tree (line 2)." : "No Worker code changes: line 1 only tells the Worker which commit it carries."} ${migration ? "A database migration is part of this deploy: answer y if it asks." : "No database migration."} A new secret cannot be seen from the diff: read the Worker config and Worker code lines below.
If wrangler is not signed in: npx wrangler@4.150.0 login (once).

${changed.join("\n")}

\`\`\`bash
cd ${folder}
\`\`\`

## Line 1: deploy

\`\`\`bash
if [ "$(shasum -a 256 board-store-deploy-${name}.mjs | cut -c1-64)" = ${deploySha} ]; then node board-store-deploy-${name}.mjs; else echo 'CHECK FAILED: board-store-deploy-${name}.mjs is not the signed file. Paste this line to Manager.'; fi
\`\`\`

Last line: \`DEPLOY OK: the Worker carries ${s8}; now run the tree step\`, and a new file \`board-store-deploy-${name}.done\`. On \`DEPLOY FAILED: ...\` stop and paste it to Manager. Undo: \`npx wrangler@4.150.0 rollback --config board-store-pa/worker/wrangler.board.toml\`.

## Line 2: tree

\`\`\`bash
if [ "$(shasum -a 256 board-store-tree-${name}.mjs | cut -c1-64)" = ${treeSha} ]; then node board-store-tree-${name}.mjs update; else echo 'CHECK FAILED: board-store-tree-${name}.mjs is not the signed file. Paste this line to Manager.'; fi
\`\`\`

Should print \`TREE OK: board-store-v4 is at ${s7}\`. Undo: \`node board-store-tree-${name}.mjs back\`. It refuses if line 1 has not run.

Full sha256: deploy ${deploySha}, tree ${treeSha}.
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
  const hashes = Object.fromEntries(Object.entries(files).map(([f, t]) => [f, sha256(t)]));
  const steps = stepsText({ name, sha, prev, commits, paths, deploySha: hashes[`board-store-deploy-${name}.mjs`], treeSha: hashes[`board-store-tree-${name}.mjs`], folder: out.startsWith(homedir() + "/") ? "~" + out.slice(homedir().length) : out });
  const all = { ...files, [`board-store-${name}-steps.md`]: steps };
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
