// #C672: one window per role for the memory tiles. The config's contextWindows { Role: tokens } is the number the red-ask hook
// (tests/red-ask.test.mjs), the probe and the Collector divide a role's tokens by, so a tile never flips between two windows.
// Fictional roles.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkConfig, fullConfig } from "../scripts/config.mjs";
import { ctxReadings, windowOf, WINDOW_TOKENS } from "../collector/readings.mjs";

const NOW = 1_793_050_000_123;

test("config: contextWindows is { Role: whole tokens 100,000 to 2,000,000 }; empty by default; a bad one is refused", () => {
  assert.deepEqual(fullConfig({}).contextWindows, {});
  assert.deepEqual(checkConfig({ contextWindows: { Manager: 350000, Builder: 1000000 } }), []);
  assert.deepEqual(checkConfig({ contextWindows: {} }), []);
  const msg = /^contextWindows: \{ Role: whole tokens/;
  for (const bad of [{ Manager: "350000" }, { Manager: 99999 }, { Manager: 2000001 }, { Manager: 350000.5 }, { Manager: null }, { Manager: true }, { "bad role": 350000 }, { "": 350000 }, [350000], "350000", 350000, null]) {
    const e = checkConfig({ contextWindows: bad });
    assert.equal(e.length, 1, JSON.stringify(bad));
    assert.match(e[0], msg, JSON.stringify(bad));
  }
  const many = Object.fromEntries(Array.from({ length: 41 }, (_, k) => [`R${k}`, 350000]));
  assert.equal(checkConfig({ contextWindows: many }).length, 1, "more than 40 roles");
});

test("the probe: a listed role is worked against its own window, the others against 1,000,000", () => {
  const tokens = { Manager: 175000, Builder: 175000 };
  const none = ctxReadings({ tokens, resetAt: 600000, now: NOW });
  assert.equal(none.Manager.pct, 18);
  assert.equal(none.Builder.pct, 18);
  const own = ctxReadings({ tokens, resetAt: 600000, now: NOW, windows: { Manager: 350000 } });
  assert.equal(own.Manager.pct, 50, "Manager's 350k");
  assert.equal(own.Builder.pct, 18, "not listed: 1M");
  assert.equal(own.Manager.tokens, 175000);
  assert.equal(own.Manager.over, false, "over is tokens against resetAt, not the window");
  assert.equal(ctxReadings({ tokens: { Manager: 400000 }, resetAt: 600000, now: NOW, windows: { Manager: 350000 } }).Manager.pct, 100, "capped at 100");
  for (const bad of [{ Manager: "350000" }, { Manager: 50000 }, { Manager: 3e6 }, { Manager: 350000.5 }, [350000], "x", null, undefined]) {
    assert.equal(ctxReadings({ tokens, resetAt: 600000, now: NOW, windows: bad }).Manager.pct, 18, `${JSON.stringify(bad)}: the default`);
  }
  assert.equal(windowOf({ Manager: 350000 }, "Manager"), 350000);
  assert.equal(windowOf({ Manager: 350000 }, "Builder"), WINDOW_TOKENS);
  assert.equal(windowOf({ constructor: 5 }, "constructor"), WINDOW_TOKENS, "an inherited or odd value is not a window");
});
