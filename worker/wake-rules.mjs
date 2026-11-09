// Row 4 wake guard (#C719, DATA.md row 4; brief "Spike result" rules 1, 3, 4, 5). Pure functions, no I/O: the probe asks the
// store every 20 s, sends ONE nudge per batch with a headless `claude -p` send, and reports every send's exit code to the
// store. The page shows "cannot reach Manager" in red with the reason and the fix when a send failed or a batch was not
// taken in time. The nudge is not a fact: Manager believes only the store.

export const TAKEN_WITHIN_MS = 3 * 60_000; // a batch not taken this long after a good send is a failure
export const RESEND_MS = 5 * 60_000;       // an untaken batch is re-sent at most this often
export const ASK_STALE_MS = 3 * 60_000;    // row 4 chip: the last ask is the heartbeat, red after this

// What a finished send was: from its exit code and the CLI's output text (stdout and stderr together).
export function classifySend(exit, text) {
  const t = String(text ?? "");
  if (exit === 0 && !/No agent named .* is reachable/i.test(t) && !/"success"\s*:\s*false/.test(t)) return { ok: true };
  if (/Failed to authenticate|OAuth session expired|not logged in|please run .*\/login/i.test(t)) {
    return { ok: false, reason: "login-lapsed", fix: "run `claude /login` in a Terminal on the Studio" };
  }
  if (/No agent named .* is reachable/i.test(t)) {
    return { ok: false, reason: "no-agent-reachable", fix: "Manager's session must be open, named, with Remote Control on" };
  }
  if (/exited ENOENT|spawn .* ENOENT|command not found/i.test(t)) {
    return { ok: false, reason: "claude-not-found", fix: "the ask job cannot find claude: reinstall the launchd jobs with claude's full path (--claude)" };
  }
  return { ok: false, reason: "send-failed", fix: `the send exited ${Number.isInteger(exit) ? exit : "abnormally"}; see the probe log` };
}

// The batch line: only a count and a batch id, never board text.
export const nudgeLine = (count, batchId) => `${Number(count)} for Manager, batch ${String(batchId).replace(/[^A-Za-z0-9-]/g, "").slice(0, 32)}`;

// Whether the probe should send now. wake = the store's row: { batchId, count, takenAt, lastSendAt, lastSendOk }.
export function shouldSend(wake, now) {
  if (!wake?.batchId || !(wake.count > 0)) return false;       // nothing for Manager: nothing runs
  if (Number.isFinite(wake.takenAt) && wake.takenAt >= (wake.batchAt ?? 0)) return false; // already taken
  if (!Number.isFinite(wake.lastSendAt) || wake.lastSendBatch !== wake.batchId) return true; // first send of this batch
  return now - wake.lastSendAt >= RESEND_MS;                    // re-send at most once per 5 min
}

// Row 4: { state: "ok" | "red" | "idle", reason?, fix?, askAge }.
export function wakeStatus(wake, now) {
  const askAge = Number.isFinite(wake?.askedAt) ? Math.max(0, now - wake.askedAt) : null;
  if (askAge === null || askAge > ASK_STALE_MS) return { state: "red", reason: "probe-not-asking", fix: "the probe has not asked the store for 3 min", askAge };
  if (wake.lastSendOk === false) return { state: "red", reason: wake.lastSendReason ?? "send-failed", fix: wake.lastSendFix ?? "see the probe log", askAge };
  const untaken = wake.batchId && !(Number.isFinite(wake.takenAt) && wake.takenAt >= (wake.batchAt ?? 0));
  if (untaken && wake.lastSendOk === true && Number.isFinite(wake.lastSendAt) && now - wake.lastSendAt > TAKEN_WITHIN_MS) {
    return { state: "red", reason: "batch-not-taken", fix: "the send went out but Manager has not read the batch", askAge };
  }
  return { state: untaken ? "ok" : "idle", askAge };
}

// The owner is told once per failure reason until a good send clears it.
export const shouldTellOwner = (status, told) => status.state === "red" && status.reason !== "probe-not-asking" && told !== status.reason;
