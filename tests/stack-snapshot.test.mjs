// #C859 slice 2: the probe's read of the store carries the stack switches to the evidence job, in a file beside the private mirror.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeSnapshot, storeCards, prepareStoreState } from "../collector/store-cards.mjs";
import { STACK_SWITCH_FILE } from "../collector/stack.mjs";

const view = (extra = {}) => ({ cards: [{ id: "card-a", title: "A", num: 1 }, { id: "Bad Id", title: "x" }], ...extra });
const fetchOf = (body, status = 200) => async () => ({ ok: status === 200, status, json: async () => body });

test("the snapshot returns the cards and the switches; a bad switch row is dropped; an older Worker with none reads as none", async () => {
  const s = await storeSnapshot({ base: "https://b.test", headers: {}, fetchImpl: fetchOf(view({ stackSwitch: [{ repo: "flight-board", stack: true }, { repo: "product", stack: false }, { repo: "Bad Repo", stack: true }, { repo: "x", stack: "yes" }, null] })) });
  assert.deepEqual(s.cards.map((c) => c.id), ["card-a"]);
  assert.deepEqual(s.stackSwitch, { "flight-board": true, product: false });
  assert.deepEqual((await storeSnapshot({ base: "https://b.test", headers: {}, fetchImpl: fetchOf(view()) })).stackSwitch, {});
  assert.deepEqual((await storeCards({ base: "https://b.test", headers: {}, fetchImpl: fetchOf(view()) })).map((c) => c.id), ["card-a"], "storeCards is unchanged");
  await assert.rejects(storeSnapshot({ base: "https://b.test", headers: {}, fetchImpl: fetchOf({}, 500) }), /view answered 500/);
});

test("prepareStoreState writes the switches beside the mirror for the evidence job to read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-snap-"));
  const privateDir = join(dir, "private"), old = join(dir, "old", "TestBoard01");
  mkdirSync(old, { recursive: true }); mkdirSync(privateDir, { recursive: true });
  const config = join(dir, "board.config.json");
  writeFileSync(config, JSON.stringify({ gate: {} }));
  const r = await prepareStoreState({ privateDir, stateFile: join(old, "state.json"), configPath: config, base: "https://b.test", headers: {}, fetchImpl: fetchOf(view({ stackSwitch: [{ repo: "flight-board", stack: true }] })), now: 1234 });
  assert.equal(r.cards.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(privateDir, "TestBoard01", STACK_SWITCH_FILE), "utf8")), { at: 1234, switches: { "flight-board": true } });
});
