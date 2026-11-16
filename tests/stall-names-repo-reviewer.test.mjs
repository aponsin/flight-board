// #C1100 (11-16: after #C1098 the dispatch sends flight-board reviews to Checker 2 from collector.reviewers, but the stall line still named the phase's lane, so a board
// card at review could read "Checker idle"): the stall line takes its reviewer from the same map. The Worker has no board config, so the probe posts the map as
// the evidence key `reviewers` (as it posts `look`), and the store hands it to stalledWaits.
import test from "node:test";
import assert from "node:assert/strict";
import { stalledWaits, reviewerOf, reviewersShape, evidenceRefusal } from "../worker/board-rules.mjs";
import { reviewerFor } from "../collector/store-dispatch.mjs";
import { reviewersWrite, evidenceJob } from "../collector/probe-evidence.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, writeEvidence, takeInbox, wakeAsk } from "../worker/board-store.mjs";

const T = 1_800_000_000_000, MIN = 60_000, NOW = T + 20 * MIN;
const REVIEWERS = { "flight-board": "Checker 2" };
const idle = { state: "idle", tool: null, card: null, since: T };
const busy = { state: "working", tool: "Bash", card: "other-card", since: T };
const evidence = { "card-a": { lit: ["checker"], phase: "checker", ci: "none" } };
const phaseStart = new Map([["card-a|checker", T]]);
const line = (card, agents, reviewers, extra = {}) => stalledWaits({ now: NOW, cards: [{ id: "card-a", num: 1, owner_role: "Boardsmith", ...card }], evidence, agents, openAskCards: new Set(), phaseStart, reviewers, ...extra });

test("a flight-board card (no repo word, or the board's words) at review names Checker 2; a product card names Checker", () => {
  const agents = { Checker: idle, "Checker 2": idle };
  for (const repo of [undefined, "", "flight-board", "board"]) {
    const got = line({ repo }, agents, REVIEWERS);
    assert.equal(got.length, 1, String(repo));
    assert.equal(got[0].role, "Checker 2", String(repo));
    assert.match(got[0].reason, /^#C1 waits at Checker 15 min, Checker 2 idle since /);
  }
  const product = line({ repo: "product-app" }, agents, REVIEWERS);
  assert.equal(product.length, 1); assert.equal(product[0].role, "Checker"); assert.match(product[0].reason, /, Checker idle since /);
});

test("the reviewer's own state decides: Checker 2 busy and Checker idle is no stall for a board card, and the reverse is", () => {
  assert.deepEqual(line({}, { Checker: idle, "Checker 2": busy }, REVIEWERS), [], "a board card waits on Checker 2, who is busy");
  const got = line({}, { Checker: busy, "Checker 2": idle }, REVIEWERS);
  assert.equal(got.length, 1); assert.equal(got[0].role, "Checker 2");
  assert.match(line({}, { Checker: idle }, REVIEWERS)[0].reason, /no session for Checker 2$/, "no session for the reviewer: the line says so");
});

test("with no map (nothing posted, or an empty one) the phase's lane is read as before", () => {
  for (const reviewers of [undefined, null, {}, [], "Checker 2"]) {
    const got = line({}, { Checker: idle, "Checker 2": idle }, reviewers);
    assert.equal(got.length, 1); assert.equal(got[0].role, "Checker", JSON.stringify(reviewers));
  }
});

test("a claim still names its own checker first; only the checker phase reads the map, and a signed-but-behind card is its owner's", () => {
  const claimed = line({}, { Checker: idle, "Checker 2": idle }, { "flight-board": "Checker 3" }, { claims: new Map([["card-a", "Checker 2"]]) });
  assert.equal(claimed[0].role, "Checker 2", "the claim wins over the map");
  const at = (phase, agents, v = {}) => stalledWaits({ now: NOW, cards: [{ id: "card-a", num: 1, owner_role: "Boardsmith" }], evidence: { "card-a": { lit: [phase], phase, ci: "none", ...v } }, agents, openAskCards: new Set(), phaseStart: new Map([[`card-a|${phase}`, T]]), reviewers: REVIEWERS });
  assert.equal(at("security", { Security: idle, "Checker 2": idle })[0].role, "Security");
  assert.equal(at("ship", { Release: idle, "Checker 2": idle })[0].role, "Release");
  assert.equal(at("ship", { Boardsmith: idle, Release: idle, "Checker 2": idle }, { behindMain: true, headSha12: "abcdef012345" })[0].role, "Boardsmith", "behind main: the owner's re-cut");
});

test("a role name the map holds that is not a plain name is ignored", () => {
  assert.equal(reviewerOf({}, { "flight-board": "<b>" }), undefined);
  assert.equal(reviewerOf({}, { "flight-board": 7 }), undefined);
  assert.equal(reviewerOf({}, { "flight-board": "x".repeat(25) }), undefined);
  assert.equal(reviewerOf({}, REVIEWERS), "Checker 2");
});

test("the Worker's reading equals the dispatch's (reviewerFor) for every repository word, once the role is on the roster", () => {
  const roster = ["Checker", "Checker 2", "Checker 3"];
  for (const repo of [undefined, "", "flight-board", "board", "product-app", "other"]) {
    for (const reviewers of [REVIEWERS, { "flight-board": "Checker 2", "product-app": "Checker" }, { "product-app": "Checker 3" }, {}, null]) {
      assert.equal(reviewerOf({ repo }, reviewers), reviewerFor({ repo }, reviewers, roster), `${repo} ${JSON.stringify(reviewers)}`);
    }
  }
});

test("the evidence key: the store takes { reviewers: { word: role } } up to 20, from the probe only, and refuses any other shape", () => {
  assert.equal(evidenceRefusal("reviewers", { reviewers: REVIEWERS }, "probe"), null);
  assert.equal(evidenceRefusal("reviewers", { reviewers: {} }, "probe"), null, "an empty map is the way to take an entry out");
  assert.ok(evidenceRefusal("reviewers", { reviewers: REVIEWERS }, "Builder"), "only the probe writes evidence");
  const bad = [null, [], "x", {}, { reviewers: [] }, { reviewers: { "flight board": "Checker 2" } }, { reviewers: { "flight-board": "<b>" } }, { reviewers: { "flight-board": 2 } }, { reviewers: REVIEWERS, extra: 1 }, { reviewers: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`r${i}`, "Checker"])) }];
  for (const v of bad) { assert.equal(reviewersShape(v), false, JSON.stringify(v)); assert.equal(evidenceRefusal("reviewers", v, "probe")?.rule ?? evidenceRefusal("reviewers", v, "probe")?.refused?.rule, "reviewers-shape", JSON.stringify(v)); }
});

test("the probe posts the config's collector.reviewers under the key reviewers: an empty map when none, nothing when the config or the map is unreadable", () => {
  const logs = [];
  assert.deepEqual(reviewersWrite(JSON.stringify({ collector: { reviewers: REVIEWERS } })), { key: "reviewers", value: { reviewers: REVIEWERS } });
  assert.deepEqual(reviewersWrite(JSON.stringify({ collector: {} })), { key: "reviewers", value: { reviewers: {} } }, "none set: an empty map, so an entry taken out stops counting");
  assert.deepEqual(reviewersWrite(JSON.stringify({})), { key: "reviewers", value: { reviewers: {} } });
  assert.equal(reviewersWrite("not json", { log: (l) => logs.push(l) }), null);
  for (const reviewers of [["Checker 2"], "Checker 2", { "flight-board": 2 }, { "flight board": "Checker 2" }, { "flight-board": "x\ny" }, null]) assert.equal(reviewersWrite(JSON.stringify({ collector: { reviewers } }), { log: (l) => logs.push(l) }), null, JSON.stringify(reviewers));
  assert.ok(logs.length >= 6, logs.join("\n"));
});

test("the evidence job posts reviewers with the config it reads, and nothing when the config cannot be read (the store keeps its last map)", async () => {
  const CONFIG = JSON.stringify({ collector: { repoPath: "/r", reviewers: REVIEWERS } });
  const read = (cfg) => (p) => { if (p === "/c") { if (cfg === null) throw new Error("none"); return cfg; } if (p === "/s/state.json") return JSON.stringify({ v: 1, board: { boardId: "b", at: 1 }, cards: {}, agents: {} }); throw new Error("none"); };
  const posted = [];
  const run = (cfg) => evidenceJob({
    job: "evidence", base: "https://x.example", headers: {}, configPath: "/c", stateFile: "/s/state.json", build: async () => {}, read: read(cfg), ghCheck: () => true,
    deployRead: async () => ({ worker: "", tree: "" }), liveFetch: async () => ({ ok: false, status: 500 }), log: () => {},
    fetchImpl: async (url, o) => { posted.push(JSON.parse(o.body)); return { ok: true, status: 200 }; }, e2e: { read: () => { throw new Error("none"); } },
  });
  await run(CONFIG);
  assert.deepEqual(posted.find((b) => b.key === "reviewers")?.value, { reviewers: REVIEWERS });
  posted.length = 0;
  await run(null);
  assert.equal(posted.some((b) => b.key === "reviewers"), false);
});

test("the store: with the probe's reviewers posted, a board card at review wakes the line for Checker 2; with none, for Checker", async () => {
  const lineFor = async (post) => {
    const db = makeDb();
    await createCard(db, T, "Manager", { id: "card-a", title: "A card", owner_role: "Boardsmith", repo: "flight-board" });
    await writeEvidence(db, T, "probe", "cards.card-a", { lit: ["checker"], phase: "checker", ci: "none" });
    await writeEvidence(db, T, "probe", "agents", { Checker: idle, "Checker 2": idle });
    if (post) assert.equal((await writeEvidence(db, T, "probe", "reviewers", { reviewers: REVIEWERS })).ok, true);
    await db.prepare("UPDATE evidence SET read_at = ? WHERE key LIKE 'cards.%'").bind(NOW).run();
    await wakeAsk(db, NOW);
    return (await takeInbox(db, NOW + MIN)).stalls.map((s) => s.reason).filter((r) => /waits at Checker/.test(r));
  };
  const withMap = await lineFor(true);
  assert.equal(withMap.length, 1); assert.match(withMap[0], /, Checker 2 idle since /);
  const without = await lineFor(false);
  assert.equal(without.length, 1); assert.match(without[0], /, Checker idle since /);
});
