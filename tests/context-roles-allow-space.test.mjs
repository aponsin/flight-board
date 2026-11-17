// #C1117 (11-16 ~3:30 pm MT: "#C1115 waits at Checker 15 min, no session for Checker 2" while Checker 2 was reviewing it): the roster accepts "Checker 2", but
// collector.contextRoles allowed only letters, digits, _ and -, so "Checker 2" could not be listed and its session never reached the agents evidence. contextRoles now takes the
// same names as the roster: letters, digits, _ and -, and spaces inside (not at either end).
import test from "node:test";
import assert from "node:assert/strict";
import { checkConfig } from "../scripts/config.mjs";

const bad = (contextRoles) => checkConfig({ collector: { contextRoles } }).filter((e) => /contextRoles/.test(e));

test("a role name with a space and digits, like Checker 2, passes checkConfig; so do the plain names that passed before", () => {
  assert.deepEqual(bad(["Manager", "Checker 2", "Checker 12", "Boardsmith", "a-b_c", "x"]), []);
  assert.deepEqual(bad(["Checker 2"]), []);
  assert.deepEqual(bad([]), []);
  assert.deepEqual(checkConfig({ collector: {} }).filter((e) => /contextRoles/.test(e)), [], "unset is fine");
});

test("a name that starts or ends with a space, is empty, is too long, or carries another character is refused; so is a list that is not a list or is too long", () => {
  for (const r of [" Checker", "Checker ", " ", "", "Checker\t2", "Checker/2", "Check\ner", "x".repeat(61), "Checker 2!", 7, null]) assert.equal(bad([r]).length, 1, JSON.stringify(r));
  assert.equal(bad(["x".repeat(60)]).length, 0, "60 characters is the limit");
  assert.equal(bad("Checker 2").length, 1, "a string is not a list");
  assert.equal(bad(Array.from({ length: 41 }, (_, i) => `R ${i}`)).length, 1, "up to 40 names");
  assert.equal(bad(Array.from({ length: 40 }, (_, i) => `R ${i}`)).length, 0);
  assert.match(bad([" x"])[0], /spaces inside/, "the message says what is allowed");
});
