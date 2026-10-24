// The collector's run: node collector/collect.mjs --config <board.config.json> [--no-fetch]
// Reads the board's mirror (<stateDir>/<board>/mirror, exported just before by the scheduled task), fetches the team's
// repository and its sign-off notes, works out each open card's phase (collector/derive.mjs), and writes
// <stateDir>/<board>/out/derived-all.json: the one document the task then writes to the board as derived/all.
// It prints one line per conflict (a card's declared phase against its evidence) and the cards live by the evidence but
// still open, for the lead. It never writes the board itself: only a Claude session can (collector/TASK.md).
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { sep } from "node:path";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkConfig, fullConfig, boardId } from "../scripts/config.mjs";
import { readMirror, home } from "../gate/gate.mjs";
import { headFor, derivePhase, conflict, staleLive } from "./derive.mjs";
import { remoteHeads, mainLine, deployedSha, factsFor, shippedHeads } from "./facts.mjs";

// Sign-off notes are fetched into a namespace of our own (refs/notes/flight-board/, where git notes can read them), so a
// local notes ref the team is writing is never overwritten.
export const localNotes = (notes) => Object.fromEntries(Object.entries(notes).map(([p, ref]) => [p, `refs/notes/flight-board/${ref.slice("refs/notes/".length)}`]));

// The mirror folder, emptied before the task exports the board into it (--prepare). Refused unless the path ends in
// /<board id>/mirror, so a wrong stateDir can never make the run remove another folder.
export function prepareMirror(dir, id) {
  const mirror = join(dir, "mirror");
  if (!id || !mirror.endsWith(`${sep}${id}${sep}mirror`)) throw new Error(`refusing to clear ${mirror}: not <stateDir>/<board id>/mirror`);
  if (existsSync(mirror)) rmSync(mirror, { recursive: true, force: true });
  mkdirSync(mirror, { recursive: true });
  return mirror;
}

export function collect({ config, cards, git, gh, now }) {
  const c = config.collector;
  const cfg = { ...config, collector: { ...c, notes: localNotes(c.notes) } };
  const line = mainLine(git, c.remote, c.mainBranch);
  const heads = [...remoteHeads(git, c.remote), ...shippedHeads(git, line, c.shippedPattern)];
  const deployed = deployedSha(gh, c.deployWorkflow, c.mainBranch);
  const open = cards.filter((k) => k.status !== "done");
  const derived = {};
  for (const card of open) derived[card.id] = { ...derivePhase(card, factsFor(git, headFor(card.id, heads), { config: cfg, line, deployed }), cfg), at: now };
  const conflicts = open.map((k) => conflict(k, derived[k.id], config)).filter(Boolean);
  return { doc: { at: now, cards: derived, conflicts, liveButOpen: staleLive(open, derived, config) }, conflicts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
    try { console.log(`Mirror ready to export into: ${prepareMirror(dir, boardId(config))}`); process.exit(0); } catch (e) { console.error(`Collector: ${e.message}`); process.exit(1); }
  }
  const mirror = readMirror(join(dir, "mirror"));
  if (!mirror?.docs.initiatives) { console.error(`Collector: no mirror at ${join(dir, "mirror")}: export the board first (collector/TASK.md, step 1).`); process.exit(1); }
  if (!process.argv.includes("--no-fetch")) {
    git(["fetch", "-q", config.collector.remote]);
    git(["fetch", "-q", config.collector.remote, "+refs/notes/*:refs/notes/flight-board/*"]);
  }
  const { doc, conflicts } = collect({ config, cards: mirror.docs.initiatives, git, gh, now: Date.now() });
  mkdirSync(join(dir, "out"), { recursive: true });
  const out = join(dir, "out", "derived-all.json");
  writeFileSync(out, JSON.stringify(doc, null, 2));
  console.log(`Derived ${Object.keys(doc.cards).length} open card(s) into ${out}.`);
  for (const line of conflicts) console.log(`CONFLICT ${line}`);
  if (doc.liveButOpen.length) console.log(`LIVE BUT OPEN (${doc.liveButOpen.length}): ${doc.liveButOpen.join(", ")}`);
}
