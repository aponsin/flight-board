// #C640: scripts/spend-by-source.py names an untitled transcript by who it is: the role in its first "/pickup <Role>" user line,
// else the folder it ran in; "(untitled)" only for the rest. The sender of a cross-session message names nobody. Run as the probe
// runs it (python3 -I, the script on stdin) against a fake HOME with made-up transcripts.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = readFileSync(new URL("../scripts/spend-by-source.py", import.meta.url), "utf8");
const usage = (n) => ({ type: "assistant", timestamp: "2026-11-03T12:00:00.000Z", message: { usage: { input_tokens: n, cache_creation_input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 5 } } });
const user = (content) => ({ type: "user", timestamp: "2026-11-03T11:00:00.000Z", message: { role: "user", content } });

function fakeHome(sessions) {
  const home = mkdtempSync(join(tmpdir(), "usage-"));
  const meta = join(home, "Library", "Application Support", "Claude", "claude-code-sessions", "a", "b");
  mkdirSync(meta, { recursive: true });
  sessions.forEach((s, n) => {
    const dir = join(home, ".claude", "projects", s.folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${s.id}.jsonl`), [...(s.lines ?? []), usage(s.tokens)].map((l) => JSON.stringify(l)).join("\n") + "\n");
    if (s.title) writeFileSync(join(meta, `local_${n}.json`), JSON.stringify({ cliSessionId: s.id, title: s.title }));
  });
  return home;
}
const rowsOf = (home, extra = []) => {
  const r = spawnSync("python3", ["-I", "-", "--json", "--since", "2026-11-03T00:00", ...extra], { input: SCRIPT, encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  return Object.fromEntries(JSON.parse(r.stdout).rows.map((x) => [x.source, x.weighted]));
};

test("an untitled transcript is named by its /pickup role, else its folder; a titled one keeps its title; the rest stays untitled", () => {
  const home = fakeHome([
    { id: "s1", folder: "-Users-x-Code-product", title: "Builder", tokens: 1 },
    // Titled sessions of the roles whose folders are named for them (the folder rule needs a title of that name to exist).
    { id: "k1", folder: "-Users-x-Code-product", title: "Manager", tokens: 1 },
    { id: "k2", folder: "-Users-x-Code-product", title: "Triage", tokens: 1 },
    { id: "s2", folder: "-Users-x-Code-product", lines: [user("hello"), user("/pickup Checker")], tokens: 20 },
    { id: "s3", folder: "-Users-x-Code-product", lines: [user([{ type: "text", text: "<command-name>/pickup</command-name>\n<command-args>Security</command-args>" }])], tokens: 300 },
    { id: "s4", folder: "-Users-x-Code-product-manager", lines: [user("what is next")], tokens: 4000 },
    { id: "s5", folder: "-Users-x--flight-board-Board01", lines: [user("run")], tokens: 50000 },
    { id: "s6", folder: "-Users-x-Code-flight-board", lines: [user("go")], tokens: 600000 },
    { id: "s7", folder: "-Users-x-Code-product-triage", tokens: 7000000 },
    // The sender of a cross-session message does not name the session.
    { id: "s8", folder: "-Users-x-Code-elsewhere", lines: [user('<cross-session-message from="Manager">do this</cross-session-message>')], tokens: 80000000 },
    // A /pickup beats the folder.
    { id: "s9", folder: "-Users-x-Code-product-manager", lines: [user("/pickup Designer")], tokens: 900000000 },
  ]);
  try {
    const r = rowsOf(home);
    assert.equal(r.Builder, 1, "a titled session keeps its title");
    assert.equal(r.Checker, 20);
    assert.equal(r.Security, 300, "the command-args form");
    assert.equal(r.Manager, 4001, "by folder (4000) beside the titled one (1), no pickup");
    assert.equal(r["scheduled: Collector"], 50000, "the Collector's folder");
    assert.equal(r.Boardsmith, 600000);
    assert.equal(r.Triage, 7000001);
    assert.equal(r["(untitled)"], 80000000, "a message from Manager does not make the session Manager");
    assert.equal(r.Designer, 900000000, "the pickup beats the folder");
    assert.equal(r.Manager, 4001, "and the folder's Manager is not credited with it");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a transcript with no /pickup in its first user lines, odd lines or no user line at all, is read without failing", () => {
  const home = fakeHome([
    { id: "s1", folder: "-Users-x-Code-elsewhere", lines: [{ type: "user", message: null }, { type: "user" }, user(42), user("no role here: /pickup")], tokens: 5 },
    { id: "s2", folder: "-Users-x-Code-elsewhere", lines: [], tokens: 6 },
  ]);
  try {
    assert.deepEqual(rowsOf(home), { "(untitled)": 11 });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the seed commit's lines are kept: the script still prints its table and totals the same way", () => {
  const home = fakeHome([{ id: "s1", folder: "-Users-x-Code-product-manager", title: "Context keeper hourly", tokens: 10 }, { id: "s2", folder: "-Users-x-Code-product", title: "Builder", tokens: 30 }]);
  try {
    const r = spawnSync("python3", ["-I", "-", "--since", "2026-11-03T00:00"], { input: SCRIPT, encoding: "utf8", env: { ...process.env, HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /total 0\.0M weighted/);
    assert.match(r.stdout, /scheduled runs: 25%/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
