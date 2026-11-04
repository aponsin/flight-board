// Quiet for a known wait (#C682): a card that is open on purpose (it waits on a real test) used to wake the lead every probe run,
// because each batch of lines carries a new `at` and a CLOSE line repeated every 10 minutes. A line now prints once, and again only
// when its text changes (the card changed), when it left the batch and came back, or after LINE_AGAIN_MS; CLOSE likewise.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINES_FILE, LINES_SEEN_FILE, linesSeenFile, LINE_AGAIN_MS, CLOSE_AGAIN_MS, linesPending, linesSeen, truthPending, truthSeen } from "../gate/reset.mjs";
import { tick, roleTick } from "../scripts/wake-watch.mjs";

const MIN = 60e3, T = 1_000_000_000_000;
const ROSTER = ["Manager", "Builder"];
const folder = () => mkdtempSync(join(tmpdir(), "wake682-"));
const batch = (dir, lines, at) => writeFileSync(join(dir, LINES_FILE), JSON.stringify({ at, lines }));
const lead = (dir, now) => tick(dir, now, 4242, ROSTER, "Manager");

const WAIT = ["LIVE BUT OPEN (2): c674, c679", "CONFLICT c674: the card says build, the repository says live"];

test("the lead's watch prints a waiting card's lines once, not at every new batch", () => {
  const dir = folder();
  try {
    batch(dir, WAIT, T);
    assert.equal(lead(dir, T), WAIT.join("\n"), "the first look prints them");
    for (let i = 1; i <= 20; i++) {
      batch(dir, WAIT, T + i * 5 * MIN);
      assert.equal(lead(dir, T + i * 5 * MIN + 1000), null, `batch ${i}: the same lines, nothing`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the same lines print again once LINE_AGAIN_MS has passed since they were printed", () => {
  const dir = folder();
  try {
    batch(dir, WAIT, T);
    lead(dir, T);
    batch(dir, WAIT, T + LINE_AGAIN_MS - 10 * MIN);
    assert.equal(lead(dir, T + LINE_AGAIN_MS - 10 * MIN), null, "just under two hours: quiet");
    batch(dir, WAIT, T + LINE_AGAIN_MS + MIN);
    assert.equal(lead(dir, T + LINE_AGAIN_MS + MIN), WAIT.join("\n"), "two hours on: they print");
    batch(dir, WAIT, T + LINE_AGAIN_MS + 6 * MIN);
    assert.equal(lead(dir, T + LINE_AGAIN_MS + 6 * MIN), null, "and the two hours start again from there");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a line whose text changed prints at once, and the unchanged one beside it stays quiet", () => {
  const dir = folder();
  try {
    batch(dir, WAIT, T);
    lead(dir, T);
    const moved = [WAIT[0], "CONFLICT c674: the card says live, the repository says build"];
    batch(dir, moved, T + 5 * MIN);
    assert.equal(lead(dir, T + 5 * MIN), moved[1]);
    batch(dir, [...moved, "NUDGE c680 is late"], T + 10 * MIN);
    assert.equal(lead(dir, T + 10 * MIN), "NUDGE c680 is late", "a new card's line alone");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a line that left the batch and came back prints again", () => {
  const dir = folder();
  try {
    batch(dir, WAIT, T);
    lead(dir, T);
    batch(dir, [WAIT[0]], T + 5 * MIN);
    assert.equal(lead(dir, T + 5 * MIN), null);
    batch(dir, WAIT, T + 10 * MIN);
    assert.equal(lead(dir, T + 10 * MIN), WAIT[1], "the conflict is back after a batch without it");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an older seen file ({ at } alone) prints what is new once, then goes quiet", () => {
  const dir = folder();
  try {
    writeFileSync(join(dir, LINES_SEEN_FILE), JSON.stringify({ at: T - 5 * MIN }));
    batch(dir, WAIT, T);
    assert.equal(lead(dir, T), WAIT.join("\n"));
    batch(dir, WAIT, T + 5 * MIN);
    assert.equal(lead(dir, T + 5 * MIN), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an agent's own watch goes quiet the same way: it ends once per line, and a changed line ends it again", () => {
  const dir = folder();
  try {
    const mine = ["NUDGE @Builder c674 waits"];
    batch(dir, mine, T);
    assert.equal(roleTick(dir, "Builder", T, 4242), mine[0]);
    batch(dir, mine, T + 5 * MIN);
    assert.equal(roleTick(dir, "Builder", T + 5 * MIN, 4242), null);
    batch(dir, ["NUDGE @Builder c674 waits longer"], T + 10 * MIN);
    assert.equal(roleTick(dir, "Builder", T + 10 * MIN, 4242), "NUDGE @Builder c674 waits longer");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("linesPending: a held-back line keeps its printed time, and a line routed elsewhere is not recorded", () => {
  const file = { at: 2, lines: ["NUDGE a", "NUDGE @Builder b"] };
  const seen = linesSeen({ at: 1, lines: ["NUDGE a"] }, null, ["NUDGE a"], T);
  assert.deepEqual(linesPending(file, seen, { lead: "Manager", roster: ROSTER, away: [], now: T + MIN }), []);
  const next = linesSeen(file, seen, [], T + MIN);
  assert.deepEqual(next, { at: 2, lines: { "NUDGE a": T }, }, "the time of the print stays; the Builder's line is not the lead's");
});

test("the overdue nudge (#C441) is still printed every run, for the lead and for the card's agent", () => {
  const dir = folder();
  try {
    const own = "NUDGE overdue: c674 (ETA 10:00Z, phase build)", mine = "NUDGE @Builder overdue: c675 (ETA 10:00Z, phase build)";
    for (let i = 0; i < 3; i++) {
      batch(dir, [own], T + i * 5 * MIN);
      assert.equal(lead(dir, T + i * 5 * MIN), own, `lead, run ${i}`);
    }
    for (let i = 0; i < 3; i++) {
      batch(dir, [mine], T + (10 + i * 5) * MIN);
      assert.equal(roleTick(dir, "Builder", T + (10 + i * 5) * MIN, 4242), mine, `agent, run ${i}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a printed time in the future (a planted seen file, a clock set back) silences nothing: the line prints and is stamped with now (Security)", () => {
  const YEAR = 365 * 24 * 60 * MIN;
  const dir = folder();
  try {
    batch(dir, WAIT, T);
    writeFileSync(join(dir, LINES_SEEN_FILE), JSON.stringify({ at: T - MIN, lines: Object.fromEntries(WAIT.map((l) => [l, T + YEAR])) }));
    assert.equal(lead(dir, T), WAIT.join("\n"), "the lead prints them");
    const seen = JSON.parse(readFileSync(join(dir, LINES_SEEN_FILE), "utf8"));
    assert.deepEqual(seen.lines, Object.fromEntries(WAIT.map((l) => [l, T])), "and stamps them with now");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const dir2 = folder();
  try {
    const mine = "NUDGE @Builder c674 waits";
    batch(dir2, [mine], T);
    writeFileSync(join(dir2, linesSeenFile("Builder")), JSON.stringify({ at: T - MIN, lines: { [mine]: T + YEAR } }));
    assert.equal(roleTick(dir2, "Builder", T, 4242), mine, "the role's watch prints it");
    assert.deepEqual(JSON.parse(readFileSync(join(dir2, linesSeenFile("Builder")), "utf8")).lines, { [mine]: T });
  } finally { rmSync(dir2, { recursive: true, force: true }); }
});

test("CLOSE is printed once per tip and repeats after two hours, not every ten minutes", () => {
  assert.equal(CLOSE_AGAIN_MS, 2 * 3600e3);
  const asked = { items: [{ kind: "close", card: "c674", sha: "a1b2c3d4e5f6" }, { kind: "close", card: "c679", sha: "b1b2c3d4e5f6" }] };
  assert.equal(truthPending(asked, null, T).length, 2);
  const seen = truthSeen(asked, null, asked.items, T);
  assert.deepEqual(truthPending(asked, seen, T + 11 * MIN), [], "ten minutes on: quiet");
  assert.deepEqual(truthPending(asked, seen, T + CLOSE_AGAIN_MS - MIN), []);
  assert.equal(truthPending(asked, seen, T + CLOSE_AGAIN_MS).length, 2, "two hours on: again");
  const moved = { items: [{ kind: "close", card: "c674", sha: "ffffffffffff" }, asked.items[1]] };
  assert.deepEqual(truthPending(moved, seen, T + 12 * MIN).map((a) => a.card), ["c674"], "a new tip prints at once");
});
