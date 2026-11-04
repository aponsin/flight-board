// The write gate, a PreToolUse hook: node gate/gate.mjs --config <board.config.json>
// - A write to the board (ArtifactData set, update, batch on the board's link) is checked by gate/rules.mjs; refused
//   with the reasons (exit 2), so the writer fixes it and sends again.
// - A hand-off message from the lead role (SendMessage, send_message) that hands out a task must name a card the board
//   has (rule 9, case 3).
// The gate keeps its state (refusals in a row, stuck items, cards it has let through) in <stateDir>/<board>/gate.json and
// reads the board's mirror (an export of its collections) from <stateDir>/<board>/mirror.
import { realpathSync } from "node:fs";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { checkConfig, fullConfig, boardId } from "../scripts/config.mjs";
import { checkWrites, refusalText } from "./rules.mjs";
import { readLines, sessionRole } from "./session.mjs";
import { mechanicalClass, refusal } from "./traffic.mjs";
import { liveFresh } from "../collector/state-schema.mjs";
import { classify, normName, PREFIX } from "./tools.mjs";
import { isReady, readyError } from "./build-steps.mjs";

const WRITES = new Set(["set", "update", "delete", "batch", "str_replace"]);
const SEND_TOOLS = new Set(["SendMessage", "mcp__ccd_session_mgmt__send_message"]);
export const home = (p) => String(p).replace(/^~(?=\/|$)/, homedir());
// The state to save, with what after.mjs keeps taken from the file now (it may have written since this call read it):
// the higher thread and card counters, and the journal and known cards as they are on disk (this hook never changes them).
export function keepCounter(state, disk) {
  const out = { ...state };
  for (const k of ["threadSeq", "cardSeq"]) {
    const seq = Math.max(state?.[k] ?? 0, Number.isInteger(disk?.[k]) ? disk[k] : 0);
    if (seq) out[k] = seq;
  }
  for (const k of ["journal", "known"]) if (Array.isArray(disk?.[k])) out[k] = disk[k];
  return out;
}
// The gate's save: the file is read again just before writing, so a counter after.mjs raised meanwhile is kept.
export function saveState(path, state) {
  let disk = {};
  try { disk = JSON.parse(readFileSync(path, "utf8")); } catch { /* none yet */ }
  writeState(path, keepCounter(state, disk));
}
// gate.json has two writers (this hook and gate/after.mjs), which parallel calls can interleave: each writes a file of its
// own and renames it into place, so a reader never sees half a file and a write is whole or not at all (Security).
export function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

// The writes in one ArtifactData call, each with its data (read from file_path when given).
export function writesOf(t) {
  const load = (w) => (w.data ?? (w.file_path ? JSON.parse(readFileSync(w.file_path, "utf8")) : null));
  // A text edit in place can't be checked (the gate never sees the field's whole new value): refused below.
  if (t.action === "str_replace") return [{ op: "str_replace", collection: t.collection, doc_id: t.doc_id, data: { [t.field]: t.new_str }, if_version: t.if_version }];
  if (t.action === "batch") return (t.writes ?? []).map((w) => ({ op: w.op, collection: w.collection, doc_id: w.doc_id, data: load(w), if_version: w.if_version }));
  return [{ op: t.action, collection: t.collection, doc_id: t.doc_id, data: load(t), if_version: t.if_version }];
}

// The owner's messages the lead's own live check found (gate/live.mjs keeps them in live.json, the Stop gate counts them), laid over
// a mirror that has not exported them yet (#C627): the owner wrote "all done" in a thread whose ask the lead had deleted, the
// Stop gate asked for a reply there, and rule 10 refused one because the export (up to a collector run old) held no message in
// it. A message already in the mirror is not added twice; a mirror without messages, or no live ones, is returned as it was.
export function withLiveMessages(mirror, msgs) {
  if (!mirror || !Array.isArray(msgs) || !msgs.length) return mirror;
  const have = new Set((mirror.docs.messages ?? []).map((d) => d.id));
  const add = msgs.filter((m) => m && typeof m.id === "string" && typeof m.thread === "string" && !have.has(m.id)).map((m) => ({ id: m.id, thread: m.thread, from: m.from, at: m.at, text: typeof m.text === "string" ? m.text : "" }));
  return add.length ? { ...mirror, docs: { ...mirror.docs, messages: [...(mirror.docs.messages ?? []), ...add] } } : mirror;
}

// The board's mirror: { docs: { collection: [ {id, ...data} ] }, at, atBy, atDoc } from an ArtifactData export (out_dir),
// or null. at: its newest file; atBy: each collection's, when that collection was listed (an export lists one after
// another); atDoc: { collection: { id: time } }, when each document was listed. A file that doesn't parse (half written)
// is no document and moves none of them (#C347).
// The collections whose deletions are tombstones (collector/delta.mjs MUTABLE; a test ties the two lists, because the gate does not
// import the collector's code).
export const TOMBSTONED = ["initiatives", "waiting", "ideas", "threads", "plan"];
export function readMirror(dir) {
  if (!existsSync(dir)) return null;
  const docs = {}, atBy = {}, atDoc = {};
  let at = 0;
  for (const c of readdirSync(dir)) {
    const cdir = join(dir, c);
    if (!statSync(cdir).isDirectory()) continue;
    docs[c] = [];
    atDoc[c] = {};
    for (const f of readdirSync(cdir)) {
      if (!f.endsWith(".json")) continue;
      const path = join(cdir, f);
      const t = statSync(path).mtimeMs;
      let doc;
      try { doc = { id: f.slice(0, -5), ...JSON.parse(readFileSync(path, "utf8")) }; } catch { continue; /* half written */ }
      // A deleted document of the five edited collections (a tombstone, #C642) is no card, wherever it was left (Checker).
      if (doc.deleted === true && TOMBSTONED.includes(c)) continue;
      docs[c].push(doc);
      atDoc[c][doc.id] = t;
      at = Math.max(at, t);
      atBy[c] = Math.max(atBy[c] ?? 0, t);
    }
  }
  // A mirror built from deltas (#C642) says in _at.json when its last run began: it holds every change up to then, so that
  // is how current it is, however long ago its newest file was written. The files' own times stay for each document.
  let stamp = null;
  try { const s = JSON.parse(readFileSync(join(dir, "_at.json"), "utf8")); if (Number.isFinite(s?.at) && s.at > 0) stamp = s.at; } catch { /* a mirror from a whole export: its files' times */ }
  if (stamp !== null) { at = Math.max(at, stamp); for (const c of Object.keys(docs)) atBy[c] = Math.max(atBy[c] ?? 0, stamp); }
  return { docs, at, atBy, atDoc };
}

// The writes the gate let through, laid over the mirror: it then shows each card as it is now (a card closed after the
// export is closed here too). journal: [{ op, collection, doc_id, data, at }]. Document by document (#C347, the
// Director's card): a write counts unless the mirror holds that same document listed at or after it (atDoc, else its
// collection's listing, else the export's). A document the mirror doesn't hold takes every write to it: the collection's
// newest file says nothing about it (a later file in steps hid Checker's 22:20 end step, and a right ship start was
// refused three times), and the export reads steps only since a time.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
// threads too (#C234: a thread numbered since the export read as unnumbered, and the lead's message into it was refused),
// but only onto a mirror that has threads: a few recent ones alone would make every older thread look unnumbered.
// log too (#C335): the journal is where the lead's digest finds the mechanical messages written since its last prompt.
export const OVERLAY = new Set(["initiatives", "waiting", "ideas", "messages", "derived", "steps", "plan", "threads", "log"]);
export function withJournal(mirror, journal) {
  if (!mirror) return null;
  const docs = Object.fromEntries(Object.entries(mirror.docs).map(([c, list]) => [c, list.map((d) => ({ ...d }))]));
  const held = (c, id) => (mirror.docs[c] ?? []).some((d) => d.id === id);
  for (const w of journal ?? []) {
    if (!OVERLAY.has(w.collection)) continue;
    if (held(w.collection, w.doc_id)) {
      const own = mirror.atDoc?.[w.collection];
      const listed = own && Object.hasOwn(own, w.doc_id) ? own[w.doc_id] : Object.hasOwn(mirror.atBy ?? {}, w.collection) ? mirror.atBy[w.collection] : mirror.at;
      if (!(w.at > listed)) continue;
    }
    if (w.collection === "threads" && !Array.isArray(docs.threads)) continue;
    const list = (docs[w.collection] ||= []);
    const i = list.findIndex((d) => d.id === w.doc_id);
    if (w.op === "delete") { if (i >= 0) list.splice(i, 1); continue; }
    const base = w.op === "update" && i >= 0 ? list[i] : { id: w.doc_id };
    const next = { ...base };
    // A journaled write's keys are the writer's: one named like an object's own machinery is skipped (Security).
    for (const [k, v] of Object.entries(w.data ?? {})) { if (UNSAFE_KEYS.has(k)) continue; if (v && typeof v === "object" && v.__delete__) delete next[k]; else next[k] = v; }
    if (i >= 0) list[i] = next; else list.push(next);
  }
  return { ...mirror, docs };
}

// Rule 9 (case 3): the card ids a hand-off names ("board id x-y", "card x-y", "task x-y"), and whether it hands out work.
// A one-word id ("board id menu") counts after "board id", "board card" or "card id", or in backticks; after a bare "card"
// or "task" it needs a hyphen, so "task for you" names no card "for". "is" or "was" before the id is read past ("its card
// id is x-y"), and a plain word is never an id ("board card for you"): the lead's refused sends, #C276.
const NOT_IDS = new Set(["is", "was", "for", "the", "a", "an", "to", "on", "in", "of", "and", "or", "that", "this", "it", "as", "at", "by", "with", "from", "here", "now", "so", "one", "you", "me", "we", "be", "has", "had", "will", "not", "no"]);
export function handOff(text) {
  const s = String(text);
  const named = [...s.matchAll(/\b(?:board (?:id|card)|card id)(?:[:\s]+(?:is|was))?[:\s]+`?([a-z0-9]+(?:-[a-z0-9]+)*)`?/gi),
    ...s.matchAll(/\b(?:card|task)[:\s]+(?:`([a-z0-9]+(?:-[a-z0-9]+)*)`|([a-z0-9]+(?:-[a-z0-9]+)+))/gi)].map((m) => (m[1] ?? m[2]).toLowerCase());
  const ids = named.filter((id) => !NOT_IDS.has(id));
  // A message that tried to name a card is a hand-off even when it named only plain words: it is refused as naming no
  // card, never let through unchecked (Checker).
  const work = /\btask\b|\bREADY\b|\bbuild\b/i.test(String(text)) || named.length > 0;
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
  // The counter after.mjs raised while this call ran is kept: re-read just before saving, the higher wins (Checker).
  const save = (s) => saveState(statePath, s);
  const t = input?.tool_input ?? {};
  const lines = input?.transcript_path ? readLines(input.transcript_path) : [];
  const { role, error: roleError } = sessionRole(lines, env.FLIGHT_BOARD_ROLE);
  const who = { role, manager: role === config.gate.managerRole };

  // The claude-artifacts server's tools (#C652): a refused call stops here; a page change is publish.mjs's to allow or deny.
  const call = classify(input, config);
  if (call?.kind === "refuse") return { block: `Flight board refused this call: ${call.why}.\n` };
  if (call?.kind === "db" || (input?.tool_name === "ArtifactData" && id && String(t.url ?? "").includes(id) && WRITES.has(t.action))) {
    if (roleError) return { block: `Flight board refused this write: ${roleError}\n` };
    const writes = call ? call.writes : writesOf(t);
    // Rules 3-5 read the mirror the collector keeps; a stale one skips them (fail open) with a note.
    const m = readMirror(join(dir, "mirror"));
    // ...with every write the gate let through since its export laid over it.
    let liveMsgs = [];
    try { const j = JSON.parse(readFileSync(join(dir, "live.json"), "utf8")); if (j && typeof j === "object" && Array.isArray(j[who.role]?.msgs)) liveMsgs = j[who.role].msgs; } catch { /* none */ }
    const seen = m ? withLiveMessages(withJournal(m, state.journal), liveMsgs) : null;
    const mirror = m && now - m.at < config.gate.mirrorMaxAgeMin * 60e3 ? seen : null;
    // The owner's words are looked up however old the mirror is (#C337): an old mirror's owner message is still theirs.
    // The live state's last reading (#C449, collector/state.mjs's state.json beside the mirror): only a fresh one that
    // fits counts; none, an old one or an odd one is no reading, and the typed status stands.
    let live = null;
    try { const s = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")); live = liveFresh(s, now) ? s : null; } catch { /* none */ }
    const out = checkWrites(writes, { config, who, now, state, mirror, seen, live });
    // The journal and the known cards are written by gate/after.mjs once the board applied the write (a write the
    // gate lets through can still be refused, at the app's consent card or by a stale pin: Security).
    save(out.state);
    return out.errors.length ? { block: refusalText(out.errors, out.stuckNow, now) } : {};
  }
  // A READY (#C649): refused until the sender's build end step exists, when the sender started that card; the refusal names
  // the write. A stale or missing mirror, a card the sender never started, or no role: not checked.
  if (SEND_TOOLS.has(input?.tool_name) && isReady(t.message ?? t.text ?? "") && role && !roleError) {
    const m = readMirror(join(dir, "mirror"));
    const text = m ? readyError({ text: t.message ?? t.text ?? "", role, mirror: withJournal(m, state.journal), now, maxAgeMs: config.gate.mirrorMaxAgeMin * 60e3 }) : null;
    if (text) return { block: `${text}\n` };
  }
  // A status-only message from any session but the lead's, to anyone, goes to the board's log instead (#C335): the lead
  // gets a digest line at its next prompt (gate/digest.mjs). The gate never guesses: no class, no refusal.
  if (SEND_TOOLS.has(input?.tool_name) && !who.manager) {
    const kind = mechanicalClass(t.message ?? t.text ?? "", config.traffic?.mechanical);
    return kind ? { block: `${refusal(kind)}\n` } : {};
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
    let input = null;
    try { input = JSON.parse(raw); r = run(input, { config }); } catch (e) {
      // A throw in the gate is never the way past it (Security, #C662): a call on the artifact tools (a board write is one) that
      // the gate could not check is refused, naming the error. Anything else the gate cannot read still passes, as before.
      const t = typeof input?.tool_name === "string" ? input.tool_name : "";
      // By the name the rules know it by (normName): a renamed server's db_write is the board's too (Security, #C662).
      if (input && (t === "ArtifactData" || normName(t).startsWith(PREFIX))) { process.stderr.write(`Flight board refused this call: the gate could not check it (${String(e?.message ?? "error").slice(0, 120)}).\n`); process.exit(2); }
      process.stderr.write(`Flight board gate could not read the call: ${e.message}\n`); process.exit(0);
    }
    if (r.block) { process.stderr.write(r.block); process.exit(2); }
    if (r.note) process.stderr.write(`Flight board gate: ${r.note}\n`);
    process.exit(0);
  });
}
