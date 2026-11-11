// #C952: the store's look rule, ported from the old board's gate (lookErrors). A Decision whose title or question names a look word needs a
// screenshot per option, for asks and for decisions posted in a thread; "Something else" and "Not now" need none; a refusal names the
// options with no picture. The words are the default list of scripts/config.mjs (the Worker has no config); the visual-lane list is empty.
import test from "node:test";
import assert from "node:assert/strict";
import { askFromTool, createAsk, postMessage } from "../worker/board-store.mjs";
import { LOOK_WORDS, isLookText, lookRefusal, askRefusal, messageExtrasRefusal } from "../worker/board-rules.mjs";
import { DEFAULTS } from "../scripts/config.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";

const NOW = 1_800_000_000_000;
const RED = "redredredredred01", BLUE = "blueblueblueblue02", GREEN = "greengreengreen003";
const ask = (extra = {}) => ({ type: "Decision", title: "Which hero?", asked_by: "Manager", question: "Red hero or blue hero?", options: ["Red", "Blue"], recommended: "Red", ...extra });
async function seeded() {
  const db = makeDb();
  await db.prepare("INSERT INTO threads (id, num, title, created_at) VALUES ('t-100', 900, 'Look', ?)").bind(NOW - 1000).run();
  for (const id of [RED, BLUE, GREEN]) await db.prepare("INSERT INTO files (id, name, type, size, sha256, added_by, added_at) VALUES (?, ?, 'image/png', 10, '', 'Manager', ?)").bind(id, `${id}.png`, NOW).run();
  return db;
}

test("the Worker's look words are the config's defaults, word for word", () => {
  assert.deepEqual(LOOK_WORDS, DEFAULTS.decisions.lookWords);
  assert.deepEqual(DEFAULTS.decisions.visualLanes, [], "and the lane list is empty by default (the team's lanes reach the Worker as the probe's evidence look, #C956)");
});

test("what is a look: a whole word or its plural in the title or the question; not part of another word", () => {
  for (const t of ["Which hero?", "Pick a colour", "the BUTTONS", "text  size", "a mock-up", "12px wide", "Which Layout"]) assert.equal(isLookText(t), true, t);
  for (const t of ["Which hero? no", "Shall we ship?", "iconic", "banders", "a bandwidth", "Where is the mocking", undefined, null, 5]) assert.equal(isLookText(t), t === "Which hero? no", String(t));
});

test("lookRefusal names the options without a picture; Something else and Not now need none; a letter beyond the options helps nothing", () => {
  const opts = [{ key: "A", label: "Red" }, { key: "B", label: "Blue" }, { key: "C", label: "Something else" }, { key: "D", label: "Not now." }];
  const texts = ["Which hero?"];
  assert.match(lookRefusal({ texts, options: opts, shots: [] }).detail, /missing: A, B\)/);
  assert.match(lookRefusal({ texts, options: opts, shots: [`${RED} A: red`] }).detail, /missing: B\)/);
  assert.equal(lookRefusal({ texts, options: opts, shots: [`${RED} A: red`, `${BLUE} B: blue`] }), null);
  assert.equal(lookRefusal({ texts, options: opts, shots: [`${RED} A: red`, `${BLUE} A: blue`] })?.rule, "look-needs-screenshots", "two pictures for A are not one for B");
  assert.equal(lookRefusal({ texts, options: opts, shots: [`${RED}`, `${BLUE} red`] })?.rule, "look-needs-screenshots", "a picture with no option letter shows no option");
  assert.equal(lookRefusal({ texts: ["Shall we ship?"], options: opts, shots: [] }), null, "not a look");
});

test("an ask: a look Decision with no picture is refused, naming the options; one picture per option passes; a decision that is not about the look needs none", async () => {
  const db = await seeded();
  const bad = await createAsk(db, NOW, ask());
  assert.equal(bad.ok, false);
  assert.equal(bad.refused.rule, "look-needs-screenshots");
  assert.match(bad.refused.detail, /missing: A, B\)/);
  const part = await createAsk(db, NOW, ask({ screenshots: [`${RED} A: red`] }));
  assert.match(part.refused.detail, /missing: B\)/);
  const ok = await createAsk(db, NOW, ask({ screenshots: [`${RED} A: red`, `${BLUE} B: blue`] }));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const plain = await createAsk(db, NOW, ask({ title: "Ship it?", question: "Ship on Friday or Monday?", options: ["Friday", "Monday"], recommended: "Friday" }));
  assert.equal(plain.ok, true, JSON.stringify(plain));
  const other = await createAsk(db, NOW, ask({ options: ["Red", "Blue", "Something else"], recommended: "Red", screenshots: [`${RED} A: red`, `${BLUE} B: blue`] }));
  assert.equal(other.ok, true, "Something else needs no picture");
  const notNow = await createAsk(db, NOW, ask({ options: ["Red", "Not now"], recommended: "Red", screenshots: [`${RED} A: red`] }));
  assert.equal(notNow.ok, true, "Not now needs no picture");
});

test("an imported Decision (now = null) keeps its old shape: the rule is for live asks", () => {
  assert.equal(askRefusal({ ...ask(), eta_at: undefined }, null), null);
  assert.equal(askRefusal(ask(), NOW)?.rule, "look-needs-screenshots");
});

test("a decision posted in a thread: the same rule, in the same picture shape; a decision that is not about the look needs none", async () => {
  const db = await seeded();
  const count = async () => (await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = 't-100'").first()).n;
  const via = (extra) => askFromTool(db, NOW, "Manager", ask({ related_thread: "t-100", ...extra }));
  const bad = await via({});
  assert.equal(bad.ok, false);
  assert.equal(bad.refused.rule, "look-needs-screenshots");
  assert.equal(await count(), 0, "nothing is posted on a refusal");
  const ok = await via({ screenshots: [`${RED} A: red`, `${BLUE} B: blue`] });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.posted_in_thread, true);
  const plain = await via({ title: "Ship it?", question: "Ship on Friday or Monday?", options: ["Friday", "Monday"], recommended: "Friday" });
  assert.equal(plain.ok, true, JSON.stringify(plain));
  // messageExtrasRefusal, the post path itself.
  const opts = [{ key: "A", label: "Red" }, { key: "B", label: "Blue" }];
  assert.equal(messageExtrasRefusal({ body: "Which button colour?", kind: "decision", options: opts }, "Manager")?.rule, "look-needs-screenshots");
  assert.equal(messageExtrasRefusal({ body: "Which button colour?", kind: "decision", options: opts, screenshots: [`${RED} A: x`, `${BLUE} B: y`] }, "Manager"), null);
  assert.equal(messageExtrasRefusal({ body: "Friday or Monday?", kind: "decision", options: opts }, "Manager"), null);
  assert.equal(messageExtrasRefusal({ body: "Which button colour?" }, "Manager"), null, "a plain message is not a decision");
  assert.equal(typeof postMessage, "function");
});
