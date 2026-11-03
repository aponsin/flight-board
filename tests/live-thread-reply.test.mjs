// #C627: the Stop gate asked the lead to reply in a thread the gate refused a reply in. The owner wrote "all done" in the thread
// of an ask the lead had already answered and deleted; the lead's live check (gate/live.mjs, live.json) found the message, so the
// Stop gate counted it, but rule 10 read only the export, which held no message in that thread yet ("no item on the board, no
// thread with messages"). The gate now lays the lead's live owner messages over the mirror.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fullConfig } from "../scripts/config.mjs";
import { run, readMirror, withLiveMessages } from "../gate/gate.mjs";

const URL_ = "https://claude.ai/" + "artifact/TestBoard01";
const MIN = 60e3, THREAD = "c598-hook-install-1793663396840";
const file = (dir, c, id, data, at) => {
  mkdirSync(join(dir, c), { recursive: true });
  const p = join(dir, c, `${id}.json`);
  writeFileSync(p, JSON.stringify(data));
  utimesSync(p, at / 1000, at / 1000);
};
const ownerMsg = (now) => ({ id: "m-owner-1", thread: THREAD, from: "Owner", at: now - 5 * MIN, text: "all done" });

function board(now, live) {
  const root = mkdtempSync(join(tmpdir(), "fb-livethread-")), dir = join(root, "TestBoard01"), m = join(dir, "mirror");
  // An export from 20 minutes ago: it knows the board but nothing of the thread (its ask was deleted, the message is newer).
  file(m, "initiatives", "x", { name: "X", status: "active", phase: "build", who: "Builder" }, now - 20 * MIN);
  file(m, "ideas", "i", { name: "I" }, now - 20 * MIN);
  file(m, "messages", "m0", { thread: "x", from: "Builder", text: "hi", at: now - 30 * MIN }, now - 20 * MIN);
  file(m, "waiting", "w", { kind: "action", since: now - 40 * MIN }, now - 20 * MIN);
  file(m, "threads", "x", { num: 1, title: "X" }, now - 20 * MIN);
  if (live) writeFileSync(join(dir, "live.json"), JSON.stringify({ Manager: { checkedAt: now - MIN, msgs: [ownerMsg(now)], asks: [] } }));
  const transcript = join(root, "t.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "custom-title", customTitle: "Manager" }) + "\n");
  return { root, m, transcript };
}
const reply = (transcript, now) => ({ tool_name: "ArtifactData", transcript_path: transcript, tool_input: { url: URL_, action: "set", collection: "messages", doc_id: `m${now}-r`, data: { thread: THREAD, from: "Manager", text: "Done, thanks.", at: now } } });

test("without the live message the export-only gate refuses the reply (the old behaviour, so the test below means something)", () => {
  const now = Date.now(), { root, transcript } = board(now, false);
  try {
    const config = fullConfig({ artifactUrl: URL_, gate: { stateDir: root, mirrorMaxAgeMin: 60 } });
    const out = run(reply(transcript, now), { config, env: {}, now });
    assert.match(out.block ?? "", /no item on the board, no thread with messages/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a thread the lead's live check found an owner message in takes the lead's reply, whatever the export holds", () => {
  const now = Date.now(), { root, transcript } = board(now, true);
  try {
    const config = fullConfig({ artifactUrl: URL_, gate: { stateDir: root, mirrorMaxAgeMin: 60 } });
    const out = run(reply(transcript, now), { config, env: {}, now });
    assert.doesNotMatch(out.block ?? "", /no item on the board, no thread with messages/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("another role's live messages do not open a thread for the lead, and a thread nobody wrote in is still refused", () => {
  const now = Date.now(), { root, transcript } = board(now, false);
  try {
    writeFileSync(join(root, "TestBoard01", "live.json"), JSON.stringify({ Checker: { checkedAt: now - MIN, msgs: [ownerMsg(now)], asks: [] } }));
    const config = fullConfig({ artifactUrl: URL_, gate: { stateDir: root, mirrorMaxAgeMin: 60 } });
    assert.match(run(reply(transcript, now), { config, env: {}, now }).block ?? "", /no item on the board, no thread with messages/);
    writeFileSync(join(root, "TestBoard01", "live.json"), JSON.stringify({ Manager: { checkedAt: now - MIN, msgs: [{ ...ownerMsg(now), thread: "some-other-thread" }], asks: [] } }));
    assert.match(run(reply(transcript, now), { config, env: {}, now }).block ?? "", /no item on the board, no thread with messages/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("withLiveMessages: adds only well-formed messages the mirror lacks, once; leaves a mirror without any alone", () => {
  const mirror = { docs: { messages: [{ id: "m1", thread: "a", from: "Owner", at: 1, text: "x" }] }, at: 1 };
  const out = withLiveMessages(mirror, [{ id: "m1", thread: "a", from: "Owner", at: 1 }, { id: "m2", thread: "b", from: "Owner", at: 2, text: "y" }, { id: 3, thread: "c" }, null]);
  assert.deepEqual(out.docs.messages.map((d) => d.id), ["m1", "m2"]);
  assert.equal(withLiveMessages(mirror, []), mirror);
  assert.equal(withLiveMessages(null, [{ id: "m2", thread: "b" }]), null);
});
