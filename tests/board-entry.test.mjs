import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import entry from "../worker/board-entry.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";

test("the deployed entry answers nothing without a valid Access token (the real check, no test hook)", async () => {
  const env = { DB: makeDb(), ACCESS_TEAM_DOMAIN: "https://team.example.test", ACCESS_AUD: "aud", ROLES: "{}" };
  for (const path of ["/", "/api/view", "/mcp", "/api/probe/wake"]) {
    const r = await entry.fetch(new Request(`https://b.test${path}`, { method: path === "/" || path === "/api/view" ? "GET" : "POST", headers: { "cf-access-jwt-assertion": "not.a.jwt" } }), env, null);
    assert.equal(r.status, 401, path);
  }
  assert.equal((await entry.fetch(new Request("https://b.test/"), env, null)).status, 401, "no header at all");
});

test("the Worker config commits no secret and no address", () => {
  const t = readFileSync(new URL("../worker/wrangler.board.toml", import.meta.url), "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  assert.doesNotMatch(t, /routes?\s*=|pattern\s*=|zone|account_id|secret|token/i);
  assert.match(t, /^name = "flight-board-store"$/m);
});
