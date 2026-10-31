// A scheduled run cut by an app restart blocks its task (#C427: the watchdog's 21:55Z run sat "running" for 6 hours,
// waiting on an approval, and every later run waited behind it). Every pack's restart step says to restart only when no
// scheduled run is in progress.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("README: every pack's restart step waits for no scheduled run in progress", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const rules = readme.slice(readme.indexOf("So every pack from then on:"), readme.indexOf("**What gates a collector change"));
  assert.match(rules, /- says, on its restart step, to restart only when no scheduled run is in progress: in the app's Scheduled tasks, no\s+task shows a run still going \(wait for it to finish first\)\./);
  assert.match(rules, /blocks every\s+later run of its task \(#C427/);
});

test("README: every pack checks its script's hash with a line that doesn't depend on spacing (#C515)", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const rules = readme.slice(readme.indexOf("So every pack from then on:"), readme.indexOf("**What gates a collector change"));
  assert.match(rules, /`if \[ "\$\(shasum -a 256 <file> \| cut -c1-64\)" = <hash> \]; then sh <file>; else echo 'CHECK FAILED:\s+nothing installed'; fi`/);
  assert.doesNotMatch(rules.replace(/\(#C515:[^)]*\)/, ""), /shasum -a 256 -c -/, "the old two-space form isn't the rule");
});
