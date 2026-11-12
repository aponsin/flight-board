// Where the live state.json is (#C861 F1). The store collector's jobs keep it in a private folder beside the old one: <stateDir>/<board>-store/<board>/state.json,
// handed to them as --private-dir by their launchd plists. The old collector's <stateDir>/<board>/state.json is dead once the store runs, and a script that
// reads it sees a state that is days old. The rule, in one place:
//   - gate.stateDir set in the board's config: <stateDir>/<board>/state.json, as the owner said;
//   - else the store's file when it exists, else the old path (a stale old file then reads as unknown through LIVE_FRESH, never as ok).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { boardId } from "./config.mjs";

export const home = (p) => String(p).replace(/^~(?=\/|$)/, homedir());

// config: the full config; raw: the config as the file has it (tells whether gate.stateDir was set); exists: injectable for tests.
export function liveStateFile(config, raw, exists = existsSync) {
  const id = boardId(config) ?? "", dir = home(config.gate.stateDir);
  const old = join(dir, id, "state.json"), store = join(dir, `${id}-store`, id, "state.json");
  if (raw?.gate?.stateDir !== undefined) return old;
  return exists(store) ? store : old;
}
