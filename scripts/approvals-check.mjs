#!/usr/bin/env node
// Release's ship-start check (#C727, board parity C4; README "Approving the prospecting agent's pull requests", step 4a): does the
// owner's approval on the board stand on this exact head? Reads the store through the shared connector (read_view as Release),
// never what the page shows, and never a field a session wrote: only an Approval ask the owner answered "Approve", open, for
// this pull request at this full commit.
//
//   node scripts/approvals-check.mjs <pr number> <40-character head> --connector-file <file holding the connector's address>
//
// The connector's address carries its secret: it is read from the file (or BOARD_CONNECTOR_URL), never from the command line,
// and never printed. Exit 0: approved at that head. Exit 1: not approved (the line says why). Exit 2: could not check.
import { readFileSync } from "node:fs";
import { approvalFor } from "../worker/compat-approvals.mjs";

export async function checkApproval({ pr, head, url, as = "Release", fetchImpl = fetch }) {
  if (!Number.isInteger(pr) || !/^[0-9a-f]{40}$/.test(head ?? "")) return { code: 2, line: "usage: approvals-check.mjs <pr number> <full 40-character head> --connector-file <file>" };
  if (!/^https:\/\/[^\s]+\/mcp\/[^\s/]+$/.test(url ?? "")) return { code: 2, line: "no connector address: pass --connector-file <file> or set BOARD_CONNECTOR_URL" };
  let res;
  try {
    const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(20_000), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_view", arguments: { as } } }) });
    if (!r.ok) return { code: 2, line: `the board answered ${r.status}` };
    res = await r.json();
  } catch (e) {
    return { code: 2, line: `could not reach the board (${String(e?.name ?? "error")})` };
  }
  const view = res?.result?.structuredContent;
  if (!view || !Array.isArray(view.asks)) return { code: 2, line: `the board's answer has no asks${res?.error ? `: ${String(res.error.message).slice(0, 80)}` : ""}` };
  const a = approvalFor(view.asks, pr, head);
  return a.ok
    ? { code: 0, line: `approved: pull request ${pr} at ${head.slice(0, 12)}, by the owner at ${new Date(a.at).toISOString()} (ask ${a.id})` }
    : { code: 1, line: `not approved: ${a.why}` };
}

async function main(argv) {
  const at = argv.indexOf("--connector-file");
  const file = at >= 0 ? argv[at + 1] : null;
  const [prArg, head] = argv.filter((x, i) => !(i === at || i === at + 1));
  const pr = /^[1-9][0-9]{0,6}$/.test(prArg ?? "") ? Number(prArg) : NaN;
  let url = process.env.BOARD_CONNECTOR_URL;
  if (file) { try { url = readFileSync(file, "utf8").trim(); } catch { console.log(`could not read ${file}`); return 2; } }
  const r = await checkApproval({ pr, head, url });
  console.log(r.line);
  return r.code;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main(process.argv.slice(2)));
