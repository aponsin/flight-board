// The one stable entry for the morning watches (#C1205): the owner's permission rules and the morning task's steps named pickup-watch.mjs and prompt-watch.mjs through the moving
// ~/.flight-board/current link, which is whatever the last landing left there. This entry reads the install the owner's hooks pin (scripts/config.mjs pinnedCommit, as wake-watch --pinned does,
// #C1165) and runs that install's copy of the script, so a rule that names this entry is the same text for every pack:
//   node ~/.flight-board/current/scripts/pinned-run.mjs pickup-watch <the script's own arguments>
//   node ~/.flight-board/current/scripts/pinned-run.mjs prompt-watch --config <board.config.json>
// The first argument is a name from a fixed list, never a path. With no single pin in the settings, or a pinned install that has no such script, it runs nothing, prints one line on stderr and exits 1;
// the script's own output, input and exit code pass through unchanged otherwise. It never runs `current`'s copy of the script, a checkout or any other folder.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { pinnedCommit } from "./config.mjs";

export const RUNNABLE = ["pickup-watch", "prompt-watch"];

// Pure: { file } is the pinned install's copy of the named script, or { why }. real(path) is the path with links resolved (a copy that is a link out of its install is refused).
export function pinnedScript({ settingsText, installRoot, name, exists = existsSync, real = realpathSync }) {
  if (!RUNNABLE.includes(name)) return { why: `${String(name).slice(0, 40)} is not one of ${RUNNABLE.join(", ")}` };
  const pin = pinnedCommit(settingsText);
  if (!pin) return { why: "the settings pin no single install: nothing is run" };
  const dir = join(installRoot, pin, "scripts"), file = join(dir, `${name}.mjs`);
  if (!exists(file)) return { why: `the pinned install ${pin.slice(0, 12)} has no scripts/${name}.mjs` };
  let root, at;
  try { root = real(join(installRoot, pin)); at = real(file); } catch { return { why: `the pinned install ${pin.slice(0, 12)} could not be read` }; }
  if (!at.startsWith(root + sep)) return { why: `scripts/${name}.mjs in the pinned install ${pin.slice(0, 12)} is a link out of it` };
  return { file: at, pin };
}

export function main(argv, { settingsText, installRoot, run = spawnSync, err = (s) => process.stderr.write(s) } = {}) {
  const [name, ...rest] = argv;
  const found = pinnedScript({ settingsText, installRoot, name });
  if (found.why) { err(`pinned-run: ${found.why}; nothing run\n`); return 1; }
  const r = run(process.execPath, [found.file, ...rest], { stdio: "inherit" });
  return r.error ? (err(`pinned-run: could not start ${name}: ${r.error.message}\n`), 1) : typeof r.status === "number" ? r.status : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  let settingsText = null; try { settingsText = readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"); } catch { /* no settings: no pin */ }
  process.exit(main(process.argv.slice(2), { settingsText, installRoot: join(homedir(), ".flight-board", "install") }));
}
