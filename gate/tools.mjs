// The board's tools by name (#C652). The app replaced ArtifactData and Artifact with the claude-artifacts server's tools
// (mcp__claude-artifacts__db_write, db_str_replace, db_query, publish_files, ...), and every hook that named the old ones went
// blind: a db_write on the board skipped the write gate, a publish skipped the signed-page check. This one module knows both
// vocabularies; the gate, the PostToolUse journal, the Stop gate and the live check read the tools through it.
//
// A call is about the board when its slug is the board's: the id in artifactUrl, or the artifact's UUID in config.artifactSlug
// (the new tools take the UUID, or a whole link). What a call on the board is:
//   - db_write / db_str_replace: board writes, mapped onto the old { op, collection, doc_id, data, if_version } the rules read;
//   - publish_version / publish_files / edit_version / copy_file: a page change (gate/publish.mjs allows a byte-verified signed
//     page and denies the rest);
//   - a read or a comment tool (OPEN): nothing to check;
//   - anything else under the prefix, an unknown name too: refused. A new tool that writes is shut until someone reads it.
export const PREFIX = "mcp__claude-artifacts__";
export const DB_WRITE = `${PREFIX}db_write`, DB_STR_REPLACE = `${PREFIX}db_str_replace`, DB_QUERY = `${PREFIX}db_query`;
export const PAGE_TOOLS = new Set(["publish_version", "publish_files", "edit_version", "copy_file"].map((n) => PREFIX + n));
// Reads, and the comment and pin tools, which change nothing the gate protects.
export const OPEN_TOOLS = new Set(["get_artifact", "read_artifact", "list_artifacts", "list_files", "read_file", "list_assets", "read_asset", "describe_capabilities", "describe_type", "list_types", "read_declaration", "read_comments", "db_get", "db_list", "db_query", "db_profiles", "db_rules_get", "db_usage", "db_whoami", "guide", "watch", "unwatch", "reply_comment", "reply_shared_comment", "resolve_comment", "pin_artifact", "unpin_artifact"].map((n) => PREFIX + n));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_IN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export const isUuid =(s) => UUID.test(String(s ?? ""));

// The same server may be registered under another name (Security): a tool whose name ends in one of the write or page tools is
// read as the claude-artifacts one. Anything else keeps its own name.
const SUFFIXED = /^mcp__.+__(db_write|db_str_replace|publish_version|publish_files|edit_version|copy_file|upload_asset)$/;
export const normName = (name) => {
  if (typeof name !== "string" || name.startsWith(PREFIX)) return name;
  const m = SUFFIXED.exec(name);
  return m ? PREFIX + m[1] : name;
};

// Whether a slug (or link) names the board: it CONTAINS the id (case-sensitive) or the UUID (any case), so a trailing slash, a
// query, a fragment or an upper-case UUID is still the board. Fails closed, as the old `.includes(id)` did (Security).
export function isBoardSlug(value, config) {
  if (typeof value !== "string" || !value) return false;
  const id = /artifact\/([A-Za-z0-9-]+)$/.exec(String(config?.artifactUrl ?? ""))?.[1];
  const uuid = String(config?.artifactSlug ?? "").toLowerCase();
  if (id && value.includes(id)) return true;
  if (!uuid || !isUuid(uuid)) {
    // No UUID in the config (Security): a slug that is any UUID could be the board, so it is treated as the board's, and the
    // gate refuses or checks it. Only a board with a link and no UUID is in this state; the pack writes artifactSlug.
    return !!id && UUID_IN.test(value);
  }
  return value.toLowerCase().includes(uuid);
}

// The artifact a tool call is aimed at: its slug, and for a copy its source too.
const aimedAt = (t) => [t?.slug, t?.url, t?.from_url].filter((v) => typeof v === "string" && v);
export const aimsAtBoard = (t, config) => aimedAt(t).some((v) => isBoardSlug(v, config));

// merge is not here: db_write's merge CREATES a missing document, and the rules check a new document only on "set" (Security).
// Agents use set (create) or update (must exist). Exactly collection/id: a deeper path names a collection no rule knows.
const OPS = { set: "set", update: "update", delete: "delete" };
// db_write's ops as the old write list, or null when any op is not one the gate can read (the call is then refused).
export function dbWriteOps(t) {
  if (!Array.isArray(t?.ops) || !t.ops.length) return null;
  const out = [];
  for (const o of t.ops) {
    const op = o && typeof o === "object" ? OPS[o.op] : undefined;
    const parts = typeof o?.path === "string" ? o.path.split("/") : [];
    if (!op || parts.length !== 2 || parts.some((p) => !p)) return null;
    if (op !== "delete" && (!o.data || typeof o.data !== "object" || Array.isArray(o.data))) return null;
    out.push({ op, collection: parts.slice(0, -1).join("/"), doc_id: parts[parts.length - 1], data: op === "delete" ? null : o.data, if_version: o.ifVersion });
  }
  return out;
}
// db_str_replace: a text edit in place, which the rules refuse whole (the gate never sees the field's new value).
export function dbStrReplaceOps(t) {
  const parts = typeof t?.path === "string" ? t.path.split("/") : [];
  if (parts.length !== 2 || parts.some((p) => !p) || typeof t.field !== "string" || !t.field) return null;
  return [{ op: "str_replace", collection: parts.slice(0, -1).join("/"), doc_id: parts[parts.length - 1], data: { [t.field]: t.new_str }, if_version: t.ifVersion }];
}

// upload_asset (#C654, Manager): agents attach screenshots and files to a thread or a decision as assets of the board, so it is no
// longer shut as an unknown tool. It only ADDS files to the artifact's asset store (the page reads them by url; nothing the
// gate protects is a document there), so it passes when its shape is the plain one: 1 to 10 files, each with a name whose
// extension is a picture or a PDF (what a screenshot or a printed page is) and a path (never the client's own `uri`), and
// nothing else beside slug, files, shared_live and artifact_title. Any other shape is refused with the reason.
export const UPLOAD_ASSET = `${PREFIX}upload_asset`;
const ASSET_EXT = /\.(png|jpe?g|gif|webp|pdf)$/i;
const ASSET_KEYS = new Set(["slug", "files", "shared_live", "artifact_title"]);
export function assetError(t) {
  const why = (m) => ({ kind: "refuse", why: `upload_asset on the board: ${m} (a picture or a PDF, 1 to 10 files, each {name, path}; the board's assets take nothing else)` });
  const extra = Object.keys(t ?? {}).filter((k) => !ASSET_KEYS.has(k));
  if (extra.length) return why(`unexpected ${extra.join(", ")}`);
  if (!Array.isArray(t.files) || t.files.length < 1 || t.files.length > 10) return why("files must be 1 to 10 entries");
  for (const f of t.files) {
    if (!f || typeof f !== "object" || Array.isArray(f)) return why("a file entry is not {name, path}");
    const bad = Object.keys(f).filter((k) => k !== "name" && k !== "path");
    if (bad.length) return why(`a file entry has ${bad.join(", ")}`);
    if (typeof f.name !== "string" || !ASSET_EXT.test(f.name)) return why("a file name is not a picture or a PDF");
    if (typeof f.path !== "string" || !f.path.startsWith("/")) return why("a file path is not an absolute path");
    // Security R1 (#C654): the client uploads the PATH, so the picture-or-PDF test is on it too, and a path into a hidden
    // folder or file (.env*, ~/.ssh, ~/.claude, .git, ~/.flight-board) or under a Library folder is refused whatever its name:
    // an extension alone is no wall (cp .env.local x.png), so the location is the part that holds.
    if (!ASSET_EXT.test(f.path)) return why("a file path is not a picture or a PDF");
    const parts = f.path.split("/");
    if (parts.some((p) => p === ".." || p === "." )) return why("a file path has a . or .. segment");
    if (parts.some((p) => p.startsWith("."))) return why("a file path goes through a hidden file or folder");
    if (parts.some((p) => p === "Library")) return why("a file path is under a Library folder");
  }
  return null;
}

// What a call on the board is: null (not about the board, or nothing to check), { kind: "db", writes }, { kind: "page" },
// or { kind: "refuse", why }. The old ArtifactData is left to the callers that already read it.
export function classify(input, config) {
  const name = normName(input?.tool_name);
  if (typeof name !== "string" || !name.startsWith(PREFIX)) return null;
  const t = input.tool_input ?? {};
  if (!aimsAtBoard(t, config)) return null;
  if (name === DB_WRITE || name === DB_STR_REPLACE) {
    const writes = name === DB_WRITE ? dbWriteOps(t) : dbStrReplaceOps(t);
    return writes ? { kind: "db", writes } : { kind: "refuse", why: `${name.slice(PREFIX.length)} on the board, in a shape the gate cannot read (ops as {op: set|update|delete, path: "collection/id", data}; merge is refused because it creates a missing document unchecked: use set to create, update to change; or a path and a field)` };
  }
  if (PAGE_TOOLS.has(name)) return { kind: "page" };
  if (name === UPLOAD_ASSET) return assetError(t);
  if (OPEN_TOOLS.has(name)) return null;
  return { kind: "refuse", why: `${name.slice(PREFIX.length)} on the board: the gate does not know this tool, so it is shut until someone reads it` };
}

// The board writes in one call of the new tools: [] when it is not one (or not readable). For the PostToolUse journal and the Stop
// gate, which read a call after the fact; the old ArtifactData stays with the code that already reads it.
export function dbWritesOf(name, t, config) {
  const c = classify({ tool_name: name, tool_input: t }, config);
  return c?.kind === "db" ? c.writes : [];
}
