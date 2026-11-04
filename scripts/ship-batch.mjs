// The board writes of a ship and of an install, as ONE ready db_write batch (#C663). Pure: commits, cards, the config and a clock
// come in; ops come out. The release tool (scripts/board-release.mjs) prints and saves the ship batch after a green ship; the
// install side builds the closing batch for the cards in a pack. The role that applies a batch applies it as is: one db_write,
// nothing composed or edited by hand.
//
// What a batch holds, by document:
//   - a NEW step per card (steps/<card>-<phase>-<kind>-<at>): needs no ifVersion, so it is always in the batch;
//   - an UPDATE of the card (nextNote, nextNoteAt, updatedAt, and the phase or status that moved): the board refuses an update
//     with no ifVersion, and only the board knows a document's version, so it is in the batch only for a card whose version was
//     given (versions: { <card id>: <version> }, from one db_query of the cards); every other card is named in `left`.
// No wait field is ever written: a card waiting for the install is on phase ship alone, and the page derives "Waiting for install"
// from the repository.

const SUBJECT_NUM = /^#C(\d{1,6}):/;
const TRAILER = /^Board-Id:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/im;
const closed = (c) => c.status === "done" || c.status === "dropped";

// What a commit names, and only by a commit of its own work: a subject that STARTS "#C<num>:" or a Board-Id trailer. A card cited
// in passing (mid-subject, in a body) is not named. A ship commit ("v1.2.3: branch@sha", the repository's shippedPattern) names
// the card of the commit at that sha, and the card whose id is the branch's last segment.
// commits: [{ sha, subject, body }]. Returns [{ sha, num, id, via }] per commit that names anything.
export function namings(commits, shippedPattern = "") {
  const list = (Array.isArray(commits) ? commits : []).map((m) => ({ sha: String(m.sha ?? ""), subject: String(m.subject ?? ""), body: String(m.body ?? "") }));
  const own = new Map();
  for (const m of list) {
    const n = SUBJECT_NUM.exec(m.subject), t = TRAILER.exec(m.body) ?? TRAILER.exec(m.subject);
    if (n || t) own.set(m.sha, { num: n ? Number(n[1]) : null, id: t ? t[1].toLowerCase() : null });
  }
  const out = [...own].map(([sha, v]) => ({ sha, ...v }));
  let re = null;
  try { re = shippedPattern ? new RegExp(shippedPattern, "g") : null; } catch { re = null; }
  if (re) for (const m of list) for (const x of m.subject.matchAll(re)) {
    const branch = x[1], at = String(x[2] ?? "").toLowerCase();
    if (!branch || !/^[0-9a-f]{7,40}$/.test(at)) continue;
    const hit = list.find((c) => c.sha !== m.sha && own.has(c.sha) && c.sha.toLowerCase().startsWith(at));
    if (hit) out.push({ sha: m.sha, ...own.get(hit.sha), via: `${branch}@${at}` });
    out.push({ sha: m.sha, num: null, id: String(branch).split("/").pop().toLowerCase(), via: `${branch}@${at}` });
  }
  return out;
}

// The cards a list of commits names (see namings). Returns { named: [{ card, commits: [sha8] }] in the cards' own order, open
// cards only, unmatched: [{ sha, cite }] for each naming that is no open card on the board }.
export function cardsNamed(commits, cards, shippedPattern = "") {
  const byNum = new Map(cards.filter((c) => Number.isInteger(c.num)).map((c) => [c.num, c]));
  const byId = new Map(cards.map((c) => [c.id, c]));
  const hits = new Map(), unmatched = [];
  for (const n of namings(commits, shippedPattern)) {
    const found = new Set();
    if (n.num !== null && byNum.has(n.num)) found.add(byNum.get(n.num).id);
    if (n.id !== null && byId.has(n.id)) found.add(n.id);
    const cites = [n.num !== null ? `#C${n.num}` : null, n.id].filter(Boolean);
    const open = [...found].filter((id) => !closed(byId.get(id)));
    // missing: the board's mirror holds no such card at all (a closed card is fine and only listed).
    if (!open.length && !(n.via && n.num === null && !byId.has(n.id))) unmatched.push({ sha: n.sha.slice(0, 8), cite: cites.join(" / "), missing: found.size === 0 });
    for (const id of open) { const l = hits.get(id) ?? []; const s = n.sha.slice(0, 8); if (!l.includes(s)) hits.set(id, [...l, s]); }
  }
  const seen = new Set();
  return { named: cards.filter((c) => hits.has(c.id) && !closed(c)).map((c) => ({ card: c, commits: hits.get(c.id) })), unmatched: unmatched.filter((u) => { const k = `${u.sha} ${u.cite}`; if (seen.has(k)) return false; seen.add(k); return true; }) };
}

const step = (card, phase, kind, who, at, extra = {}) => ({ op: "set", path: `steps/${card.id}-${phase}-${kind}-${at}`, data: { at, init: card.id, kind, phase, who, ...extra } });

// The batch after a green ship. input: { version ("1.200.0"), sha, commits, cards, config, now, who ("Release"), versions,
// derived (the repository's reading, derived/all's cards: { <id>: { phase } }), partial (ids of cards only partly in this ship) }.
// Returns { ops, left: [text], named: [card id], unmatched: [{ sha, cite }] }.
//  - A card gets the ship END step (Release logs the ship's start itself when the ship begins; this closes it) and the move to
//    phase ship only when the repository's reading puts the card on ship or live (signed, or on main); with no such reading the
//    card gets NO step and is named in `left`: a mention is never a ship.
//  - A card in `partial` (some of its work is not in this ship) gets a BUILD step carrying the note and its nextNote; its phase is
//    left alone, and no ship step is written.
export function shipBatch({ version, sha, commits, cards, config, now, who = "Release", versions = {}, derived = {}, partial = [] }) {
  const c = config.collector, order = config.phases.map((p) => p[0]), ship = order.indexOf(c.shipPhase);
  const ops = [], left = [], named = [];
  const short = String(sha ?? "").slice(0, 8);
  const part = new Set(partial);
  const r = cardsNamed(commits, cards, c.shippedPattern ?? "");
  // A --partial id that no commit of the range names is a typo, never to be ignored (the real card would get a full ship step).
  const badPartial = [...part].filter((id) => !r.named.some((n) => n.card.id === id));
  for (const { card } of r.named) {
    if (part.has(card.id)) {
      const note = `v${version} (${short}) holds part of this card; the rest is not on ${c.mainBranch} yet.`;
      named.push(card.id);
      ops.push(step(card, c.buildPhase, "start", who, now, { note }));
      if (versions[card.id] === undefined) { left.push(`${card.id}: its card (nextNote) is not in this batch: no version given for it`); continue; }
      ops.push({ op: "update", path: `initiatives/${card.id}`, data: { nextNote: note, nextNoteAt: now, updatedAt: now }, ifVersion: versions[card.id] });
      continue;
    }
    const reading = derived?.[card.id]?.phase;
    if (order.indexOf(reading) < ship || ship < 0) { left.push(`${card.id}: named by a commit, but the repository's reading is ${reading ? `"${reading}"` : "nothing"}, not ship or live: no ship step, no card update (use --partial if only part of it shipped)`); continue; }
    named.push(card.id);
    ops.push(step(card, c.shipPhase, "end", who, now));
    // The waiting for the install is the page's to show from the repository (phase ship alone, no wait field): the line says only what shipped.
    const data = { nextNote: `v${version} (${short}) is on ${c.mainBranch}.`, nextNoteAt: now, updatedAt: now };
    // The phase moves to ship from any phase before it (a Quick card skips reviews): the repository's reading, required above, is
    // ship or later, which is what the gate asks for a jump.
    if (order.indexOf(card.phase) < ship) data.phase = c.shipPhase;
    if (versions[card.id] === undefined) { left.push(`${card.id}: its card (nextNote${data.phase ? ", phase" : ""}) is not in this batch: no version given for it`); continue; }
    ops.push({ op: "update", path: `initiatives/${card.id}`, data, ifVersion: versions[card.id] });
  }
  return { ops, left, named, unmatched: r.unmatched, badPartial };
}

// The closing batch after an install is verified. input: { cards (the pack's, open ones only count), watch (ids that stay open),
// config, now, who ("Security"), versions }. Per card not on watch: the live end step, then the card: phase live, status done,
// doneAt, and issuesAt when it has counted issues. A card with doneWhen lines is left to its lead (each line has its own end step).
export function installBatch({ cards, watch = [], config, now, who = "Security", versions = {} }) {
  const c = config.collector;
  const ops = [], left = [], closing = [];
  const hold = new Set(watch);
  for (const card of cards) {
    if (closed(card)) continue;
    if (hold.has(card.id)) { left.push(`${card.id}: stays open (a watch)`); continue; }
    if (Array.isArray(card.doneWhen) && card.doneWhen.length) { left.push(`${card.id}: has doneWhen lines; its lead logs each line's end step`); continue; }
    closing.push(card.id);
    ops.push(step(card, c.livePhase, "end", who, now));
    if (versions[card.id] === undefined) { left.push(`${card.id}: its card (phase, status, doneAt) is not in this batch: no version given for it`); continue; }
    const data = { phase: c.livePhase, status: "done", doneAt: now, updatedAt: now };
    if (card.issues && typeof card.issues === "object") data.issuesAt = now;
    ops.push({ op: "update", path: `initiatives/${card.id}`, data, ifVersion: versions[card.id] });
  }
  return { ops, left, closing };
}

// The batch as the db_write call takes it, with the slug the caller names.
export const asCall = (slug, ops) => ({ slug, ops });

// The versions file: { "<card id>": <version> }, or a list of { id | path ("initiatives/<id>"), version } as a db_query lists
// documents. Returns the map, or null when the shape is neither.
export function parseVersions(x) {
  const map = {};
  const put = (id, v) => { if (typeof id === "string" && id && Number.isInteger(v) && v >= 1) map[id.replace(/^initiatives\//, "")] = v; };
  if (Array.isArray(x)) { for (const d of x) if (d && typeof d === "object") put(d.id ?? d.path, d.version); return map; }
  if (x && typeof x === "object") { for (const [k, v] of Object.entries(x)) put(k, v); return map; }
  return null;
}
// What the CLI says when the versions are missing: the one query to run.
export const VERSIONS_HELP = "--versions is required: run ONE db_query on the board's initiatives (collection initiatives, every document with its version), save {\"<card id>\": <version>} for the cards (or the list the query gives, each with its id and version) to a file, and pass that file. A card's update is refused by the board without its version, so a batch without them leaves the cards out, which is the gap this closes";

// The command line, for a ship script (the product's or the board's) and for the install:
//   node scripts/ship-batch.mjs ship    --config C --repo R --range A..B --version 1.2.3 [--versions F] [--partial id,id] [--now MS] [--out F]
//   node scripts/ship-batch.mjs install --config C --cards id,id [--watch id,id] [--versions F] [--now MS] [--out F]
// Reads the cards from the mirror the gate keeps, the commits from the repository, and prints the db_write call as JSON (and saves it
// with --out); what it could not put in the batch is listed on stderr. It writes nothing to the board itself.
if (process.argv[1] && (await import("node:fs")).realpathSync(process.argv[1]) === (await import("node:url")).fileURLToPath(import.meta.url)) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { readMirror } = await import("../gate/gate.mjs");
  const { execFileSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const { checkConfig, fullConfig, boardId } = await import("./config.mjs");
  const [mode, ...rest] = process.argv.slice(2);
  const arg = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
  const fail = (m) => { process.stderr.write(`STOP: ${m}\n`); process.exit(1); };
  try {
    if (mode !== "ship" && mode !== "install") fail("usage: ship-batch.mjs ship|install --config C ...");
    const raw = JSON.parse(readFileSync(arg("config") ?? "", "utf8"));
    const problems = checkConfig(raw);
    if (problems.length) fail(`the config: ${problems.join("; ")}`);
    const config = fullConfig(raw);
    const dir = join(String(config.gate.stateDir).replace(/^~(?=\/|$)/, homedir()), boardId(config) ?? "no-board", "mirror");
    const now = arg("now") ? Number(arg("now")) : Date.now();
    if (!Number.isFinite(now) || now <= 0) fail("--now is a time in ms");
    // The cards are the gate's mirror: a mirror whose CARDS are older than gate.mirrorMaxAgeMin may lack the cards of this very
    // ship, so it stops. The age is the cards' own (the newest card file, or the delta stamp), never the mirror's newest file of
    // any collection (the collector rewrites derived/all every run), and it is measured against the real clock, not --now.
    const mirror = readMirror(dir);
    if (!mirror || !Array.isArray(mirror.docs.initiatives)) fail(`no mirror of the board at ${dir}`);
    const maxMin = config.gate.mirrorMaxAgeMin, cardsAt = mirror.atBy?.initiatives ?? 0, realNow = Date.now();
    if (!(realNow - cardsAt < maxMin * 60e3)) fail(`the mirror's cards were last written ${cardsAt ? Math.round((realNow - cardsAt) / 60e3) + " minutes ago" : "never"} (more than gate.mirrorMaxAgeMin, ${maxMin}): wait for the collector's next run, then run this again`);
    const cards = mirror.docs.initiatives;
    const derived = (mirror.docs.derived ?? []).find((d) => d.id === "all")?.cards ?? {};
    if (!arg("versions")) fail(VERSIONS_HELP);
    const versions = parseVersions(JSON.parse(readFileSync(arg("versions"), "utf8")));
    if (!versions || !Object.keys(versions).length) fail(`the versions file holds no card version. ${VERSIONS_HELP}`);
    let r;
    if (mode === "ship") {
      const range = arg("range"), version = arg("version"), repo = arg("repo");
      if (!/^[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}$/.test(range ?? "") || !/^\d+\.\d+\.\d+$/.test(version ?? "") || !repo) fail("ship needs --range <sha>..<sha>, --version N.N.N and --repo");
      const out = execFileSync("git", ["log", "--format=%H%x1f%s%x1f%b%x1e", range], { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      const commits = out.split("\x1e").map((x) => x.trim()).filter(Boolean).map((x) => { const [sha, subject, body] = x.split("\x1f"); return { sha, subject, body }; });
      const partial = String(arg("partial") ?? "").split(",").filter(Boolean);
      r = shipBatch({ version, sha: range.split("..")[1], commits, cards, config, now, versions, derived, partial });
    } else {
      const ids = new Set(String(arg("cards") ?? "").split(",").filter(Boolean)), watch = String(arg("watch") ?? "").split(",").filter(Boolean);
      if (!ids.size) fail("install needs --cards id,id");
      r = installBatch({ cards: cards.filter((c) => ids.has(c.id)), watch, config, now, versions });
    }
    // A card named but with no version is a card left out of the batch: stop, naming them, rather than print half of it. (A card the
    // pack keeps open or leaves to its lead is on purpose and is not one of these.)
    // A citation of a card the mirror does not hold at all means the mirror is behind (or the citation is wrong): stop too, rather
    // than ship around it. A closed card is only listed.
    const absent = (r.unmatched ?? []).filter((u) => u.missing && /#C\d/.test(u.cite));
    if (absent.length) fail(`${absent.map((u) => `commit ${u.sha} cites ${u.cite}`).join("; ")}: the mirror holds no such card (it is behind, or the citation is wrong): wait for the collector's next run, then run this again`);
    if ((r.badPartial ?? []).length) fail(`--partial names ${r.badPartial.join(", ")}, which no commit of the range names (a typo?)`);
    const missing = r.left.filter((l) => /no version given/.test(l)).map((l) => l.split(":")[0]);
    if (missing.length) fail(`no version for ${missing.join(", ")}: add them to the versions file (the query above), then run this again`);
    const call = JSON.stringify(asCall(config.artifactSlug || config.artifactUrl, r.ops), null, 2);
    if (arg("out")) writeFileSync(arg("out"), call + "\n", { mode: 0o600 });
    process.stdout.write(call + "\n");
    for (const l of r.left) process.stderr.write(`left out: ${l}\n`);
    for (const u of r.unmatched ?? []) process.stderr.write(`unmatched: commit ${u.sha} cites ${u.cite}, which is no open card on the board\n`);
  } catch (e) { fail(String(e.message).split("\n")[0]); }
}
