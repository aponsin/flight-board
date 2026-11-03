// The page's pack label (#C609) must never go out empty: Version 147 was nearly published from a page board-release built
// without BOARD_PACK, which would have dropped "Board v3.51 · page ..." from the header. Fictional paths.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { packLabel } from "../scripts/pack-label.mjs";

const file = (text) => () => text;
const missing = () => { throw new Error("ENOENT"); };

test("the label: BOARD_PACK first, then the pack-label file beside the config; a bad or missing one is none", () => {
  assert.equal(packLabel({ BOARD_PACK: "v3.52" }, "/cfg", file("v3.51\n")), "v3.52", "the environment wins");
  assert.equal(packLabel({}, "/cfg", file("v3.51\n")), "v3.51", "the file, with its newline");
  assert.equal(packLabel({ BOARD_PACK: "" }, "/cfg", file(" v3.5b ")), "v3.5b", "an empty variable falls through");
  for (const bad of ["", "3.51", "v3", "v3.51.1", "v3.51; rm -rf", "latest", "V3.51"]) {
    assert.equal(packLabel({ BOARD_PACK: bad }, "/cfg", missing), null, `variable ${JSON.stringify(bad)}`);
    assert.equal(packLabel({}, "/cfg", file(bad)), null, `file ${JSON.stringify(bad)}`);
  }
  // Checker: a variable that is set but is no label never falls back to the file (a three-part name went out as the older pack's).
  assert.equal(packLabel({ BOARD_PACK: "v3.5.1" }, "/cfg", file("v3.50\n")), null);
  assert.equal(packLabel({ BOARD_PACK: "oops" }, "/cfg", file("v3.50\n")), null);
  assert.equal(packLabel({}, "/cfg", missing), null, "no variable and no file");
  assert.equal(packLabel(undefined, "/cfg", missing), null);
});

test("the file is read beside the board config", () => {
  let read = null;
  packLabel({}, "/home/x/board-config", (p) => { read = p; return "v3.51"; });
  assert.equal(read, "/home/x/board-config/pack-label");
});

test("board-release builds the page only with a label, and passes it to the build; with none it refuses and names how to fix it", () => {
  const src = readFileSync(new URL("../scripts/board-release.mjs", import.meta.url), "utf8");
  assert.match(src, /import \{ packLabel \} from "\.\/pack-label\.mjs"/);
  assert.match(src, /const pack = packLabel\(process\.env, out\);\s*if \(!pack\) \{ built = false; v\.refusals\.push\(`the page has no pack label: set BOARD_PACK=vN\.NN/);
  assert.match(src, /env: \{ \.\.\.process\.env, BOARD_PACK: pack \}/);
});
