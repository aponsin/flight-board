// The agent's pull requests on the board (#C554): the owner approves a Reviewer-signed pull request with
// a button on the board; Release merges it at the next ship's start.
//   agentPrs/pr<number>   what the board shows for one open pull request, written by the team: Reviewer (its review and
//                        signature) and Release (checks, merged), and the lead. No field carries a GitHub approval: Release checks one itself.
//   approvals/pr<number> { number, head, at, by }: the owner's button, the page's alone. No session writes it, the
//                        lead included (it is the owner's go for a merge; the gate is what keeps an agent from giving it).
// An approval counts for the head it names: Release merges a pull request only when that head is the pull request's
// current head. A push after the approval leaves it standing for the old head, and the board asks again.
export const PR_ID = /^pr[1-9][0-9]{0,6}$/;
const HEX = /^[0-9a-f]{7,40}$/;
export const PR_FIELDS = ["number", "title", "url", "head", "signedHead", "signedAt", "review", "checks", "merged", "at"];
// A field only Reviewer (or the lead) writes: the signature itself.
export const SIGN_FIELDS = ["signedHead", "signedAt", "review"];
export const REVIEWS = ["ok", "failed", "pending"], CHECKS = ["green", "running", "failed"];
const REQUIRED = ["number", "title", "url", "head"];
const URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}\/pull\/([1-9][0-9]{0,6})$/;

// The approvals: nobody's but the page's.
export function approvalWriteErrors({ id }) {
  return [`approvals/${id} is the owner's button on the board: only the board's page writes it, and no session, the lead included`];
}

const del = (v) => v && typeof v === "object" && Object.keys(v).length === 1 && v.__delete__ === true;

// w: { op, doc_id, data }; who: { role, manager }; reviewerRole and releaseRole from the config's gate.
export function agentPrWriteErrors(w, { who, config, now }) {
  const { op, doc_id: id, data } = w, e = [];
  const reviewer = config.gate.reviewerRole, release = config.gate.releaseRole;
  const mayWrite = who.manager || who.role === reviewer || who.role === release;
  if (!mayWrite) return [`agentPrs/${id}: written by ${reviewer}, ${release} or ${config.gate.managerRole}, not ${who.role ?? "a session with no role"}`];
  if (!PR_ID.test(String(id))) return [`agentPrs/${id}: the id is pr<number> (pr301)`];
  if (op === "delete") return [];
  if (!data || typeof data !== "object" || Array.isArray(data)) return ["a pull request entry is an object"];
  const keys = Object.keys(data);
  const odd = keys.filter((k) => !PR_FIELDS.includes(k));
  if (odd.length) e.push(`a pull request entry holds only ${PR_FIELDS.join(", ")} (not ${odd.join(", ")})`);
  if (op === "set") for (const f of REQUIRED) if (!(f in data)) e.push(`${f}: a pull request entry needs it`);
  const signs = keys.filter((k) => SIGN_FIELDS.includes(k));
  if (signs.length && !(who.manager || who.role === reviewer)) e.push(`${signs.join(", ")}: only ${reviewer} signs a pull request`);
  const n = Number(String(id).slice(2));
  if ("number" in data && data.number !== n) e.push(`number: ${n}, as the id says`);
  if ("title" in data && !(typeof data.title === "string" && data.title.trim().length >= 1 && data.title.length <= 120 && !/[\u0000-\u001f\u007f<>]/.test(data.title))) e.push("title: 1 to 120 characters, one line, no < or >");
  if ("url" in data) {
    const m = typeof data.url === "string" ? URL_RE.exec(data.url) : null;
    if (!m || Number(m[1]) !== n) e.push(`url: the pull request's own GitHub address (https://github.com/<owner>/<repo>/pull/${n})`);
  }
  for (const f of ["head", "signedHead"]) {
    if (!(f in data)) continue;
    const v = data[f];
    if (v === null && f !== "head") continue;
    if (del(v) && op === "update" && f !== "head") continue;
    if (!(typeof v === "string" && HEX.test(v))) e.push(`${f}: a commit, 7 to 40 lower-case hex digits${f === "head" ? "" : ", or null"}`);
  }
  for (const f of ["signedAt", "at"]) {
    if (!(f in data)) continue;
    const v = data[f];
    if (del(v) && op === "update") continue;
    if (!(Number.isInteger(v) && v > 1577836800000 && v <= now + 5 * 60e3)) e.push(`${f}: a time in ms, not in the future`);
  }
  if ("review" in data && !REVIEWS.includes(data.review)) e.push(`review: ${REVIEWS.join(", ")}`);
  if ("checks" in data && !CHECKS.includes(data.checks)) e.push(`checks: ${CHECKS.join(", ")}`);
  if ("merged" in data && typeof data.merged !== "boolean") e.push("merged: true or false");
  return e;
}
