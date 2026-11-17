// #C1167 (Checker 2, 11-17: `node ~/.flight-board/current/scripts/group-check.mjs read ...` did nothing and exited 0): a script's "am I the file node was started with" check.
// It compared process.argv[1], the path as typed (here the `current` link), with import.meta.url, which node resolves to the real file, so through a symlink the two
// differ, main() never ran and nothing said so. One reading for every script: both sides by their real path. A path that cannot be resolved is not the main file.
// Usage: if (isMain(import.meta.url)) { ... }
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const real = (p) => { try { return realpathSync(p); } catch { return null; } };

export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const started = real(argv1), file = real(fileURLToPath(metaUrl));
  return started !== null && started === file;
}
