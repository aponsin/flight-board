// #C1382: two facts the card row relies on, held where they are decided (worker/reading.mjs).
// (1) `pack` is the pack's number as a plain word ("pc111"), set only for a board card at the pack or install wait, null everywhere else, so the page never reads the evidence for it.
// (2) A session on a card that has pushed nothing is working on it (the contract's state order puts working before queued); nobody on it is queued.
import test from "node:test";
import assert from "node:assert/strict";
import { reading } from "../worker/reading.mjs";

const NOW = 1_795_208_000_000;
const card = (over = {}) => ({ id: "c-1", num: 1, owner_role: "Builder", repo: "flight-board", ...over });
const board = { reviewers: undefined };
const landed = (over = {}) => ({ phase: "ship", headSha12: "a1b2c3d4e5f6", headSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", signed: ["checker", "security"], onMain: true, at: NOW - 1000, ...over });
const read = (c, e, agents = {}) => reading(c, e, [], agents, board, NOW, {});

test("pack is 'pc<N>' at a board card's pack or install wait, null otherwise", () => {
  const atPack = read(card(), landed({ pack: 111, packed: false }));
  assert.equal(atPack.wait, "pack");
  assert.equal(atPack.pack, "pc111", "a number the probe read is named at the pack wait too");
  const atInstall = read(card(), landed({ pack: 111, packed: true, installed: false }));
  assert.equal(atInstall.wait, "install");
  assert.equal(atInstall.pack, "pc111");
  const noNumber = read(card(), landed({ packed: true, installed: false }));
  assert.equal(noNumber.wait, "install");
  assert.equal(noNumber.pack, null);
});

test("pack is only a small whole number, never a word the evidence made up, and never on a card that has no pack wait", () => {
  for (const bad of [0, -3, 1.5, 1e6, "7", "pc9", "<b>1</b>", null, undefined, NaN]) {
    const r = read(card(), landed({ pack: bad, packed: true, installed: false }));
    assert.equal(r.pack, null, `pack ${String(bad)}`);
  }
  const working = read(card(), { ...landed({ pack: 111, packed: true, installed: false }), phase: "build", onMain: false, signed: [] }, {});
  assert.notEqual(working.wait, "install");
  assert.equal(working.pack, null, "a card not at the pack or install wait carries no number");
});

test("a session on a card with no push of its own is working; nobody on it is queued", () => {
  const working = read(card(), undefined, { Builder: { state: "working", card: "c-1" } });
  assert.equal(working.state, "working");
  assert.equal(working.working, true);
  assert.equal(working.with, "Builder");
  const idle = read(card(), undefined, { Builder: { state: "idle" } });
  assert.equal(idle.state, "queued");
  assert.equal(idle.working, false);
  const elsewhere = read(card(), undefined, { Builder: { state: "working", card: "c-other" } });
  assert.equal(elsewhere.state, "queued");
  assert.equal(elsewhere.wait, "turn", "its owner is on another card: it waits its turn");
});
