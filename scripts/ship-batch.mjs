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

const NUM = /(?:^|[^A-Za-z0-9])#C(\d{1,6})(?![0-9])/g;
const TRAILER = /^Board-Id:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/gim;
const closed = (c) => c.status === "done" || c.status === "dropped";

// The cards a list of commits names: by #C<num> in the subject or body, or a Board-Id trailer. commits: [{ sha, subject, body }].
// Returns [{ card, commits: [sha] }] in the cards' own order, open cards only.
export function cardsNamed(commits, cards) {
  const byNum = new Map(cards.filter((c) => Number.isInteger(c.num)).map((c) => [c.num, c]));
  const byId = new Map(cards.map((c) => [c.id, c]));
  const hits = new Map();
  for (const m of Array.isArray(commits) ? commits : []) {
    const text = `${m.subject ?? ""}\n${m.body ?? ""}`;
    const found = new Set();
    for (const x of text.matchAll(NUM)) { const c = byNum.get(Number(x[1])); if (c) found.add(c.id); }
    for (const x of text.matchAll(TRAILER)) { const c = byId.get(x[1].toLowerCase()); if (c) found.add(c.id); }
    for (const id of found) hits.set(id, [...(hits.get(id) ?? []), String(m.sha ?? "").slice(0, 8)]);
  }
  return cards.filter((c) => hits.has(c.id) && !closed(c)).map((c) => ({ card: c, commits: hits.get(c.id) }));
}

const step = (card, phase, kind, who, at, extra = {}) => ({ op: "set", path: `steps/${card.id}-${phase}-${kind}-${at}`, data: { at, init: card.id, kind, phase, who, ...extra } });

// The batch after a green ship. input: { version ("1.200.0"), sha, commits, cards, config, now, who ("Release"), versions }.
// Returns { ops, left: [text], named: [card id] }. A partial ship (a card whose commits are not all in this ship) is not this
// function's to judge: the release tool calls it only after the ship went out whole.
export function shipBatch({ version, sha, commits, cards, config, now, who = "Release", versions = {} }) {
  const c = config.collector, order = config.phases.map((p) => p[0]), ship = order.indexOf(c.shipPhase);
  const ops = [], left = [], named = [];
  const short = String(sha ?? "").slice(0, 8);
  for (const { card } of cardsNamed(commits, cards)) {
    named.push(card.id);
    ops.push(step(card, c.shipPhase, "start", who, now));
    // The waiting for the install is the page's to show from the repository (phase ship alone, no wait field): the line says only what shipped.
    const data = { nextNote: `v${version} (${short}) is on ${c.mainBranch}.`, nextNoteAt: now, updatedAt: now };
    // The phase moves only one step, to ship; a card further behind keeps what the repository derives (the gate refuses a skip).
    if (order.indexOf(card.phase) === ship - 1) data.phase = c.shipPhase;
    if (versions[card.id] === undefined) { left.push(`${card.id}: its card (nextNote${data.phase ? ", phase" : ""}) is not in this batch: no version given for it`); continue; }
    ops.push({ op: "update", path: `initiatives/${card.id}`, data, ifVersion: versions[card.id] });
  }
  return { ops, left, named };
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

// The command line, for a ship script (the product's or the board's) and for the install:
//   node scripts/ship-batch.mjs ship    --config C --repo R --range A..B --version 1.2.3 [--versions F] [--now MS] [--out F]
//   node scripts/ship-batch.mjs install --config C --cards id,id [--watch id,id] [--versions F] [--now MS] [--out F]
// Reads the cards from the mirror the gate keeps, the commits from the repository, and prints the db_write call as JSON (and saves it
// with --out); what it could not put in the batch is listed on stderr. It writes nothing to the board itself.
if (process.argv[1] && (await import("node:fs")).realpathSync(process.argv[1]) === (await import("node:url")).fileURLToPath(import.meta.url)) {
  const { readFileSync, readdirSync, writeFileSync } = await import("node:fs");
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
    const dir = join(String(config.gate.stateDir).replace(/^~(?=\/|$)/, homedir()), boardId(config) ?? "no-board", "mirror", "initiatives");
    const cards = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => ({ id: f.slice(0, -5), ...JSON.parse(readFileSync(join(dir, f), "utf8")) }));
    const now = arg("now") ? Number(arg("now")) : Date.now();
    if (!Number.isFinite(now) || now <= 0) fail("--now is a time in ms");
    const versions = arg("versions") ? JSON.parse(readFileSync(arg("versions"), "utf8")) : {};
    let r;
    if (mode === "ship") {
      const range = arg("range"), version = arg("version"), repo = arg("repo");
      if (!/^[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}$/.test(range ?? "") || !/^\d+\.\d+\.\d+$/.test(version ?? "") || !repo) fail("ship needs --range <sha>..<sha>, --version N.N.N and --repo");
      const out = execFileSync("git", ["log", "--format=%H%x1f%s%x1f%b%x1e", range], { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      const commits = out.split("\x1e").map((x) => x.trim()).filter(Boolean).map((x) => { const [sha, subject, body] = x.split("\x1f"); return { sha, subject, body }; });
      r = shipBatch({ version, sha: range.split("..")[1], commits, cards, config, now, versions });
    } else {
      const ids = new Set(String(arg("cards") ?? "").split(",").filter(Boolean)), watch = String(arg("watch") ?? "").split(",").filter(Boolean);
      if (!ids.size) fail("install needs --cards id,id");
      r = installBatch({ cards: cards.filter((c) => ids.has(c.id)), watch, config, now, versions });
    }
    const call = JSON.stringify(asCall(config.artifactSlug || config.artifactUrl, r.ops), null, 2);
    if (arg("out")) writeFileSync(arg("out"), call + "\n", { mode: 0o600 });
    process.stdout.write(call + "\n");
    for (const l of r.left) process.stderr.write(`left out: ${l}\n`);
  } catch (e) { fail(String(e.message).split("\n")[0]); }
}
