// #C1388: a checker's name ("Checker" or "Checker <n>") is recognised by one pattern, worker/board-rules.mjs CHECKER_NAME; the dispatch imports it
// and no other file spells it again (three copies had three different digit limits).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKER_NAME } from "../worker/board-rules.mjs";
import * as dispatch from "../collector/store-dispatch.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("CHECKER_NAME takes Checker and Checker <n>, and nothing else", () => {
  for (const ok of ["Checker", "Checker 2", "Checker 12"]) assert.equal(CHECKER_NAME.test(ok), true, ok);
  for (const bad of ["checker", "Checker2", "Checker 100", "Checker 2 ", " Checker", "Security", "Checker 2x", "the Checker", ""]) assert.equal(CHECKER_NAME.test(bad), false, JSON.stringify(bad));
});

test("no other file in worker/, collector/, scripts/ or gate/ writes its own pattern for a checker's name", () => {
  const spelled = /\/\^\s*Checker\b/; // a regex literal that starts "/^Checker"
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(mjs|js)$/.test(name)) continue;
      readFileSync(p, "utf8").split("\n").forEach((line, i) => { if (spelled.test(line)) found.push(`${relative(ROOT, p)}:${i + 1}`); });
    }
  };
  for (const d of ["worker", "collector", "scripts", "gate"]) walk(join(ROOT, d));
  assert.deepEqual(found, ["worker/board-rules.mjs:325"], "the one definition; every reader imports CHECKER_NAME");
});

test("the dispatch module loads with the shared pattern (it imports it from board-rules)", () => {
  assert.equal(typeof dispatch.dispatchRun, "function");
});
