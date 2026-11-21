// #C1402 (11-20: after pc124 replaced pc123, the cards still read "pc123 · <owner>"; pc123 never ran): the pack a card is labelled with is the pack that carries or carried it.
// packOf (collector/pairs.mjs) named the OLDEST pair that holds the landing, ran or not. A pair that never ran and has a newer holder is replaced (make-pair starts each pair's list at the last
// pair that RAN, so the newer pair carries all of it). Now: the oldest holding pair that ran, else the newest holding pair (the one to install). And "waiting for install" ends when a holder's
// .done is read: installed is any holding pair that ran, and the Worker's wait for the card is then gone.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packOf, pairsIn } from "../collector/pairs.mjs";
import { waitOf } from "../worker/reading.mjs";

const H = (c) => c.repeat(40);
const LANDING = H("b"), P122 = H("a"), P123 = LANDING, P124 = H("c");
// A git whose only answer is `merge-base --is-ancestor <landing> <pin>`: 0 when the pin holds the landing (pc123's pin is the landing itself, pc124's descends from it), 1 otherwise.
const git = (args) => ({ status: args[0] === "merge-base" && [P123, P124].includes(args[3]) ? 0 : 1 });
const pairs = (ran) => [{ n: 124, sha: P124, ran: ran.includes(124) }, { n: 123, sha: P123, ran: ran.includes(123) }, { n: 122, sha: P122, ran: true }];

test("neither pc123 nor pc124 has run: the pack to install is pc124, the newer one; pc123 is replaced", () => {
  assert.deepEqual(packOf(pairs([]), LANDING, git), { packed: true, installed: false, pack: 124 });
});

test("only pc124 ran (pc123 never did): the card is installed, in pc124", () => {
  assert.deepEqual(packOf(pairs([124]), LANDING, git), { packed: true, installed: true, pack: 124 });
});

test("both ran, pc123 first: the pack the card rode in is pc123, the oldest that ran", () => {
  assert.deepEqual(packOf(pairs([123, 124]), LANDING, git), { packed: true, installed: true, pack: 123 });
});

test("only pc123 ran: installed, in pc123", () => {
  assert.deepEqual(packOf(pairs([123]), LANDING, git), { packed: true, installed: true, pack: 123 });
});

test("a pair below the landing never names the card: pc122 ran, no holder did, so pc124 is still the pack to install and the card is not installed", () => {
  const r = packOf(pairs([]), LANDING, git);
  assert.equal(r.installed, false);
  assert.equal(r.pack, 124);
  assert.deepEqual(packOf([{ n: 122, sha: P122, ran: true }], LANDING, git), { packed: false, installed: false });
});

test("one holder: its own number, whether it ran or not (unchanged)", () => {
  assert.deepEqual(packOf([{ n: 124, sha: P124, ran: false }], LANDING, git), { packed: true, installed: false, pack: 124 });
  assert.deepEqual(packOf([{ n: 124, sha: P124, ran: true }], LANDING, git), { packed: true, installed: true, pack: 124 });
});

test("from the pair folder: the .done marker is what installs, and the install wait ends with it", () => {
  const dir = mkdtempSync(join(tmpdir(), "pairs-"));
  try {
    for (const [n, sha] of [[122, P122], [123, P123], [124, P124]]) writeFileSync(join(dir, `board-store-deploy-pc${n}.mjs`), `const SIGNED = "${sha}";\n`);
    writeFileSync(join(dir, "board-store-deploy-pc122.done"), `${P122}\n`);
    const card = { id: "x" }, wait = (installed) => waitOf({ card, e: { onMain: true, packed: true, installed, headSha12: "bbbbbbbbbbbb" }, phase: "ship", kind: "board", now: 1_800_000_000_000, ctx: {} });
    // before: nothing of 123 or 124 ran
    let r = packOf(pairsIn(dir), LANDING, git);
    assert.deepEqual([r.pack, r.installed], [124, false]);
    assert.deepEqual(wait(r.installed), { kind: "install" }, "waiting for install");
    // a marker that holds some other sha is no install
    writeFileSync(join(dir, "board-store-deploy-pc124.done"), `${P123}\n`);
    assert.equal(packOf(pairsIn(dir), LANDING, git).installed, false, "a stray marker installs nothing");
    // pc124's marker with its own pin: installed, the wait is gone
    writeFileSync(join(dir, "board-store-deploy-pc124.done"), `${P124}\n`);
    r = packOf(pairsIn(dir), LANDING, git);
    assert.deepEqual([r.pack, r.installed], [124, true]);
    assert.equal(wait(r.installed), null, "no install wait once the .done is read");
    // and pc123's too (the owner ran both): the card rode in pc123
    writeFileSync(join(dir, "board-store-deploy-pc123.done"), `${P123}\n`);
    r = packOf(pairsIn(dir), LANDING, git);
    assert.deepEqual([r.pack, r.installed], [123, true]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
