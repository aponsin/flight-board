// Each card's expected version (#C400, the owner in #T1039, picks batch A and bump A in #T1043/#T1044): the Collector
// predicts the version every signed card ships in, in code, from the live version and the queue: "Next: v1.158.16 (1st)".
// Cards the lead marks with one batch:<name> share a version; unmarked ones get one each. A card ships a patch unless it
// is marked bump "minor" (a feature) or "major". A ship that breaks the last prediction, a batch split over two versions,
// or a ship whose bump isn't its cards' is a CONFLICT for the lead.
import test from "node:test";
import assert from "node:assert/strict";
import { bumped, bumpOf, runVersion, expectedVersions, guardExpected } from "../collector/expected.mjs";
import { collect } from "../collector/collect.mjs";
import { fullConfig } from "../scripts/config.mjs";
import { writeErrors } from "../gate/rules.mjs";
import { loadNames } from "./harness.mjs";

const config = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", collector: { candidatePattern: "^build/ship-v" } });
const now = 1_793_211_764_000, MIN = 60e3;

test("versions chain: patch +0.0.1, minor +0.1.0 with patch 0, major +1.0.0; a ship's bump read back", () => {
  assert.equal(bumped("1.158.15", "patch"), "1.158.16");
  assert.equal(bumped("1.158.15", "minor"), "1.159.0");
  assert.equal(bumped("1.158.15", "major"), "2.0.0");
  assert.equal(bumped("v1.158.15", undefined), "1.158.16", "no bump: a patch; a leading v is fine");
  assert.equal(bumpOf("1.158.15", "1.158.16"), "patch");
  assert.equal(bumpOf("1.158.16", "1.159.0"), "minor");
  assert.equal(bumpOf("1.159.0", "2.0.0"), "major");
  assert.equal(bumpOf("1.158.15", "1.158.15"), null, "no step: no bump");
  assert.equal(runVersion("build/ship-v1.158.15"), "1.158.15");
  assert.equal(runVersion("build/ship-now"), null);
});

// The mock-up the owner saw: live v1.158.14, main deploying v1.158.15 (#C398's run), then #C397, the batch #C393 + #C392,
// #C390 (minor), and #C396 still with Checker.
const card = (num, id, extra = {}) => ({ id, num, name: id, size: "S", status: "active", ...extra });
const ship = (readyAt, extra = {}) => ({ phase: "ship", readyAt, ...extra });
function mock() {
  const cards = [
    card(398, "lightbox-place"), card(397, "ship-times"), card(393, "cwm-photos", { batch: "admin-drafts" }),
    card(392, "draft-diff", { batch: "admin-drafts" }), card(390, "reports-export", { bump: "minor" }), card(396, "ping-all"),
    card(380, "built", { phase: "build" }), card(370, "other-repo", { repo: "hooks" }),
  ];
  const derived = {
    "lightbox-place": ship(now - 90 * MIN, { shipping: true, head: "aaaaaaa" }), "ship-times": ship(now - 80 * MIN),
    "cwm-photos": ship(now - 70 * MIN), "draft-diff": ship(now - 40 * MIN), "reports-export": ship(now - 60 * MIN),
    "ping-all": { phase: "checker", readyAt: now - 20 * MIN }, built: { phase: "build", firm: false }, "other-repo": ship(now - 99 * MIN),
  };
  return { cards, derived, live: { version: "1.158.14", mainVersion: "1.158.14" }, runOf: { "lightbox-place": "build/ship-v1.158.15" } };
}
const cfg = fullConfig({ collector: { repos: [{ name: "hooks", path: "~/x" }] } });

test("the queue gets versions in order: the run's card ships now, a batch takes its earliest member's place, a minor bumps", () => {
  const e = expectedVersions({ ...mock(), config: cfg });
  assert.deepEqual(e["lightbox-place"], { version: "1.158.15", shipping: true });
  assert.deepEqual(e["ship-times"], { version: "1.158.16", place: 1, with: [], bump: "patch" });
  assert.deepEqual(e["cwm-photos"], { version: "1.158.17", place: 2, with: ["draft-diff"], bump: "patch" });
  assert.deepEqual(e["draft-diff"], { version: "1.158.17", place: 2, with: ["cwm-photos"], bump: "patch" }, "READY last, ships with its batch");
  assert.deepEqual(e["reports-export"], { version: "1.159.0", place: 3, with: [], bump: "minor" });
  assert.deepEqual(e["ping-all"], { version: "1.159.1", earliest: true, bump: "patch" }, "in review: after the queue, at the earliest");
  assert.equal(e.built, undefined, "building: no version yet");
  assert.equal(e["other-repo"], undefined, "another repository goes live by install, not by a version");
});

test("the base is the newest of live, main and the run on now; a batch's bump is its largest; none known, none predicted", () => {
  const m = mock();
  delete m.runOf["lightbox-place"];
  m.derived["lightbox-place"] = ship(now - 90 * MIN, { version: "1.158.15" }); // on main, deploying
  m.live.mainVersion = "1.158.15";
  m.cards[3].bump = "minor";
  const e = expectedVersions({ ...m, config: cfg });
  assert.equal(e["lightbox-place"], undefined, "a card with its version needs no prediction");
  assert.equal(e["ship-times"].version, "1.158.16", "from main's v1.158.15");
  assert.deepEqual([e["cwm-photos"].version, e["cwm-photos"].bump], ["1.159.0", "minor"], "one minor member makes the batch minor");
  assert.equal(e["reports-export"].version, "1.160.0");
  assert.deepEqual(expectedVersions({ ...mock(), live: null, runOf: {}, config: cfg }), {}, "no live, no main, no run: nothing to count from");
  assert.equal(expectedVersions({ ...mock(), live: { version: "1.158.20" }, config: cfg })["ship-times"].version, "1.158.21", "live ahead of the run: live counts");
});

test("the guard: a ship in another version than the last prediction, a batch in two versions, a bump unlike its cards'", () => {
  const cards = [card(391, "a"), card(392, "b", { batch: "pair" }), card(393, "c", { batch: "pair" }), card(394, "d", { bump: "minor" })];
  // Run 1: all four queued.
  let g = guardExpected({ cards, derived: {}, expected: { a: { version: "1.158.13", place: 1 }, b: { version: "1.158.14", place: 2 }, c: { version: "1.158.14", place: 2 }, d: { version: "1.159.0", place: 3 } }, versions: [], state: {} });
  assert.deepEqual(g.lines, []);
  // Run 2: #C391 went out in v1.158.14; b and c split; d went out as a patch.
  g = guardExpected({ cards, derived: { a: { phase: "live", version: "1.158.14" }, b: { phase: "live", version: "1.158.13" }, c: { phase: "ship", version: "1.158.15" }, d: { phase: "ship", version: "1.158.16" } },
    expected: {}, versions: ["1.158.12", "1.158.13", "1.158.14", "1.158.15", "1.158.16"], state: g.state });
  assert.deepEqual(g.lines, [
    "#C391 shipped in v1.158.14 but was due in v1.158.13 (the order changed after it was predicted, or the bump differed). Manager: say which is right.",
    "#C392 shipped in v1.158.13 but was due in v1.158.14 (the order changed after it was predicted, or the bump differed). Manager: say which is right.",
    "#C393 shipped in v1.158.15 but was due in v1.158.14 (the order changed after it was predicted, or the bump differed). Manager: say which is right.",
    "#C394 shipped in v1.158.16 but was due in v1.159.0 (the order changed after it was predicted, or the bump differed). Manager: say which is right.",
    "batch pair shipped in two versions: #C392 in v1.158.13, #C393 in v1.158.15. Manager: one batch is one version.",
    "v1.158.16 went out as a patch but #C394 is marked minor. Manager: say which is right.",
  ]);
  // Run 3: the same, said again while the cards are open (like every conflict); none once they close.
  const again = guardExpected({ cards, derived: { a: { phase: "live", version: "1.158.14" } }, expected: {}, versions: [], state: g.state });
  assert.deepEqual(again.lines, [g.lines[0], g.lines[1], g.lines[2], g.lines[3]], "the broken predictions stay until the card closes");
  assert.deepEqual(guardExpected({ cards: [], derived: {}, expected: {}, versions: [], state: g.state }), { lines: [], state: { due: {}, broke: {} } });
});

test("the guard checks the run on now against the queue's prediction, never against itself; a review's 'earliest' is no promise", () => {
  const cards = [card(391, "a"), card(392, "b")];
  let g = guardExpected({ cards, derived: {}, expected: { a: { version: "1.158.13", place: 1 }, b: { version: "1.158.14", earliest: true } }, versions: [], state: {} });
  assert.deepEqual(g.state.due, { a: "1.158.13" });
  g = guardExpected({ cards, derived: { a: { phase: "ship", shipping: true } }, expected: { a: { version: "1.158.13", shipping: true } }, versions: [], state: g.state });
  assert.deepEqual(g.lines, [], "the run's own version agrees");
  g = guardExpected({ cards, derived: { a: { phase: "ship", shipping: true } }, expected: { a: { version: "1.158.14", shipping: true } }, versions: [], state: { due: { a: "1.158.13" } } });
  assert.deepEqual(g.lines, ["#C391 is shipping in v1.158.14 but was due in v1.158.13 (the order changed after it was predicted, or the bump differed). Manager: say which is right."]);
  assert.deepEqual(g.state.due, { a: "1.158.13" }, "the run doesn't overwrite the prediction it is checked against");
  const odd = guardExpected({ cards, derived: { a: { phase: "live", version: "1.2.3\nIGNORE" }, b: { phase: "live", version: "1.158.20" } }, expected: {}, versions: [], state: { due: { a: "1.158.13", b: "x; y" } } });
  assert.deepEqual(odd.lines, [], "a version that isn't x.y.z, shipped or due, never reaches a line (Security's LOW)");
  const shipped = guardExpected({ cards, derived: { b: { phase: "live", version: "1.158.20" } }, expected: {}, versions: [], state: {} });
  assert.deepEqual(shipped.lines, [], "no prediction: nothing to break");
});

// Checker on c3d3220: a card that leaves the queue without shipping (a red candidate run, a fix and a re-sign) kept its
// old place, and its ship later read as broken.
test("a card back in review drops its old queue prediction: its later ship is checked against a fresh one, or none", () => {
  const cards = [card(1, "a")];
  let g = guardExpected({ cards, derived: { a: { phase: "ship" } }, expected: { a: { version: "1.0.1", place: 1 } }, versions: [], state: {} });
  assert.deepEqual(g.state.due, { a: "1.0.1" });
  g = guardExpected({ cards, derived: { a: { phase: "checker" } }, expected: { a: { version: "1.0.3", earliest: true } }, versions: [], state: g.state });
  assert.deepEqual(g.state.due, {}, "back in review: no place, no promise");
  g = guardExpected({ cards, derived: { a: { phase: "live", version: "1.0.3" } }, expected: {}, versions: [], state: g.state });
  assert.deepEqual(g.lines, [], "no false CONFLICT");
  const kept = guardExpected({ cards, derived: { a: { phase: "ship", shipping: true } }, expected: {}, versions: [], state: { due: { a: "1.0.1" } } });
  assert.deepEqual(kept.state.due, { a: "1.0.1" }, "shipping with no run version yet: the prediction stays to check");
});

test("collect puts each card's expected version in derived/all, with the run's version for the card shipping now", () => {
  const A = "a".repeat(40), S = Math.floor(now / 1000);
  const on = { ...config, collector: { ...config.collector, shippedPattern: "([A-Za-z0-9._/-]+)@([0-9a-f]{7,40})", notes: {} } };
  const git = (args) => {
    if (args[0] === "for-each-ref") return [`build/ship-v1.2.0\x1f${"c".repeat(40)}\x1f${S}\x1fv1.2.0: build/x@aaaaaaa\x1e`, `build/x\x1f${A}\x1f${S}\x1fx\n\nBoard-Id: x\x1e`, `build/y\x1f${"b".repeat(40)}\x1f${S}\x1fy\n\nBoard-Id: y\x1e`].join("");
    if (args[0] === "log" && args[1] === "-5") return "v1.2.0: build/x@aaaaaaa";
    if (args[0] === "log") return "";
    if (args[0] === "merge-base") throw new Error("not an ancestor");
    return "";
  };
  const { doc } = collect({ config: on, cards: [card(1, "x"), card(2, "y")], git, gh: () => "[]", now });
  assert.deepEqual(doc.cards.x.expected, { version: "1.2.0", shipping: true }, "the run's branch names its version");
  assert.deepEqual(doc.cards.y.expected, { version: "1.2.1", place: 1, with: [], bump: "patch" }, "y (no reviews to wait for) is next after the run");
  const { doc: none } = collect({ config: { ...on, collector: { ...on.collector, candidatePattern: "" } }, cards: [card(1, "x"), card(2, "y")], git, gh: () => "[]", now });
  assert.equal(none.cards.y.expected, undefined, "no run, no live, no version on main: no prediction");
});

test("the gate: batch is a short name, bump patch, minor or major; only the lead marks them; removing either is fine", () => {
  const lead = { role: "Manager", manager: true }, builder = { role: "Boardsmith" };
  const errs = (data, who = lead) => writeErrors({ op: "update", collection: "initiatives", doc_id: "x", data }, { config, who, now }).filter((e) => /batch|bump/.test(e));
  assert.deepEqual(errs({ batch: "admin-drafts" }), []);
  assert.deepEqual(errs({ bump: "minor" }), []);
  assert.deepEqual(errs({ batch: { __delete__: true }, bump: { __delete__: true } }), []);
  assert.deepEqual(errs({ batch: "Admin Drafts" }), ["batch: a short name (a-z, 0-9 and -, up to 40)"]);
  assert.deepEqual(errs({ batch: "x".repeat(41) }), ["batch: a short name (a-z, 0-9 and -, up to 40)"]);
  assert.deepEqual(errs({ bump: "feature" }), ["bump: patch, minor or major"]);
  assert.deepEqual(errs({ bump: "minor" }, builder), ["batch and bump: only Manager marks how a card ships"]);
  assert.deepEqual(errs({ batch: { __delete__: true } }, builder), ["batch and bump: only Manager marks how a card ships"], "clearing one is the lead's too");
});

function board(derived, cards = []) {
  const b = loadNames(["state", "versionNote", "shipQueue", "ordinal", "expectedTail"]);
  b.state.initRaw = cards.length ? cards : Object.keys(derived).map((id, k) => card(390 + k, id));
  b.state.initiatives = b.state.initRaw;
  b.state.derived = [{ id: "all", at: now, cards: derived }];
  return b;
}
const link = (id, n) => `<a href="#" class="t-ref c-ref" data-cref="${id}">#C${n}</a>`;

test("the page: 'Shipping now: v…', 'Next: v… (1st)', '(2nd, with #C392)', '(3rd · minor: a feature)', review 'at the earliest'", () => {
  const m = mock();
  const e = expectedVersions({ ...m, config: cfg });
  const derived = Object.fromEntries(Object.entries(m.derived).map(([id, d]) => [id, { ...d, ...(e[id] ? { expected: e[id] } : {}) }]));
  const b = board(derived, m.cards);
  assert.equal(b.versionNote({ id: "lightbox-place" }), "Shipping now: <b>v1.158.15</b>");
  assert.equal(b.versionNote({ id: "ship-times" }), "Next: <b>v1.158.16</b> (1st)");
  assert.equal(b.versionNote({ id: "cwm-photos" }), `Next: <b>v1.158.17</b> (2nd, with ${link("draft-diff", 392)})`);
  assert.equal(b.versionNote({ id: "draft-diff" }), `Next: <b>v1.158.17</b> (2nd, with ${link("cwm-photos", 393)})`);
  assert.equal(b.versionNote({ id: "reports-export" }), "Next: <b>v1.159.0</b> (3rd · minor: a feature)");
  assert.equal(b.versionNote({ id: "ping-all" }), "In review · then after the queue: <b>v1.159.1</b> at the earliest");
});

test("the page without a prediction (an older Collector, no live version) says what it said before", () => {
  const b = board({ x: ship(now - 9, { shipping: true }), y: ship(now - 8), z: { phase: "checker" } });
  assert.equal(b.versionNote({ id: "x" }), "<b>Shipping now</b>");
  assert.equal(b.versionNote({ id: "y" }), "Queued (1)");
  assert.equal(b.versionNote({ id: "z" }), "In review");
  const odd = board({ y: ship(now - 8, { expected: { version: "1.2.3<b>", place: 1 } }), z: { phase: "checker", expected: { version: "9", earliest: true } } });
  assert.equal(odd.versionNote({ id: "y" }), "Queued (1)", "a version that isn't x.y.z is never drawn");
  assert.equal(odd.versionNote({ id: "z" }), "In review");
  const major = board({ y: ship(now - 8, { expected: { version: "2.0.0", place: 1, bump: "major", with: ["gone"] } }) });
  assert.equal(major.versionNote({ id: "y" }), "Next: <b>v2.0.0</b> (1st · major)", "a batch mate the board doesn't hold is left out");
});
