// A node:test reporter that writes one line per FAILING test, as it fails: "FAILED <file>: <name> -- <first line of the error>" (#C1091). scripts/test-run.mjs runs
// it beside the spec reporter, into a file, and prints those lines as the last lines of the run, so a cut-off run still shows what failed (11-16: Checker 2's
// first full run on #C1075 went red, the output was cut, and nobody knew which test it was). A suite (a describe) and a test that only failed because a
// subtest did are not listed: the failing subtest is. A test file that crashes before its tests run is listed by its file name.
import { relative } from "node:path";

const oneLine = (s, n) => String(s ?? "").split("\n")[0].replace(/\s+/g, " ").trim().slice(0, n);

export function failureLine(data, cwd = process.cwd()) {
  const d = data ?? {};
  if (d.details?.type === "suite") return null;
  const err = d.details?.error;
  if (err?.failureType === "subtestsFailed") return null;
  let file = String(d.file ?? "");
  try { if (file) file = relative(cwd, file) || file; } catch { /* keep the path as given */ }
  const why = oneLine(err?.cause?.message ?? err?.message, 160);
  return `FAILED ${file || "(no file)"}: ${oneLine(d.name, 200) || "(no name)"}${why ? ` -- ${why}` : ""}\n`;
}

export default async function* failuresReporter(source) {
  for await (const e of source) {
    if (e.type !== "test:fail") continue;
    const line = failureLine(e.data);
    if (line) yield line;
  }
}
