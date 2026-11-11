// #C859 slice 1: one stack switch per repository in the store. The owner alone writes it; the store records who and when; the view carries it;
// the board repository is on and the product off until the owner says otherwise.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { setStackSwitch, readView } from "../worker/board-store.mjs";
import { stackSwitchRefusal } from "../worker/board-rules.mjs";

const T = 1_800_000_000_000;
const call = async (env, who, role, name, args) => {
  const auth = async () => ({ who, role });
  const r = await worker.fetch(new Request("https://b.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), env, null, T + 9000, auth);
  return r.json();
};

test("the view carries the switches: the board on, the product off, both by default", async () => {
  const db = makeDb();
  const v = await readView(db, T);
  assert.deepEqual(v.stackSwitch, [
    { repo: "board", stack: true, set_by: "default", set_at: 0 },
    { repo: "product", stack: false, set_by: "default", set_at: 0 },
  ]);
});

test("the owner flips a switch: recorded with who and when, and a repository with no row can be set", async () => {
  const db = makeDb();
  assert.deepEqual(await setStackSwitch(db, T + 1, "owner", { repo: "product", stack: true }), { ok: true, repo: "product", stack: true });
  assert.deepEqual(await setStackSwitch(db, T + 2, "owner", { repo: "site-one", stack: true }), { ok: true, repo: "site-one", stack: true });
  const v = (await readView(db, T + 3)).stackSwitch;
  assert.deepEqual(v.find((r) => r.repo === "product"), { repo: "product", stack: true, set_by: "owner", set_at: T + 1 });
  assert.deepEqual(v.find((r) => r.repo === "site-one"), { repo: "site-one", stack: true, set_by: "owner", set_at: T + 2 });
  await setStackSwitch(db, T + 4, "owner", { repo: "board", stack: false });
  assert.equal((await readView(db, T + 5)).stackSwitch.find((r) => r.repo === "board").stack, false, "off again");
});

test("nobody else writes it: an agent, Manager and the probe are refused and logged, and nothing changes", async () => {
  const db = makeDb();
  for (const who of ["Manager", "Builder", "probe", undefined, "Owner"]) {
    const r = await setStackSwitch(db, T + 1, who, { repo: "product", stack: true });
    assert.equal(r.ok, false, String(who));
    assert.equal(r.refused.rule, "stack-switch-owner");
  }
  assert.equal((await readView(db, T + 2)).stackSwitch.find((r) => r.repo === "product").stack, false);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM refusals WHERE rule = 'stack-switch-owner'").first()).n, 5, "each refusal is in the log");
});

test("the shape is checked: a repository is a short lower-case word, the switch is true or false, nothing else rides along", () => {
  assert.equal(stackSwitchRefusal({ repo: "board", stack: true }, "owner"), null);
  for (const bad of [null, [], { repo: "Board", stack: true }, { repo: "board", stack: "yes" }, { repo: "board", stack: 1 }, { repo: "", stack: true }, { repo: "a".repeat(40), stack: true }, { repo: "board; drop", stack: true }, { repo: "board", stack: true, extra: 1 }, { stack: true }]) {
    assert.equal(stackSwitchRefusal(bad, "owner")?.rule, "stack-switch-shape", JSON.stringify(bad));
  }
});

test("the typed tool is the owner's alone: an agent calling it is refused by role; the owner's call writes", async () => {
  const db = makeDb();
  const env = { DB: db };
  const agent = await call(env, "Builder", "agent", "set_stack_switch", { repo: "product", stack: true });
  assert.ok(agent.error || agent.result?.isError, "an agent cannot call it");
  assert.equal((await readView(db, T)).stackSwitch.find((r) => r.repo === "product").stack, false);
  const owner = await call(env, "owner", "owner", "set_stack_switch", { repo: "product", stack: true });
  assert.equal(owner.result?.structuredContent?.ok, true);
  assert.equal((await readView(db, T)).stackSwitch.find((r) => r.repo === "product").stack, true);
});

test("the page's route /api/stack-switch is the owner's: the owner writes, anyone else gets 403", async () => {
  const db = makeDb();
  const post = (role, who, body) => worker.fetch(new Request("https://b.test/api/stack-switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { DB: db }, null, T + 9000, async () => ({ who, role }));
  assert.equal((await post("agent", "Builder", { repo: "product", stack: true })).status, 403);
  const ok = await post("owner", "owner", { repo: "product", stack: true });
  assert.equal(ok.status, 200);
  assert.equal((await readView(db, T)).stackSwitch.find((r) => r.repo === "product").stack, true);
  assert.equal((await post("owner", "owner", { repo: "Bad Repo", stack: true })).status, 422);
});
