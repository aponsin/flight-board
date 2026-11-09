// Pull request approvals as Approval asks (#C727, board parity C4; docs/DATA.md row 22). The old page's panel ("<agent>'s pull
// requests", board.template.html renderAgentPrs) draws two collections, agentPrs and approvals; here both come from the store's
// Approval asks, so the panel looks as it did and Release reads one record:
//   - An Approval ask is Reviewer's (or the lead's) "pull request <pr> at commit <head> is signed: approve it?". A push makes a
//     new head: Reviewer asks again for it, and closes the old ask.
//   - The owner's Approve answers the open ask for that exact head ("Approve"); Withdraw clears the answer (withdrawAsk).
//   - Release merges only a head the owner's answer stands on (scripts/approvals-check.mjs, README step 4).
// Approval asks are drawn in the panel, never in Needs you. Pure but for routeApproval, which calls the store's own functions.
import { answerAsk, withdrawAsk, refuse } from "./board-store.mjs";
import { APPROVE } from "./board-rules.mjs";

const body = (a) => { try { const b = JSON.parse(a.body); return b && typeof b === "object" ? b : {}; } catch { return {}; } };
const PR_PATH = /^pr([1-9][0-9]{0,6})$/;

// The Approval asks, newest first, with their parts.
function approvalAsks(asks) {
  return (asks ?? []).filter((a) => a.type === "Approval").map((a) => ({ a, ...body(a) })).filter((x) => Number.isInteger(x.pr)).sort((x, y) => y.a.num - x.a.num);
}

// Pure: the panel's two collections.
//   agentPrs/pr<n>:  the newest OPEN ask for the pull request: signed by its asker at its head (the panel lists only signed heads).
//   approvals/pr<n>: the newest ask the owner's Approve stands on, open or closed, so a push after an approval shows "Approve again".
export function approvalDocs(asks) {
  const agentPrs = new Map(), approvals = new Map();
  const list = approvalAsks(asks);
  for (const { a, pr, head, url } of list) {
    const id = `pr${pr}`;
    if (!a.closed_at && !agentPrs.has(id)) agentPrs.set(id, { id, number: pr, title: a.title, url, head, signedHead: head, signedAt: a.created_at, review: "ok", at: a.created_at });
  }
  for (const { a, pr, head } of list) {
    const id = `pr${pr}`;
    // A closed approval for the head an open ask now asks about again is not shown: the open ask is the one Release reads, and it
    // is unapproved (review on #C727: the panel said "approved" while approvalFor said no and Withdraw was refused).
    if (a.closed_at && agentPrs.get(id)?.head === head) continue;
    if (a.answered_at && a.answer === APPROVE && !approvals.has(id)) approvals.set(id, { id, number: pr, head, at: a.answered_at, by: a.answered_by });
  }
  return { agentPrs: [...agentPrs.values()], approvals: [...approvals.values()] };
}

// Hook in compatView: Approval asks leave Needs you and fill the panel.
export function applyApprovals(collections, view) {
  const ids = new Set((view.asks ?? []).filter((a) => a.type === "Approval").map((a) => a.id));
  if (collections.waiting) collections.waiting = collections.waiting.filter((w) => !ids.has(w.id));
  Object.assign(collections, approvalDocs(view.asks));
  return collections;
}

// The panel's two writes (board.template.html onAgentPr): set approvals/pr<n> {number, head, at, by} is Approve for that head;
// delete approvals/pr<n> is Withdraw. Each lands on the store's own function and rules; anything else is refused by name.
export async function routeApproval(db, now, who, role, op, id, data) {
  const m = PR_PATH.exec(id), pr = m ? Number(m[1]) : null;
  if (!pr) return refuse(db, now, { rule: "compat-shape", detail: `approvals/${String(id).slice(0, 20)} is approvals/pr<number>` }, null, who);
  const open = approvalAsks((await db.prepare("SELECT * FROM asks WHERE type = 'Approval' AND closed_at IS NULL").all()).results).filter((x) => x.pr === pr);
  if (op === "set") {
    if (data?.number !== undefined && data.number !== pr) return refuse(db, now, { rule: "approval-shape", detail: `number ${data.number} is not ${pr}` }, null, who);
    const ask = open.find((x) => x.head === data?.head);
    if (!ask) return refuse(db, now, { rule: "approval-unknown", detail: `no open Approval for pull request ${pr} at ${String(data?.head).slice(0, 12)}` }, null, who);
    return answerAsk(db, now, who, { id: ask.a.id, answer: APPROVE });
  }
  if (op === "delete") {
    // Every open approved ask for this pull request, not only the newest: an older head left open must not keep counting if the
    // branch is pushed back to it (review on #C727).
    const approved = open.filter((x) => x.a.answered_at);
    if (!approved.length) return refuse(db, now, { rule: "withdraw-not-approved", detail: `pull request ${pr} has no approval to withdraw` }, null, who);
    let r;
    for (const x of approved) { r = await withdrawAsk(db, now, who, x.a.id, role); if (!r.ok) return r; }
    return r;
  }
  return refuse(db, now, { rule: "no-route-yet", detail: `approvals/${id}: ${op} has no route` }, null, who);
}

// For Release's ship start (scripts/approvals-check.mjs): does the owner's approval stand on this exact head? Read from the store's
// view (read_view), never from what the page shows. Pure.
export function approvalFor(asks, pr, head) {
  if (!Number.isInteger(pr) || typeof head !== "string" || !/^[0-9a-f]{40}$/.test(head)) return { ok: false, why: "a pull request number and its full 40-character head" };
  const mine = approvalAsks(asks).filter((x) => x.pr === pr);
  if (!mine.length) return { ok: false, why: `no Approval ask for pull request ${pr}` };
  const at = mine.find((x) => x.head === head);
  if (!at) return { ok: false, why: `no Approval ask for pull request ${pr} at ${head.slice(0, 12)}: Reviewer has not asked for this head` };
  if (at.a.closed_at) return { ok: false, why: `the Approval for ${head.slice(0, 12)} is closed (merged or replaced)` };
  if (!(at.a.answered_at && at.a.answer === APPROVE && at.a.answered_by === "owner")) return { ok: false, why: at.a.withdrawn_at ? `the owner withdrew the approval of ${head.slice(0, 12)}` : `the owner has not approved ${head.slice(0, 12)}` };
  return { ok: true, id: at.a.id, at: at.a.answered_at, by: at.a.answered_by };
}
