// The agent's pull requests on the board (#C554; the owner's A on #T1361, as pictured): the owner approves
// a Reviewer-signed pull request with a button; Release merges it at the next ship's start.
//   - only pull requests that need him are listed (a head Reviewer signed, not yet approved for that head);
//   - an approval on GitHub for the current head counts: the row isn't listed, it is under "approved";
//   - only his account approves: no session writes approvals/<pr>, the lead included; the gate is the barrier.
import test from "node:test";
import assert from "node:assert/strict";
import { writeErrors } from "../gate/rules.mjs";
import { fullConfig, checkConfig } from "../scripts/config.mjs";
import { PR_ID } from "../gate/agent-prs.mjs";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const config = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01" });
const NOW = 1_800_000_000_000, MIN = 60e3;
const lead = { role: "Manager", manager: true }, reviewer = { role: "Reviewer", manager: false }, release = { role: "Release", manager: false }, builder = { role: "Builder", manager: false };
const errs = (w, who) => writeErrors({ op: "set", ...w }, { config, who, now: NOW });
const H1 = "4f2a9c1e0d3b5a6978c1d2e3f40516273849a0b1", H2 = "9be0d47a1c2e3f4051627384950a1b2c3d4e5f60";
const entry = (n, extra = {}) => ({ number: n, title: "Sample Roofing: new site", url: `https://github.com/example-org/example-repo/pull/${n}`, head: H1, ...extra });

test("the gate: approvals/<pr> is the page's alone, for every session, the lead included, whatever the write", () => {
  for (const who of [lead, reviewer, release, builder, { role: null, manager: false }]) {
    for (const op of ["set", "update", "delete"]) {
      const e = errs({ op, collection: "approvals", doc_id: "pr301", data: { number: 301, head: H1, at: NOW, by: "Owner" } }, who);
      assert.equal(e.length, 1, `${who.role} ${op}`);
      assert.match(e[0], /the owner's button on the board: only the board's page writes it/);
    }
  }
});

test("the gate: agentPrs is written by Reviewer, Release and the lead; another role is refused", () => {
  for (const who of [reviewer, release, lead]) assert.deepEqual(errs({ collection: "agentPrs", doc_id: "pr301", data: entry(301) }, who), [], who.role);
  const e = errs({ collection: "agentPrs", doc_id: "pr301", data: entry(301) }, builder);
  assert.match(e[0], /agentPrs\/pr301: written by Reviewer, Release or Manager, not Builder/);
  assert.match(errs({ collection: "agentPrs", doc_id: "pr301", data: entry(301) }, { role: null, manager: false })[0], /a session with no role/);
});

test("the gate: only Reviewer (or the lead) signs: signedHead, signedAt, review; Release writes checks, merged and a GitHub approval", () => {
  const sign = { signedHead: H1, signedAt: NOW - MIN, review: "ok" };
  assert.deepEqual(errs({ collection: "agentPrs", doc_id: "pr301", data: entry(301, sign) }, reviewer), []);
  assert.deepEqual(errs({ collection: "agentPrs", doc_id: "pr301", data: entry(301, sign) }, lead), []);
  assert.match(errs({ collection: "agentPrs", doc_id: "pr301", data: entry(301, sign) }, release)[0], /signedHead, signedAt, review: only Reviewer signs a pull request/);
  assert.deepEqual(errs({ op: "update", collection: "agentPrs", doc_id: "pr301", data: { checks: "green", merged: false, at: NOW } }, release), []);
  assert.match(errs({ op: "update", collection: "agentPrs", doc_id: "pr301", data: { review: "ok" } }, release)[0], /only Reviewer signs/);
});

test("the gate: a pull request entry's fields are each checked", () => {
  const bad = (data, who = reviewer, op = "set", id = "pr301") => errs({ op, collection: "agentPrs", doc_id: id, data }, who).join(" | ");
  assert.match(bad(entry(301), reviewer, "set", "301"), /the id is pr<number>/);
  assert.match(bad(entry(301), reviewer, "set", "pr0"), /the id is pr<number>/);
  assert.match(bad(entry(302)), /number: 301, as the id says/);
  assert.match(bad({ ...entry(301), extra: 1 }), /not extra/);
  assert.match(bad({ number: 301 }), /title: a pull request entry needs it/);
  assert.match(bad(entry(301, { title: "" })), /title: 1 to 120/);
  assert.match(bad(entry(301, { title: "<b>hi</b>" })), /title: 1 to 120/);
  assert.match(bad(entry(301, { title: "x".repeat(121) })), /title: 1 to 120/);
  assert.match(bad(entry(301, { title: "two\nlines" })), /title: 1 to 120/);
  for (const url of ["http://github.com/o/r/pull/301", "https://github.com/o/r/pull/302", "https://evil.example/o/r/pull/301", "https://github.com/o/r/pull/301?x=1", "https://github.com/o/r/issues/301", 5]) assert.match(bad(entry(301, { url })), /url: the pull request's own GitHub address/, String(url));
  for (const head of ["", "XYZ", "4f2a9c", "4F2A9C1E", H1 + "0", null, 7]) assert.match(bad(entry(301, { head })), /head: a commit/, String(head));
  assert.match(bad(entry(301, { signedHead: "nothex1" })), /signedHead: a commit/);
  assert.match(bad(entry(301, { signedAt: NOW + 10 * MIN })), /signedAt: a time in ms, not in the future/);
  assert.match(bad(entry(301, { review: "great" })), /review: ok, failed, pending/);
  assert.match(bad(entry(301, { checks: "blue" })), /checks: green, running, failed/);
  assert.match(bad(entry(301, { merged: "yes" })), /merged: true or false/);
  assert.deepEqual(errs({ op: "update", collection: "agentPrs", doc_id: "pr301", data: { signedHead: null } }, reviewer), [], "signedHead can be cleared");
  // Security on 97f141c5 (HIGH): no field a session writes may stand in for the owner's approval, so there is none.
  for (const who of [reviewer, release, lead]) assert.match(errs({ collection: "agentPrs", doc_id: "pr301", data: entry(301, { ghApproved: H1 }) }, who)[0], /not ghApproved/, `${who.role}: a GitHub approval is not a board field`);
  assert.match(errs({ op: "update", collection: "agentPrs", doc_id: "pr301", data: { approved: true } }, lead)[0], /not approved/);
  assert.deepEqual(errs({ op: "delete", collection: "agentPrs", doc_id: "pr301" }, release), [], "a merged or closed pull request's entry can go");
  assert.match(errs({ op: "delete", collection: "agentPrs", doc_id: "pr301" }, builder)[0], /written by/);
  assert.ok(PR_ID.test("pr1") && !PR_ID.test("pr01") && !PR_ID.test("pr"), "the id shape");
});

test("the config: reviewerRole and releaseRole are role names, with defaults", () => {
  assert.equal(config.gate.reviewerRole, "Reviewer");
  assert.equal(config.gate.releaseRole, "Release");
  assert.deepEqual(checkConfig({ gate: { reviewerRole: "Reviewer 2", releaseRole: "Ship" } }).filter((p) => /gate\./.test(p)), []);
  assert.ok(checkConfig({ gate: { reviewerRole: 5 } }).some((p) => /gate\.reviewerRole: a role name/.test(p)));
  assert.ok(checkConfig({ gate: { releaseRole: "<x>" } }).some((p) => /gate\.releaseRole: a role name/.test(p)));
});

test("the config names the agent in the panel: prAgent, a plain name; the page reads it, with a neutral default", () => {
  assert.equal(config.prAgent, "The agent");
  assert.deepEqual(checkConfig({ prAgent: "Pat's agent" }).filter((p) => /prAgent/.test(p)), []);
  for (const bad of ["", "  ", 7, "x".repeat(41), "<b>", "two\nlines", "a{b}"]) assert.ok(checkConfig({ prAgent: bad }).some((p) => /prAgent: a name/.test(p)), JSON.stringify(bad));
  const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.match(page, /const PR_AGENT=String\(\(CONFIG&&CONFIG\.prAgent\)\|\|"The agent"\)/);
  assert.match(page, /<h3>\$\{esc\(PR_AGENT\)\}'s pull requests<\/h3>/);
  assert.match(page, /\$\{esc\(PR_AGENT\)\} pushed after your approval/);
});

// --- the page ---

const b = loadNames(["prRows", "renderAgentPrs"]);
const pr = (n, o = {}) => ({ id: `pr${n}`, number: n, title: `Title ${n}`, url: `https://github.com/example-org/example-repo/pull/${n}`, head: H1, signedHead: H1, signedAt: NOW - 20 * MIN, review: "ok", checks: "green", ...o });
const app = (n, head, o = {}) => ({ id: `pr${n}`, number: n, head, at: NOW - 3600e3, by: "Owner", ...o });
const ids = (rows) => Array.from(rows, (r) => r.p.id);

test("the picture's four rows: #301 approve, #303 pushed after an approval, #298 approved, #302 waiting on Reviewer (not listed)", () => {
  const prs = [
    pr(301), pr(303, { head: H2, signedHead: H2, checks: "running" }),
    pr(298, { checks: "green" }),
    pr(302, { signedHead: null, review: "failed" }),
  ];
  const { need, approved } = b.prRows(prs, [app(303, H1), app(298, H1)]);
  assert.deepEqual(ids(need), ["pr301", "pr303"], "only what needs him");
  assert.deepEqual(Array.from(need, (r) => r.again), [false, true]);
  assert.equal(need[1].was, H1, "the approved head it asks again over");
  assert.deepEqual(ids(approved), ["pr298"]);
});

test("a pull request needs him only with a head Reviewer signed: not an older one, not a failed review, not an unsigned one", () => {
  const rows = (p) => b.prRows([p], []).need.length;
  assert.equal(rows(pr(1)), 1);
  assert.equal(rows(pr(1, { signedHead: H2 })), 0, "signed an older head: Reviewer hasn't signed this one");
  assert.equal(rows(pr(1, { signedHead: undefined })), 0);
  assert.equal(rows(pr(1, { review: "failed" })), 0);
  assert.equal(rows(pr(1, { merged: true })), 0);
  assert.equal(rows(pr(1, { head: "nothex" })), 0);
  assert.equal(b.prRows([{ id: "301", head: H1, signedHead: H1 }, { id: "pr0", head: H1, signedHead: H1 }, null, undefined], []).need.length, 0, "an odd id or entry is skipped");
});

test("an approval counts for its head, and only the owner's own from the board: never an older head, never a field a session wrote", () => {
  const one = (p, apps) => b.prRows([p], apps);
  assert.equal(one(pr(5), [app(5, H1)]).approved.length, 1, "the board's approval of this head");
  assert.equal(one(pr(5), [app(5, H1)]).need.length, 0);
  assert.equal(one(pr(5), [app(5, H1)]).approved[0].a.head, H1, "with its Withdraw");
  // Security on 97f141c5 (HIGH): an entry that says the owner approved on GitHub (any such field) changes nothing here.
  for (const extra of [{ ghApproved: H1 }, { approved: true }, { approvedHead: H1 }, { ghApproved: true }]) {
    const r = one(pr(5, extra), []);
    assert.equal(r.need.length, 1, JSON.stringify(extra));
    assert.equal(r.approved.length, 0, JSON.stringify(extra));
  }
  const stale = one(pr(5), [app(5, H2)]);
  assert.equal(stale.need.length, 1);
  assert.equal(stale.need[0].again, true);
  assert.equal(stale.approved.length, 0);
  assert.equal(one(pr(5), [app(6, H1)]).need.length, 1, "another pull request's approval");
});

test("the panel: a count, a button per row ('Approve again' after a push), the stale-approval note, approved ones apart", () => {
  const els = new Map();
  const bb = loadNames(["renderAgentPrs"], {});
  bb.state.agentPrs = [pr(301), pr(303, { head: H2, signedHead: H2, checks: "running" }), pr(298), pr(302, { signedHead: null })];
  bb.state.approvals = [app(303, H1), app(298, H1, { at: Date.UTC(2026, 10, 2, 2, 31) })];
  bb.renderAgentPrs(NOW);
  const html = bb.els.agentprs.innerHTML;
  assert.equal(bb.els.agentprs.hidden, false);
  assert.match(html, /The agent's pull requests/);
  assert.match(html, /<span class="gp-count">2 to approve<\/span>/);
  assert.match(html, /data-gpa="1" data-n="301" data-head="4f2a9c1e[0-9a-f]+">Approve<\/button>/);
  assert.match(html, /data-gpa="1" data-n="303" data-head="9be0d47a[0-9a-f]+">Approve again<\/button>/);
  assert.match(html, /The agent pushed after your approval of <code>4f2a9c1<\/code>; Reviewer re-signed the new commit\. Approve it again to ship it\./);
  assert.match(html, /Reviewer signed<\/span><span>at <code>4f2a9c1<\/code>, 20 min ago<\/span><span class="gp-tag ok">Checks green/);
  assert.match(html, /Checks running/);
  assert.doesNotMatch(html, /#302|Title 302/, "waiting on Reviewer: nothing for him to do");
  assert.match(html, /<details class="gp-done"><summary>1 approved: merge at the next ship<\/summary>/);
  assert.match(html, /You, 02:31Z, <code>4f2a9c1<\/code>[\s\S]*data-gpw="1" data-n="298">Withdraw/);
  assert.match(html, /Approve here, not Merge on GitHub/);
  assert.match(html, /href="https:\/\/github\.com\/example-org\/example-repo\/pull\/301" target="_blank" rel="noopener">Open on GitHub/);
});

test("every control of the panel shows keyboard focus, and Withdraw and the summary are tap-sized (Designer on 97f141c5)", () => {
  const css = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8").match(/<style>([\s\S]*?)<\/style>/)[1];
  for (const sel of [".gp-act button:focus-visible", ".gp-act a:focus-visible", ".gp-num:focus-visible", ".gp-done button:focus-visible"]) assert.ok(css.includes(sel), sel);
  assert.match(css, /\.gp-act button:focus-visible[^{]*\{outline:2px solid var\(--accent\);outline-offset:2px\}/);
  assert.match(css, /\.gp-done summary:focus-visible\{outline:2px solid var\(--accent\);outline-offset:-2px\}/);
  assert.match(css, /\.gp-done button\{[^}]*min-height:36px;display:inline-flex/);
  assert.match(css, /\.gp-done summary\{padding:6px 0\}/);
});

test("the panel is hidden with nothing to show, and no count while only approved ones are left", () => {
  const bb = loadNames(["renderAgentPrs"], {});
  bb.renderAgentPrs(NOW);
  assert.equal(bb.els.agentprs.hidden, true);
  assert.equal(bb.els.agentprs.innerHTML, "");
  bb.state.agentPrs = [pr(7)];
  bb.state.approvals = [app(7, H1)];
  bb.renderAgentPrs(NOW);
  assert.equal(bb.els.agentprs.hidden, false);
  assert.doesNotMatch(bb.els.agentprs.innerHTML, /gp-count/);
  assert.match(bb.els.agentprs.innerHTML, /1 approved/);
});

test("the panel escapes what the agent's pull request carries, and links only a real GitHub pull request address", () => {
  const bb = loadNames(["renderAgentPrs"], {});
  bb.state.agentPrs = [pr(9, { title: "<img src=x onerror=alert(1)> \"q\"", url: "javascript:alert(1)" }), pr(10, { url: "https://evil.example/o/r/pull/10" })];
  bb.renderAgentPrs(NOW);
  const html = bb.els.agentprs.innerHTML;
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /javascript:|evil\.example|href="[^"]*"[^>]*>Open on GitHub[^<]*<\/a>[^]*evil/);
  assert.match(html, /&lt;img/);
  assert.equal([...html.matchAll(/Open on GitHub/g)].length, 0, "neither address is a GitHub pull request");
});

test("Approve writes approvals/pr<n> {number, head, at, by} for the head shown, once; Withdraw deletes it; nothing else is written", async () => {
  const log = [];
  const doc = (path) => ({ set: async (d) => log.push(["set", path, d]), update: async (d) => log.push(["update", path, d]), delete: async () => log.push(["delete", path]) });
  const db = { doc, collection: () => ({ onSnapshot: () => () => {} }) };
  const bb = loadNames(["onAgentPr"], { window: { claude: { use: async (n) => (n === "db" ? db : null) } } });
  await new Promise((r) => setImmediate(r));
  const btn = (dataset) => ({ currentTarget: { dataset, textContent: "Approve", disabled: false } });
  await bb.onAgentPr(btn({ n: "301", head: H1 }));
  assert.equal(log.length, 1);
  assert.deepEqual(log[0].slice(0, 2), ["set", "approvals/pr301"]);
  assert.deepEqual(Object.keys(log[0][2]).sort(), ["at", "by", "head", "number"]);
  assert.equal(log[0][2].head, H1);
  assert.equal(log[0][2].number, 301);
  assert.equal(log[0][2].by, "Owner");
  await bb.onAgentPr(btn({ n: "301", gpw: "1" }));
  assert.deepEqual(log[1], ["delete", "approvals/pr301"]);
  await bb.onAgentPr(btn({ n: "301", head: "not-a-commit" }));
  await bb.onAgentPr(btn({ n: "0", head: H1 }));
  await bb.onAgentPr(btn({ n: "x", head: H1 }));
  assert.equal(log.length, 2, "a bad head or number writes nothing");
});
