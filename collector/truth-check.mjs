// #C1386 (the audit's point 4, board-reading-contract.md B4): the truth check. A job on the Studio asks git, per card, four plain questions with commands of its OWN:
// is the card's commit on main, is it inside the live deploy (a board card: the Worker's deployed commit AND the Studio tree; a product card: a version commit on main that
// holds it), which review notes sit on its tip, and has a pair covered it (packed, installed). It then compares the answers with the stored reading (GET /api/probe/readings).
// A difference that lasts two runs in a row is written as the evidence key `truth` ({ at, count, items }) for the Worker to draw as a red line and to wake the lead once.
//
// This file imports NOTHING of ours: not worker/reading.mjs, not worker/compat-reading.mjs, not collector/state.mjs, not any collector file that feeds the evidence. The rules
// it checks are written out again here on purpose (a second reading of the same facts is the check); tests/truth-check.test.mjs holds that, and holds that the check catches
// the --first-parent bug of #C1376 when it is put back into the reading chain.
//   askGit(card, deps)   one card's facts from git and the pair folder; an answer git or the folder could not give is "unread", never a no
//   compare(reading, facts, { now })   the differences the reading implies against the facts: [{ field, reading, git }]
//   truthJob({ readings, cardsFacts, stateFile, now, write })   the two-run rule, the kept state, the evidence write
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const UNREAD = "unread";
export const RUNS_TO_REPORT = 2; // a difference is reported when it has stood, unchanged, for this many runs in a row
export const CARD_CAP = 60; // cards checked in one run (the first by number)
export const ITEM_CAP = 10, COUNT_CAP = 500; // the evidence value's own bounds
export const PAIRS_MAX = 200;
export const CLOSED_GRACE_MS = 3_600_000; // a closed card whose reading is not done is compared only after it has been closed this long
export const CLOSED_WINDOW_MS = 7 * 86_400_000; // cards closed longer ago than this are not checked
export const DEPLOY_SETTLE_MS = 30 * 60_000; // a product's version commit younger than this may not be deployed yet: its "deploy" wait is not called wrong
export const GIT_TIMEOUT_MS = 15_000;
export const MAIN_LOOKBACK = 400;
const SHA = /^[0-9a-f]{40}$/;
const SAFE_REF = /^[A-Za-z0-9._\/-]{1,100}$/;
const CARD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const DEFAULT_VERSION_PATTERN = "^v(\\d+\\.\\d+\\.\\d+)\\b";
const REVIEW_PHASES = ["language", "design", "checker", "security"];
// What a landing that changed only these paths needs no deploy or install for (the same groups as the board's own rule, written out here).
const DOCS_ONLY = /^(docs\/|tests\/|README\.md$|CHANGELOG\.md$|CHANGELOG\.d\/[^/]+\.md$)/;
const BOARD_WORDS = new Set(["flight-board", "board"]);
const wordKey = (r) => (typeof r === "string" ? r.trim().toLowerCase().replace(/^.*\//, "").replace(/\.git$/, "") : "");
export const kindOfWord = (word) => (typeof word === "string" && word.trim() !== "" && !BOARD_WORDS.has(wordKey(word)) ? "product" : "board");
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clip = (s) => String(s).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 80) || "none";

// The one git helper: a read-only command in `dir`, its text out, and a throw (with .status) when git says no. Every git call of this file goes through deps.git.
export const defaultGit = (dir, args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });

// true / false when git answered yes / no (exit 1); "unread" for any other failure (a commit this clone lacks, a timeout, no git).
function ancestor(g, a, b) {
  try { g(["merge-base", "--is-ancestor", a, b]); return true; } catch (e) { return e && e.status === 1 ? false : UNREAD; }
}

// The commit on main that carries the card when its own commit is not an ancestor of main (a squash, a cherry-pick): the newest of main's last MAIN_LOOKBACK commits whose
// Board-Id line names the card AND whose subject is the card's commit's subject. null: none; "unread": git could not say.
function landedAs(g, card, mainRef) {
  try {
    const subject = g(["log", "-1", "--format=%s", card.headSha]).trim();
    if (!subject) return UNREAD;
    const out = g(["log", `-${MAIN_LOOKBACK}`, "--fixed-strings", `--grep=Board-Id: ${card.id}`, "--format=%H%x1f%s%x1f%B%x1e", mainRef]);
    for (const rec of out.split("\x1e")) {
      const [sha, s, body] = rec.replace(/^\n/, "").split("\x1f");
      if (!SHA.test(sha ?? "") || s !== subject) continue;
      if (String(body ?? "").split("\n").some((l) => l.trim() === `Board-Id: ${card.id}`)) return sha;
    }
    return null;
  } catch { return UNREAD; }
}

// The version commit that holds `landing` on main's line: the first of main's first-parent commits after it that descend from it (the ancestry path WITHOUT --first-parent: a commit
// that reached main inside a group is not on the first-parent line, and asking the two together answers nothing, #C1376), then any of those, or the landing itself, whose subject
// names a version. { version, at } (at: epoch ms of the version commit), null when none, "unread" when git could not say.
function versionHolding(g, landing, mainRef, pattern) {
  try {
    const re = new RegExp(pattern);
    const descends = new Set(g(["rev-list", "--ancestry-path", `${landing}..${mainRef}`]).split("\n").filter(Boolean));
    const line = g(["log", "--first-parent", "--reverse", "--format=%H%x1f%ct%x1f%s", `${landing}..${mainRef}`]).split("\n").filter(Boolean).map((l) => l.split("\x1f")).filter(([h]) => descends.has(h));
    const own = g(["log", "-1", "--format=%H%x1f%ct%x1f%s", landing]).trim().split("\x1f");
    for (const [, ct, s] of [own, ...line]) {
      const m = re.exec(s ?? "");
      const v = m ? m[1] ?? m[0] : null;
      if (v && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v)) return { version: v, at: Number(ct) * 1000 };
    }
    return null;
  } catch { return UNREAD; }
}

// The review notes on the tip: the roles whose note starts FINDINGS, the roles that signed (a role's word: PASS for checker, SECURE for security, any other note for another
// role), and the roles that said STOP. "unread" when the list of a ref cannot be read, or a note cannot be shown.
function notesOn(g, sha, refs) {
  const roles = Object.entries(plain(refs) ? refs : {}).filter(([r, ref]) => /^[a-z][a-z0-9-]{0,30}$/.test(r) && typeof ref === "string" && SAFE_REF.test(ref) && !ref.startsWith("-"));
  if (!roles.length) return UNREAD;
  const out = { findings: [], signed: [], stops: [] };
  for (const [role, ref] of roles) {
    let has;
    try { has = g(["notes", `--ref=${localRef(ref)}`, "list"]).split("\n").map((l) => l.trim().split(/\s+/)[1]).includes(sha); } catch { return UNREAD; }
    if (!has) continue;
    let first;
    try { first = String(g(["notes", `--ref=${localRef(ref)}`, "show", sha])).split("\n")[0].trim(); } catch { return UNREAD; }
    // The first word is read as a word (the same cut as a leading \b), not by a first-word regex of the sign-off words: that regex lives in collector/signoff.mjs only (a test holds it), and this file imports nothing of the collector.
    const word = /^\w+/.exec(first)?.[0] ?? "";
    if (word === "FINDINGS") out.findings.push(role);
    else if (word === "STOP") out.stops.push(role);
    else if (role === "checker" ? word === "PASS" : role === "security" ? word === "SECURE" : first !== "") out.signed.push(role);
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}
// A config note ref (refs/notes/<x>) is read from where the probe fetches it: refs/notes/flight-board/<x>.
export const localRef = (ref) => (String(ref).startsWith("refs/notes/flight-board/") ? ref : String(ref).startsWith("refs/notes/") ? `refs/notes/flight-board/${ref.slice("refs/notes/".length)}` : ref);

// The pairs in the owner's pair folder, newest first: [{ n, sha, ran }] (a deploy file holding `const SIGNED = "<40 hex>"`; ran: its .done holds the same sha). null when the folder is
// not given or cannot be read (unread, never "no pair").
export function readPairs(folder, io = {}) {
  const readdir = io.readdir ?? readdirSync, readFile = io.readFile ?? ((p) => readFileSync(p, "utf8"));
  if (typeof folder !== "string" || !folder) return null;
  let names;
  try { names = readdir(folder); } catch { return null; }
  const nums = names.map((f) => /^board-store-deploy-pc(\d{1,6})\.mjs$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => b - a).slice(0, PAIRS_MAX);
  const out = [];
  for (const n of nums) {
    let sha;
    try { sha = /const SIGNED = "([0-9a-f]{40})"/.exec(readFile(join(folder, `board-store-deploy-pc${n}.mjs`)))?.[1]; } catch { return null; }
    if (!sha) continue;
    let ran = false;
    if (names.includes(`board-store-deploy-pc${n}.done`)) { try { ran = String(readFile(join(folder, `board-store-deploy-pc${n}.done`))).trim() === sha; } catch { return null; } }
    out.push({ n, sha, ran });
  }
  return out;
}

// One card's facts. card: { id, kind: "board"|"product", dir, remote, main, headSha, notes: { role: ref }, versionPattern }; deps: { git(dir, args), pairs (readPairs), workerSha, treeSha, now }.
// { kind, onMain, landing, docsOnly, deployed, settled, version, packed, installed, notes }: each true / false, or "unread".
export function askGit(card, deps) {
  const out = { kind: card?.kind === "product" ? "product" : "board", onMain: UNREAD, landing: null, docsOnly: false, deployed: UNREAD, settled: true, version: null, packed: UNREAD, installed: UNREAD, notes: UNREAD };
  const ok = card && SHA.test(String(card.headSha)) && CARD_ID.test(String(card.id)) && SAFE_REF.test(`${card.remote}/${card.main}`) && !String(card.remote).startsWith("-") && typeof card.dir === "string" && card.dir !== "";
  if (!ok || typeof deps?.git !== "function") return out;
  const g = (args) => deps.git(card.dir, args), mainRef = `${card.remote}/${card.main}`;
  try { out.notes = notesOn(g, card.headSha, card.notes); } catch { out.notes = UNREAD; }
  // On main: the commit is an ancestor of main, or main carries it as another commit (the Board-Id and the subject).
  let landing = null;
  const direct = ancestor(g, card.headSha, mainRef);
  if (direct === true) landing = card.headSha;
  else if (direct === false) {
    const as = landedAs(g, card, mainRef);
    if (as === UNREAD) return out;
    if (as === null) { out.onMain = false; return out; }
    landing = as;
  } else return out;
  out.onMain = true; out.landing = landing;
  // What the landing changed: docs and tests only needs no deploy and no pack.
  let paths = null;
  try { paths = g(["diff", "--name-only", `${landing}^`, landing]).split("\n").map((p) => p.trim()).filter(Boolean); } catch { /* unread */ }
  out.docsOnly = !!paths && paths.length > 0 && paths.every((p) => DOCS_ONLY.test(p));
  if (out.kind === "board") {
    if (out.docsOnly) out.deployed = true;
    else if (SHA.test(String(deps.workerSha)) && SHA.test(String(deps.treeSha))) {
      const a = ancestor(g, landing, deps.workerSha), b = ancestor(g, landing, deps.treeSha);
      out.deployed = a === false || b === false ? false : a === true && b === true ? true : UNREAD;
    }
    // Pairs: the newest pair holds the landing or none does (pins are main commits, newest last); installed when the newest pair that ran holds it too.
    if (Array.isArray(deps.pairs) && !out.docsOnly) {
      const holds = (p) => ancestor(g, landing, p.sha);
      if (!deps.pairs.length) { out.packed = false; out.installed = false; } else {
        out.packed = holds(deps.pairs[0]);
        if (out.packed === false) out.installed = false;
        else if (out.packed === true) { const ran = deps.pairs.find((p) => p.ran); out.installed = ran ? holds(ran) : false; }
      }
    }
  } else if (typeof card.versionPattern === "string" && card.versionPattern) {
    const v = versionHolding(g, landing, mainRef, card.versionPattern);
    if (v === UNREAD) out.deployed = UNREAD;
    else if (v === null) out.deployed = false;
    else { out.deployed = true; out.version = v.version; out.settled = Number.isFinite(deps.now) && Number.isFinite(v.at) && deps.now - v.at >= DEPLOY_SETTLE_MS; }
  }
  return out;
}

// What a stored reading implies against the facts. A reading that says it cannot be trusted (stale, unknown) is skipped. Returns [{ field, reading, git }], each string 1..80.
export function compare(reading, facts, { now = Date.now() } = {}) {
  if (!plain(reading) || !plain(facts)) return [];
  if (reading.stale === true || reading.state === "unknown") return [];
  const diffs = [], add = (field, r, g) => diffs.push({ field, reading: clip(r), git: clip(g) });
  const word = reading.state === "done" ? "done" : reading.state === "rework" ? "rework" : reading.wait ? `waits: ${reading.wait}` : String(reading.state ?? "none");
  const board = facts.kind === "board";
  const deployedText = board ? (facts.docsOnly ? "docs only landing" : "in the deploy and the tree") : `in v${facts.version ?? "?"} on main`;
  const notDeployedText = board ? "not in the deploy and the tree" : "no version commit holds it";
  // A closed card is meant to read done. One whose reading is not done is compared on that alone, once it has been closed over CLOSED_GRACE_MS (`closedAt`, epoch ms, which the Worker serves beside `closed: true`; a closed time we cannot read: skipped).
  if (reading.closed && reading.state !== "done") {
    const at = Number.isFinite(reading.closedAt) ? reading.closedAt : null;
    if (at !== null && now - at > CLOSED_GRACE_MS && facts.onMain === true && facts.deployed === true) add("state", `${reading.state ?? "none"}${reading.wait ? `, waits: ${reading.wait}` : ""}, card closed`, `live: ${deployedText}`);
    return diffs;
  }
  if (reading.state === "done") {
    if (facts.onMain === false) add("onMain", "done", "not on main");
    else if (facts.onMain === true && facts.deployed === false) add("deployed", "done", notDeployedText);
    return diffs;
  }
  if (reading.state === "rework") {
    const n = facts.notes;
    if (REVIEW_PHASES.includes(reading.phase) && plain(n) && !n.findings.length && n.signed.length) add("notes", "rework", `no FINDINGS, signed: ${n.signed.join(", ")}`);
    return diffs;
  }
  // A review's FINDINGS on the tip of a card that is not on main sends it back: a reading that is not rework while one stands is wrong (the review phases only).
  if (REVIEW_PHASES.includes(reading.phase) && facts.onMain === false && plain(facts.notes) && facts.notes.findings.length) add("notes", `${reading.state ?? "none"}, not rework`, `FINDINGS by ${facts.notes.findings.join(", ")}`);
  switch (reading.wait) {
    case "land":
      if (facts.onMain === true) add("onMain", word, "on main");
      break;
    case "pack":
      if (facts.onMain === false) add("onMain", word, "not on main");
      else if (facts.onMain === true && facts.packed === true) add("pair", word, "packed");
      break;
    case "install":
      if (facts.onMain === false) add("onMain", word, "not on main");
      else if (facts.onMain === true && facts.packed === false) add("pair", word, "not packed");
      else if (facts.onMain === true && facts.installed === true) add("pair", word, "pair done");
      break;
    case "deploy":
      if (facts.onMain === false) add("onMain", word, "not on main");
      else if (facts.onMain === true && facts.deployed === true && facts.settled === true) add("deployed", word, deployedText);
      break;
    default:
  }
  return diffs;
}

// ---- the kept state and the evidence value ----
function loadSeen(read, file) {
  try { const k = JSON.parse(read(file)); if (plain(k) && plain(k.seen)) return Object.fromEntries(Object.entries(k.seen).filter(([, v]) => plain(v) && typeof v.reading === "string" && typeof v.git === "string" && Number.isInteger(v.n) && v.n > 0)); } catch { /* the first run */ }
  return {};
}
export function saveAtomic(file, text, { write = (p, t) => writeFileSync(p, t, { mode: 0o600 }), rename = renameSync } = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  write(tmp, text);
  rename(tmp, file);
}
// Runs the two-run rule over this run's differences and writes the evidence value every run (count 0 and no items when everything agrees, so a line clears).
// readings: the stored readings; cardsFacts: { [card id]: facts }, only for the cards that were asked (a card with no facts is not compared, and its kept differences are dropped).
// A difference counts n + 1 only when both its values are what they were last run; a changed or vanished one starts again. It is reported at n >= RUNS_TO_REPORT.
export async function truthJob({ readings, cardsFacts, stateFile, now = Date.now(), write, read = (p) => readFileSync(p, "utf8"), save = saveAtomic }) {
  const before = loadSeen(read, stateFile), next = {}, reported = [];
  for (const r of Array.isArray(readings) ? readings : []) {
    const facts = plain(r) && typeof r.id === "string" ? cardsFacts?.[r.id] : null;
    if (!facts) continue;
    for (const d of compare(r, facts, { now })) {
      const key = `${r.id}|${d.field}`, was = before[key];
      const n = was && was.reading === d.reading && was.git === d.git ? was.n + 1 : 1;
      next[key] = { reading: d.reading, git: d.git, n };
      if (n >= RUNS_TO_REPORT) reported.push({ card: r.id, num: Number.isInteger(r.num) ? r.num : null, field: d.field, reading: d.reading, git: d.git });
    }
  }
  reported.sort((a, b) => (a.num ?? Infinity) - (b.num ?? Infinity) || (a.card < b.card ? -1 : a.card > b.card ? 1 : 0) || (a.field < b.field ? -1 : 1));
  const value = { at: now, count: Math.min(COUNT_CAP, reported.length), items: reported.slice(0, ITEM_CAP) };
  await write({ key: "truth", value });
  try { save(stateFile, JSON.stringify({ seen: next })); } catch { /* the count starts again next run: a difference is reported one run later */ }
  return value;
}

// ---- gathering ----
const expandHome = (p, home) => String(p).replace(/^~(?=\/|$)/, home);
// The readings to check: every open card and each closed in the last CLOSED_WINDOW_MS, the first CARD_CAP by number.
export function pickReadings(readings, now = Date.now()) {
  return (Array.isArray(readings) ? readings : [])
    .filter((r) => plain(r) && typeof r.id === "string" && CARD_ID.test(r.id) && !(Number.isFinite(r.closedAt) && now - r.closedAt > CLOSED_WINDOW_MS))
    .sort((a, b) => (Number.isInteger(a.num) ? a.num : Infinity) - (Number.isInteger(b.num) ? b.num : Infinity) || (a.id < b.id ? -1 : 1))
    .slice(0, CARD_CAP);
}
// The repository a card lives in, from the board config's collector block: the named collector.repos row, else the row whose idPrefixes start the id, else collector.repoPath.
export function repoFor(reading, c, home = homedir()) {
  const rows = Array.isArray(c?.repos) ? c.repos.filter(plain) : [];
  const word = typeof reading.repo === "string" ? reading.repo.trim() : "";
  const row = (word && rows.find((r) => r.name === word)) || rows.find((r) => (Array.isArray(r.idPrefixes) ? r.idPrefixes : []).some((p) => String(reading.id).startsWith(p))) || null;
  const dir = row ? row.path : c?.repoPath;
  if (typeof dir !== "string" || !dir) return null;
  const kind = row && (row.kind === "board" || row.kind === "product") ? row.kind : kindOfWord(word);
  return {
    dir: expandHome(dir, home), kind,
    remote: typeof (row ? row.remote : c.remote) === "string" && (row ? row.remote : c.remote) ? (row ? row.remote : c.remote) : "origin",
    main: typeof (row ? row.mainBranch : c.mainBranch) === "string" && (row ? row.mainBranch : c.mainBranch) ? (row ? row.mainBranch : c.mainBranch) : "main",
    notes: plain(row?.notes) ? row.notes : plain(c?.notes) ? c.notes : {},
    versionPattern: row ? (typeof row.versionPattern === "string" ? row.versionPattern : null) : typeof c.versionPattern === "string" && c.versionPattern ? c.versionPattern : DEFAULT_VERSION_PATTERN,
  };
}
// Facts for the picked readings. cards: the state's per-card evidence ({ [id]: { headSha } }); a card with no full head sha is skipped (nothing to ask about).
// deploy: { worker, tree } (the Worker's deployed commit, the Studio tree's). Stops starting new cards once clock() passes the deadline.
export function gatherFacts({ readings, cards, config, deploy, now = Date.now(), git = defaultGit, pairs = null, home = homedir(), deadline = Infinity, clock = Date.now, log = () => {} }) {
  const cardsFacts = {};
  let skipped = 0, late = 0;
  const cache = new Map();
  const pairsOf = (dir) => { if (!cache.has(dir)) cache.set(dir, typeof pairs === "function" ? pairs(dir) : pairs); return cache.get(dir); };
  for (const r of pickReadings(readings, now)) {
    const head = plain(cards?.[r.id]) ? cards[r.id].headSha : null, repo = repoFor(r, config, home);
    if (!SHA.test(String(head)) || !repo) { skipped++; continue; }
    if (clock() >= deadline) { late++; continue; }
    cardsFacts[r.id] = askGit({ id: r.id, headSha: head, ...repo }, { git, pairs: repo.kind === "board" ? pairsOf(repo.dir) : null, workerSha: deploy?.worker, treeSha: deploy?.tree, now });
  }
  if (skipped) log(`truth: ${skipped} card(s) skipped (no full head sha or no repository)`);
  if (late) log(`truth: ${late} card(s) left for the next run (out of time)`);
  return cardsFacts;
}
export const pairsFromConfig = (config, home = homedir(), io = {}) => (typeof config?.pairFolder === "string" && config.pairFolder ? readPairs(expandHome(config.pairFolder, home), io) : null);
