// Page-only board releases publish without the owner's word (#C409, the owner's B in #T1051; Security: an allow rule
// can't be narrowed to one board, so it is this hook instead). A PreToolUse hook on Artifact that says "allow" for one
// call only and is silent on every other (the app's own consent applies as before):
//   - the session is the lead (its title, as the gate reads it; FLIGHT_BOARD_ROLE must agree);
//   - a publish (action "publish" or none) to exactly this board's artifactUrl, with no field but action, url, file_path;
//   - the file, after realpath, is a regular file in the config's own folder named board-<commit>.html or
//     board-v<NNN>.html, at most MAX_PAGE bytes;
//   - its sha256 is that of the page this pinned build-page.mjs builds from the template of the current link (the signed
//     commit board releases move it to, scripts/current.mjs) with today's config (the --config file, as it is).
// Anything it can't read or check is silence, never an allow. It never refuses: refusing is the gate's.
import { realpathSync, readFileSync, openSync, fstatSync, readSync, closeSync, constants } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildPage } from "../scripts/build-page.mjs";
import { fullConfig } from "../scripts/config.mjs";
import { currentLink } from "../collector/fence.mjs";
import { readLines, sessionRole } from "./session.mjs";

export const PAGE_NAME = /^board-(?:[0-9a-f]{7,40}|v\d{1,4})\.html$/;
export const MAX_PAGE = 8 * 1024 * 1024;
const KEYS = new Set(["action", "url", "file_path"]);
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
export function publishAllowed(input, { rawConfig, managerRole, configDir, current, lines, envRole = "" }) {
  if (input?.tool_name !== "Artifact") return null;
  const t = input.tool_input;
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  if (Object.keys(t).some((k) => !KEYS.has(k))) return null;
  if (t.action !== undefined && t.action !== "publish") return null;
  const board = rawConfig?.artifactUrl;
  if (typeof board !== "string" || !board || t.url !== board) return null;
  const { role, error } = sessionRole(lines, envRole);
  if (error || !role || role !== managerRole) return null;
  if (typeof t.file_path !== "string" || !t.file_path || !configDir || !current) return null;
  let real;
  try { real = realpathSync(t.file_path); } catch { return null; }
  if (dirname(real) !== configDir || !PAGE_NAME.test(basename(real))) return null;
  const file = readCapped(real, MAX_PAGE);
  if (!file) return null;
  let built;
  try { built = buildPage(readFileSync(join(current, "page", "board.template.html"), "utf8"), rawConfig); } catch { return null; }
  if (sha(file) !== sha(built)) return null;
  return `Flight board: ${basename(real)} is the page the signed board code builds (${basename(current).slice(0, 12)}) for this board: published by ${role} without asking (#C409).`;
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
    try {
      const input = JSON.parse(raw);
      const lines = input?.transcript_path ? readLines(input.transcript_path) : [];
      const managerRole = fullConfig(rawConfig).gate.managerRole;
      const reason = publishAllowed(input, { rawConfig, managerRole, configDir, current, lines, envRole: process.env.FLIGHT_BOARD_ROLE });
      if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: reason } }));
    } catch { /* silence */ }
    process.exit(0);
  });
}
