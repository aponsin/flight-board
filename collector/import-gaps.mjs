// What the switch import lost (#C901, from Designer's #C884 pairs): four gaps, closed by one additive delta. DRY RUN FIRST: it reads the
// old board's export and the store's own view and writes nothing itself; --sql gives the file the owner would run, signed, and --put the
// object-store commands for the pictures.
//   node collector/import-gaps.mjs --export <dir with waiting/ threads/ messages/> --store <a read of the store's view as JSON>
//        [--blobs <dir of the old board's picture files, one per file id>] [--bucket <r2 bucket>] [--sql <out>] [--put <out>] [--report <out>] [--now N]
// The four gaps, and the rule each is held to (nothing the store has written since the switch is ever overwritten):
//  1 pictures. An ask's screenshots are file ids; the store holds no bytes for the old ones (/_blob answers 404), and #T1701's were saved as
//    "[object Object]". The list is repaired only where it is missing, empty or still holds that text; the bytes come from --blobs (fetched
//    from the old board by someone signed in), are checked by the store's own file rules (type from the first bytes, the sniff, the size),
//    and become a `files` row under the OLD id (INSERT OR IGNORE) plus an object-store put; a picture with no bytes given is listed, never invented;
//  2 the owner's note on an answered Decision. Set only on the ask the import answered (answered_at equals the old response's time), only while
//    the store has no note and no status, and only when the store's answer is the very option the old response chose;
//  3 messages posted on the old board that the store lacks, on a thread the store holds (an ask, a card, a thread or one with messages),
//    INSERT OR IGNORE by old id. A message is flagged resolved only when the old one was and the store's ask is closed;
//  4 a thread's old title, as the owner's rename row (num NULL, like a rename), only while the store's thread has no title.
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readMirror, shotsOf } from "./import-mirror.mjs";
import { ID as FILE_ID, MAX_FILE_BYTES, sniffRefusal, cleanName, parseShot } from "../worker/file-store.mjs";
import { ANSWER_NOTE_MAX } from "../worker/board-rules.mjs";
import { MAX_TEXT } from "../worker/compat-threads.mjs";

const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const MSG_ID = /^[A-Za-z0-9-]{1,64}$/;
const THREAD_ID = /^[A-Za-z0-9-]{1,64}$/;
const KIND = /^[a-z][a-z-]{0,19}$/;
const TITLE_MAX = 120;
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const str = (v) => (typeof v === "string" && v.trim() ? v : null);
const live = (coll) => Object.entries(coll ?? {}).filter(([, d]) => d && d.deleted !== true);

const q = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new Error("sql: a number that is not finite"); return String(v); }
  const s = String(v);
  if (CTRL.test(s)) throw new Error("sql: a control character other than tab and newline in a value");
  return `'${s.replaceAll("'", "''")}'`;
};

// The picture's type from its first bytes (the store's list of image types); anything else is not a picture here.
export function imageTypeOf(b) {
  const at = (sig, off = 0) => b.length >= off + sig.length && sig.every((x, i) => b[off + i] === x);
  if (at([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (at([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (at([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || at([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif";
  if (at([0x52, 0x49, 0x46, 0x46]) && at([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

// docs: the old board's { waiting, threads, messages } (readMirror). view: the store's view ({ asks, cards, threads: { threads, messages }, files: { images } }).
// blobs: { <file id>: Uint8Array } the old pictures' bytes. now: the time the file rows are stamped with.
export function planGaps(docs, view, { blobs = {}, now = Date.now() } = {}) {
  const asks = new Map((view.asks ?? []).map((a) => [a.id, a]));
  const storeMsgs = view.threads?.messages ?? [], storeThreads = view.threads?.threads ?? [];
  const messageIds = new Set(storeMsgs.map((m) => m.id));
  const threadRows = new Map(storeThreads.map((t) => [t.id, t]));
  const holds = new Set([...asks.keys(), ...(view.cards ?? []).map((c) => c.id), ...threadRows.keys(), ...storeMsgs.map((m) => m.thread_id)]);
  const knownFiles = new Set((view.files?.images ?? []).map((f) => f.id));
  const out = {
    notes: [], shots: [], files: [], puts: [], messages: [], titles: [],
    missingBlobs: [], refused: [],
    held: { notes: 0, shots: 0, messages: 0, titles: 0 },
  };
  const refuse = (gap, id, rule, detail) => out.refused.push({ gap, id, rule, ...(detail ? { detail } : {}) });

  // Gap 2: the owner's note on an answered Decision.
  for (const [aid, d] of live(docs.waiting)) {
    const s = asks.get(aid), resp = d.response;
    const note = typeof resp?.note === "string" ? resp.note.trim() : "";
    if (!s || !note) continue;
    const at = int(resp.at) ?? int(d.respondedAt);
    if (resp.status !== undefined && resp.status !== "chose") continue; // a note on an ack or a done is already the answer's text
    if (s.answered_at !== at || at === null) { refuse("note", aid, "answer-differs", "the store's answer is not the old board's (time)"); continue; }
    if (s.answer_note !== null && s.answer_note !== undefined || s.answer_status !== null && s.answer_status !== undefined) { out.held.notes++; continue; }
    const opt = Array.isArray(d.options) ? d.options.find((o) => o && typeof o === "object" && o.key === resp.choice) : null;
    if (!opt || typeof opt.label !== "string" || opt.label !== s.answer) { refuse("note", aid, "answer-differs", "the store's answer is not the option the old board chose"); continue; }
    if (note.length > ANSWER_NOTE_MAX) { refuse("note", aid, "answer-shape", `a note is up to ${ANSWER_NOTE_MAX} characters`); continue; }
    if (CTRL.test(note)) { refuse("note", aid, "control-char"); continue; }
    out.notes.push({ id: aid, answered_at: at, note });
  }

  // Gap 1: the screenshot lists and the picture files.
  const wanted = new Map(); // file id -> a name for it
  const wantFile = (shot) => { const p = parseShot(shot); if (p && FILE_ID.test(p.id) && !wanted.has(p.id)) wanted.set(p.id, p.label || p.id); };
  for (const [aid, d] of live(docs.waiting)) {
    const s = asks.get(aid);
    if (!s) continue;
    let body; try { body = JSON.parse(s.body); } catch { continue; }
    const cur = body?.screenshots;
    const bad = !Array.isArray(cur) || !cur.length || cur.some((x) => typeof x !== "string" || x.includes("[object"));
    if (!bad) { out.held.shots++; for (const x of cur) wantFile(x); continue; }
    const list = shotsOf(d.images);
    if (!list.length) continue;
    out.shots.push({ id: aid, screenshots: list });
    for (const x of list) wantFile(x);
  }
  for (const [id, label] of wanted) {
    if (knownFiles.has(id)) continue;
    const bytes = blobs[id];
    if (!bytes) { out.missingBlobs.push({ id, label }); continue; }
    const type = imageTypeOf(bytes);
    if (!type) { refuse("file", id, "file-type", "the bytes are not a PNG, JPEG, GIF or WebP picture"); continue; }
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) { refuse("file", id, "file-size", `${bytes.length} bytes`); continue; }
    const bad = sniffRefusal(type, bytes);
    if (bad) { refuse("file", id, bad.rule, bad.detail); continue; }
    out.files.push({ id, name: cleanName(label), type, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), added_by: "import", added_at: now });
    out.puts.push({ id, type, size: bytes.length });
  }

  // Gap 3: messages the store lacks, on a thread it holds.
  for (const [id, m] of live(docs.messages)) {
    const tid = typeof m.thread === "string" ? m.thread : "";
    if (!holds.has(tid)) continue;
    if (messageIds.has(id)) { out.held.messages++; continue; }
    if (!MSG_ID.test(id)) { refuse("message", id, "message-id"); continue; }
    if (!str(m.from) || typeof m.text !== "string" || !m.text.trim()) { refuse("message", id, "message-shape"); continue; }
    if (CTRL.test(m.text) || m.text.length > MAX_TEXT) { refuse("message", id, CTRL.test(m.text) ? "control-char" : "too-long"); continue; }
    if (CTRL.test(m.from) || m.from.length > 64) { refuse("message", id, "message-shape", "author"); continue; }
    if (int(m.at) === null || m.at === 0) { refuse("message", id, "message-time"); continue; }
    const kind = typeof m.kind === "string" && KIND.test(m.kind) ? m.kind : null;
    const resolved = m.resolved === true && !!asks.get(tid)?.closed_at ? 1 : 0;
    const row = { id, thread_id: tid, author: m.from, body: m.text, created_at: m.at, kind, resolved, delivered_at: m.at };
    out.messages.push(row);
  }
  out.messages.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));

  // Gap 4: a thread's old title.
  for (const [tid, t] of live(docs.threads)) {
    const title = str(t.title)?.trim();
    if (!title || !holds.has(tid)) continue;
    if (!THREAD_ID.test(tid)) { refuse("title", tid, "thread-id"); continue; }
    if (Array.from(title).length > TITLE_MAX || CTRL.test(title)) { refuse("title", tid, "thread-title", `a title is 1 to ${TITLE_MAX} characters`); continue; }
    if (str(threadRows.get(tid)?.title)) { out.held.titles++; continue; }
    const firstMsg = [...live(docs.messages)].filter(([, m]) => m.thread === tid).map(([, m]) => int(m.at)).filter((x) => x).sort((a, b) => a - b)[0];
    out.titles.push({ id: tid, title, created_at: int(t.createdAt) ?? firstMsg ?? int(t.updatedAt) ?? now });
  }
  out.shots.sort((a, b) => a.id.localeCompare(b.id)); out.notes.sort((a, b) => a.id.localeCompare(b.id)); out.titles.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

// The SQL, one statement a line. Every line is by its own key and guarded, so a second run, or a row the store wrote since, changes nothing.
export function gapsSql(p) {
  const insert = (t, row) => `INSERT OR IGNORE INTO ${t} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(q).join(", ")});`;
  return [
    ...p.files.map((f) => insert("files", f)),
    ...p.shots.map((s) => `UPDATE asks SET body = json_patch(body, ${q(JSON.stringify({ screenshots: s.screenshots }))}) WHERE id = ${q(s.id)} AND (json_extract(body, '$.screenshots') IS NULL OR json_extract(body, '$.screenshots') = '[]' OR json_extract(body, '$.screenshots') LIKE '%[object%');`),
    ...p.notes.map((n) => `UPDATE asks SET answer_status = 'chose', answer_note = ${q(n.note)} WHERE id = ${q(n.id)} AND answered_at = ${q(n.answered_at)} AND answer_note IS NULL AND answer_status IS NULL;`),
    ...p.messages.map((m) => insert("messages", { id: m.id, thread_id: m.thread_id, author: m.author, body: m.body, created_at: m.created_at, kind: m.kind, resolved: m.resolved, delivered_at: m.delivered_at })),
    ...p.titles.map((t) => `INSERT INTO threads (id, num, title, created_at) VALUES (${q(t.id)}, NULL, ${q(t.title)}, ${q(t.created_at)}) ON CONFLICT (id) DO UPDATE SET title = excluded.title WHERE threads.title IS NULL;`),
  ].join("\n");
}

// The object-store commands for the pictures with bytes (wrangler's own: run by the owner, signed, with the SQL). `dir` is where the bytes are.
export function putCommands(p, { bucket, dir, ext = {} }) {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(bucket ?? "")) throw new Error("--bucket: the object-store bucket's name (lower case letters, digits and -)");
  return p.puts.map((f) => `npx wrangler r2 object put ${bucket}/${f.id} --file ${shellQuote(join(dir, ext[f.id] ?? f.id))} --content-type ${f.type} --remote`).join("\n");
}
const shellQuote = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

export function report(p) {
  return {
    notes: p.notes.map((n) => n.id), shots: p.shots.map((s) => ({ id: s.id, pictures: s.screenshots.length })),
    files: p.files.map((f) => ({ id: f.id, type: f.type, size: f.size })), missingBlobs: p.missingBlobs,
    messages: p.messages.map((m) => ({ id: m.id, thread: m.thread_id })), titles: p.titles.map((t) => ({ id: t.id, title: t.title })),
    held: p.held, refused: p.refused,
  };
}

// The old board's pictures from a folder: one file per file id, named <id> or <id>.<ext>; returns the bytes and each file's real name.
export function readBlobs(dir) {
  const blobs = {}, ext = {};
  for (const f of readdirSync(dir)) {
    const id = basename(f, extname(f));
    if (!FILE_ID.test(id) || blobs[id]) continue;
    blobs[id] = new Uint8Array(readFileSync(join(dir, f))); ext[id] = f;
  }
  return { blobs, ext };
}

const same = (a, b) => { try { return resolve(a) === resolve(b); } catch { return false; } };
if (process.argv[1] && same(fileURLToPath(import.meta.url), process.argv[1])) {
  const get = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
  if (!get("--export") || !get("--store")) { console.error("pass --export <dir> and --store <view.json>"); process.exit(64); }
  const docs = readMirror(get("--export"));
  const view = JSON.parse(readFileSync(get("--store"), "utf8"));
  const bl = get("--blobs") && existsSync(get("--blobs")) ? readBlobs(get("--blobs")) : { blobs: {}, ext: {} };
  const p = planGaps(docs, view, { blobs: bl.blobs, now: Number(get("--now") ?? Date.now()) });
  const whole = JSON.stringify(report(p), null, 2);
  if (get("--report")) { writeFileSync(get("--report"), whole + "\n"); console.log(`report written to ${get("--report")}: ${p.notes.length} notes, ${p.shots.length} picture lists, ${p.files.length} pictures with bytes, ${p.missingBlobs.length} without, ${p.messages.length} messages, ${p.titles.length} titles, ${p.refused.length} refused`); } else console.log(whole);
  if (get("--sql")) writeFileSync(get("--sql"), gapsSql(p) + "\n");
  if (get("--put")) writeFileSync(get("--put"), putCommands(p, { bucket: get("--bucket"), dir: get("--blobs"), ext: bl.ext }) + "\n");
}
