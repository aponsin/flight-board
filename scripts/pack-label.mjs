// The installed pack's label for the page's "Board <pack> · page <commit>" line (#C609). A page built without one drew no pack
// (Version 147 nearly went out so: board-release built it with an empty data-pack). The label is BOARD_PACK, or the one-line
// file `pack-label` beside the board config, which the owner's install and whoever publishes a page for a pack keep current.
// null when neither holds a label of the form v3.51 (or v3.5b): the caller refuses to build.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PACK_LABEL = /^v\d+\.\d+[a-z]?$/;
export function packLabel(env, configDir, read = (p) => readFileSync(p, "utf8")) {
  const fromEnv = String(env?.BOARD_PACK ?? "").trim();
  // A variable that is set but is no label is an error, never a reason to read the file (Checker: v3.5.1 fell back to an older pack's v3.50).
  if (fromEnv) return PACK_LABEL.test(fromEnv) ? fromEnv : null;
  try { const fromFile = String(read(join(configDir, "pack-label"))).trim(); return PACK_LABEL.test(fromFile) ? fromFile : null; } catch { return null; }
}
