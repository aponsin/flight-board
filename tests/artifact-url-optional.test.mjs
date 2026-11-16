// #C1075 step 1 (the old board artifact was deleted on 2026-11-13): artifactUrl is optional end to end. With boardId set and artifactUrl empty, every reader
// that needs the board's id or a link still works: the red-ask hook finds its state folder, the release tool's prompt renders, the gate matches the board's calls,
// and no other source file reads the old link.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { boardId, checkConfig, fullConfig } from "../scripts/config.mjs";
import { isBoardSlug } from "../gate/tools.mjs";
import { promptBoard, renderPrompt, PROMPT_FILE } from "../scripts/board-release.mjs";
import { OPEN_ASKS_FILE } from "../collector/store-dispatch.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOOK = join(ROOT, "hooks/red-ask-board.py");
const RED = "\u{1F534}";
const ID = "flight-board-main";

// The hook, with a home whose registered config holds `cfg` and whose state folder `folder` holds a fresh open-asks.json naming #T1830.
function hookSays(cfg, folder) {
  const home = mkdtempSync(join(tmpdir(), "fb-aurl-")), state = join(home, "state"), conf = join(home, "board.config.json");
  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(conf, JSON.stringify({ owner: "Owner", gate: { stateDir: state }, ...cfg }));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `'/n/node' '${home}/.flight-board/install/${"a".repeat(40)}/gate/stop.mjs' --config '${conf}'` }] }] } }));
    mkdirSync(join(state, folder), { recursive: true });
    writeFileSync(join(state, folder, OPEN_ASKS_FILE), JSON.stringify({ at: Date.now(), asks: [1830] }));
    const t = join(home, "s.jsonl");
    const lines = [{ type: "custom-title", customTitle: "Manager" }, { type: "user", message: { content: [{ type: "text", text: "status" }] } }, { type: "assistant", message: { content: [{ type: "text", text: `${RED} Reminder: #T1830 still needs your answer.` }] } }];
    writeFileSync(t, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const r = spawnSync("python3", [HOOK], { input: JSON.stringify({ transcript_path: t }), encoding: "utf8", env: { ...process.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "", HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout).reason : "";
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test("the red-ask hook finds its open-asks.json by boardId when artifactUrl is empty, and the old link still works as a fallback", () => {
  assert.equal(hookSays({ boardId: ID, artifactUrl: "" }, ID), "", "the open ask #T1830 is read from the boardId folder: no new ask needed");
  assert.match(hookSays({ boardId: ID, artifactUrl: "" }, "no-board"), /red ask/, "the file in the no-board folder is not the board's");
  assert.equal(hookSays({ artifactUrl: `https://claude.ai/${"artifact"}/OldBoard01` }, "OldBoard01"), "", "no boardId: the id in the link, as before");
  assert.equal(hookSays({ boardId: ID, artifactUrl: `https://claude.ai/${"artifact"}/OldBoard01` }, ID), "", "the key wins over the link");
  assert.equal(hookSays({ boardId: "../x", artifactUrl: "" }, "no-board"), "", "a key that is not a plain id is ignored: the no-board folder, never a path out of the state folder");
});

test("the release tool's prompt renders with artifactUrl empty: the link, else the store address, else the id; nothing empty", () => {
  const link = `https://claude.ai/${"artifact"}/OldBoard01`;
  assert.equal(promptBoard({ artifactUrl: link, storeUrl: "https://b.example.com/", boardId: ID }), link);
  assert.equal(promptBoard({ artifactUrl: "", storeUrl: "https://b.example.com/", boardId: ID }), "https://b.example.com/");
  assert.equal(promptBoard({ artifactUrl: "", storeUrl: "", boardId: ID }), ID);
  assert.equal(promptBoard({ artifactUrl: "", storeUrl: "" }), "", "nothing at all stays empty: renderPrompt refuses it, as before");
  const template = readFileSync(join(ROOT, PROMPT_FILE), "utf8");
  const values = { CONFIG: "/c", LEAD_ROLE: "Manager", LEAD: "Manager", CURRENT: "/cur", OUT: "/out" };
  const text = renderPrompt(template, { ...values, BOARD: promptBoard(fullConfig({ boardId: ID })) });
  assert.ok(text.includes(ID) && !/undefined|\{\{/.test(text));
  assert.throws(() => renderPrompt(template, { ...values, BOARD: promptBoard(fullConfig({})) }), /no value for \{\{BOARD\}\}/);
});

// Checker 2's F1 on 0abd8096: promptBoard is only worth anything if the release tool's main path uses it.
test("the release tool fills {{BOARD}} through promptBoard and nowhere else: no BOARD value reads artifactUrl directly", () => {
  const src = readFileSync(join(ROOT, "scripts/board-release.mjs"), "utf8");
  const boardValues = [...src.matchAll(/\bBOARD:\s*([^,}]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(boardValues, ["promptBoard(config)"], "every BOARD: value in the tool is promptBoard(config)");
  const calls = src.split("\n").filter((l) => /=\s*renderPrompt\(/.test(l));
  assert.equal(calls.length, 1, "one call site of renderPrompt: a second one needs its own check");
  assert.ok(calls[0].includes("BOARD: promptBoard(config)"), "the call that renders the prompt carries it");
});

test("with boardId set and artifactUrl empty the config is valid, the id is the key, and the gate matches the board's own calls", () => {
  const raw = { boardId: ID, artifactUrl: "" };
  assert.deepEqual(checkConfig(raw), []);
  const c = fullConfig(raw);
  assert.equal(boardId(c), ID);
  assert.equal(isBoardSlug(ID, c), true);
  assert.equal(isBoardSlug("some-other-board", c), false);
});

// No other file reads the old link. A new reader means this list changes on purpose.
const READS_ARTIFACT_URL = new Set([
  "scripts/config.mjs",          // the key, its check, boardId()'s fallback
  "gate/tools.mjs",              // isBoardSlug's fallback
  "scripts/board-release.mjs",   // promptBoard
  "hooks/red-ask-board.py",      // the fallback for a config with no boardId
  "page/board.template.html",    // the old board's deaf line (off on the store)
  "gate/publish.mjs",            // the publish guard: goes in #C1054 b2, after the owner's pack
  "collector/fence.mjs",         // the old Collector's fence: goes with the old Collector files (#C864 2b)
  "collector/state.mjs",         // a comment
]);
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", ".wrangler", "tests", "CHANGELOG.d", "docs", "keeper"].includes(name)) continue;
    const p = join(dir, name), s = statSync(p);
    if (s.isDirectory()) walk(p, out); else if (/\.(mjs|py|html|js)$/.test(name)) out.push(p);
  }
  return out;
}
test("no source file but the listed ones reads artifactUrl", () => {
  const readers = walk(ROOT).filter((p) => /\bartifactUrl\b/.test(readFileSync(p, "utf8"))).map((p) => relative(ROOT, p)).sort();
  const extra = readers.filter((p) => !READS_ARTIFACT_URL.has(p));
  assert.deepEqual(extra, [], "a new reader of the old link: use boardId() or storeUrl, or list it here on purpose");
});
