// The write router behind the old page's dbRef / applyWrites (#C723 A3): one old write {op, path, data} in, one call to the store's
// own function out, so every rule of the store applies as strict as before and the refusal comes back in the same call.
// A write with no route is REFUSED by name ("no-route-yet", logged like any refusal), never dropped and never half-applied.
// Owner only (the caller checks the role). A route is added with its stage: threads/messages (B1), the answer's note and files (B2),
// approvals (C4).
import { answerAsk, closeAsk, createListItem, updateListItem, refuse } from "./board-store.mjs";
import { optionOfKey } from "./compat-view.mjs";

const NO_ROUTE = (path, why) => ({ rule: "no-route-yet", detail: `${path}: ${why}` });
const askOf = async (db, id) => (typeof id === "string" ? db.prepare("SELECT * FROM asks WHERE id = ?").bind(id).first() : null);
// Keys the old page sends along with an answer that the store does not need (the wake is the store's own count).
const HARMLESS = new Set(["ping", "respondedAt", "doneAt"]);
const ID = /^[A-Za-z0-9-]{1,64}$/;

export async function routeWrite(db, now, who, { op, path, data } = {}) {
  const [coll, id, ...rest] = String(path ?? "").split("/");
  if (!["set", "update", "delete"].includes(op) || !coll || !id || rest.length || !ID.test(id)) return refuse(db, now, { rule: "compat-shape", detail: "op is set, update or delete; path is collection/id" }, null, who);
  const d = data && typeof data === "object" && !Array.isArray(data) ? data : {};

  if (coll === "waiting" && op === "update") {
    const ask = await askOf(db, id);
    if (!ask) return refuse(db, now, { rule: "ask-unknown", detail: id }, null, who);
    const keys = Object.keys(d);
    if (keys.every((k) => HARMLESS.has(k))) return { ok: true }; // a ping (or its time): nothing to store, the wake counts the answer
    const r = d.response;
    if (r !== undefined) {
      if (typeof r !== "object" || r === null) return refuse(db, now, NO_ROUTE(path, "the answer is an object"), ask.card_id, who);
      if (Array.isArray(r.files) && r.files.length) return refuse(db, now, NO_ROUTE(path, "files arrive with the file store (C1)"), ask.card_id, who);
      const note = typeof r.note === "string" ? r.note.trim() : "";
      let answer;
      if (r.status === "chose") {
        if (note) return refuse(db, now, NO_ROUTE(path, "a note with a choice arrives with B2"), ask.card_id, who);
        answer = optionOfKey(JSON.parse(ask.body).options, r.choice);
        if (answer === undefined) return refuse(db, now, { rule: "answer-not-an-option", detail: String(r.choice) }, ask.card_id, who);
      } else if (r.status === "ack" || r.status === "done") {
        if (ask.type === "Decision") return refuse(db, now, { rule: "answer-not-an-option", detail: "a Decision is answered with one of its options" }, ask.card_id, who);
        answer = note || (r.status === "ack" ? "Ack" : "Done");
      } else return refuse(db, now, NO_ROUTE(path, `answer status ${String(r.status).slice(0, 20)} arrives with B2`), ask.card_id, who);
      const done = await answerAsk(db, now, who, { id, answer });
      if (!done.ok) return done;
      if (d.done === true) return closeAsk(db, now, who, id, "owner");
      return done;
    }
    if (d.done === true && keys.every((k) => k === "done" || HARMLESS.has(k))) return closeAsk(db, now, who, id, "owner");
    return refuse(db, now, NO_ROUTE(path, `fields ${keys.join(", ").slice(0, 60)}`), ask.card_id, who);
  }

  if ((coll === "todo" || coll === "ideas") && op === "set") {
    const f = { kind: coll === "todo" ? "todo" : "idea", text: d.text };
    for (const k of ["area", "category", "note", "rank"]) if (d[k] !== undefined && d[k] !== null) f[k] = d[k];
    if (d.done === true) f.done = true;
    return createListItem(db, now, who, f);
  }
  if ((coll === "todo" || coll === "ideas") && op === "update") {
    if (d.startAt !== undefined) return refuse(db, now, NO_ROUTE(path, "Let's start is not part of this change"), null, who);
    const f = { id };
    for (const k of ["text", "area", "category", "note", "rank", "done"]) if (d[k] !== undefined) f[k] = d[k];
    return updateListItem(db, now, who, f);
  }

  return refuse(db, now, NO_ROUTE(path, `${op} on ${coll} has no route`), null, who);
}
