// #C1018 / #C1035: one checker per tip. A Checker session claims a tip in the store before it reviews it (the first claim wins; the other is told "<checker> has
// this"); a tip with a Checker note is refused; a re-cut keeps the claim; the dispatch wakes no Checker for a claimed tip; and the sign script never replaces
// another signer's note. The store is the real one on the sqlite test database.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { claimReview, releaseReview, readView } from "../worker/board-store.mjs";
import { reviewClaimRefusal } from "../worker/board-rules.mjs";
import { dispatchRun } from "../collector/store-dispatch.mjs";
import { signNote, signerOf } from "../scripts/sign-note.mjs";

const T = 1_800_000_000_000;
const S1 = "1".repeat(40), S2 = "2".repeat(40), S3 = "3".repeat(40);
const evidence = (db, id, value) => db.prepare("INSERT OR REPLACE INTO evidence (key, value, read_at) VALUES (?, ?, ?)").bind(`cards.${id}`, JSON.stringify(value), T).run();

test("the first claim of a tip wins; the other checker is refused with '<checker> has this' and the refusal is logged", async () => {
  const db = makeDb();
  assert.deepEqual(await claimReview(db, T, "Checker", { sha: S1, checker: "Checker 2" }), { ok: true, sha: S1, checker: "Checker 2" });
  const r = await claimReview(db, T + 1, "Checker", { sha: S1, checker: "Checker" });
  assert.equal(r.ok, false); assert.equal(r.refused.rule, "review-claim-held"); assert.match(r.refused.detail, /^Checker 2 has this$/);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM refusals WHERE rule = 'review-claim-held'").first()).n, 1);
  assert.equal((await db.prepare("SELECT checker FROM review_claims WHERE sha = ?").bind(S1).first()).checker, "Checker 2", "the holder is unchanged");
});

test("the same checker claiming again is fine, an unnamed Checker is 'Checker', and different tips are independent", async () => {
  const db = makeDb();
  assert.equal((await claimReview(db, T, "Checker", { sha: S1 })).checker, "Checker");
  assert.equal((await claimReview(db, T + 1, "Checker", { sha: S1, checker: "Checker" })).ok, true);
  assert.equal((await claimReview(db, T + 2, "Checker", { sha: S2, checker: "Checker 2" })).ok, true, "another tip, another checker");
  assert.equal((await claimReview(db, T + 3, "Checker", { sha: S3, checker: "Checker 2" })).ok, true);
});

test("two claims at once: exactly one wins", async () => {
  const db = makeDb();
  const [a, b] = await Promise.all([claimReview(db, T, "Checker", { sha: S1, checker: "Checker" }), claimReview(db, T, "Checker", { sha: S1, checker: "Checker 2" })]);
  assert.equal([a, b].filter((x) => x.ok).length, 1);
  assert.equal([a, b].filter((x) => !x.ok && x.refused.rule === "review-claim-held").length, 1);
});

test("only Checker and Manager claim; the shape is checked", async () => {
  const db = makeDb();
  for (const who of ["Builder", "Security", "Boardsmith", "owner", "probe", undefined]) {
    const r = await claimReview(db, T, who, { sha: S1 });
    assert.equal(r.refused?.rule, "review-claim-role", String(who));
  }
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM review_claims").first()).n, 0);
  for (const bad of [null, [], {}, { sha: "abc" }, { sha: "A".repeat(40) }, { sha: S1.slice(0, 12) }, { sha: S1, checker: "Security" }, { sha: S1, checker: "Checker 100" }, { sha: S1, checker: 2 }, { sha: S1, extra: 1 }, { sha: S1, card_id: "Bad Id" }]) {
    assert.equal(reviewClaimRefusal(bad, "Checker", "claim")?.rule, "review-claim-shape", JSON.stringify(bad));
  }
  assert.equal(reviewClaimRefusal({ sha: S1, checker: "Checker 2", card_id: "a-card" }, "Checker", "claim"), null);
  assert.equal(reviewClaimRefusal({ sha: S1 }, "Manager", "claim")?.rule, "review-claim-shape", "Manager names the checker");
  assert.equal(reviewClaimRefusal({ sha: S1, checker: "Checker" }, "Manager", "claim"), null);
});

test("Manager claims a tip for a named checker up front; the other checker is then refused and the named one is in", async () => {
  const db = makeDb();
  assert.equal((await claimReview(db, T, "Manager", { sha: S1, checker: "Checker 2" })).checker, "Checker 2");
  assert.equal((await claimReview(db, T + 1, "Checker", { sha: S1, checker: "Checker" })).refused.detail, "Checker 2 has this");
  assert.equal((await claimReview(db, T + 2, "Checker", { sha: S1, checker: "Checker 2" })).ok, true);
});

test("a tip that already has a Checker note (signed or findings) is refused; a Security-only note is not a Checker note", async () => {
  const db = makeDb();
  await evidence(db, "done-card", { phase: "security", headSha12: S1.slice(0, 12), signed: ["checker"] });
  await evidence(db, "sent-back", { phase: "build", headSha12: S2.slice(0, 12), findings: ["checker"] });
  await evidence(db, "sec-only", { phase: "checker", headSha12: S3.slice(0, 12), signed: ["security"] });
  assert.equal((await claimReview(db, T, "Checker", { sha: S1 })).refused.rule, "review-claim-noted");
  assert.equal((await claimReview(db, T, "Checker", { sha: S2 })).refused.rule, "review-claim-noted");
  assert.equal((await claimReview(db, T, "Checker", { sha: S3 })).ok, true);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM review_claims WHERE sha IN (?, ?)").bind(S1, S2).first()).n, 0, "nothing was claimed");
});

test("release: the holder or Manager frees a tip; another checker cannot; then a new claim works; releasing a free tip is a no-op", async () => {
  const db = makeDb();
  await claimReview(db, T, "Checker", { sha: S1, checker: "Checker 2" });
  assert.equal((await releaseReview(db, T + 1, "Checker", { sha: S1, checker: "Checker" })).refused.rule, "review-claim-held", "not Checker's to release");
  assert.equal((await claimReview(db, T + 2, "Checker", { sha: S1, checker: "Checker" })).ok, false, "still held");
  assert.deepEqual(await releaseReview(db, T + 3, "Checker", { sha: S1, checker: "Checker 2" }), { ok: true, sha: S1, released: true });
  assert.equal((await claimReview(db, T + 4, "Checker", { sha: S1, checker: "Checker" })).ok, true, "after a release a new claim works");
  assert.equal((await releaseReview(db, T + 5, "Manager", { sha: S1 })).released, true, "Manager frees a gone checker's claim");
  assert.equal((await releaseReview(db, T + 6, "Manager", { sha: S1 })).released, false, "already free");
  assert.equal((await releaseReview(db, T + 7, "Manager", { sha: S2 })).released, false, "never claimed");
  assert.equal((await releaseReview(db, T + 8, "Builder", { sha: S1 })).refused.rule, "review-claim-role");
});

test("a re-cut keeps the claim: the holder claims the new tip and the old one is handed on; the other checker is refused on the new tip too", async () => {
  const db = makeDb();
  await claimReview(db, T, "Checker", { sha: S1, checker: "Checker 2", card_id: "a-card" });
  const other = await claimReview(db, T + 1, "Checker", { sha: S2, checker: "Checker", card_id: "a-card" });
  assert.equal(other.refused.detail, "Checker 2 has this", "the re-cut belongs to the same checker");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM review_claims WHERE sha = ?").bind(S2).first()).n, 0);
  assert.equal((await claimReview(db, T + 2, "Checker", { sha: S2, checker: "Checker 2", card_id: "a-card" })).ok, true);
  const view = await readView(db, T + 3);
  assert.deepEqual(view.reviewClaims.map((k) => [k.sha, k.checker]), [[S2, "Checker 2"]], "only the new tip is held now");
  assert.equal((await claimReview(db, T + 4, "Checker", { sha: S3, checker: "Checker", card_id: "other-card" })).ok, true, "another card is independent");
});

test("a re-cut is held to the claim whatever card_id the caller passes: the card comes from the evidence whose head is the tip (Checker's F2)", async () => {
  for (const passed of [{}, { card_id: "wrong-card" }, { card_id: "a-card" }]) {
    const db = makeDb();
    await evidence(db, "a-card", { phase: "checker", headSha12: S1.slice(0, 12) });
    assert.equal((await claimReview(db, T, "Checker", { sha: S1, checker: "Checker 2" })).ok, true);
    await evidence(db, "a-card", { phase: "checker", headSha12: S2.slice(0, 12) }); // the re-cut: the card's head moved
    const r = await claimReview(db, T + 1, "Checker", { sha: S2, checker: "Checker", ...passed });
    assert.equal(r.refused?.detail, "Checker 2 has this", JSON.stringify(passed));
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM review_claims WHERE sha = ?").bind(S2).first()).n, 0);
    assert.equal((await claimReview(db, T + 2, "Checker", { sha: S2, checker: "Checker 2", ...passed })).ok, true, "the holder takes the re-cut");
    assert.deepEqual((await readView(db, T + 3)).reviewClaims.map((k) => [k.sha, k.card_id]), [[S2, "a-card"]]);
  }
});

test("the view lists the claims still held and nothing else", async () => {
  const db = makeDb();
  assert.deepEqual((await readView(db, T)).reviewClaims, []);
  await claimReview(db, T, "Checker", { sha: S1 }); await claimReview(db, T + 1, "Checker", { sha: S2, checker: "Checker 2", card_id: "a-card" });
  await releaseReview(db, T + 2, "Manager", { sha: S1 });
  assert.deepEqual((await readView(db, T + 3)).reviewClaims, [{ sha: S2, card_id: "a-card", checker: "Checker 2", claimed_at: T + 1 }]);
});

test("the typed tools: Checker claims and releases through the connector; a non-agent role cannot call them", async () => {
  const db = makeDb(), env = { DB: db };
  const call = async (who, role, name, args) => {
    const auth = async () => ({ who, role });
    const r = await worker.fetch(new Request("https://b.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), env, null, T + 9000, auth);
    return r.json();
  };
  const ok = await call("Checker", "agent", "claim_review", { sha: S1, checker: "Checker 2" });
  assert.equal(ok.result.structuredContent.ok, true);
  const no = await call("Checker", "agent", "claim_review", { sha: S1, checker: "Checker" });
  assert.equal(no.result.structuredContent.refused.detail, "Checker 2 has this");
  assert.equal((await call("Checker", "agent", "release_review", { sha: S1, checker: "Checker 2" })).result.structuredContent.released, true);
  const owner = await call("owner", "owner", "claim_review", { sha: S2 });
  assert.ok(owner.error || owner.result?.isError, "the owner's role has no such tool");
});

// ---- the dispatch ----
const NOW = 1_800_000_000_000, MIN = 60e3;
const ROSTER = ["Manager", "Boardsmith", "Builder", "Checker", "Security", "Release"], LEAD = "Manager";
const idle = { state: "idle", lastActivityAt: NOW - 2 * MIN, since: NOW - 2 * MIN };
const card = (id, extra = {}) => ({ id, num: Number(id.replace(/\D/g, "")) || null, owner_role: "Builder", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "", ...extra });
const world = ({ cards, ev = {}, claims }) => ({
  cards, asks: [], stackSwitch: [{ repo: "board", stack: false, set_by: "default", set_at: 0 }], ...(claims ? { reviewClaims: claims } : {}),
  evidence: { agents: { readAt: NOW - 5_000, value: Object.fromEntries(ROSTER.map((r) => [r, idle])) }, ...Object.fromEntries(Object.entries(ev).map(([id, v]) => [`cards.${id}`, { readAt: NOW - 5_000, value: v }])) },
});
const who = (v) => dispatchRun(v, { dir: mkdtempSync(join(tmpdir(), "rcl-")), roster: ROSTER, lead: LEAD, now: NOW }).items.map((i) => `${i.card}:${i.role}:${i.step}`);
const head = (n) => ({ lit: ["checker"], phase: "checker", headSha12: `${n}`.repeat(12), headSha: `${n}`.repeat(40), signed: [], onMain: false });

test("the dispatch wakes Checker for a review, and stops once a Checker holds the tip (the claim is on that tip only)", () => {
  const free = world({ cards: [card("c1-a")], ev: { "c1-a": head(1) } });
  assert.deepEqual(who(free), ["c1-a:Checker:review"]);
  const claimed = world({ cards: [card("c1-a")], ev: { "c1-a": head(1) }, claims: [{ sha: S1, checker: "Checker 2", card_id: "c1-a", claimed_at: NOW }] });
  assert.deepEqual(who(claimed), [], "claimed: no second checker is woken");
  const elsewhere = world({ cards: [card("c1-a")], ev: { "c1-a": head(1) }, claims: [{ sha: S2, checker: "Checker 2", card_id: "c2-b", claimed_at: NOW }] });
  assert.deepEqual(who(elsewhere), ["c1-a:Checker:review"], "a claim on another tip hides nothing");
  const recut = world({ cards: [card("c1-a")], ev: { "c1-a": head(3) }, claims: [{ sha: S1, checker: "Checker 2", card_id: "c1-a", claimed_at: NOW }] });
  assert.deepEqual(who(recut), ["c1-a:Checker:review"], "a new tip not yet claimed is woken (the holder claims it on intake; others are refused there)");
});

test("a claim hides only the Checker review: Security's review of a Full card stays", () => {
  const v = world({ cards: [card("c1-a", { review_level: "Full" })], ev: { "c1-a": head(1) }, claims: [{ sha: S1, checker: "Checker", card_id: "c1-a", claimed_at: NOW }] });
  assert.deepEqual(who(v), ["c1-a:Security:review"]);
});

// ---- the sign script, against a temp repository ----
function repo() {
  const root = mkdtempSync(join(tmpdir(), "sgn-")), work = join(root, "work"), bare = join(root, "origin.git");
  const g = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).replace(/\n+$/, "");
  mkdirSync(bare); g(bare, "init", "-q", "--bare", "-b", "main");
  execFileSync("git", ["clone", "-q", bare, work], { stdio: "ignore" });
  g(work, "config", "user.email", "none"); g(work, "config", "user.name", "t"); g(work, "checkout", "-q", "-b", "main");
  g(work, "commit", "-q", "--allow-empty", "-m", "c"); g(work, "push", "-q", "origin", "main");
  const sha = g(work, "rev-parse", "HEAD");
  return { sha, g: (...a) => g(work, ...a), gb: (...a) => g(bare, ...a), run: (a) => execFileSync("git", a, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
}
const sign = (r, signer, line = "PASS ok", extra = {}) => signNote({ run: r.run, role: "checker", sha: r.sha, signer, line, ...extra });

test("sign-note: a note is written with the signer on its second line, and the first line is what the release tool reads", () => {
  const r = repo();
  assert.match(sign(r, "Checker 2", "PASS (Quick) ok", { push: true }), /^SIGNED checker [0-9a-f]{12} as Checker 2, pushed$/);
  const note = r.gb("notes", "--ref=refs/notes/checker", "show", r.sha);
  assert.equal(note, "PASS (Quick) ok\nsigned-by: Checker 2");
  assert.equal(note.split("\n")[0], "PASS (Quick) ok");
  assert.equal(signerOf(note), "Checker 2");
});

test("sign-note: another signer's note is never replaced, in the checkout or on origin; the same signer may replace its own", () => {
  const r = repo();
  sign(r, "Checker 2", "PASS one", { push: true });
  assert.throws(() => sign(r, "Checker", "PASS two"), /already has a checker note signed by Checker 2; I will not replace it/);
  assert.equal(r.g("notes", "--ref=refs/notes/checker", "show", r.sha), "PASS one\nsigned-by: Checker 2");
  // a note only on origin (the local ref is gone): still refused
  r.g("update-ref", "-d", "refs/notes/checker");
  assert.throws(() => sign(r, "Checker", "PASS two"), /signed by Checker 2/);
  assert.match(sign(r, "Checker 2", "PASS three"), /^SIGNED/);
  assert.equal(r.g("notes", "--ref=refs/notes/checker", "show", r.sha), "PASS three\nsigned-by: Checker 2");
});

test("sign-note: a note with no signer line (written before this tool) is not replaced either; the roles' refs are separate", () => {
  const r = repo();
  r.g("notes", "--ref=refs/notes/checker", "add", "-m", "PASS old note", r.sha);
  assert.throws(() => sign(r, "Checker 2"), /no signer \("PASS old note"\); I will not replace it \(ask Manager\)/);
  assert.match(signNote({ run: r.run, role: "security", sha: r.sha, signer: "Security", line: "SECURE ok" }), /^SIGNED security/);
  assert.equal(r.g("notes", "--ref=refs/notes/checker", "show", r.sha), "PASS old note");
});

test("sign-note: --push succeeds when the other signer pushed a note on another commit since our last fetch (Checker's F1)", () => {
  const r = repo();
  const g = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).replace(/\n+$/, "");
  sign(r, "Checker", "PASS first", { push: true }); // our local notes ref exists and is at origin's tip
  // a second clone (the other signer) signs and pushes a note on a different commit
  const other = mkdtempSync(join(tmpdir(), "sgn-b-"));
  execFileSync("git", ["clone", "-q", r.g("remote", "get-url", "origin"), other], { stdio: "ignore" });
  g(other, "config", "user.email", "none"); g(other, "config", "user.name", "t");
  g(other, "commit", "-q", "--allow-empty", "-m", "c2");
  const sha2 = g(other, "rev-parse", "HEAD");
  signNote({ run: (a) => execFileSync("git", a, { cwd: other, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), role: "checker", sha: sha2, signer: "Checker 2", line: "PASS other", push: true });
  // we sign our commit and push with a stale local notes ref
  assert.match(sign(r, "Checker", "PASS mine", { push: true }), /pushed$/);
  assert.equal(r.gb("notes", "--ref=refs/notes/checker", "show", r.sha), "PASS mine\nsigned-by: Checker");
  assert.equal(r.gb("notes", "--ref=refs/notes/checker", "show", sha2), "PASS other\nsigned-by: Checker 2", "the other signer's note survives on origin");
});

test("sign-note: bad input changes nothing", () => {
  const r = repo();
  for (const [bad, why] of [[{ role: "release" }, /--role is checker or security/], [{ sha: "abc" }, /--sha is the commit's full/], [{ sha: r.sha.toUpperCase().replace(/[0-9]/g, "A") }, /--sha is the commit's full/], [{ signer: "" }, /--signer is your own name/], [{ signer: "Check;er" }, /--signer is your own name/], [{ line: "" }, /--line is the note's one first line/], [{ line: "PASS\nFAKE" }, /--line is the note's one first line/]]) {
    assert.throws(() => signNote({ run: r.run, role: "checker", sha: r.sha, signer: "Checker", line: "PASS", ...bad }), why, JSON.stringify(bad));
  }
  assert.throws(() => r.g("notes", "--ref=refs/notes/checker", "show", r.sha), "no note was written");
});
