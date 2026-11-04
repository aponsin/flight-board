// The commit gate, a PreToolUse hook on Bash: node gate/commit.mjs --config <board.config.json> (#C649).
// A git commit whose message starts "#C<num>:" is refused until the committing agent has a plain build start step on card <num>
// (gate/build-steps.mjs), and the refusal names the exact write. Every other Bash call passes at once: this hook runs on EVERY Bash
// call of every session, so the pass path reads nothing but the call itself (no file, no state, no network) and a failure of its
// own is never a refusal. It fails OPEN on: a throw, input that is not JSON, a config it cannot read, a missing or stale mirror, a
// timeout, a role it cannot tell, a card or steps it does not find. Only a clear "tagged commit, no start step" refuses (exit 2).
import { pathToFileURL } from "node:url";
import { commitCardNum, commitError } from "./build-steps.mjs";

const TIMEOUT_MS = Number(process.env.FLIGHT_BOARD_COMMIT_TIMEOUT_MS) > 0 ? Number(process.env.FLIGHT_BOARD_COMMIT_TIMEOUT_MS) : 5000;

// input: the hook's call. Returns { block } or {}. Async only for the lazy imports of the commit path.
export async function run(input, { config, env = process.env, now = Date.now() }) {
  const num = input?.tool_name === "Bash" ? commitCardNum(input?.tool_input?.command) : null;
  if (num === null) return {};
  const { join } = await import("node:path");
  const { readFileSync } = await import("node:fs");
  const { readMirror, withJournal, home } = await import("./gate.mjs");
  const { readLines, sessionRole } = await import("./session.mjs");
  const { boardId } = await import("../scripts/config.mjs");
  const id = boardId(config);
  const dir = join(home(config.gate.stateDir), id ?? "no-board");
  const lines = input?.transcript_path ? readLines(input.transcript_path) : [];
  const { role, error } = sessionRole(lines, env.FLIGHT_BOARD_ROLE);
  if (error || !role) return {};
  const m = readMirror(join(dir, "mirror"));
  if (!m) return {};
  let state = {};
  try { state = JSON.parse(readFileSync(join(dir, "gate.json"), "utf8")); } catch { /* none yet */ }
  // The writes the gate let through since the export, laid over the mirror: a start step written a minute ago counts.
  const seen = withJournal(m, state.journal);
  const text = commitError({ num, role, mirror: seen, now, maxAgeMs: config.gate.mirrorMaxAgeMin * 60e3 });
  return text ? { block: `${text}\n` } : {};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const timer = setTimeout(() => process.exit(0), TIMEOUT_MS);
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", async () => {
    try {
      const input = JSON.parse(raw);
      if (commitCardNum(input?.tool_input?.command) === null) process.exit(0); // not a tagged commit: nothing else is touched
      const { readFileSync } = await import("node:fs");
      const { checkConfig, fullConfig } = await import("../scripts/config.mjs");
      const at = process.argv.indexOf("--config");
      const cfg = JSON.parse(readFileSync(process.argv[at + 1], "utf8"));
      if (at < 0 || checkConfig(cfg).length) process.exit(0);
      const r = await run(input, { config: fullConfig(cfg) });
      clearTimeout(timer);
      if (r.block) { process.stderr.write(r.block); process.exit(2); }
    } catch { /* fails open */ }
    process.exit(0);
  });
}
