// #C1096: the push scan's phone rule no longer reads a commit id as a phone number. About one commit id in a hundred holds ten digits in a row (main's tip on 11-16 began
// a 12-character id that starts d and runs digits to its last letter), and the rule read them as a phone: no note or message could name the commit, and Release's dry runs stopped on three signed branches. The rule now
// skips a whole hex token of 12 to 40 characters that holds a letter a-f and stands alone. Every phone shape is still refused. The strings are built from pieces: this
// file is scanned by the same rule.
import test from "node:test";
import assert from "node:assert/strict";
import { scanText, withoutCommitIds } from "../scripts/scan.mjs";

const hits = (line) => scanText(line, []).map((h) => h.what);
const ten = "2291" + "318417";            // ten digits in a row
const id12 = `d${ten}e`;                   // an abbreviated id, as git log prints it
const id40 = id12 + "a".repeat(28);        // a full id
const phone = "303" + "4431079";           // a phone number as ten digits

test("a commit id with ten digits in a row, abbreviated or full, is no phone number, alone or in a sentence, a note line or a path", () => {
  assert.deepEqual(hits(id12), []);
  assert.deepEqual(hits(id40), []);
  assert.deepEqual(hits(`main is ${id40}.`), [], "a full stop after it");
  assert.deepEqual(hits(`line from ${id40}, signed`), []);
  assert.deepEqual(hits(`(${id12}) and [${id40}]`), []);
  assert.deepEqual(hits(`refs/notes/security ${id40}`), []);
  assert.deepEqual(hits(`${id40}\n${id12}\nPASS Full at ${id40}`), []);
});

test("every phone shape is still refused, also on a line that names a commit id", () => {
  assert.deepEqual(hits(`call ${phone}`), ["a phone number"]);
  assert.deepEqual(hits(`call +1${phone}`), ["a phone number"]);
  assert.deepEqual(hits(`call (303) 444` + "-1234"), ["a phone number"]);
  assert.deepEqual(hits(`call 303-444` + "-1234"), ["a phone number"]);
  assert.deepEqual(hits(`call ${ten}`), ["a phone number"], "ten digits with no letter in them are no commit id");
  assert.deepEqual(hits(`${id40} and call ${phone}`), ["a phone number"], "an id beside a phone does not hide the phone");
  assert.deepEqual(hits(`call ${phone} (${id12})`), ["a phone number"]);
  assert.deepEqual(hits(`555: +13035550100 and 3035550199`), [], "the 555 exemption is as before");
});

test("only a whole hex token of 12 to 40 characters is skipped: a shorter one, a longer one, one that something touches, one with no letter a-f", () => {
  assert.deepEqual(hits(`d${ten}`), ["a phone number"], "11 characters is no id");
  assert.deepEqual(hits(`${id40}a`), ["a phone number"], "41 hex characters are no id");
  assert.deepEqual(hits(`x${id12}`), ["a phone number"], "a letter touching the front");
  assert.deepEqual(hits(`${id12}x`), ["a phone number"], "a letter touching the back");
  assert.deepEqual(hits(`${id12}7`), [], "a 13-character hex token is still an id (any length from 12 to 40)");
  assert.deepEqual(hits(`1${ten}`), ["a phone number"], "eleven digits, no letter a-f: no hex id");
  assert.equal(withoutCommitIds(`id ${id12} end`), "id   end");
  assert.equal(withoutCommitIds(`id ${"2".repeat(40)} end`), `id ${"2".repeat(40)} end`, "40 digits are not hex letters");
});

test("the other rules read the line as it was: an id beside an email, a token or a listed word does not hide them", () => {
  const email = "someone" + "@" + "realco.io";
  assert.deepEqual(hits(`${id40} ${email}`), ["an email address"]);
  assert.deepEqual(hits(`${id12} ghp_` + "a".repeat(24)), ["a token"]);
  assert.deepEqual(hits(`${id12}` + "@" + "realco.io"), ["an email address"], "an email whose local part is hex is still an email: only the phone rule skips ids");
  assert.deepEqual(hits("github_pat_" + "a".repeat(40)), ["a token"], "a key made of hex after its prefix is still a key");
  assert.deepEqual(scanText(`${id12} the-secret-word`, ["secret-word"]).map((h) => h.what), ['a listed word ("secret-word")']);
});
