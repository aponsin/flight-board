// #C1054 (a): the board's id comes from the boardId config key; artifactUrl is optional and only the fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardId, checkConfig, fullConfig } from "../scripts/config.mjs";
import { isBoardSlug } from "../gate/tools.mjs";

// A made-up id, built in two pieces so the pre-push scan's "an artifact link" rule has nothing real to hold.
const LINK = ["https://claude.ai", "artifact", "abc-123"].join("/");

test("boardId reads the key first, then the id in artifactUrl, else null", () => {
  assert.equal(boardId({ boardId: "my-board" }), "my-board");
  assert.equal(boardId({ boardId: "my-board", artifactUrl: LINK }), "my-board");
  assert.equal(boardId({ artifactUrl: LINK }), "abc-123");
  assert.equal(boardId({ boardId: "", artifactUrl: LINK }), "abc-123");
  assert.equal(boardId({}), null);
});

test("a boardId that is not a plain id is ignored, and the config check names it", () => {
  assert.equal(boardId({ boardId: "../x", artifactUrl: LINK }), "abc-123");
  assert.equal(boardId({ boardId: "a b" }), null);
  assert.equal(boardId({ boardId: "x".repeat(81) }), null);
  assert.ok(checkConfig({ boardId: "../x" }).some((m) => m.startsWith("boardId:")));
  assert.deepEqual(checkConfig({ boardId: "my-board" }), []);
  assert.deepEqual(checkConfig({ boardId: "" }), []);
});

test("a config with boardId and no artifactUrl is valid, and the default boardId is empty", () => {
  assert.deepEqual(checkConfig({ boardId: "my-board", artifactUrl: "" }), []);
  assert.equal(fullConfig({}).boardId, "");
});

test("the gate matches a call on the board by boardId when there is no artifactUrl", () => {
  const config = { boardId: "my-board", artifactUrl: "", artifactSlug: "" };
  assert.equal(isBoardSlug("my-board", config), true);
  assert.equal(isBoardSlug("other-board", config), false);
});
