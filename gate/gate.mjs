// The write gate, a PreToolUse hook: node gate/gate.mjs --config <board.config.json>
// - A write to the board (ArtifactData set, update, batch on the board's link) is checked by gate/rules.mjs; refused
//   with the reasons (exit 2), so the writer fixes it and sends again.
// - A hand-off message from the lead role (SendMessage, send_message) that hands out a task must name a card the board
//   has (rule 9, case 3).
// The gate keeps its state (refusals in a row, stuck items, cards it has let through) in <stateDir>/<board>/gate.json and
// reads the board's mirror (an export of its collections) from <stateDir>/<board>/mirror.
import { realpathSync } from "node:fs";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { checkConfig, fullConfig, boardId } from "../scripts/config.mjs";
import { checkWrites, refusalText } from "./rules.mjs";
import { readLines, sessionRole } from "./session.mjs";

const WRITES = new Set(["set", "update", "delete", "batch", "str_replace"]);
const SEND_TOOLS = new Set(["SendMessage", "mcp__ccd_session_mgmt__send_message"]);
export const home = (p) => String(p).replace(/^~(?=\/|$)/, homedir());

// The writes in one ArtifactData call, each with its data (read from file_path when given).
export function writesOf(t) {
  const load = (w) => (w.data ?? (w.file_path ? JSON.parse(readFileSync(w.file_path, "utf8")) : null));
  // A text edit in place can't be checked (the gate never sees the field's whole new value): refused below.
  if (t.action === "str_replace") return [{ op: "str_replace", collection: t.collection, doc_id: t.doc_id, data: { [t.field]: t.new_str } }];
  if (t.action === "batch") return (t.writes ?? []).map((w) => ({ op: w.op, collection: w.collection, doc_id: w.doc_id, data: load(w) }));
  return [{ op: t.action, collection: t.collection, doc_id: t.doc_id, data: load(t) }];
}

// The board's mirror: { docs: { collection: [ {id, ...data} ] }, at } from an ArtifactData export (out_dir), or null.
export function readMirror(dir) {
  if (!existsSync(dir)) return null;
  const docs = {};
  let at = 0;
  for (const c of readdirSync(dir)) {
    const cdir = join(dir, c);
    if (!statSync(cdir).isDirectory()) continue;
    docs[c] = [];
    for (const f of readdirSync(cdir)) {
      if (!f.endsWith(".json")) continue;
      const path = join(cdir, f);
      at = Math.max(at, statSync(path).mtimeMs);
      try { docs[c].push({ id: f.slice(0, -5), ...JSON.parse(readFileSync(path, "utf8")) }); } catch { /* half written */ }
    }
  }
  return { docs, at };
}

// Rule 9 (case 3): the card ids a hand-off names ("board id x-y", "card x-y", "task x-y"), and whether it hands out work.
export function handOff(text) {
  const ids = [...String(text).matchAll(/\b(?:board (?:id|card)|card(?: id)?|task)[:\s]+`?([a-z0-9]+(?:-[a-z0-9]+)+)`?/gi)].map((m) => m[1].toLowerCase());
  const work = /\btask\b|\bREADY\b|\bbuild\b/i.test(String(text)) || ids.length > 0;
  return { ids: [...new Set(ids)], work };
}

export function checkHandOff(text, { known, fresh }) {
  const { ids, work } = handOff(text);
  if (!work) return { errors: [], note: null };
  if (!ids.length) return { errors: ["this hands out work but names no card: write \"board id <id>\" (create the card first if it has none)"], note: null };
  const missing = ids.filter((id) => !known.has(id));
  if (!missing.length) return { errors: [], note: null };
  if (!fresh) return { errors: [], note: `the board's mirror is stale; couldn't check card ${missing.join(", ")} exists` };
  return { errors: [`no card ${missing.join(", ")} on the board: create it first (initiatives/<id>), then send`], note: null };
}

export function run(input, { config, env = process.env, now = Date.now() }) {
  const id = boardId(config);
  const dir = join(home(config.gate.stateDir), id ?? "no-board");
  const statePath = join(dir, "gate.json");
  let state = {};
  try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { /* first run */ }
  const save = (s) => { mkdirSync(dir, { recursive: true }); writeFileSync(statePath, JSON.stringify(s, null, 2)); };
  const t = input?.tool_input ?? {};
  const lines = input?.transcript_path ? readLines(input.transcript_path) : [];
  const { role, error: roleError } = sessionRole(lines, env.FLIGHT_BOARD_ROLE);
  const who = { role, manager: role === config.gate.managerRole };

  if (input?.tool_name === "ArtifactData" && id && String(t.url ?? "").includes(id) && WRITES.has(t.action)) {
    if (roleError) return { block: `Flight board refused this write: ${roleError}\n` };
    const writes = writesOf(t);
    // Rules 3-5 read the mirror the collector keeps; a stale one skips them (fail open) with a note.
    const m = readMirror(join(dir, "mirror"));
    // ...and only when it was exported after the last write the gate let through: an older one misses that write.
    const mirror = m && now - m.at < config.gate.mirrorMaxAgeMin * 60e3 && m.at >= (state.lastWriteAt ?? 0) ? m : null;
    const out = checkWrites(writes, { config, who, now, state, mirror });
    const known = new Set(state.known ?? []);
    if (!out.errors.length) for (const w of writes) if (w.collection === "initiatives" && w.op !== "delete") known.add(w.doc_id);
    save({ ...out.state, known: [...known], lastWriteAt: out.errors.length ? state.lastWriteAt : now });
    return out.errors.length ? { block: refusalText(out.errors, out.stuckNow, now) } : {};
  }
  if (SEND_TOOLS.has(input?.tool_name) && who.manager) {
    const mirror = readMirror(join(dir, "mirror"));
    const fresh = !!mirror && now - mirror.at < config.gate.mirrorMaxAgeMin * 60e3;
    const known = new Set([...(state.known ?? []), ...((mirror?.docs.initiatives ?? []).map((d) => d.id))]);
    const r = checkHandOff(t.message ?? t.text ?? "", { known, fresh });
    if (r.errors.length) return { block: `Not sent. ${r.errors.join(" ")}\n` };
    return r.note ? { note: r.note } : {};
  }
  return {};
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const at = process.argv.indexOf("--config");
  let config;
  try {
    const raw = JSON.parse(readFileSync(process.argv[at + 1], "utf8"));
    const problems = checkConfig(raw);
    if (at < 0 || problems.length) throw new Error(problems.join("; ") || "no --config");
    config = fullConfig(raw);
  } catch (e) { process.stderr.write(`Flight board gate: can't read its config (${e.message}); writes are not checked.\n`); process.exit(0); }
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    let r = {};
    try { r = run(JSON.parse(raw), { config }); } catch (e) { process.stderr.write(`Flight board gate could not read the call: ${e.message}\n`); process.exit(0); }
    if (r.block) { process.stderr.write(r.block); process.exit(2); }
    if (r.note) process.stderr.write(`Flight board gate: ${r.note}\n`);
    process.exit(0);
  });
}
