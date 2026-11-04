// New work needs an open card (#C673), by recipient (Manager): a lead's send to a builder role that names a card in ship or live,
// or done or dropped, is refused with "open a new card and name that one". A send to a reviewer, Release, Ops, Designer or
// Linguist is not checked; a send that says "rebase" is the legitimate case on a signed-but-unreleased card; a send naming an
// open card goes; a stale mirror or an unknown recipient checks nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fullConfig } from "../scripts/config.mjs";
import { run, checkHandOff, finishedCard, recipientRole, BUILDER_ROLES, REBASE } from "../gate/gate.mjs";

const SHIP = ["ship", "live"];
const cards = new Map([
  ["open-card", { phase: "build", status: "active" }],
  ["in-ship", { phase: "ship", status: "active" }],
  ["in-live", { phase: "live", status: "active" }],
  ["is-done", { phase: "build", status: "done" }],
  ["dropped-one", { phase: "plan", status: "dropped" }],
  ["lagging", { phase: "build", status: "active", derivedPhase: "ship" }],
]);
const known = new Set(cards.keys());
const go = (text, role, over = {}) => checkHandOff(text, { known, fresh: true, cards, shipPhases: SHIP, role, ...over });
const ID = "local_5965caef-819b-4022-b36e-80f9d3fd93a4";
const config = fullConfig({ roster: ["Manager", "Builder", "Boardsmith", "Admin", "Checker", "Release"], rosterSessions: { Admin: ID } });

test("finishedCard: ship, live (typed or by the evidence), done and dropped; open cards and unknown ones are not", () => {
  for (const id of ["in-ship", "in-live", "is-done", "dropped-one", "lagging"]) assert.equal(finishedCard(cards.get(id), SHIP), true, id);
  assert.equal(finishedCard(cards.get("open-card"), SHIP), false);
  assert.equal(finishedCard(undefined, SHIP), false);
});

test("a send to a builder role naming a card in ship, live, done or dropped is refused: open a new card and name that one", () => {
  for (const role of BUILDER_ROLES) for (const id of ["in-ship", "in-live", "is-done", "dropped-one", "lagging"]) {
    const r = go(`New work for you, board id ${id}`, role);
    assert.equal(r.errors.length, 1, `${role} ${id}`);
    assert.match(r.errors[0], new RegExp(`card ${id} is already in ship, live or done: open a new card and name that one`));
  }
  assert.match(go("board id in-ship and board id open-card", "Builder").errors[0], /card in-ship is already/, "only the finished one is named");
});

test("a send to a builder role naming an open card goes", () => {
  for (const role of BUILDER_ROLES) assert.deepEqual(go("Please build board id open-card", role).errors, [], role);
});

test("the rebase case: a builder is sent a rebase of a signed-but-unreleased card in ship, and it goes", () => {
  for (const t of ["Please rebase board id in-ship onto main", "rebase and re-sign board id in-ship", "Rebasing board id in-ship is needed", "board id in-live was rebased: check"]) assert.deepEqual(go(t, "Boardsmith").errors, [], t);
  assert.match(go("Please fix board id in-ship", "Boardsmith").errors[0], /already in ship/, "a fix without a rebase is refused");
  assert.deepEqual(go("Please build board id rebase-fix-card", "Builder", { known: new Set([...known, "rebase-fix-card"]), cards: new Map([...cards, ["rebase-fix-card", { phase: "build" }]]) }).errors, [], "an id holding the word is no rebase, and the card is open");
  assert.match(go("Please build board id in-ship-rebase", "Builder", { known: new Set([...known, "in-ship-rebase"]), cards: new Map([...cards, ["in-ship-rebase", { phase: "ship" }]]) }).errors[0], /in-ship-rebase is already/, "the word inside a card id is no rebase");
});

test("a reviewer, Release, Ops, Designer, Linguist or an unknown recipient is never checked", () => {
  for (const role of ["Checker", "Security", "Release", "Ops", "Designer", "Linguist", "Reviewer", "Triage", "Sales", "Manager", null])
    assert.deepEqual(go("Please re-sign board id in-ship; fix board id is-done", role).errors, [], String(role));
});

test("a stale mirror or no card list checks nothing; an unknown card is still refused as before", () => {
  assert.deepEqual(go("build, board id in-ship", "Builder", { fresh: false }).errors, []);
  assert.deepEqual(go("build, board id in-ship", "Builder", { cards: null }).errors, []);
  assert.match(go("build board id nope", "Builder").errors[0], /no card nope on the board/);
});

test("recipientRole: a session id from the config, or a role's name in any case; else null", () => {
  assert.equal(recipientRole(ID, config), "Admin");
  assert.equal(recipientRole("builder", config), "Builder");
  assert.equal(recipientRole("BOARDSMITH", config), "Boardsmith");
  for (const bad of [undefined, null, "", "local_00000000-0000-0000-0000-000000000000", "somebody"]) assert.equal(recipientRole(bad, config), null, String(bad));
  assert.match("rebase", REBASE);
  assert.doesNotMatch("database", REBASE);
});

test("the hook end to end: the lead's send is judged by recipient and by the mirror's cards (typed phase, status, derived/all)", () => {
  const URL_ = "https://claude.ai/" + "artifact/TestBoard01";
  const dir = mkdtempSync(join(tmpdir(), "fb-open-card-"));
  try {
    const cfg = fullConfig({ artifactUrl: URL_, gate: { stateDir: dir }, roster: ["Manager", "Builder", "Checker"], rosterSessions: { Builder: ID } });
    const transcript = join(dir, "t.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "custom-title", customTitle: "Manager" }) + "\n");
    const mir = join(dir, "TestBoard01", "mirror");
    for (const c of ["initiatives", "derived"]) mkdirSync(join(mir, c), { recursive: true });
    const put = (id, d) => writeFileSync(join(mir, "initiatives", `${id}.json`), JSON.stringify(d));
    put("open-card", { phase: "build", status: "active" });
    put("shipped-card", { phase: "ship", status: "active" });
    put("lagging-card", { phase: "build", status: "active" });
    writeFileSync(join(mir, "derived", "all.json"), JSON.stringify({ cards: { "lagging-card": { phase: "live" } } }));
    const send = (to, message) => run({ tool_name: "SendMessage", tool_input: { to, message }, transcript_path: transcript }, { config: cfg, env: {} });
    assert.deepEqual(send("builder", "Please build board id open-card"), {});
    assert.match(send("builder", "Please build the follow-up, board id shipped-card").block, /card shipped-card is already in ship, live or done: open a new card/);
    assert.match(send(ID, "Please fix the badge, board id lagging-card").block, /card lagging-card is already/, "by session id, and by the evidence");
    assert.deepEqual(send("builder", "Please rebase board id shipped-card"), {}, "the rebase case");
    assert.deepEqual(send("checker", "Please fix up the note, board id shipped-card"), {}, "a reviewer");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
