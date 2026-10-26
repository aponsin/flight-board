// The gate's PostToolUse hook: node gate/after.mjs --config <board.config.json>
// Runs only after a board write the board applied (Claude Code calls PostToolUse on a tool's success), and records what
// the gate must remember from it: the thread counter's new next. The PreToolUse gate checks "never back" against that,
// so a batch the board refused (a stale pin, a network error) leaves the memory as it was and its rerun passes (Checker).
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { boardId, checkConfig, fullConfig } from "../scripts/config.mjs";
import { COUNTERS } from "./rules.mjs";
import { writesOf, home, writeState, OVERLAY } from "./gate.mjs";

// Every write the gate sees, delete included (the overlay drops a deleted document: Checker).
const WRITES = new Set(["set", "update", "delete", "batch"]);

// state with what an applied write teaches the gate: the highest thread and card counters applied, the cards it created (for
// the hand-off check), and the journal of board-state writes, newest 500, which the gate lays over the mirror.
export function afterWrite(state, writes, now = Date.now()) {
  let next = state;
  for (const c of COUNTERS) {
    const seq = writes.find((w) => w.collection === "meta" && w.doc_id === c.seq && w.op !== "delete" && Number.isInteger(w.data?.next));
    if (seq) next = { ...next, [c.key]: Math.max(next?.[c.key] ?? 0, seq.data.next) };
  }
  const cards = writes.filter((w) => w.collection === "initiatives" && w.op !== "delete").map((w) => w.doc_id);
  if (cards.length) next = { ...next, known: [...new Set([...(next?.known ?? []), ...cards])] };
  const kept = writes.filter((w) => OVERLAY.has(w.collection));
  if (kept.length) next = { ...next, journal: [...(next?.journal ?? []), ...kept.map((w) => ({ op: w.op, collection: w.collection, doc_id: w.doc_id, data: w.data, at: now }))].slice(-500) };
  return next;
}

// One hook call: { tool_name, tool_input }. Returns the new state, or null when the call isn't a write to this board.
export function after(input, { config }) {
  const id = boardId(config);
  const t = input?.tool_input ?? {};
  if (input?.tool_name !== "ArtifactData" || !id || !String(t.url ?? "").includes(id) || !WRITES.has(t.action)) return null;
  const dir = join(home(config.gate.stateDir), id);
  const path = join(dir, "gate.json");
  let state = {};
  try { state = JSON.parse(readFileSync(path, "utf8")); } catch { /* first run */ }
  const next = afterWrite(state, writesOf(t));
  if (next === state) return state;
  writeState(path, next);
  return next;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const at = process.argv.indexOf("--config");
  let config;
  try {
    const raw = JSON.parse(readFileSync(process.argv[at + 1], "utf8"));
    if (at < 0 || checkConfig(raw).length) process.exit(0);
    config = fullConfig(raw);
  } catch { process.exit(0); }
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    try { after(JSON.parse(raw), { config }); } catch (e) { process.stderr.write(`Flight board gate (after a write): ${e.message}\n`); }
    process.exit(0);
  });
}
