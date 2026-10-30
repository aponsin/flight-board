// A card's issue chips name every kind of rework (#C468, board-issue-kinds; the owner's #T1170: #C465 went back to build
// for Designer's two findings and his own Spanish-menu decision, and its chips still said 0 bugs, 0 security fixes and
// 0 wording fixes: the page knew only bugs, security and language).
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const chip = (n, label) => `<span class="chip ${n ? "" : "zero"}">${n} ${label}</span>`;

test("#C465's issues show as 2 design fixes and 1 owner change, beside the three kinds there were", () => {
  const { issueChips } = loadNames(["issueChips"]);
  const c465 = { issues: { bugs: 0, design: 2, language: 0, owner: 1, security: 0 } };
  assert.equal(issueChips(c465), [chip(0, "bugs"), chip(0, "security fixes"), chip(0, "wording fixes"), chip(2, "design fixes"), chip(1, "owner changes")].join(" "));
});

test("no issues, or junk in them: every chip at 0", () => {
  const { issueChips } = loadNames(["issueChips"]);
  const zero = [chip(0, "bugs"), chip(0, "security fixes"), chip(0, "wording fixes"), chip(0, "design fixes"), chip(0, "owner changes")].join(" ");
  assert.equal(issueChips({}), zero);
  assert.equal(issueChips({ issues: { design: "2<b>", owner: null } }), zero, "a count is a number or nothing");
});

test("the card row draws them", () => {
  const b = loadNames(["initRow"]);
  Object.assign(b.state, { steps: [], derived: [], todo: [], ideas: [], waiting: [], messages: [], threads: [] });
  const card = { id: "c-1", num: 1, name: "One", size: "S", status: "active", phase: "build", issues: { design: 2, owner: 1 }, createdAt: Date.now() - 6e4, etaLive: Date.now() + 36e5 };
  Object.assign(b.state, { initRaw: [card], initiatives: [card] });
  const row = b.initRow(card);
  assert.ok(row.includes(chip(2, "design fixes")) && row.includes(chip(1, "owner changes")));
});
