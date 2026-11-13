// The file store (#C726 C1, board parity): the old page's attachments and an ask's screenshots, behind the Worker.
// Bytes in R2 (env.FILES, key = id), the list in D1 (migration 0010: files, file_links). A file is written once and never
// changed; its id is random (24 bytes, base64url), so a URL cannot be guessed and can be cached for good.
//
// Who writes: the owner through POST /api/files (the page's assets.upload), an agent through the file_put tool, and (#C1056) a local script with the probe's
// token through POST /api/probe/file (scripts/put-file.mjs: a file on the Mac that no model has to carry as base64). Who reads:
// anyone past the Worker's Access check, at GET /_blob/<id>, served with the type it was stored as, never sniffed, and in a
// sandbox (a stored file can never run as a page of this Worker).
//
// The page's Attach, paste and drop stay off until the answer and message hooks are in: the shim's FILES_ON (compat-shim.mjs)
// is false until then, so no upload is made that a refused answer would leave unlinked.
//
// Hooks for the store and the compatibility view (Boardsmith adds them, one line each):
//   board-store readView      files: await readFiles(db, asks)                 (and in the tag's content)
//   compat-view compatView    applyFiles(collections, view)                    (after waiting and messages are built)
//   compat-write answer       filesRefusal(db, r.files) before answerAsk; linkFiles(db, now, "answer", id, ids) after it
//   compat-write message      the same with "message" and the message's id, for data.assets
//   board-store createAsk     screenshotsRefusal(db, ask.screenshots) next to askRefusal
//   compat-shim               FILES_ON = true, in the same change as the two compat-write hooks
// Everything below that reads only its arguments is pure and tested in Node.

export const FILE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "text/markdown", "text/csv", "application/json"];
export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 2 * 1024 ** 3; // the store's whole size; past it a new upload is refused ("quota")
export const MAX_FILES_PER_SEND = 10;
// Uploads in 24 hours, the owner's and all agents' together (#C727): a looping agent or a leaked connector secret cannot fill the store.
export const MAX_DAY_BYTES_PER_CALLER = 200 * 1024 * 1024;
// A request body bigger than one file in base64 plus its JSON is refused before it is read (the Worker has 128 MB).
export const MAX_BODY_BYTES = Math.ceil(MAX_FILE_BYTES / 3) * 4 + 64 * 1024;
export const ID = /^[A-Za-z0-9_-]{16,64}$/;
const IMAGE = /^image\//;

const refusal = (rule, detail) => ({ rule, detail: String(detail ?? "").slice(0, 200) });
const startsWith = (b, sig, at = 0) => b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

// The first bytes must say what the type says: a file named .png that is really HTML is refused, not stored.
export function sniffRefusal(type, b) {
  const ok = {
    "image/png": () => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    "image/jpeg": () => startsWith(b, [0xff, 0xd8, 0xff]),
    "image/gif": () => startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a")),
    "image/webp": () => startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8),
    "application/pdf": () => startsWith(b, ascii("%PDF-")),
  }[type];
  if (ok) return ok() ? null : refusal("file-content", `the bytes are not ${type}`);
  // Text kinds: valid UTF-8 with no NUL byte. They are served as text with nosniff and a sandbox, so markup in them stays text.
  if (b.includes(0)) return refusal("file-content", `a ${type} file has a NUL byte`);
  try { new TextDecoder("utf-8", { fatal: true }).decode(b); } catch { return refusal("file-content", `a ${type} file is not UTF-8 text`); }
  return null;
}

// A file's name as stored: no control characters, no bidi controls (a name can't read reversed: Checker's LOW on #C726), no path,
// at most 200 characters.
// Cut by code point and with lone surrogates dropped, so the name is always well-formed text (encodeURIComponent never throws on it).
export function cleanName(name) {
  const s = String(name ?? "").replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "").replace(/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, "").split(/[\\/]/).pop().trim();
  return Array.from(s).slice(0, 200).join("").trim() || "file";
}

export function decodeBase64(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) return null;
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function newFileId() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_");
}

const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");

// Store one file. `data` is base64 text (the page and the tool both send JSON). Refusals are logged through `refuse`
// (the store's own, passed in so this module does not import the store) and returned; nothing is half-stored.
export async function putFile({ db, bucket, now, who, refuse }, { name, type, data } = {}) {
  const no = (r) => refuse(db, now, r, null, who);
  if (!bucket) return no(refusal("file-store-off", "this Worker has no file store bound"));
  if (!FILE_TYPES.includes(type)) return no(refusal("file-type", String(type).slice(0, 60)));
  // A base64 text more than a third over the limit is refused before it is decoded.
  if (typeof data !== "string" || data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4) return no(refusal("file-too-large", `over ${MAX_FILE_BYTES} bytes`));
  const bytes = decodeBase64(data);
  if (!bytes) return no(refusal("file-shape", "data is base64"));
  if (!bytes.length) return no(refusal("file-empty", cleanName(name)));
  if (bytes.length > MAX_FILE_BYTES) return no(refusal("file-too-large", `${bytes.length} bytes`));
  const bad = sniffRefusal(type, bytes);
  if (bad) return no(bad);
  const total = (await db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM files").first()).n;
  if (total + bytes.length > MAX_TOTAL_BYTES) return no(refusal("file-quota", "the board's file store is full"));
  // Two daily caps (Security's LOW on #C726): the owner's own, and one for all the agents together, so a leaked connector secret
  // can't multiply the cap by naming each role in turn.
  const owner = who === "owner";
  const mine = (await db.prepare(`SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE added_by ${owner ? "=" : "<>"} 'owner' AND added_at > ?`).bind(now - 864e5).first()).n;
  if (mine + bytes.length > MAX_DAY_BYTES_PER_CALLER) return no(refusal("file-quota-daily", `${owner ? "the owner" : "the agents together"} stored ${mine} bytes in the last 24 hours`));
  const id = newFileId(), file = cleanName(name);
  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  await bucket.put(id, bytes, { httpMetadata: { contentType: type } });
  try {
    await db.prepare("INSERT INTO files (id, name, type, size, sha256, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, file, type, bytes.length, sha256, String(who), now).run();
  } catch (e) {
    await bucket.delete(id).catch(() => {});
    throw e;
  }
  return { ok: true, id, name: file, contentType: type, sizeBytes: bytes.length };
}

// GET /_blob/<id>: the stored bytes with their stored type. Images show inline; any other kind is a download. The sandbox and
// default-src 'none' mean a file opened on its own can run nothing and load nothing.
export async function fileResponse(db, bucket, id) {
  const none = () => new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  if (!ID.test(id ?? "") || !bucket) return none();
  const meta = await db.prepare("SELECT id, name, type, size FROM files WHERE id = ?").bind(id).first();
  if (!meta) return none();
  const obj = await bucket.get(id);
  if (!obj) return none();
  const ascii = meta.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const disposition = `${IMAGE.test(meta.type) ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(meta.name)}`;
  return new Response(obj.body, {
    status: 200,
    headers: {
      "content-type": meta.type.startsWith("text/") ? `${meta.type}; charset=utf-8` : meta.type,
      "content-length": String(meta.size),
      "content-disposition": disposition,
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
      "referrer-policy": "no-referrer",
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}

// The old page's file list on an answer or a message: [{id, name, type, size}], at most ten, every id a stored file.
// Returns { ids } or { refused }. Only the ids are kept: name, type and size are the store's, never the page's.
export async function filesRefusal(db, files) {
  if (files === undefined) return { ids: [] };
  if (!Array.isArray(files) || files.length > MAX_FILES_PER_SEND) return { refused: refusal("files-shape", `a list of at most ${MAX_FILES_PER_SEND}`) };
  const ids = files.map((f) => (f && typeof f === "object" ? f.id : f));
  if (!ids.every((id) => typeof id === "string" && ID.test(id)) || new Set(ids).size !== ids.length) return { refused: refusal("files-shape", "each file is a stored file's id, once") };
  for (const id of ids) if (!(await db.prepare("SELECT 1 AS x FROM files WHERE id = ?").bind(id).first())) return { refused: refusal("file-unknown", id) };
  return { ids };
}

export async function linkFiles(db, now, kind, refId, ids) {
  if (!ids?.length) return;
  await db.batch(ids.map((id, pos) => db.prepare("INSERT OR IGNORE INTO file_links (file_id, ref_kind, ref_id, pos, at) VALUES (?, ?, ?, ?, ?)").bind(id, kind, refId, pos, now)));
}

// An ask's screenshots: each a stored image's id, then optionally the option it shows and a label:
//   "<id>", "<id> label", "<id> A: label"   (A to D: the Decision option the picture sits beside)
export function parseShot(s) {
  const m = /^\s*([A-Za-z0-9_-]{16,64})(?:\s+(?:([A-D]):\s*)?(.*))?$/s.exec(String(s ?? ""));
  return m ? { id: m[1], option: m[2] ?? "", label: (m[3] ?? "").trim().slice(0, 200) } : null;
}
export async function screenshotsRefusal(db, list) {
  if (list === undefined) return null;
  if (!Array.isArray(list) || list.length > 8) return refusal("screenshots-shape", "a list of at most 8");
  for (const s of list) {
    const p = parseShot(s);
    if (!p) return refusal("screenshots-shape", `"<file id>", "<file id> label" or "<file id> A: label", not ${String(s).slice(0, 40)}`);
    const f = await db.prepare("SELECT type FROM files WHERE id = ?").bind(p.id).first();
    if (!f) return refusal("file-unknown", p.id);
    if (!IMAGE.test(f.type)) return refusal("screenshots-shape", `${p.id} is ${f.type}, not an image`);
  }
  return null;
}

// What the view needs: every link with its file, and the stored images the asks' screenshots name.
export async function readFiles(db, asks = [], messages = []) {
  const links = (await db.prepare("SELECT l.ref_kind, l.ref_id, l.pos, f.id, f.name, f.type, f.size FROM file_links l JOIN files f ON f.id = l.file_id ORDER BY l.ref_kind, l.ref_id, l.pos").all()).results;
  const want = new Set();
  for (const a of asks) { let b; try { b = JSON.parse(a.body); } catch { continue; } for (const s of Array.isArray(b?.screenshots) ? b.screenshots : []) { const p = parseShot(s); if (p) want.add(p.id); } }
  // #C936: the pictures an agent's message carries (messages.screenshots, a JSON list) are read the same way.
  for (const m of messages) { let l; try { l = JSON.parse(m.screenshots); } catch { continue; } for (const s of Array.isArray(l) ? l : []) { const p = parseShot(s); if (p) want.add(p.id); } }
  const images = [];
  const ids = [...want];
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    images.push(...(await db.prepare(`SELECT id, name, type, size FROM files WHERE type LIKE 'image/%' AND id IN (${part.map(() => "?").join(", ")})`).bind(...part).all()).results);
  }
  return { links, images };
}

// Pure: the old page's fields from the view's files. waiting[].response.files, waiting[].images, messages[].assets.
export function applyFiles(collections, view) {
  const files = view?.files;
  if (!files) return collections;
  const byRef = {};
  for (const l of files.links ?? []) (byRef[`${l.ref_kind}:${l.ref_id}`] ??= []).push({ id: l.id, name: l.name, type: l.type, size: l.size });
  const images = new Set((files.images ?? []).map((f) => f.id));
  const asks = Object.fromEntries((view.asks ?? []).map((a) => [a.id, a]));
  for (const w of collections.waiting ?? []) {
    const sent = byRef[`answer:${w.id}`];
    if (sent && w.response) w.response.files = sent;
    let body;
    try { body = JSON.parse(asks[w.id]?.body ?? "{}"); } catch { body = {}; }
    const shots = (Array.isArray(body.screenshots) ? body.screenshots : []).map(parseShot).filter((p) => p && images.has(p.id));
    if (shots.length) w.images = shots.map((p) => ({ url: `/_blob/${p.id}`, label: p.label, ...(p.option ? { option: p.option } : {}) }));
  }
  for (const m of collections.messages ?? []) {
    const sent = byRef[`message:${m.id}`]; if (sent) m.assets = sent;
    // #C936: an agent's message with screenshots: the same images list an ask has ({ url, label, option? }), only stored images.
    if (m.screenshots !== undefined) {
      const shots = (Array.isArray(m.screenshots) ? m.screenshots : []).map(parseShot).filter((p) => p && images.has(p.id));
      if (shots.length) m.images = shots.map((p) => ({ url: `/_blob/${p.id}`, label: p.label, ...(p.option ? { option: p.option } : {}) }));
      delete m.screenshots;
    }
  }
  return collections;
}
