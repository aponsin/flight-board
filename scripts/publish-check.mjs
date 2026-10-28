// After a hook-allowed publish (#C415, Security's second part of #C409's race), the lead reads the artifact back and
// checks it is the page the hook verified: the hook's reason line names that page's sha256, and the read-back must
// hash to it once the app's own wrapping is taken off.
//   node scripts/publish-check.mjs <read-back file> <sha256 from the hook's reason line>
// The read-back is the file Artifact's read action saves: the published page inside the document skeleton the app adds
// at publish time (its <!doctype html><html><head>…</head><body> and a closing </body></html>). Prints one line:
// "publish check: ok", or "publish check: MISMATCH …" / "publish check: can't check …" and exit 1. The lead tells
// Security and the owner on anything but ok.
import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const SKELETON_HEAD = /^<!doctype html><html><head>(?:(?!<\/head>)[\s\S]){0,4000}<\/head><body>\n/;
const SKELETON_TAIL = "\n</body></html>";

// The page inside the app's wrapping, or null when the text isn't wrapped as the app wraps a page.
export function unwrap(text) {
  const s = String(text ?? ""), head = SKELETON_HEAD.exec(s);
  if (!head || !s.endsWith(SKELETON_TAIL)) return null;
  return s.slice(head[0].length, s.length - SKELETON_TAIL.length);
}

// { ok, line } for a read-back's text and the sha256 the hook named.
export function publishCheck(text, expected) {
  if (!/^[0-9a-f]{64}$/.test(String(expected ?? ""))) return { ok: false, line: "publish check: can't check: no sha256 from the hook's reason line" };
  const page = unwrap(text);
  if (page === null) return { ok: false, line: "publish check: can't check: the read-back isn't wrapped as the app wraps a page" };
  const got = createHash("sha256").update(page, "utf8").digest("hex");
  return got === expected
    ? { ok: true, line: "publish check: ok" }
    : { ok: false, line: `publish check: MISMATCH: the board holds ${got.slice(0, 12)}, the hook verified ${expected.slice(0, 12)}: tell Security and the owner` };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [file, expected] = process.argv.slice(2);
  let text = null;
  try { text = readFileSync(file, "utf8"); } catch { /* below */ }
  const r = text === null ? { ok: false, line: `publish check: can't check: ${file} can't be read` } : publishCheck(text, expected);
  console.log(r.line);
  process.exit(r.ok ? 0 : 1);
}
