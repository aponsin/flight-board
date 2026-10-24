// The gate's Stop hook: node gate/stop.mjs --config <board.config.json>
// A lead-role reply can't end its turn when
// - it states a verdict (the config's verdictWords: shipped, is live, decided…) and the turn wrote nothing to the board
//   (case 4: "the initiative was not up to date"); or
// - the turn began with the owner's "Board thread [<id>]" message and wrote no message to that thread (case 5: an
//   answer in a comment the board never shows).
// Exit 2 sends the reason back, so the lead writes it and finishes. A second stop in a row (stop_hook_active) passes.
import { realpathSync } from "node:fs";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { checkConfig, fullConfig, boardId } from "../scripts/config.mjs";
import { readLines, sessionRole, currentTurn, turnCalls, turnText, lastReply } from "./session.mjs";
import { writesOf } from "./gate.mjs";

const WRITES = new Set(["set", "update", "delete", "batch", "str_replace"]);

export function stopCheck(lines, { config, env = {} }) {
  const { role } = sessionRole(lines, env.FLIGHT_BOARD_ROLE);
  if (role !== config.gate.managerRole) return [];
  const id = boardId(config);
  const turn = currentTurn(lines);
  const writes = turnCalls(turn).filter((c) => c.name === "ArtifactData" && id && String(c.input.url ?? "").includes(id) && WRITES.has(c.input.action))
    .flatMap((c) => { try { return writesOf(c.input); } catch { return []; } });
  const out = [];
  const reply = lastReply(turn);
  const said = (config.gate.verdictWords ?? []).filter((w) => new RegExp(`(^|[^A-Za-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z]|$)`, "i").test(reply));
  if (said.length && !writes.length) out.push(`your reply says "${said[0]}" but this turn wrote nothing to the board: write it there first (the item, its step, or the event)`);
  const asked = [...turnText(turn, "user").matchAll(/Board thread \[([^\]\s]{1,80})\]/g)].map((m) => m[1]);
  for (const t of new Set(asked)) {
    if (!writes.some((w) => w.collection === "messages" && w.op !== "delete" && w.data?.thread === t)) out.push(`the owner wrote in thread ${t}: answer there (messages {thread: "${t}", from: "${role}", text, at}), not only here`);
  }
  return out;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const at = process.argv.indexOf("--config");
  let config;
  try {
    const raw = JSON.parse(readFileSync(process.argv[at + 1], "utf8"));
    if (at < 0 || checkConfig(raw).length) throw new Error("bad config");
    config = fullConfig(raw);
  } catch { process.exit(0); }
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    let input = {};
    try { input = JSON.parse(raw); } catch { process.exit(0); }
    if (input.stop_hook_active || !input.transcript_path) process.exit(0);
    const errs = stopCheck(readLines(input.transcript_path), { config, env: process.env });
    if (errs.length) { process.stderr.write(`Before you finish:\n- ${errs.join("\n- ")}\n`); process.exit(2); }
    process.exit(0);
  });
}
