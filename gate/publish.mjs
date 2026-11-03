// Page-only board releases publish without the owner's word (#C409, the owner's B in #T1051; Security: an allow rule
// can't be narrowed to one board, so it is this hook instead). A PreToolUse hook on Artifact that says "allow" for one
// call only and is silent on every other (the app's own consent applies as before):
//   - the session is the lead (its title, as the gate reads it; FLIGHT_BOARD_ROLE must agree);
//   - a publish (action "publish" or none) to exactly this board's artifactUrl, with no field but action, url, file_path;
//   - the file, after realpath, is a regular file in the config's own folder named board-<commit>.html or
//     board-v<NNN>.html, at most MAX_PAGE bytes;
//   - its sha256 is that of the page this pinned build-page.mjs builds from the template of the current link (the signed
//     commit board releases move it to, scripts/current.mjs) with today's config (the --config file, as it is).
// Anything it can't read or check is silence, never an allow. For the old Artifact tool it never refuses (the app's consent
// applies); for the claude-artifacts server's page tools on this board it denies what it cannot verify (#C652, below).
// The allow publishes a copy of the bytes it checked, never the file itself (updatedInput: #C415, the race between the
// check and the publish), and its reason names their sha256, which the lead checks the board's read-back against
// (scripts/publish-check.mjs).
import { realpathSync, readFileSync, openSync, fstatSync, readSync, closeSync, constants, readdirSync, lstatSync, rmSync, mkdtempSync, chmodSync, writeFileSync } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildPage } from "../scripts/build-page.mjs";
import { fullConfig } from "../scripts/config.mjs";
import { currentLink } from "../collector/fence.mjs";
import { readLines, sessionRole } from "./session.mjs";
import { PREFIX, classify, isBoardSlug, normName } from "./tools.mjs";

export const PAGE_NAME = /^board-(?:[0-9a-f]{7,40}|v\d{1,4})\.html$/;
export const MAX_PAGE = 8 * 1024 * 1024;
const KEYS = new Set(["action", "url", "file_path"]);
const PUBLISH_FILES = `${PREFIX}publish_files`;
const FILES_KEYS = new Set(["slug", "base_version", "files", "label", "shared_live", "artifact_title"]);
const sha = (b) => createHash("sha256").update(b).digest("hex");

// A regular file's bytes, at most max, or null (opened non-blocking: a FIFO or device never holds the hook).
function readCapped(path, max) {
  let fd = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(max + 1);
    let n = 0, got;
    while ((got = readSync(fd, buf, n, buf.length - n, null)) > 0) { n += got; if (n > max) return null; }
    return buf.subarray(0, n);
  } catch { return null; } finally { if (fd !== null) try { closeSync(fd); } catch { /* closed */ } }
}

// input: the hook's call. rawConfig: the --config file as JSON; configDir: its folder, after realpath; current: the
// current link's target folder (a signed pinned copy) or null; lines: the session's transcript. Returns the reason to
// allow, or null for silence.
export function publishAllowed(input, ctx) { return publishVerdict(input, ctx)?.reason ?? null; }

// The same, with what the allow needs: { reason, bytes (the verified page), name, input (the call's own fields) }.
export function publishVerdict(input, { rawConfig, managerRole, configDir, current, lines, envRole = "" }) {
  const files = normName(input?.tool_name) === PUBLISH_FILES; // the claude-artifacts server's publish (#C652)
  if (input?.tool_name !== "Artifact" && !files) return null;
  const t = input.tool_input;
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  let path;
  const { role, error } = sessionRole(lines, envRole);
  if (files) {
    // Exactly one file, the page, at index.html; the call may carry a slug, the version it replaces and a label, and nothing
    // else (no remove, mode, icon, title, contract: those change more than the page). Any session of a roster role may send a
    // page the signed board code builds: the bytes are checked below, so who sends them does not matter.
    if (Object.keys(t).some((k) => !FILES_KEYS.has(k)) || !isBoardSlug(t.slug, rawConfig)) return null;
    const f = Array.isArray(t.files) && t.files.length === 1 ? t.files[0] : null;
    if (!f || typeof f !== "object" || Object.keys(f).some((k) => k !== "as" && k !== "path") || f.as !== "index.html") return null;
    if (error || !role) return null;
    path = f.path;
  } else {
    if (Object.keys(t).some((k) => !KEYS.has(k))) return null;
    if (t.action !== undefined && t.action !== "publish") return null;
    const board = rawConfig?.artifactUrl;
    if (typeof board !== "string" || !board || t.url !== board) return null;
    if (error || !role || role !== managerRole) return null;
    path = t.file_path;
  }
  if (typeof path !== "string" || !path || !current || (!files && !configDir)) return null;
  let real;
  try { real = realpathSync(path); } catch { return null; }
  // The old tool's page must be a board page in the config's folder. The claude-artifacts server's publish_files is checked by
  // its bytes alone (#C652, Manager: "the page's bytes against the signed build's hash, not the folder it comes from"): the file
  // may sit anywhere the session can read, such as its scratchpad, and only the very page the signed code builds passes.
  if (!files && (dirname(real) !== configDir || !PAGE_NAME.test(basename(real)))) return null;
  const file = readCapped(real, MAX_PAGE);
  if (!file) return null;
  let built;
  try { built = buildPage(readFileSync(join(current, "page", "board.template.html"), "utf8"), rawConfig); } catch { return null; }
  if (sha(file) !== sha(built)) return null;
  // The page's sha256 rides in the reason (#C415): the lead reads the board back and checks it (scripts/publish-check.mjs).
  return { bytes: file, name: files ? "index.html" : basename(real), copyDir: files ? dirname(real) : configDir, input: t, withPath: (p) => (files ? { ...t, files: [{ ...t.files[0], path: p }] } : { ...t, file_path: p }), reason: `Flight board: ${basename(real)} is the page the signed board code builds (${basename(current).slice(0, 12)}) for this board: published by ${role} without asking (#C409). sha256 ${sha(file)}: after the publish, read the board back and run scripts/publish-check.mjs on it with this hash.` };
}

// A page change on the board through the claude-artifacts server (#C652) that is not a byte-verified signed page is denied:
// publish_version, edit_version, copy_file and an unverified publish_files would put a page the signed code did not build in
// front of the owner's browser, with its db and state connector. The old Artifact tool kept the app's consent card instead;
// the new tools had no hook at all.
export const PAGE_DENIED = "Flight board: a page change on the board's artifact must be the page the signed board code builds (the very bytes scripts/build-page.mjs builds from the signed copy and today's config, sent with publish_files as the only file, index.html); this one is not. Build it with scripts/build-page.mjs, or ask Manager.";
export const pageDenied = (input, rawConfig) => classify(input, rawConfig)?.kind === "page";

// #C409's race (#C415, Security's first part): between this hook's check and the publish, the file could be changed.
// So the publish goes from a copy of the very bytes checked, in a fresh folder of its own (mode 0700, a random name, in
// the config's folder, where the lead may publish from), the file created there, never written through an entry; the
// call's file_path points at it (updatedInput replaces the whole input, so the other fields go with it). Copies older
// than a day are cleared on the way. Returns the new input, or null when the copy can't be made (then: silence).
export const COPY_DIR = /^\.publish-[A-Za-z0-9]{6}$/;
export function verifiedCopy(verdict, configDir, now = Date.now()) {
  try {
    for (const d of readdirSync(configDir)) {
      if (!COPY_DIR.test(d)) continue;
      const p = join(configDir, d), st = lstatSync(p);
      if (st.isDirectory() && !st.isSymbolicLink() && now - st.mtimeMs > 864e5) rmSync(p, { recursive: true, force: true });
    }
  } catch { /* clearing is best effort */ }
  try {
    const dir = mkdtempSync(join(configDir, ".publish-"));
    chmodSync(dir, 0o700);
    const path = join(dir, verdict.name);
    writeFileSync(path, verdict.bytes, { flag: "wx", mode: 0o600 });
    return verdict.withPath(path);
  } catch { return null; }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  let rawConfig = null, configDir = null, current = null;
  try {
    const at = process.argv.indexOf("--config");
    const path = realpathSync(process.argv[at + 1]);
    rawConfig = JSON.parse(readFileSync(path, "utf8"));
    configDir = dirname(path);
    const link = currentLink(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
    current = link ? realpathSync(link) : null;
  } catch { process.exit(0); }
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    const out = hookResponse(raw, { rawConfig, configDir, current, envRole: process.env.FLIGHT_BOARD_ROLE });
    if (out) process.stdout.write(out);
    process.exit(0);
  });
}

// The hook's whole answer to one call, as the text for stdout ("" is silence). verdictOf is the check, a parameter only so a
// test can make it throw.
export function hookResponse(raw, { rawConfig, configDir, current, envRole }, verdictOf = publishVerdict) {
  const deny = () => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: PAGE_DENIED } });
  try {
    const input = JSON.parse(raw);
    const lines = input?.transcript_path ? readLines(input.transcript_path) : [];
    const managerRole = fullConfig(rawConfig).gate.managerRole;
    const v = verdictOf(input, { rawConfig, managerRole, configDir, current, lines, envRole });
    const updatedInput = v ? verifiedCopy(v, v.copyDir ?? configDir) : null;
    if (v && updatedInput) return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: v.reason, updatedInput } });
    return pageDenied(input, rawConfig) ? deny() : "";
  } catch {
    // A throw must not hand a page tool back to the app's own permission check (Security): on the board's page tools, deny.
    try { return pageDenied(JSON.parse(raw), rawConfig) ? deny() : ""; } catch { return ""; }
  }
}
