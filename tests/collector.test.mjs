// The collector: each card's phase from the repository (branches, Board-Id trailers, sign-off notes, the main branch,
// the deploy run), its conflicts with what the card says, and the gate's rules that read the mirror. Fictional repo.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { boardIdOf, headFor, reviewsFor, derivePhase, conflict, staleLive } from "../collector/derive.mjs";
import { remoteHeads, signedPhases, versionFor, mainLine, factsFor, shippedHeads } from "../collector/facts.mjs";
import { collect, localNotes, prepareMirror, swapMirror, runNudges } from "../collector/collect.mjs";
import { mirrorErrors, checkWrites } from "../gate/rules.mjs";

const config = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: { language: "refs/notes/linguist", checker: "refs/notes/checker", security: "refs/notes/security" }, deployWorkflow: "CI" } });
const facts = (over = {}) => ({ head: { branch: "build/tabs", sha: "aaaaaaaa11", message: "x\n\nBoard-Id: tabs" }, signed: new Set(), onMain: false, deployed: false, version: null, ...over });
const card = (over = {}) => ({ id: "tabs", status: "active", level: "Full", customerText: true, ...over });

test("Board-Id trailers, and a card's head: the trailer wins, then a branch named for the card, newest first", () => {
  assert.equal(boardIdOf("Fix tabs\n\nBoard-Id: tab-fix\nCo-Authored-By: x"), "tab-fix");
  assert.equal(boardIdOf("mentions Board-Id: inline only"), null);
  const heads = [{ branch: "build/tabs", sha: "1", at: 2, message: "" }, { branch: "admin/other", sha: "2", at: 1, message: "Board-Id: tabs" }, { branch: "old/tabs", sha: "3", at: 1, message: "" }];
  assert.equal(headFor("tabs", heads).sha, "2");
  assert.equal(headFor("tabs", heads.slice(0, 1).concat(heads[2])).sha, "1", "newest of the named branches");
  assert.equal(headFor("none", heads), null);
});

test("the reviews a card needs follow its level and fields, and its skips", () => {
  assert.deepEqual(reviewsFor(card(), config), ["language", "checker", "security"]);
  assert.deepEqual(reviewsFor(card({ level: "Quick", customerText: false }), config), ["checker"]);
  assert.deepEqual(reviewsFor(card({ skip: ["checker"] }), config), ["language", "security"]);
});

test("the derived phase: build, then each review not yet signed in order, then ship, then live with its version", () => {
  assert.equal(derivePhase(card(), { head: null }, config).phase, null);
  assert.equal(derivePhase(card(), facts({ head: { branch: "build/tabs", sha: "a", message: "wip" } }), config).phase, "build");
  assert.equal(derivePhase(card(), facts(), config).phase, "language");
  assert.equal(derivePhase(card(), facts({ signed: new Set(["language"]) }), config).phase, "checker");
  assert.equal(derivePhase(card(), facts({ signed: new Set(["language", "checker"]) }), config).phase, "security");
  assert.equal(derivePhase(card(), facts({ signed: new Set(["language", "checker", "security"]) }), config).phase, "ship");
  assert.equal(derivePhase(card(), facts({ onMain: true }), config).phase, "ship");
  assert.deepEqual(derivePhase(card(), facts({ onMain: true, deployed: true, version: "1.2.0" }), config).version, "1.2.0");
  assert.match(derivePhase(card(), facts({ onMain: true, deployed: true, version: "1.2.0" }), config).evidence, /deployed in 1\.2\.0/);
});

test("case 2: a card still on build while its head carries every sign-off is a conflict, with the evidence", () => {
  const d = derivePhase(card({ level: "Full", customerText: false }), facts({ signed: new Set(["checker", "security"]) }), config);
  assert.equal(d.phase, "ship");
  assert.match(conflict(card({ phase: "build" }), d, config), /^tabs: the card says build, the repository says ship \(READY at aaaaaaaa; every review signed\)$/);
  assert.equal(conflict(card({ phase: "ship" }), d, config), null);
  assert.match(conflict(card({ phase: "live" }), d, config), /ahead of its evidence/);
});

test("case 1: open cards that are live by the evidence are listed for the close-out", () => {
  const derived = { a: { phase: "live" }, b: { phase: "ship" } };
  assert.deepEqual(staleLive([card({ id: "a" }), card({ id: "b" }), card({ id: "c" })], derived, config), ["a"]);
});

// A scratch repository with a remote: a branch READY with notes, one merged and released, one still in build.
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-coll-"));
  const repo = join(dir, "repo"), bare = join(dir, "origin.git");
  const g = (args, cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  const commit = (file, msg) => { writeFileSync(join(repo, file), msg + "\n"); g(["add", "-A"]); g(["commit", "-qm", msg]); return g(["rev-parse", "HEAD"]).trim(); };
  commit("a.md", "start");
  g(["checkout", "-qb", "build/shipped-one"]); const shipped = commit("s.md", "shipped work\n\nBoard-Id: shipped-one");
  g(["checkout", "-q", "main"]); g(["merge", "-q", "--no-ff", "-m", "Merge shipped-one", "build/shipped-one"]);
  commit("v.md", "v1.4.0: build/shipped-one@" + shipped.slice(0, 8));
  g(["checkout", "-qb", "build/ready-one"]); const ready = commit("r.md", "ready work\n\nBoard-Id: ready-one");
  g(["notes", "--ref=refs/notes/checker", "add", "-m", "PASS", ready]);
  g(["checkout", "-qb", "build/wip-one", "main"]); commit("w.md", "wip");
  g(["checkout", "-q", "main"]);
  g(["push", "-q", "origin", "main", "build/shipped-one", "build/ready-one", "build/wip-one", "refs/notes/checker"]);
  g(["fetch", "-q", "origin", "+refs/notes/*:refs/notes/flight-board/*"]);
  g(["fetch", "-q", "origin"]);
  return { dir, repo, git: (args) => g(args), shipped, ready, main: g(["rev-parse", "main"]).trim() };
}

test("the facts from a real repository: heads with messages, notes signed, the version a commit shipped in", () => {
  const s = scratch();
  try {
    const heads = remoteHeads(s.git, "origin");
    assert.deepEqual(heads.map((h) => h.branch).sort(), ["build/ready-one", "build/shipped-one", "build/wip-one", "main"]);
    assert.match(heads.find((h) => h.branch === "build/ready-one").message, /Board-Id: ready-one/);
    assert.deepEqual([...signedPhases(s.git, s.ready, localNotes({ checker: "refs/notes/checker", security: "refs/notes/security" }))], ["checker"]);
    const line = mainLine(s.git, "origin", "main");
    assert.equal(versionFor(s.git, s.shipped, line, config.collector.versionPattern), "1.4.0");
    assert.equal(versionFor(s.git, s.ready, line, config.collector.versionPattern), null);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("a whole run: each open card's phase, its conflicts, the live-but-open list; the deploy run decides live", () => {
  const s = scratch();
  try {
    const cfg = fullConfig({ owner: "Sam", collector: { repoPath: s.repo, notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, deployWorkflow: "CI" } });
    const cards = [
      { id: "shipped-one", status: "active", phase: "build", level: "Quick" },
      { id: "ready-one", status: "active", phase: "build", level: "Full" },
      { id: "wip-one", status: "active", phase: "build", level: "Quick" },
      { id: "plan-only", status: "active", phase: "plan" },
      { id: "old", status: "done", phase: "live" },
    ];
    const gh = (args) => (args.includes("--workflow") ? JSON.stringify([{ headSha: s.main }]) : "[]");
    const { doc, conflicts } = collect({ config: cfg, cards, git: s.git, gh, now: 5 });
    assert.equal(doc.cards["shipped-one"].phase, "live");
    assert.equal(doc.cards["shipped-one"].version, "1.4.0");
    assert.equal(doc.cards["ready-one"].phase, "security", "checker signed, security not yet");
    assert.equal(doc.cards["wip-one"].phase, "build");
    assert.equal(doc.cards["plan-only"].phase, null);
    assert.equal(doc.cards.old, undefined, "done cards aren't read");
    assert.deepEqual(doc.liveButOpen, ["shipped-one"]);
    assert.equal(conflicts.length, 2);
    const noDeploy = collect({ config: cfg, cards, git: s.git, gh: () => "[]", now: 5 }).doc;
    assert.equal(noDeploy.cards["shipped-one"].phase, "ship", "on main but no successful deploy run: not live");
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

// ---- The gate's rules on the mirror ----
const mirror = (over = {}) => ({ docs: {
  initiatives: [{ id: "tabs", status: "active", phase: "checker", who: "Checker" }, { id: "menu", status: "active", phase: "build", who: "Builder" }],
  waiting: [], messages: [], derived: [{ id: "all", cards: { tabs: { phase: "security", evidence: "e" } } }], ...over } });
const upd = (data, id = "tabs") => ({ op: "update", collection: "initiatives", doc_id: id, data });

test("rule 3: a card's phase moves forward only; a jump past a phase needs it skipped, the evidence past it, or a reason", () => {
  assert.match(mirrorErrors(upd({ phase: "build" }), { config, mirror: mirror() })[0], /only move forward: checker → build/);
  assert.deepEqual(mirrorErrors(upd({ phase: "security" }), { config, mirror: mirror() }), []);
  assert.match(mirrorErrors(upd({ phase: "live" }), { config, mirror: mirror() })[0], /skips security, ship/);
  assert.deepEqual(mirrorErrors(upd({ phase: "live", phaseReason: "shipped by hand" }), { config, mirror: mirror() }), []);
  assert.deepEqual(mirrorErrors(upd({ phase: "live" }), { config, mirror: mirror({ derived: [{ id: "all", cards: { tabs: { phase: "live" } } }] }) }), [], "the evidence is already live");
  assert.deepEqual(mirrorErrors(upd({ phase: "build" }, "new-card"), { config, mirror: mirror() }), [], "a card the mirror doesn't know");
});

test("rule 4: one card per role per build or review phase", () => {
  assert.match(mirrorErrors(upd({ phase: "build", who: "Builder" }, "other"), { config, mirror: mirror({ initiatives: [...mirror().docs.initiatives, { id: "other", status: "active", phase: "plan" }] }) })[0], /menu is on build for Builder: has it moved on\? Update menu first/);
  assert.deepEqual(mirrorErrors(upd({ phase: "ship", who: "Release" }, "other"), { config, mirror: mirror() }), [], "ship isn't a lane");
  assert.deepEqual(mirrorErrors(upd({ phase: "build", who: "Builder" }, "menu"), { config, mirror: mirror() }), [], "the same card");
});

test("rule 5, case 1: done only with the owner answered, no open ask tied to it, and live by the evidence", () => {
  const done = upd({ status: "done", doneAt: 1 });
  assert.match(mirrorErrors(done, { config, mirror: mirror() }).join(), /repository says security, not live/);
  const live = { derived: [{ id: "all", cards: { tabs: { phase: "live" } } }] };
  assert.deepEqual(mirrorErrors(done, { config, mirror: mirror(live) }), []);
  assert.match(mirrorErrors(done, { config, mirror: mirror({ ...live, messages: [{ thread: "tabs", from: "Sam", text: "Still on?", at: 1 }] }) }).join(), /Sam's last message in its thread is unanswered/);
  assert.match(mirrorErrors(done, { config, mirror: mirror({ ...live, waiting: [{ id: "ask-1", initiative: "tabs", done: false }] }) }).join(), /ask tied to it is still open \(ask-1\)/);
  assert.deepEqual(mirrorErrors(done, { config, mirror: mirror({ ...live, waiting: [{ id: "ask-1", initiative: "tabs", done: false, response: { status: "ok" } }] }) }), []);
  assert.deepEqual(mirrorErrors(upd({ status: "done" }, "unknown"), { config, mirror: mirror() }), [], "no evidence for this card: it passes");
});

test("the gate runs rules 3-5 only with a mirror; without one they pass", () => {
  const w = upd({ phase: "build" });
  assert.equal(checkWrites([w], { config, who: { role: "Manager", manager: true }, now: Date.now() - 1234, state: {}, mirror: null }).errors.length, 0);
  assert.equal(checkWrites([w], { config, who: { role: "Manager", manager: true }, now: Date.now() - 1234, state: {}, mirror: mirror() }).errors.length, 1);
});

test("a branch deleted after it shipped is still found, from the release commit that names it (shippedPattern)", () => {
  const s = scratch();
  try {
    s.git(["push", "-q", "origin", "--delete", "build/shipped-one"]); s.git(["fetch", "-q", "--prune", "origin"]);
    const line = mainLine(s.git, "origin", "main");
    const pattern = "([A-Za-z0-9._/-]+)@([0-9a-f]{7,40})";
    assert.deepEqual(shippedHeads(s.git, line, pattern).map((h) => [h.branch, h.sha]), [["build/shipped-one", s.shipped]]);
    assert.deepEqual(shippedHeads(s.git, line, ""), [], "no pattern, no guess");
    const cfg = fullConfig({ collector: { repoPath: s.repo, notes: { checker: "refs/notes/checker" }, deployWorkflow: "CI", shippedPattern: pattern } });
    const gh = () => JSON.stringify([{ headSha: s.main }]);
    const { doc } = collect({ config: cfg, cards: [{ id: "shipped-one", status: "active", phase: "ship" }], git: s.git, gh, now: 1 });
    assert.equal(doc.cards["shipped-one"].phase, "live");
    assert.equal(doc.cards["shipped-one"].version, "1.4.0");
    assert.equal(collect({ config: fullConfig({ collector: { ...cfg.collector, shippedPattern: "" } }), cards: [{ id: "shipped-one", status: "active" }], git: s.git, gh, now: 1 }).doc.cards["shipped-one"].phase, null);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("the live-but-open list leaves out cards already done; notes are read from the collector's own namespace only", () => {
  assert.deepEqual(staleLive([card({ id: "a", status: "done" }), card({ id: "b" })], { a: { phase: "live" }, b: { phase: "live" } }, config), ["b"]);
  assert.deepEqual(localNotes({ checker: "refs/notes/checker" }), { checker: "refs/notes/flight-board/checker" });
  const s = scratch();
  try {
    // The team's own ref says nothing (deleted here); the fetched copy is what counts.
    s.git(["update-ref", "-d", "refs/notes/checker"]);
    const cfg = fullConfig({ collector: { repoPath: s.repo, notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, deployWorkflow: "CI" } });
    const { doc } = collect({ config: cfg, cards: [{ id: "ready-one", status: "active", level: "Full" }], git: s.git, gh: () => "[]", now: 1 });
    assert.equal(doc.cards["ready-one"].phase, "security", "checker's note found in refs/notes/flight-board/checker");
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("Security, Checker: a subject's sha reaches git only as plain hex; the export goes to mirror.next and swaps in whole, only under <stateDir>/<board id>", async () => {
  const { mkdirSync, existsSync, writeFileSync: write } = await import("node:fs");
  const calls = [];
  const git = (args) => { calls.push(args); return "abc1234def\n"; };
  const line = [{ sha: "m1", at: 1, subject: "v1.0.0: build/a@--upload-pack=x build/b@ABCDEF1 build/c@abc1234" }];
  assert.deepEqual(shippedHeads(git, line, "([A-Za-z0-9._/-]+)@([^\\s]+)").map((h) => h.branch), ["build/c"]);
  assert.ok(calls.every((a) => a.every((x) => !String(x).startsWith("--upload"))), "no subject text as an option");
  const dir = mkdtempSync(join(tmpdir(), "fb-prep-"));
  try {
    const boardDir = join(dir, "Board01");
    mkdirSync(join(boardDir, "mirror", "initiatives"), { recursive: true });
    write(join(boardDir, "mirror", "initiatives", "old.json"), "{}");
    assert.equal(prepareMirror(boardDir, "Board01"), join(boardDir, "mirror.next"));
    assert.equal(existsSync(join(boardDir, "mirror", "initiatives", "old.json")), true, "the gate's mirror stays whole while the export runs");
    mkdirSync(join(boardDir, "mirror.next", "initiatives"));
    write(join(boardDir, "mirror.next", "initiatives", "new.json"), "{}");
    assert.equal(swapMirror(boardDir, "Board01"), true);
    assert.equal(existsSync(join(boardDir, "mirror", "initiatives", "new.json")), true, "swapped into place");
    assert.equal(existsSync(join(boardDir, "mirror", "initiatives", "old.json")), false);
    assert.equal(existsSync(join(boardDir, "mirror.next")), false);
    assert.equal(swapMirror(boardDir, "Board01"), false, "nothing new: the mirror is left as it is");
    assert.throws(() => prepareMirror(dir, "Board01"), /refusing to clear/);
    assert.throws(() => swapMirror(boardDir, ""), /refusing to clear/);
    assert.equal(existsSync(dir), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Checker 1: until heads carry a Board-Id, a sign-off note on a branch named for the card means READY; missing evidence is no conflict", () => {
  const head = { branch: "build/own-visits", sha: "bbbbbbbb22", message: "fix: tests" };
  const c = card({ id: "own-visits", level: "Full", customerText: false });
  assert.equal(derivePhase(c, facts({ head, signed: new Set(["checker"]) }), config).phase, "security", "checker signed: READY, waiting for security");
  const noNote = derivePhase(c, facts({ head }), config);
  assert.equal(noNote.phase, "build");
  assert.equal(noNote.firm, false);
  assert.equal(conflict(card({ id: "own-visits", phase: "checker" }), noNote, config), null, "a card in review whose head has no note yet: not a conflict");
  assert.match(conflict(card({ id: "own-visits", phase: "plan" }), noNote, config), /says plan, the repository says build/, "behind the evidence still is");
});

test("Manager: one card per owner in build and test only; reviews and shipping queue many", () => {
  const two = { initiatives: [{ id: "a", status: "active", phase: "checker", who: "Checker" }, { id: "t", status: "active", phase: "test", who: "Builder" }, { id: "b", status: "active", phase: "language" }] };
  assert.deepEqual(mirrorErrors(upd({ phase: "checker", who: "Checker" }, "b"), { config, mirror: mirror(two) }), [], "a second card in checker queues");
  assert.match(mirrorErrors(upd({ phase: "test", who: "Builder", phaseReason: "back for a fix" }, "b"), { config, mirror: mirror(two) }).join(), /t is on test for Builder/);
  const c = { id: "c", status: "active", phase: "build", who: "Builder" };
  assert.match(mirrorErrors(upd({ phase: "test" }, "c"), { config, mirror: mirror({ initiatives: [two.initiatives[1], c] }) }).join(), /t is on test for Builder/);
  assert.deepEqual(mirrorErrors(upd({ phase: "test" }, "c"), { config, mirror: mirror({ initiatives: [{ ...two.initiatives[1], status: "dropped" }, c] }) }), [], "a dropped card holds no lane");
});

test("Manager: a card given up closes as dropped with a reason, needing no live evidence", () => {
  assert.match(mirrorErrors(upd({ status: "dropped" }), { config, mirror: mirror() }).join(), /needs dropReason/);
  assert.deepEqual(mirrorErrors(upd({ status: "dropped", dropReason: "the owner chose another way" }), { config, mirror: mirror() }), [], "the repository says security: no matter");
  assert.match(mirrorErrors(upd({ status: "dropped", dropReason: "x" }), { config, mirror: mirror({ messages: [{ thread: "tabs", from: "Sam", text: "?", at: 1 }] }) }).join(), /unanswered/);
  assert.deepEqual(staleLive([card({ id: "a", status: "dropped" })], { a: { phase: "live" } }, config), [], "a dropped card isn't listed as live but open");
});

test("rule 10: a reply names an item or a thread with messages; a made-up thread id is refused (the reply-card bug)", () => {
  const m = mirror({ waiting: [{ id: "ask-one" }], ideas: [{ id: "idea-one" }], messages: [{ id: "m1", thread: "old-thread", at: 1 }, { id: "m0", thread: "t-1700000000000", at: 1 }] });
  const msg = (thread, op = "set") => ({ op, collection: "messages", doc_id: "m2", data: { thread, from: "Lead", text: "x", at: 2 } });
  for (const t of ["tabs", "ask-one", "idea-one", "old-thread", "t-1700000000000"]) assert.deepEqual(mirrorErrors(msg(t), { config, mirror: m }), [], t);
  assert.match(mirrorErrors(msg("ask-one-reply"), { config, mirror: m })[0], /thread ask-one-reply is no item/);
  assert.match(mirrorErrors(msg("t-made-up"), { config, mirror: m })[0], /thread t-made-up is no item/, "an agent never starts a t- thread (Checker)");
  const now = 1_800_000_000_000;
  assert.deepEqual(mirrorErrors(msg(`t-${now - 60_000}`), { config, mirror: m, now }), [], "the owner's new thread, not yet in the mirror, is answerable (Checker)");
  assert.match(mirrorErrors(msg(`t-${now - 8 * 864e5}`), { config, mirror: m, now })[0], /no new thread of the owner's/, "older than 7 days and unknown");
  assert.match(mirrorErrors(msg(`t-${now + 3_600_000}`), { config, mirror: m, now })[0], /is no item/, "a time in the future");
  assert.match(mirrorErrors(msg("t-17000000000001"), { config, mirror: m, now })[0], /is no item/, "14 digits is not the box's shape");
  assert.match(mirrorErrors({ op: "set", collection: "messages", doc_id: "m3", data: { text: "x" } }, { config, mirror: m })[0], /names its thread/);
  const batch = [{ op: "set", collection: "waiting", doc_id: "new-ask", data: {} }, msg("new-ask")];
  assert.deepEqual(checkWrites(batch, { config, who: { role: "Lead", manager: true }, now: 5, state: {}, mirror: m }).errors.filter((e) => e.startsWith("messages/")), [], "an ask made in the same call");
  assert.deepEqual(mirrorErrors(msg("anything"), { config, mirror: mirror() }), [], "an export without ideas skips the rule");
  assert.deepEqual(mirrorErrors(msg("anything"), { config, mirror: null }), [], "no mirror: fail open");
});

test("the run's nudges keep their state next to the mirror: sent once, quiet on the next run, fine with a broken state file", async () => {
  const { writeFileSync: write, readFileSync: read } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "fb-nudge-"));
  try {
    const cfg = fullConfig({ owner: "Sam" }), T = 1_800_000_000_000;
    const docs = { messages: [{ id: "m1", thread: "t-1", from: "Sam", text: "x", at: T - 20 * 60e3 }] };
    assert.deepEqual(runNudges(dir, cfg, docs, T), ["NUDGE thread t-1: Sam has waited 20 min for an answer"]);
    assert.equal(typeof JSON.parse(read(join(dir, "nudges.json"), "utf8")).sent["thread:t-1"], "number");
    assert.deepEqual(runNudges(dir, cfg, docs, T + 60 * 60e3), [], "the next run, an hour later, inside the quiet period");
    write(join(dir, "nudges.json"), "not json");
    assert.equal(runNudges(dir, cfg, docs, T + 61 * 60e3).length, 1, "a broken state file starts afresh");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Security: TASK.md sets the task's title, its exact permission rules, no reading of the export, one task after a ship", async () => {
  const { readFileSync: read } = await import("node:fs");
  const doc = read(new URL("../collector/TASK.md", import.meta.url), "utf8");
  assert.match(doc, /\*\*Session title\*\*: exactly `Collector`/);
  assert.match(doc, /enforced by permission rules, not by the prompt/);
  assert.match(doc, /"Bash\(node collector\/collect\.mjs --config <full path to board\.config\.json> --prepare\)"/);
  assert.match(doc, /"Bash\(node collector\/collect\.mjs --config <full path to board\.config\.json>\)"/);
  assert.match(doc, /no wildcards/);
  assert.match(doc, /never runs with\s+bypassPermissions or in auto mode/);
  assert.match(doc, /Never open, read or print those files/);
  assert.match(doc, /Never read the exported files/);
  assert.match(doc, /The after-ship run is \*\*this same task\*\*/);
  assert.match(doc, /`ctx`;[\s\S]*`query` of `steps`/, "the export takes the memory tiles and the last days' steps for the nudges");
  assert.match(doc, /`NUDGE` line/);
  const settings = JSON.parse(doc.match(/```json\n([\s\S]*?)\n  ```/)[1].replace(/^  /gm, ""));
  assert.deepEqual(settings.permissions.allow.slice(2), ["ArtifactData", "SendMessage"]);
  assert.ok(settings.permissions.allow.slice(0, 2).every((r) => r.startsWith("Bash(node collector/collect.mjs --config ") && !r.includes("*")), "the two node commands, whole");
  for (const d of ["Read", "Grep", "Glob", "Agent", "Bash(head:*)", "Bash(tail:*)", "Bash(git:*)", "Bash(npm:*)", "mcp__ccd_session_mgmt__send_message"]) assert.ok(settings.permissions.deny.includes(d), d);
  assert.equal(settings.permissions.defaultMode, "default");
  assert.deepEqual(settings.permissions.additionalDirectories, ["<gate.stateDir>/<board id>/mirror.next"], "only the export's folder (Security)");
  assert.match(doc, /SendMessage to the lead's\s+session id/, "a scheduled run reaches no session by name");
  assert.match(doc, /no prompt of a run with "always allow"/);
  assert.deepEqual(settings.env, { FLIGHT_BOARD_ROLE: "Collector" });
  assert.match(doc, /the four steps below, written out in full \(the task can't Read this file\)/);
});
