// #C1295: the stack switch is per repository. The board's row switches the board's own cards, the product's row any other repository's cards, and a card reads
// only its own repository's row. With the product row on, a product group is built on one stacked branch, its reviewers are woken once for the tip, and the
// builder's stack-ready command works from a product checkout. With the product row off (the default) nothing a product card sees changes.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { dispatchRun } from "../collector/store-dispatch.mjs";
import { stackKeyOf, stackOnFor, stackSatisfies, dependsNotLive } from "../worker/board-rules.mjs";
import { stacksOn, productRepoNames } from "../collector/store-cards.mjs";
import { stackReady } from "../scripts/stack-ready.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, writeEvidence, wakeAsk, takeInbox, setStackSwitch } from "../worker/board-store.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const ROSTER = ["Manager", "Boardsmith", "Builder", "Checker", "Security", "Release"], LEAD = "Manager";
const idle = { state: "idle", lastActivityAt: NOW - 2 * MIN, since: NOW - 2 * MIN };
const prod = (id, extra = {}) => ({ id, num: Number(id.replace(/\D/g, "")) || null, owner_role: "Builder", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "platform", batch: "g1", ...extra });
const brd = (id, extra = {}) => ({ id, num: Number(id.replace(/\D/g, "")) || null, owner_role: "Boardsmith", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "flight-board", ...extra });
const dep = (...ids) => ({ depends_on: JSON.stringify(ids) });
const world = ({ cards, ev = {}, board = false, product = false }) => ({
  cards, asks: [], stackSwitch: [{ repo: "board", stack: board, set_by: "default", set_at: 0 }, { repo: "product", stack: product, set_by: "default", set_at: 0 }],
  evidence: { agents: { readAt: NOW - 5_000, value: Object.fromEntries(ROSTER.map((r) => [r, idle])) }, ...Object.fromEntries(Object.entries(ev).map(([id, v]) => [`cards.${id}`, { readAt: NOW - 5_000, value: v }])) },
});
const items = (v) => dispatchRun(v, { dir: mkdtempSync(join(tmpdir(), "pgs-")), roster: ROSTER, lead: LEAD, now: NOW }).items;
const who = (v) => items(v).map((i) => `${i.card}:${i.role}:${i.step}`).sort();
const TIP = "abcdef012345";
const inStack = (extra = {}) => ({ lit: ["checker"], phase: "checker", headSha12: "111111111111", signed: [], onMain: false, stack: { tip: TIP, size: 2, branch: "build/product-stack" }, ...extra });

test("the switch row a card reads is its own repository's: the board's own words read board, every other repository reads product", () => {
  assert.equal(stackKeyOf({ repo: "flight-board" }), "board");
  assert.equal(stackKeyOf({ repo: "someone/Board.git" }), "board");
  assert.equal(stackKeyOf({}), "board");
  assert.equal(stackKeyOf({ repo: "platform" }), "product");
  assert.equal(stackOnFor(new Set(["product"]), { repo: "platform" }), true);
  assert.equal(stackOnFor(new Set(["product"]), { repo: "flight-board" }), false, "the product's row does not switch a board card");
  assert.equal(stackOnFor(new Set(["board"]), { repo: "platform" }), false, "the board's row does not switch a product card");
  assert.equal(stackOnFor(true, { repo: "flight-board" }), true, "a plain boolean still means the board's row");
  assert.equal(stackOnFor(true, { repo: "platform" }), false);
  assert.equal(stackOnFor(false, { repo: "flight-board" }), false);
});

test("a pushed same-role dependency is satisfied only inside one stack-mode repository", () => {
  const a = prod("c1-a"), b = prod("c2-b", dep("c1-a")), other = brd("c3-board", { owner_role: "Builder", ...dep("c1-a") });
  assert.equal(stackSatisfies(new Set(["product"]), b, a), true);
  assert.equal(stackSatisfies(new Set(), b, a), false, "row off");
  assert.equal(stackSatisfies(new Set(["board"]), b, a), false, "the other repository's row");
  assert.equal(stackSatisfies(new Set(["product", "board"]), other, a), false, "a board card does not take a product card's push as its dependency");
  assert.equal(stackSatisfies(new Set(["product"]), b, { ...a, owner_role: "Boardsmith" }), false, "another role's card still has to be live");
  const pushed = { "c1-a": { headSha12: "111111111111" } };
  assert.equal(dependsNotLive(b, [a, b], pushed, new Set(["product"])), false);
  assert.equal(dependsNotLive(b, [a, b], pushed, new Set()), true);
  assert.equal(dependsNotLive(b, [a, b], pushed, false), true);
});

test("dispatch: with the product row on a product card's builder is told to push with stack-ready on the stack branch; the board's cards are untouched", () => {
  const v = world({ product: true, cards: [prod("c1-a"), prod("c2-b"), brd("c3-board")], ev: { "c1-a": inStack(), "c2-b": inStack({ phase: "build", lit: [] }) } });
  const build = items(v).filter((i) => i.step === "build");
  const b = build.find((i) => i.card === "c2-b");
  assert.equal(b.stackMode, true);
  assert.equal(b.stack, "build/product-stack");
  const board = build.find((i) => i.card === "c3-board");
  assert.equal(board.stackMode, undefined, "the board's row is off, so its card pushes as before");
  assert.equal(board.stack, undefined);
});

test("dispatch: with the product row off (the default) a product card sees no stack mode at all", () => {
  const v = world({ product: false, board: true, cards: [prod("c1-a"), prod("c2-b")], ev: { "c1-a": inStack(), "c2-b": inStack({ phase: "build", lit: [] }) } });
  const b = items(v).find((i) => i.card === "c2-b" && i.step === "build");
  assert.equal(b.stackMode, undefined);
  assert.equal(b.stack, undefined);
});

test("dispatch: a pushed dependency starts the next product card with the product row on, not with it off or with only the board's on", () => {
  const cards = [prod("c1-a"), prod("c2-b", dep("c1-a"))];
  const ev = { "c1-a": inStack() };
  assert.deepEqual(who(world({ product: true, cards, ev })).filter((s) => s.startsWith("c2-b")), ["c2-b:Builder:build"]);
  assert.deepEqual(who(world({ product: false, cards, ev })).filter((s) => s.startsWith("c2-b")), []);
  assert.deepEqual(who(world({ product: false, board: true, cards, ev })).filter((s) => s.startsWith("c2-b")), [], "the board's row does not switch a product card");
});

test("dispatch: a product stack's reviewers wait for the product builders only; a board card with a build turn does not hold them, and a product one does", () => {
  const tipCard = prod("c1-a");
  const withBoardBuilding = world({ product: true, board: true, cards: [tipCard, brd("c3-board")], ev: { "c1-a": inStack(), "c3-board": inStack({ phase: "build", lit: [], stack: { tip: TIP, size: 2, branch: "build/board-stack" } }) } });
  assert.ok(who(withBoardBuilding).includes("c1-a:Checker:review"), "the board's builder does not hold the product stack's review");
  const withProductBuilding = world({ product: true, cards: [tipCard, prod("c2-b")], ev: { "c1-a": inStack(), "c2-b": inStack({ phase: "build", lit: [] }) } });
  assert.ok(!who(withProductBuilding).some((s) => s.startsWith("c1-a:Checker")), "a product builder with a turn left holds the product stack's review");
  assert.ok(who(withProductBuilding).includes("c2-b:Builder:build"));
});

test("the probe's stack list: the board's row names the team's own repository, the product's row every other repository the config lists", () => {
  const sw = (board, product) => [{ repo: "board", stack: board }, { repo: "product", stack: product }];
  assert.deepEqual(stacksOn(sw(true, false), ["platform"]), [""]);
  assert.deepEqual(stacksOn(sw(false, true), ["platform"]), ["platform"]);
  assert.deepEqual(stacksOn(sw(true, true), ["platform", "site"]), ["", "platform", "site"]);
  assert.deepEqual(stacksOn(sw(false, false), ["platform"]), []);
  assert.deepEqual(stacksOn(sw(false, true), []), [], "no other repository listed: nothing to read");
  assert.deepEqual(stacksOn(sw(true, false)), [""], "called as before");
  const cfg = { collector: { repos: [{ name: "flight-board" }, { name: "platform" }, { name: "" }, {}] } };
  // #C1303: the board's own repository is listed, so "" (the clone at repoPath) is the product's: the product row switches it too. tests/product-stack-wiring.test.mjs holds both shapes.
  assert.deepEqual(productRepoNames(cfg), ["", "platform"]);
  assert.deepEqual(productRepoNames({}), []);
});

// ---- the Worker's own wiring: the stall line reads the switch row of the card's repository ----
const T = 1_800_000_000_000, SNOW = T + 30 * MIN;
const wpushed = (extra = {}) => ({ lit: ["checker"], phase: "checker", headSha12: "aaaaaaaaaaaa", ...extra });
async function storeLines(rows) {
  const db = makeDb();
  const mk = (id, extra) => createCard(db, T, "Manager", { id, title: id, owner_role: "Boardsmith", repo: "platform", ...extra }).then((r) => assert.ok(r.ok, id));
  await mk("c1-one", { batch: "g1-a", queue_pos: 1 }); await mk("c4-four", { queue_pos: 9 });
  await mk("c2-two", { batch: "g1-a", queue_pos: 2, depends_on: ["c4-four"] });
  await writeEvidence(db, T, "probe", "cards.c1-one", wpushed()); await writeEvidence(db, T, "probe", "cards.c4-four", wpushed({ headSha12: "123456abcdef" }));
  for (const [repo, stack] of rows) assert.ok((await setStackSwitch(db, T, "owner", { repo, stack })).ok);
  await writeEvidence(db, T, "probe", "agents", { Boardsmith: { state: "idle", tool: null, card: null, since: T } });
  await db.prepare("UPDATE evidence SET read_at = ? WHERE key LIKE 'cards.%'").bind(SNOW).run();
  await wakeAsk(db, SNOW);
  return (await takeInbox(db, SNOW + 1000)).stalls.map((s) => s.reason).filter((r) => /queued/.test(r));
}
test("the store: a product card's pushed same-role dependency is satisfied only with the product row on; the board's row alone does not", async () => {
  assert.deepEqual(await storeLines([["board", true], ["product", false]]), [], "product off, board on: c2 waits on c4, which is not live: nothing can start");
  assert.deepEqual(await storeLines([["board", false], ["product", false]]), []);
  const on = await storeLines([["board", false], ["product", true]]);
  assert.equal(on.length, 1); assert.match(on[0], /, 1 queued, next #C3$/, "c2-two is the third card created");
});

// ---- the builder's command from a product checkout ----
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function productCheckout() {
  const root = mkdtempSync(join(tmpdir(), "pgs-git-"));
  const origin = join(root, "origin.git"), wt = join(root, "wt");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, wt);
  git(wt, "config", "user.email", ["t", "example.test"].join("@")); git(wt, "config", "user.name", "t");
  writeFileSync(join(wt, "app.txt"), "one\n");
  git(wt, "add", "."); git(wt, "commit", "-q", "-m", "base"); git(wt, "push", "-q", "origin", "main");
  git(wt, "switch", "-q", "-c", "build/group");
  const commit = (id, file) => { writeFileSync(join(wt, file), `${id}\n`); git(wt, "add", "."); git(wt, "commit", "-q", "-m", `Card ${id}\n\nBoard-Id: ${id}`); };
  return { wt, commit, run: (a) => git(wt, ...a) };
}
const q = (cards) => ({ at: Date.parse("2026-11-19T12:00:00Z"), cards });
const now = () => "2026-11-19T12:01:00.000Z";
const row = (id, extra = {}) => ({ id, owner_role: "Builder", repo: "platform", dependsOn: [], batch: "g1", held: false, started: false, ...extra });

test("stack-ready runs in a product checkout (no docs/DATA.md there): it waits for its group, then signals once the group is built", () => {
  const { wt, commit, run } = productCheckout();
  commit("c1-a", "a.txt");
  const waiting = stackReady({ run, queue: q([row("c1-a"), row("c2-b")]), now });
  assert.equal(waiting.signal, false);
  assert.match(waiting.line, /waiting for its group g1 \(c2-b not built\)/);
  commit("c2-b", "b.txt");
  const done = stackReady({ run, queue: q([row("c1-a", { started: true }), row("c2-b")]), now });
  assert.equal(done.signal, true, done.line);
  assert.match(done.line, /signal written/);
  assert.equal(git(wt, "notes", "--ref=refs/notes/stack-ready", "list").split("\n").filter(Boolean).length, 1);
});
