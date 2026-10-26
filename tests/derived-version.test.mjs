// #C211: versions come from the repository, never from a hand-written plannedVersion.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";
import { fullConfig } from "../scripts/config.mjs";
import { writeErrors } from "../gate/rules.mjs";
import { mainVersion, liveBuild } from "../collector/facts.mjs";
import { collect, shipping } from "../collector/collect.mjs";
import { decide, runMark } from "../collector/refresh.mjs";

const config = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01" });
const now = 1_792_998_566_221;
const lead = { role: "Manager", manager: true };

test("the gate refuses a hand-written version on a card; removing one is fine", () => {
  const card = { name: "X", size: "S", status: "active", level: "Quick", etaLive: now + 6e5, nextNote: "n", nextNoteAt: now - 1, plan: "p" };
  const refused = (w) => writeErrors(w, { config, who: lead, now }).some((e) => /plannedVersion is retired/.test(e));
  assert.ok(refused({ op: "set", collection: "initiatives", doc_id: "x", data: { ...card, plannedVersion: "1.2.0" } }));
  assert.ok(refused({ op: "update", collection: "initiatives", doc_id: "x", data: { plannedVersion: "1.2.1" } }));
  assert.ok(!refused({ op: "update", collection: "initiatives", doc_id: "x", data: { plannedVersion: { __delete__: true } } }));
  assert.ok(!refused({ op: "set", collection: "initiatives", doc_id: "x", data: card }));
});

function board(cards, derived, live) {
  const b = loadNames(["state", "versionNote", "liveText", "shipQueue"]);
  b.state.initRaw = cards.map((id) => ({ id, status: "active", name: id }));
  b.state.derived = [{ id: "all", at: now, cards: derived, ...(live ? { live } : {}) }];
  return b;
}

test("a shipped card shows the repository's version; one on main and not yet deployed says deploying", () => {
  const b = board(["a", "b"], { a: { phase: "live", version: "1.104.1" }, b: { phase: "ship", version: "1.105.0" } });
  assert.equal(b.versionNote({ id: "a" }), "Live in <b>v1.104.1</b>");
  assert.equal(b.versionNote({ id: "b" }), "Deploying <b>v1.105.0</b>");
});

test("two signed cards show their places in the queue by when they went READY; others say what they are in", () => {
  const b = board(["late", "early", "rev", "bld", "closed"], {
    late: { phase: "ship", readyAt: now - 100 }, early: { phase: "ship", readyAt: now - 900 },
    rev: { phase: "checker", readyAt: now - 50 }, bld: { phase: "build", firm: false }, closed: { phase: "ship", readyAt: now - 9999 },
  });
  b.state.initRaw.find((i) => i.id === "closed").status = "done";
  assert.equal(b.versionNote({ id: "early" }), "Queued (1)");
  assert.equal(b.versionNote({ id: "late" }), "Queued (2)");
  assert.equal(b.versionNote({ id: "rev" }), "In review");
  assert.equal(b.versionNote({ id: "bld" }), "Building");
  assert.equal(b.versionNote({ id: "none" }), "");
  assert.deepEqual([...b.shipQueue()], ["early", "late"], "a closed card holds no place");
});

test("Live now comes from the live site's build; deploying shows while main names a newer version", () => {
  assert.equal(board([], {}, { version: "1.105.0", commit: "0653ff6", mainVersion: "1.105.1" }).liveText(), "Live now: v1.105.0 · deploying v1.105.1");
  assert.equal(board([], {}, { version: "1.105.1", commit: "0653ff6", mainVersion: "1.105.1" }).liveText(), "Live now: v1.105.1");
  const old = board([], {}, null);
  old.state.meta = [{ id: "live", version: "1.104.0" }];
  old.state.events = [];
  assert.equal(old.liveText(), "Live now: 1.104.0", "no reading yet: the lead's meta/live as before");
});

test("the collector reads the live build from its tag, and main's newest version from the main line", async () => {
  const page = (html, ok = true) => async () => new Response(html, { status: ok ? 200 : 500 });
  const tag = config.collector.liveTag;
  assert.deepEqual(await liveBuild(page('<meta name="generator" content="Shop v1.2.3 abc1234">'), "https://example.com/", tag), { version: "1.2.3", commit: "abc1234" });
  assert.equal(await liveBuild(page("<p>no tag</p>"), "https://example.com/", tag), null);
  assert.equal(await liveBuild(page('<meta name="generator" content="Shop v1.2.3 abc1234">', false), "https://example.com/", tag), null);
  assert.equal(await liveBuild(async () => { throw new Error("offline"); }, "https://example.com/", tag), null);
  assert.equal(await liveBuild(page("x"), "", tag), null);
  assert.equal(mainVersion([{ subject: "v1.0.0: a" }, { subject: "Merge x" }, { subject: "v1.1.0: b" }, { subject: "Release times" }], config.collector.versionPattern), "1.1.0");
  assert.equal(mainVersion([{ subject: "nothing" }], config.collector.versionPattern), null);
});

test("collect writes live only when the board names a live site", () => {
  const git = (args) => (args[0] === "log" ? ["a", "1", "v2.0.0: x"].join("\x1f") : "");
  const gh = () => "[]";
  const off = collect({ config, cards: [], git, gh, now, live: { version: "1.9.0", commit: "abc1234" } });
  assert.equal(off.doc.live, undefined);
  const on = { ...config, collector: { ...config.collector, liveUrl: "https://example.com/" } };
  assert.deepEqual(collect({ config: on, cards: [], git, gh, now, live: { version: "1.9.0", commit: "abc1234" } }).doc.live, { version: "1.9.0", commit: "abc1234", mainVersion: "2.0.0", at: now });
});

test("the config takes an https live address only", async () => {
  const { checkConfig } = await import("../scripts/config.mjs");
  const base = { artifactUrl: "https://claude.ai/" + "artifact/TestBoard01" };
  assert.ok(checkConfig({ ...base, collector: { liveUrl: "http://example.com/" } }).some((p) => /liveUrl/.test(p)));
  assert.ok(checkConfig({ ...base, collector: { liveUrl: "https://example.com/ x" } }).some((p) => /liveUrl/.test(p)));
  assert.ok(!checkConfig({ ...base, collector: { liveUrl: "https://example.com/" } }).some((p) => /liveUrl/.test(p)));
  assert.ok(checkConfig({ ...base, collector: { liveTag: "(" } }).some((p) => /liveTag/.test(p)));
});

test("a ship run on now: the cards its candidate branch names are shipping now; the other signed ones queue (#C211)", () => {
  const A = "a".repeat(40), B = "b".repeat(40);
  const c = { ...config.collector, candidatePattern: "^build/ship-v", shippedPattern: "([A-Za-z0-9._/-]+)@([0-9a-f]{7,40})" };
  const heads = [{ branch: "build/ship-v1.2.0", sha: "c".repeat(40), message: "Start CI", at: now }, { branch: "build/x", sha: A, message: "x", at: now }];
  const git = (args) => (args[0] === "log" && args[1] === "-5" ? "Start CI (no run appeared)\nv1.2.0: build/x@aaaaaaa" : "");
  assert.deepEqual(shipping(git, heads, c), [{ branch: "build/ship-v1.2.0", names: [{ branch: "build/x", sha: "aaaaaaa" }] }]);
  assert.deepEqual(shipping(git, heads, { ...c, candidatePattern: "" }), [], "no pattern, no runs");
  const b = board(["x", "y"], { x: { phase: "ship", head: A, readyAt: now - 900, shipping: "build/ship-v1.2.0" }, y: { phase: "ship", head: B, readyAt: now - 100 } });
  assert.equal(b.versionNote({ id: "x" }), "<b>Shipping now</b>");
  assert.equal(b.versionNote({ id: "y" }), "Queued (1)", "the card in the run holds no place in the queue");
  const deploying = board(["x"], { x: { phase: "ship", head: A, version: "1.2.0", shipping: "build/ship-v1.2.0" } });
  assert.equal(deploying.versionNote({ id: "x" }), "Deploying <b>v1.2.0</b>", "on main while the run finishes: its version");
  const after = board(["x", "y"], { x: { phase: "live", head: A, version: "1.2.0" }, y: { phase: "ship", head: B, readyAt: now - 100 } });
  assert.equal(after.versionNote({ id: "x" }), "Live in <b>v1.2.0</b>");
  assert.equal(after.versionNote({ id: "y" }), "Queued (1)", "only the card in the run has a version");
});

test("collect marks only the run's cards as shipping, and never one already on main", () => {
  const A = "a".repeat(40);
  const S = Math.floor(now / 1000);
  const on = { ...config, collector: { ...config.collector, candidatePattern: "^build/ship-v", shippedPattern: "([A-Za-z0-9._/-]+)@([0-9a-f]{7,40})", notes: {} } };
  const git = (args) => {
    if (args[0] === "for-each-ref") return [`build/ship-v1.2.0\x1f${"c".repeat(40)}\x1f${S}\x1fv1.2.0: build/x@aaaaaaa\x1e`, `build/x\x1f${A}\x1f${S}\x1fx\n\nBoard-Id: x\x1e`, `build/y\x1f${"b".repeat(40)}\x1f${S}\x1fy\n\nBoard-Id: y\x1e`].join("");
    if (args[0] === "log" && args[1] === "-5") return "v1.2.0: build/x@aaaaaaa";
    if (args[0] === "log") return "";
    if (args[0] === "merge-base") throw new Error("not an ancestor");
    return "";
  };
  const cards = [{ id: "x", status: "active" }, { id: "y", status: "active" }];
  const { doc } = collect({ config: on, cards, git, gh: () => "[]", now });
  assert.equal(doc.cards.x.shipping, "build/ship-v1.2.0");
  assert.equal(doc.cards.y.shipping, undefined);
});

test("the refresh hook starts the collector when a ship run starts or ends (its candidate branch comes or goes)", () => {
  const base = { lead: true, stopActive: false, now: now + 3600e3, run: { startedAt: now, finishedAt: now + 60e3 } };
  assert.equal(decide({ ...base, refs: { shop: "m1", "shop ship": "build/ship-v1.2.0 ccc" }, baseline: { shop: "m1", "shop ship": "-" } }), "shop ship started or ended");
  assert.equal(decide({ ...base, refs: { shop: "m2", "shop ship": "-" }, baseline: { shop: "m1", "shop ship": "build/ship-v1.2.0 ccc" } }), "shop shipped; shop ship started or ended");
  assert.equal(decide({ ...base, refs: { shop: "m1", "shop ship": "-" }, baseline: { shop: "m1" } }), null, "an older mark without the ship key: no trigger");
  assert.deepEqual(runMark(5, ["/x/shop"], () => "m1", () => "-").refs, { shop: "m1", "shop ship": "-" });
  assert.deepEqual(runMark(5, ["/x/shop"], () => "m1").refs, { shop: "m1" });
});

test("liveBuild reads no more than 256 KB of the page and refuses a redirect off https (Checker, Security)", { timeout: 5000 }, async () => {
  const tag = config.collector.liveTag;
  let pulled = 0;
  const huge = () => new Response(new ReadableStream({ pull(ctl) { pulled++; ctl.enqueue(new TextEncoder().encode("x".repeat(65536))); } }));
  assert.equal(await liveBuild(async () => huge(), "https://example.com/", tag), null);
  assert.ok(pulled <= 6, `read ${pulled} chunks of 64 KB`);
  const late = new Response("y".repeat(300000) + '<meta name="generator" content="Shop v1.2.3 abc1234">');
  assert.equal(await liveBuild(async () => late, "https://example.com/", tag), null, "a tag past the cap isn't read");
  const off = new Response('<meta name="generator" content="Shop v1.2.3 abc1234">');
  Object.defineProperty(off, "redirected", { value: true });
  Object.defineProperty(off, "url", { value: "http://example.com/" });
  assert.equal(await liveBuild(async () => off, "https://example.com/", tag), null);
});
