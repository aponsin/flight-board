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
import { writeContext, usageWindow, readWindows, tap } from "../collector/context.mjs";

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

test("the Collector: a listed role's tile percentage is worked from its tokens against the config's window; the others keep the app's", () => {
  const base = mkdtempSync(join(tmpdir(), "fb-win-"));
  try {
    const dir = join(base, "state"), out = join(base, "out");
    mkdirSync(dir); mkdirSync(join(dir, "usage")); mkdirSync(out);
    writeFileSync(join(dir, "usage-plan.json"), JSON.stringify({ at: NOW, roles: { Manager: "local_m", Builder: "local_b" } }));
    writeFileSync(join(dir, "usage", "local_m.json"), JSON.stringify({ status: "ok", pct: 18, tokens: 175000, at: NOW + 5 }));
    writeFileSync(join(dir, "usage", "local_b.json"), JSON.stringify({ status: "ok", pct: 18, tokens: 175000, at: NOW + 5 }));
    const config = fullConfig({ collector: { contextRoles: ["Manager", "Builder"] }, contextWindows: { Manager: 350000 } });
    writeContext(dir, out, config, NOW + 10);
    assert.deepEqual(JSON.parse(readFileSync(join(out, "ctx-Manager.json"), "utf8")), { pct: 50, tokens: 175000, at: NOW + 5 });
    assert.deepEqual(JSON.parse(readFileSync(join(out, "ctx-Builder.json"), "utf8")), { pct: 18, tokens: 175000, at: NOW + 5 }, "not listed: the app's number");
    // A reading with no tokens has nothing to divide: the app's percentage stays.
    writeFileSync(join(dir, "usage", "local_m.json"), JSON.stringify({ status: "ok", pct: 18, tokens: null, at: NOW + 5 }));
    writeContext(dir, out, config, NOW + 10);
    assert.deepEqual(JSON.parse(readFileSync(join(out, "ctx-Manager.json"), "utf8")), { pct: 18, at: NOW + 5 });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("get_usage's window: tap keeps it, the Collector saves it, the probe works an unlisted 200k role against it (config still wins)", () => {
  const base = mkdtempSync(join(tmpdir(), "fb-win-"));
  try {
    const dir = join(base, "state"), out = join(base, "out");
    mkdirSync(dir); mkdirSync(out);
    writeFileSync(join(dir, "usage-plan.json"), JSON.stringify({ at: NOW, roles: { Manager: "local_m", Scout: "local_s" } }));
    const resp = (session, tokensUsed, contextWindow) => ({ plan: { status: "ok" }, context: { session, status: "ok", percentUsed: Math.round(tokensUsed / contextWindow * 100), tokensUsed, contextWindow } });
    const read = (id, t, w, at) => tap({ cwd: dir, tool_name: "mcp__ccd_session_mgmt__get_usage", tool_input: { session_id: id }, tool_response: JSON.stringify(resp(id, t, w)) }, { dir, now: at });
    assert.equal(usageWindow(resp("local_s", 100000, 200000), "local_s"), 200000);
    for (const w of [undefined, "200000", 50000, 3e6, 200000.5, null]) assert.equal(usageWindow({ context: { session: "local_s", contextWindow: w } }, "local_s"), null, String(w));
    assert.equal(usageWindow(resp("local_other", 1, 200000), "local_s"), null, "another session's window");
    assert.equal(read("local_m", 175000, 1000000, NOW + 5), null);
    assert.equal(read("local_s", 100000, 200000, NOW + 5), null);
    const config = fullConfig({ collector: { contextRoles: ["Manager", "Scout"] }, contextWindows: { Manager: 350000 } });
    writeContext(dir, out, config, NOW + 10);
    assert.deepEqual(readWindows(dir), { Manager: 1000000, Scout: 200000 });
    // The probe: Scout (200k, not in the config) reads 50%, like the app's tile; Manager's config window wins over the app's.
    const tokens = { Manager: 175000, Scout: 100000 };
    const c = ctxReadings({ tokens, resetAt: 600000, now: NOW, windows: config.contextWindows, seen: readWindows(dir) });
    assert.equal(c.Scout.pct, 50);
    assert.equal(c.Manager.pct, 50, "config 350k beats the app's 1M");
    assert.equal(ctxReadings({ tokens, resetAt: 600000, now: NOW }).Scout.pct, 10, "without the app's window it was 10 against 1M");
    // A run that reads only one role keeps the other's last window; a bad file is no windows.
    writeFileSync(join(dir, "usage-plan.json"), JSON.stringify({ at: NOW + 20, roles: { Scout: "local_s" } }));
    read("local_s", 100000, 400000, NOW + 25);
    writeContext(dir, out, config, NOW + 30);
    assert.deepEqual(readWindows(dir), { Manager: 1000000, Scout: 400000 });
    writeFileSync(join(dir, "ctx-windows.json"), JSON.stringify({ Scout: "x", "bad role": 200000, Ok: 150000 }));
    assert.deepEqual(readWindows(dir), { Ok: 150000 });
    writeFileSync(join(dir, "ctx-windows.json"), "{");
    assert.deepEqual(readWindows(dir), {});
  } finally { rmSync(base, { recursive: true, force: true }); }
});
