// A review only some cards need (a designer's, on a look change): the skip kind unlessTrue.
import test from "node:test";
import assert from "node:assert/strict";
import { fullConfig, checkConfig } from "../scripts/config.mjs";
import { reviewsFor } from "../collector/derive.mjs";
import { step } from "./harness.mjs";
import { buildPage } from "../scripts/build-page.mjs";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const base = { artifactUrl: "https://claude.ai/" + "artifact/TestBoard01" };
const phases = [["plan", "Plan"], ["build", "Build"], ["test", "Test"], ["language", "Language"], ["design", "Design"], ["checker", "Checker"], ["security", "Security"], ["ship", "Ship"], ["live", "Live"]];
const skips = [{ phase: "security", unlessLevel: "Full" }, { phase: "language", whenFalse: "customerText" }, { phase: "design", unlessTrue: "lookChange" }];

test("the collector waits for the design review only on a card that says lookChange: true", () => {
  const config = fullConfig({ ...base, phases, skips, collector: { notes: { language: "refs/notes/linguist", design: "refs/notes/designer", checker: "refs/notes/checker", security: "refs/notes/security" } } });
  assert.deepEqual(reviewsFor({ level: "Quick", customerText: false, lookChange: true }, config), ["design", "checker"]);
  assert.deepEqual(reviewsFor({ level: "Quick", customerText: false }, config), ["checker"], "no field: no design review");
  assert.deepEqual(reviewsFor({ level: "Quick", customerText: false, lookChange: "yes" }, config), ["checker"], "only true counts");
});

test("the page skips the design box unless the card says lookChange: true", () => {
  const html = buildPage(readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8"), { ...base, phases, skips });
  const ctx = { document: { getElementById: () => ({ innerHTML: "", textContent: "", classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {} }), querySelectorAll: () => [], querySelector: () => null, addEventListener() {} }, window: {}, console, setInterval() {}, setTimeout() {}, queueMicrotask() {}, navigator: {}, Date, Math, JSON, Number, String, Array, Object, Set, Map, isFinite, URLSearchParams };
  vm.createContext(ctx);
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1] + "\n;globalThis.__b={state,enrich};", ctx);
  const b = ctx.__b;
  b.state.waiting = [];
  b.state.steps = [step("x", "build", "Builder", "start", Date.now() - 9e5), step("x", "build", "Builder", "end", Date.now() - 6e5)];
  const card = (fields) => b.enrich({ id: "x", level: "Quick", customerText: false, skip: ["plan"], status: "active", name: "X", ...fields });
  assert.ok(card({}).skip.includes("design"), "no field: skipped");
  assert.equal(card({}).phase, "checker");
  assert.ok(!card({ lookChange: true }).skip.includes("design"));
  assert.equal(card({ lookChange: true }).phase, "design", "a look change waits on the designer first");
});

test("the config takes exactly one skip kind, and unlessTrue names a card field", () => {
  assert.deepEqual(checkConfig({ ...base, phases, skips }).filter((p) => /skips/.test(p)), []);
  assert.ok(checkConfig({ ...base, phases, skips: [{ phase: "design", unlessTrue: "lookChange", whenFalse: "x" }] }).some((p) => /exactly one of unlessLevel, whenFalse or unlessTrue/.test(p)));
  assert.ok(checkConfig({ ...base, phases, skips: [{ phase: "design" }] }).some((p) => /exactly one of/.test(p)), "no kind at all");
  assert.ok(checkConfig({ ...base, phases, skips: [{ phase: "design", unlessTrue: "look change!" }] }).some((p) => /unlessTrue: a card field name/.test(p)));
});
