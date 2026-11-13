// #C1006: scheduled tasks flag a model they were not given. On 11-12 the watchdog task named no model, followed the app default and ran two days on the
// top model before anyone saw it. The app's session file of every run, a scheduled task's too, carries the model it ran on (`model`) and, for a task's
// run, `scheduledTaskId` (appSessions keeps both, as plain words or null). What no file carries is the model a task was MEANT to have, so the board config
// does: `scheduledTasks: [{ id, model?, paused? }]` (scripts/config.mjs). This reads the two together and posts one evidence key, schedule.models:
//   { at, tasks: [{ id, chosen, lastRun, at }] }   (words, model names and times only; chosen and lastRun are null when not known; at is the last run's time)
// One entry for each configured task that is not paused, in the config's order, 30 at most. A task id that is not in the config is never listed.
// The page draws the verdict (page/board.template.html scheduleModelsHtml); nothing is decided here beyond what to post.
import { TASK_ID, MODEL_WORD, TASK_MAX } from "../scripts/config.mjs";

// The configured list, or null (with a logged reason) when it is not a list of plain entries: the store then keeps its last good reading.
export function configuredTasks(configText, log = () => {}) {
  let list;
  try { list = JSON.parse(configText)?.scheduledTasks; } catch { log("schedule: the board config could not be read"); return null; }
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > TASK_MAX) { log("schedule: scheduledTasks is not a list of up to 30 tasks; not posted"); return null; }
  const seen = new Set(), out = [];
  for (const t of list) {
    const ok = t && typeof t === "object" && !Array.isArray(t) && Object.keys(t).every((k) => ["id", "model", "paused"].includes(k))
      && typeof t.id === "string" && TASK_ID.test(t.id) && !seen.has(t.id)
      && (t.model === undefined || t.model === null || (typeof t.model === "string" && MODEL_WORD.test(t.model)))
      && (t.paused === undefined || typeof t.paused === "boolean");
    if (!ok) { log("schedule: an entry of scheduledTasks is not { id, model, paused } with plain words; not posted"); return null; }
    seen.add(t.id);
    out.push({ id: t.id, model: t.model ?? null, paused: t.paused === true });
  }
  return out;
}

// sessions: appSessions' rows (archived ones are already left out). The newest run of each task id, by the session's last activity.
export function newestRuns(sessions) {
  const by = new Map();
  for (const s of sessions) {
    if (typeof s?.scheduledTaskId !== "string" || !TASK_ID.test(s.scheduledTaskId)) continue;
    const at = Number.isFinite(s.at) ? s.at : 0, held = by.get(s.scheduledTaskId);
    if (!held || at > held.at) by.set(s.scheduledTaskId, { at, model: typeof s.model === "string" && MODEL_WORD.test(s.model) ? s.model : null, known: Number.isFinite(s.at) });
  }
  return by;
}

export function scheduleModelsWrite(configText, { sessions, now, log = () => {} }) {
  const tasks = configuredTasks(configText, log);
  if (!tasks) return null;
  const runs = newestRuns(sessions ?? []);
  const entry = (id, chosen) => { const r = runs.get(id); return { id, chosen, lastRun: r?.model ?? null, at: r?.known ? r.at : null }; };
  // Only the tasks the config names: a task id seen on a session but not in scheduledTasks (another project's task) is not listed, so no other project's task name reaches the board (Security's LOW).
  const own = tasks.filter((t) => !t.paused).map((t) => entry(t.id, t.model));
  return { key: "schedule.models", value: { at: now, tasks: own.slice(0, TASK_MAX) } };
}
