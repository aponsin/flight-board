// #C990: the store treats a silence of PROBE_SILENT_MS as an outage and the step clocks skip it. Tests that write evidence at one time and then ask the store
// about a time long after it (wakeAsk, takeInbox) would otherwise read as "the probe was down all that time". These two run the real functions after
// stamping a heartbeat at the asked time, straight in SQL, so no outage is recorded: the probe is taken to have been posting throughout.
import { wakeAsk as realWakeAsk, takeInbox as realTakeInbox } from "../../worker/board-store.mjs";

export const beat = (db, now) => db.prepare("INSERT INTO evidence (key, value, read_at) VALUES ('beat', '{}', ?) ON CONFLICT (key) DO UPDATE SET read_at = MAX(read_at, excluded.read_at)").bind(now).run();
export const wakeAsk = async (db, now, ...rest) => { await beat(db, now); return realWakeAsk(db, now, ...rest); };
export const takeInbox = async (db, now, ...rest) => { await beat(db, now); return realTakeInbox(db, now, ...rest); };
