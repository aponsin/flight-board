// #C1370: tests/threads.test.mjs crashed node (SIGSEGV in a V8 mark-compact GC that ran inside vm.Script::Run, node 24.21.0, about one run in ten under load, with no
// test output) because every loadNames call compiled and ran the whole page script; the harness now compiles the page once per run and runs it in each new context.
// The crash itself cannot be asserted; these hold what the change must not break: each call is its own world, and what is exposed is what was asked for.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

test("two loads are two worlds: a change to one's state is not in the other's, and the page's own listeners and elements are per load", () => {
  const a = loadNames(["state", "renderAll"]), b = loadNames(["state", "renderAll"]);
  assert.notEqual(a.state, b.state, "the page script ran again in the new context, so each has its own state");
  a.state.waiting = [{ id: "only-in-a" }];
  assert.equal((b.state.waiting ?? []).length, 0, "b did not see a's change"); // a vm array has the context's own prototype: compare by length, not deepEqual
  assert.notEqual(a.els, b.els);
  assert.notEqual(a.listeners, b.listeners);
});

test("what is exposed is what was named: a different list of names on the same page gives a different set, and an unknown name still throws", () => {
  const a = loadNames(["renderAll"]), b = loadNames(["youItems", "tabCounts"]);
  assert.equal(typeof a.renderAll, "function");
  assert.equal(a.youItems, undefined, "not named, not exposed");
  assert.equal(typeof b.youItems, "function");
  assert.equal(typeof b.tabCounts, "function");
  assert.equal(b.renderAll, undefined);
  assert.throws(() => loadNames(["noSuchFunctionOnThePage"]), (e) => e.name === "ReferenceError" && /noSuchFunctionOnThePage/.test(e.message)); // the context's own ReferenceError class
  // and a throw leaves the next load whole
  assert.equal(typeof loadNames(["renderAll"]).renderAll, "function");
});

test("globals laid over the default world reach only that load", () => {
  const given = loadNames(["state", "marker"], { marker: "mine" });
  assert.equal(given.marker, "mine", "the global is in that load's world");
  assert.throws(() => loadNames(["state", "marker"]), (e) => e.name === "ReferenceError", "and not in the next load's: the compiled page does not carry it over");
});
