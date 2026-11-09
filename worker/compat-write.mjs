// The write router behind the old page's dbRef / applyWrites (#C723 A3): one old write {op, path, data} in, one call to the store's
// own function out, so every rule of the store applies as strict as before and the refusal comes back in the same call.
// A write with no route is REFUSED by name ("no-route-yet", logged like any refusal), never dropped and never half-applied.
// Owner only (the caller checks the role). A route is added with its stage: threads/messages (B1), the answer's note and files (B2),
// approvals (C4).
import { answerAsk, closeAsk, reopenAsk, createListItem, updateListItem, refuse, mint } from "./board-store.mjs";
import { routeThreadWrite } from "./compat-threads.mjs";
import { optionOfKey } from "./compat-view.mjs";
import { filesRefusal, linkFiles } from "./file-store.mjs";
import { routeApproval } from "./compat-approvals.mjs";

const NO_ROUTE = (path, why) => ({ rule: "no-route-yet", detail: `${path}: ${why}` });
const askOf = async (db, id) => (typeof id === "string" ? db.prepare("SELECT * FROM asks WHERE id = ?").bind(id).first() : null);
// Keys the old page sends along with an answer that the store does not need (the wake is the store's own count).
// The page stamps updatedAt on every write to waiting/ideas and turns a delete into {deleted:true, updatedAt} (board.template.html stampedDb).
const HARMLESS = new Set(["ping", "respondedAt", "doneAt", "updatedAt"]);
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
    // A reply reopens a closed thread (#C725 B1): the page sends done:false (and when) with the message.
    if (d.done === false && keys.every((k) => k === "done" || k === "reopenedAt" || HARMLESS.has(k))) return reopenAsk(db, now, who, id);
    // A closed ask takes no answer and no second close (Checker, #C723): refuse BEFORE anything is stored, so a write that is
    // refused is never half applied (an answer stored, then the close refused).
    if (ask.closed_at) return refuse(db, now, { rule: "ask-already-closed", detail: id }, ask.card_id, who);
    const r = d.response;
    if (r !== undefined) {
      if (typeof r !== "object" || r === null) return refuse(db, now, NO_ROUTE(path, "the answer is an object"), ask.card_id, who);
      const fl = await filesRefusal(db, r.files);
      if (fl.refused) return refuse(db, now, fl.refused, ask.card_id, who);
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
      await linkFiles(db, now, "answer", id, fl.ids);
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
    if (d.deleted !== undefined) return refuse(db, now, NO_ROUTE(path, "the store deletes nothing; mark the row done"), null, who);
    if (d.startAt !== undefined) return refuse(db, now, NO_ROUTE(path, "Let's start is not part of this change"), null, who);
    const f = { id };
    for (const k of ["text", "area", "category", "note", "rank", "done"]) if (d[k] !== undefined) f[k] = d[k];
    return updateListItem(db, now, who, f);
  }

  // Threads and messages (#C725 B1): the owner's reply, ack, close and new thread, and a thread's rename.
  if (coll === "messages" || coll === "threads") return routeThreadWrite({ db, now, who, mint, refuse, filesRefusal, linkFiles }, { op, coll, id, d });

  // The pull request panel's Approve (set) and Withdraw (delete) (#C727 C4): the caller is the owner (the route is owner only).
  if (coll === "approvals") return routeApproval(db, now, who, "owner", op, id, d);

  return refuse(db, now, NO_ROUTE(path, `${op} on ${coll} has no route`), null, who);
}
