// The lead's digest, a UserPromptSubmit hook: node gate/digest.mjs --config <board.config.json>
// The mechanical messages the send gate turned into board log entries (#C335, gate/traffic.mjs) reach the lead as one
// line at the start of its next turn: what this hook prints is added to the turn as context, so the lead spends no tool
// call and no extra round on them. The entries come from the gate's journal (gate/after.mjs keeps every log write the
// board applied, newest 500), each counted from when it was journaled; <stateDir>/<board>/digest.json keeps when the
// lead's last digest ran, per role. Nothing to say, another role, or anything unreadable: it prints nothing and exits 0.
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkConfig, fullConfig, boardId } from "../scripts/config.mjs";
import { readLines, sessionRole } from "./session.mjs";
import { home, writeState } from "./gate.mjs";
import { logDigest } from "./traffic.mjs";

const DAY = 864e5;

// { line, record }: the digest line (or null) and the time to keep for next time, for one prompt of `role`.
export function digest({ journal, last, now }) {
  const since = typeof last === "number" && Number.isFinite(last) && last <= now ? last : now - DAY;
  const entries = (journal ?? []).filter((w) => w?.collection === "log" && w.op === "set" && w.data && typeof w.data === "object" && typeof w.at === "number" && w.at <= now)
    .map((w) => ({ ...w.data, at: w.at }));
  return { line: logDigest(entries, since), record: now };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    try {
      const at = process.argv.indexOf("--config");
      const cfg = JSON.parse(readFileSync(process.argv[at + 1], "utf8"));
      if (at < 0 || checkConfig(cfg).length) process.exit(0);
      const config = fullConfig(cfg), id = boardId(config);
      const input = JSON.parse(raw);
      if (!id || !input?.transcript_path) process.exit(0);
      const { role } = sessionRole(readLines(input.transcript_path), process.env.FLIGHT_BOARD_ROLE);
      if (role !== config.gate.managerRole) process.exit(0);
      const dir = join(home(config.gate.stateDir), id), path = join(dir, "digest.json");
      let state = {}, journal = [];
      try { state = JSON.parse(readFileSync(path, "utf8")); } catch { /* first run */ }
      try { journal = JSON.parse(readFileSync(join(dir, "gate.json"), "utf8")).journal ?? []; } catch { /* none yet */ }
      const last = state && typeof state === "object" && Object.hasOwn(state, role) ? state[role] : null;
      const { line, record } = digest({ journal, last, now: Date.now() });
      writeState(path, { ...(state && typeof state === "object" ? state : {}), [role]: record });
      if (line) process.stdout.write(`${line}\n`);
    } catch { /* never in the lead's way */ }
    process.exit(0);
  });
}
