// #C1401: the page stopped reading abandonedAt. The collector's derive.mjs no longer writes it (#C1393), so the page's read of it (and the `abandoned` mark it put on a phase-log
// step, read again by the noWork and finished-phase lines) could never be true. A test fails if the page names it again, in code, a comment or a string.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const html = readFileSync(root + "page/board.template.html", "utf8");

test("the page does not name abandonedAt, nor an `abandoned` mark on a phase-log step", () => {
  const lines = html.split("\n").map((l, k) => [k + 1, l]).filter(([, l]) => /abandon/i.test(l)).map(([k, l]) => `line ${k}: ${l.trim().slice(0, 80)}`);
  assert.deepEqual(lines, [], "the page names the dead abandonedAt field or the mark that depended on it");
});

test("nothing the collector or the Worker writes carries abandonedAt either, so the page has nothing to read", () => {
  for (const f of ["collector/derive.mjs", "collector/state.mjs", "collector/state-schema.mjs", "worker/reading.mjs", "worker/board-rules.mjs"]) {
    const code = readFileSync(root + f, "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    assert.equal(/abandonedAt/.test(code), false, `${f} writes abandonedAt`);
  }
});

test("the build-phase lines the read used to feed still stand: a lone open build with no work seen is noWork, a finished phase is any ended one", () => {
  assert.match(html, /const lone=opens\.filter\(e=>e\.phase===BUILD_PHASE\)\.pop\(\);/);
  assert.match(html, /const finished=new Set\(work\.filter\(e=>e\.end!=null\)\.map\(e=>e\.phase\)\);/);
});
