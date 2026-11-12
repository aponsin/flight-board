// The landing job (#C967): a program lands a flight-board commit that is signed, dry-run clean and not held; Release takes only what it refuses.
//   node ~/.flight-board/current/scripts/board-land.mjs --config <board.config.json> [--dry-run]
// Run from the signed linked copy, like the release tool it calls (board-release.mjs, beside it): that tool does every check and the push
// (Checker's PASS and Security's SECURE on the exact tip, a fast-forward of origin/main, no newer -vN of the card, nothing the owner's install
// pins, the Board-Id trailers, the page). This job adds three things around it:
//   1. which tips to try: origin's build/* branches that continue main, carry a Checker PASS and a Security SECURE on the exact tip (the first
//      line of each note), and whose cards are all free. A tip with a note that says anything else (STOP, FINDINGS, a withdrawn PASS) is not
//      tried. A line of several commits lands as its tip, in one fast-forward; the branches under it are then on main and drop out.
//   2. holds: the probe's dispatch job writes <stateDir>/<board>/land-holds.json each minute ({ at, cards: { id: "" | "paused" | "dropped" |
//      "blocked" | "waiting_on" }}). A tip lands only when every card it carries (the Board-Id trailers of main..tip) is listed with no hold. A file
//      that is missing, unreadable or older than 10 minutes, or a card it does not list, lands nothing: Release lands by hand as before.
//   3. the refusals: the release tool's dry run (and then its real run) decides; a refusal is written to <stateDir>/<board>/land-report.json
//      ({ at, landed, refused: [{ branch, sha, cards, reasons }], waiting }) and printed, for Release to take. The job never retries a refused tip
//      in the same run, never forces, never touches a branch, a note or a hold.
// Flight-board only: the release tool lands into the flight-board repository, and a product ship stays with Release.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const NOTES = { security: "refs/notes/security", checker: "refs/notes/checker" };
export const HOLDS_FRESH_MS = 10 * 60e3, MAX_ROUNDS = 10;
const CARD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const signed = (notes) => /^PASS\b/.test(String(notes?.checker ?? "").split("\n")[0].trim()) && /^SECURE\b/.test(String(notes?.security ?? "").split("\n")[0].trim());

// The tips to try, from the facts only. heads: [{ branch, sha, notes: { checker, security }, cards: [ids], onMain, forward, ahead }]
// (onMain: already an ancestor of main; forward: main is an ancestor of it; ahead: commits it adds to main). holds: the parsed land-holds.json or
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
    if (!h.forward) { out.blocked.push({ branch: h.branch, sha: h.sha, cards, reasons: ["it doesn't continue origin/main: rebase it on main and sign it again"] }); continue; }
    out.try.push(h);
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
export function landRun({ readFacts, readHolds, release, now = Date.now(), dry = false, log = () => {} }) {
  const landed = [], refused = [], seen = new Set();
  let waiting = [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const plan = landPlan({ heads: readFacts().heads.filter((h) => !seen.has(h.sha)), holds: readHolds(), now });
    waiting = plan.waiting;
    for (const b of plan.blocked) if (!seen.has(b.sha)) { seen.add(b.sha); refused.push(b); }
    const next = plan.try[0];
    if (!next) break;
    seen.add(next.sha);
    const check = release(next.sha, true);
    if (check.code !== 0) { refused.push({ branch: next.branch, sha: next.sha, cards: next.cards, reasons: refusalReasons(check.text) }); log(`refused ${next.branch} ${next.sha.slice(0, 12)}`); continue; }
    if (dry) { landed.push({ branch: next.branch, sha: next.sha, dry: true }); log(`would land ${next.branch} ${next.sha.slice(0, 12)}`); continue; }
    const real = release(next.sha, false);
    if (real.code !== 0) { refused.push({ branch: next.branch, sha: next.sha, cards: next.cards, reasons: refusalReasons(real.text) }); log(`refused on the real run ${next.branch} ${next.sha.slice(0, 12)}`); continue; }
    landed.push({ branch: next.branch, sha: next.sha });
    log(`landed ${next.branch} ${next.sha.slice(0, 12)}`);
  }
  return { at: now, landed, refused, waiting };
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2), dry = args.includes("--dry-run"), ci = args.indexOf("--config");
  const configPath = ci >= 0 ? args[ci + 1] : null;
  if (!configPath || args.some((a, n) => a !== "--dry-run" && a !== "--config" && n !== ci + 1)) { console.error("Usage: node ~/.flight-board/current/scripts/board-land.mjs --config <board.config.json> [--dry-run]"); process.exit(2); }
  const self = dirname(fileURLToPath(import.meta.url));
  const link = join(homedir(), ".flight-board", "current", "scripts");
  if (!existsSync(link) || realpathSync(link) !== realpathSync(self)) { console.log("NOT RUN: this is not the signed linked copy (~/.flight-board/current): run it from there"); process.exit(1); }
  const repo = process.env.FLIGHT_BOARD_REPO || join(homedir(), "Documents/Code/flight-board");
  const git = (a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
  const quiet = (a) => { try { return git(a); } catch { return null; } };
  const { checkConfig, fullConfig, boardId } = await import("./config.mjs");
  const { home } = await import("../gate/gate.mjs");
  const raw = readJson(configPath);
  if (!raw || checkConfig(raw).length) { console.log("NOT RUN: the board config is missing or invalid"); process.exit(1); }
  const config = fullConfig(raw), id = boardId(config);
  if (!id) { console.log("NOT RUN: the config names no board"); process.exit(1); }
  const dir = join(home(config.gate.stateDir), id);
  const readFacts = () => {
    quiet(["fetch", "-q", "origin"]);
    for (const [who, ref] of Object.entries(NOTES)) quiet(["fetch", "-q", "origin", `+${ref}:refs/notes/board-release/${who}`]);
    const main = git(["rev-parse", "origin/main"]);
    const heads = (quiet(["for-each-ref", "refs/remotes/origin/build", "--format=%(refname:lstrip=3) %(objectname)"]) ?? "").split("\n").filter(Boolean).map((l) => {
      const [branch, sha] = l.split(" ");
      const notes = Object.fromEntries(Object.keys(NOTES).map((who) => [who, quiet(["notes", `--ref=board-release/${who}`, "show", sha])]));
      const cards = [...new Set((quiet(["log", "--format=%(trailers:key=Board-Id,valueonly,separator=%x2c)", `${main}..${sha}`]) ?? "").split(/[\n,]/).map((x) => x.trim()).filter(Boolean))];
      return { branch, sha, notes, cards, onMain: quiet(["merge-base", "--is-ancestor", sha, main]) !== null, forward: quiet(["merge-base", "--is-ancestor", main, sha]) !== null, ahead: Number(quiet(["rev-list", "--count", `${main}..${sha}`]) ?? 0) };
    });
    return { main, heads };
  };
  const release = (sha, dryRun) => {
    const r = spawnSync(process.execPath, [join(self, "board-release.mjs"), sha, ...(dryRun ? ["--dry-run"] : [])], { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { code: r.status ?? 1, text: `${r.stderr ?? ""}\n${r.stdout ?? ""}` };
  };
  const report = landRun({ readFacts, readHolds: () => readJson(join(dir, "land-holds.json")), release, dry, log: (s) => console.log(`land: ${s}`) });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "land-report.json"), part = `${file}.${process.pid}.part`;
  writeFileSync(part, JSON.stringify(report), { mode: 0o600 }); renameSync(part, file);
  console.log(`land: ${report.landed.length} landed${dry ? " (dry run)" : ""}, ${report.refused.length} refused, ${report.waiting.length} waiting`);
  for (const r of report.refused) console.log(`REFUSED ${r.branch} ${r.sha.slice(0, 12)}: ${r.reasons.join("; ")}`);
}
