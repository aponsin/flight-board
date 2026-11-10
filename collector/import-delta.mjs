// The C5 delta import (#C741), DRY RUN FIRST: the old board's cards numbered 719 and up that the store does not hold yet, and the repo word of
// the board's own cards. It is NOT import3 (never re-run): it reads only the initiatives the lead exported and the store's own view, and it
// writes nothing itself; --sql gives the file the owner would run, signed, after the deploy pair.
//   node collector/import-delta.mjs --export <dir with initiatives/> --store <a read of the store's view as JSON> --repo <flight-board checkout>
//        [--sql <out file>] [--repo-word flight-board] [--from-num 719]
// Rules:
//  1 a card of the board's own repository is one whose Board-Id trailer is on a commit of origin/main, or on the tip of an origin build/ branch
//    (work not landed yet): read from git, never from who or num. Its repo word is --repo-word (the config's repos[] name). Any other card gets
//    no repo word (the team's repository), and is listed so the lead can see it;
//  2 a card the store lacks is inserted (INSERT OR IGNORE, by its old id, with its number kept) through the store's own card rules; a refused
//    one is listed with rule and id, never patched; a done card is a history row, as in import3, not a card;
//  3 a card the store holds gets its repo word only if it has none (UPDATE ... WHERE repo IS NULL), nothing else changes;
//  4 the card counter only goes up. Threads, asks, messages and steps are not touched: the probe writes a card's phase history itself.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cardRow, ID, plan as mirrorPlan, readMirror, compare, closures } from "./import-mirror.mjs";
import { planHistory, historySql, readHistory } from "./import-history.mjs";
import { compareTabs } from "./import-compare.mjs";

// A control character other than tab and newline (a NUL cuts the SQL text: SQLite would run the earlier statements, then fail) is never written.
const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const q = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new Error("sql: a number that is not finite"); return String(v); }
  const s = String(v);
  if (CTRL.test(s)) throw new Error("sql: a control character other than tab and newline in a value");
  return `'${s.replaceAll("'", "''")}'`;
};
const hasCtrl = (row) => Object.values(row).some((v) => typeof v === "string" && CTRL.test(v));
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
// The probe's rule for a card number (collector/state.mjs): an integer from 1 to 1e6.
const numOk = (n) => Number.isInteger(n) && n >= 1 && n <= 1e6;
const WORD = /^[a-z0-9][a-z0-9-]{0,39}$/;

// The Board-Id trailers of a git log output (valueonly: one id a line, blank lines between).
export const idsOf = (text) => new Set([...String(text).matchAll(/^Board-Id:[ \t]*([a-z0-9][a-z0-9-]{0,63})[ \t]*$/gm)].map((m) => m[1]));

// Which card ids the repository holds work for: commits on origin/main, and the tip of each origin/build/ branch. `git` is (args) -> text.
export function boardIdsFromGit(git) {
  const ids = idsOf(git(["log", "origin/main", "--format=%B"]));
  const refs = git(["for-each-ref", "--format=%(refname)", "refs/remotes/origin/build/"]).split("\n").map((s) => s.trim()).filter(Boolean);
  for (const ref of refs) for (const id of idsOf(git(["log", "-1", "--format=%B", ref]))) ids.add(id);
  return ids;
}

// docs: the exported initiatives { id: doc }. store: { cardIds: Set, historyIds: Set } of what the store holds. boardIds: the set above.
export function planDelta(docs, { storeIds = new Set(), historyIds = new Set(), boardIds = new Set(), repoWord = "flight-board", fromNum = 719 } = {}) {
  if (!WORD.test(repoWord)) throw new Error("repo word: lower case letters, digits and -");
  const out = { insert: [], history: [], setRepo: [], refused: [], teamCards: [], skipped: { belowNum: 0, alreadyThere: 0, deleted: 0 }, counterC: 0 };
  for (const [id, d] of Object.entries(docs).sort(([a], [b]) => a.localeCompare(b))) {
    // No number at all is not a card (left alone, as before); a number that is not an integer from 1 to 1e6 is refused, never counted.
    if (d?.deleted === true) { out.skipped.deleted++; continue; }
    if (d?.num === undefined || d?.num === null) { out.skipped.belowNum++; continue; }
    if (!numOk(d.num)) { out.refused.push({ id, rule: "card-shape", detail: "number out of range" }); continue; }
    const num = d.num;
    if (num < fromNum) { out.skipped.belowNum++; continue; }
    if (!ID.test(id)) { out.refused.push({ id, rule: "card-id" }); continue; }
    out.counterC = Math.max(out.counterC, num + 1);
    const board = boardIds.has(id);
    if (!board) out.teamCards.push({ id, num });
    if (storeIds.has(id)) {
      if (board) out.setRepo.push({ id, repo: repoWord }); else out.skipped.alreadyThere++;
      continue;
    }
    if (d.status === "done") {
      const doneAt = int(d.doneAt);
      if (!historyIds.has(id) && !d.dropped && typeof d.name === "string" && d.name.trim() && doneAt) {
        const h = { id, num, title: d.name, size: ["XS", "S", "M", "L", "XL"].includes(d.size) ? d.size : null, review_level: ["None", "Quick", "Full"].includes(d.level) ? d.level : null, created_at: int(d.createdAt), done_at: doneAt };
        if (hasCtrl(h)) out.refused.push({ id, rule: "card-shape", detail: "control character" }); else out.history.push(h);
      }
      continue;
    }
    const r = cardRow(id, d);
    if (!r.ok) { out.refused.push({ id, rule: r.rule, detail: r.detail }); continue; }
    if (hasCtrl(r.row)) { out.refused.push({ id, rule: "card-shape", detail: "control character" }); continue; }
    out.insert.push({ ...r.row, ...(board ? { repo: repoWord } : {}) });
  }
  return out;
}

// The asks and threads still open on the old board (#C744), by the first import's rules (collector/import-mirror.mjs plan: open items only,
// the owner's answer carried, the old #T number kept, the store's own ask rules, a refused item listed and never patched, the lead as the
// asker where the item names none). INSERT OR IGNORE by old id, so a second run with a fresher export changes nothing already there.
// docs: { initiatives, threads, messages, waiting } (the lists and steps are not read here). storeAsks: the store's own asks.
// Nothing is closed here: an ask the store holds that the old board has since closed is listed (stillOpenInStoreButClosedOld); the history
// plan (planHistory, --history) closes it by a guarded UPDATE (closeOpenSql).
export function planAsks(docs, { owner = "", roster = [], lead = "", liveT = 0, storeAsks = [] } = {}) {
  // A thread number must be an integer from 1 to 1e6 (the probe's rule): any other is dropped, and the ask is given the next number above the counters.
  // Since board v3.56 a delete on the old board is { deleted: true, updatedAt }: such an item (a waiting item, a thread, a message) is gone, not open.
  const live = (coll) => Object.fromEntries(Object.entries(coll ?? {}).filter(([, d]) => d?.deleted !== true));
  const threads = {};
  const dropped = [];
  for (const [id, t] of Object.entries(live(docs.threads))) {
    if (t && t.num !== undefined && !numOk(t.num)) { dropped.push(id); threads[id] = { ...t, num: undefined }; } else threads[id] = t;
  }
  const waiting = live(docs.waiting);
  docs = { ...docs, waiting };
  const p = mirrorPlan({ initiatives: live(docs.initiatives), threads, messages: live(docs.messages), waiting, ideas: {}, steps: {} }, { owner, roster, lead, liveT });
  const refused = p.refused.filter((r) => r.kind === "ask" || r.kind === "message");
  // Every file-name id that reaches the SQL (an ask's, a message's, a message's thread) passes the card-id rule, and no value holds a control character.
  const okRow = (kind, row, ids) => {
    if (ids.some((i) => typeof i !== "string" || !ID.test(i))) { refused.push({ kind, id: String(row.id), rule: `${kind}-id` }); return false; }
    if (!hasCtrl(row)) return true;
    refused.push({ kind, id: row.id, rule: "control-char" });
    return false;
  };
  const asks = p.asks.filter((r) => okRow("ask", r, [r.id]));
  const have = new Set(storeAsks.map((s) => s.id));
  const messages = p.messages.filter((m) => okRow("message", m, [m.id, m.thread_id]));
  // What the old board has closed since (done, or its thread resolved): the first import's own reading (closures), listed only, never closed here.
  const cl = closures({ ...docs, threads, messages: live(docs.messages) }, storeAsks ?? [], { now: 0 });
  const stillOpen = cl.close.map((c) => c.id);
  return {
    asks, messages, refused, notes: p.notes, droppedThreadNums: dropped, counts: p.counts, defaultedAsker: p.defaulted,
    skipped: { doneAsks: p.skipped.doneAsks, resolvedAsks: p.skipped.resolvedAsks },
    newAsks: asks.filter((a) => !have.has(a.id)).map((a) => a.id), heldAlready: asks.filter((a) => have.has(a.id)).map((a) => a.id),
    stillOpenInStoreButClosedOld: stillOpen, closeRefused: cl.refused, notOnOldBoard: cl.unknown.map((u) => u.id), counterT: p.counters.T,
  };
}

// #C748: an ask the store already holds from the first import has the parts the store's rules then dropped (a Later's steps, expect and
// where; an Action's where) or the wrong type (a "later" item with options is a Decision). One guarded UPDATE each, by old id: it
// changes the ask only while it is open and unanswered and its body lacks the part, so a second run, or an ask the owner has since
// answered or closed, changes nothing. Reads the plan's own row, so it is as fresh as the export.
const PATCHABLE = { Later: ["steps", "expect", "where"], Action: ["where"] };
export function askFixSql(r) {
  const body = JSON.parse(r.body);
  const open = `closed_at IS NULL AND answered_at IS NULL`;
  if (r.type === "Decision" && body.options) {
    // Answered on the old board before this run: its answer is not carried by this UPDATE, so converting would ask the owner again. Left as it is.
    if (r.answered_at) return null;
    // An item the first import made a Later: becomes the Decision with its question and options (only while it still is a Later).
    return `UPDATE asks SET type = 'Decision', body = ${q(r.body)}, eta_at = NULL, eta_precondition = NULL WHERE id = ${q(r.id)} AND type = 'Later' AND ${open};`;
  }
  const keys = (PATCHABLE[r.type] ?? []).filter((k) => body[k] !== undefined);
  if (!keys.length) return null;
  const patch = Object.fromEntries(keys.map((k) => [k, body[k]]));
  return `UPDATE asks SET body = json_patch(body, ${q(JSON.stringify(patch))}) WHERE id = ${q(r.id)} AND type = ${q(r.type)} AND ${open} AND ${keys.map((k) => `json_extract(body, '$.${k}') IS NULL`).join(" AND ")};`;
}

// #C824: an ask the first runs stored with its screenshots as "[object Object]" (#T1701: the old images were objects, and String() made them
// that) gets the right list, by one guarded UPDATE that touches only a body whose screenshots still hold the bad text.
export function shotsFixSql(r) {
  const shots = JSON.parse(r.body).screenshots;
  if (!Array.isArray(shots) || !shots.length || shots.some((s) => typeof s !== "string" || s.includes("[object"))) return null;
  return `UPDATE asks SET body = json_patch(body, ${q(JSON.stringify({ screenshots: shots }))}) WHERE id = ${q(r.id)} AND json_extract(body, '$.screenshots') LIKE '%[object Object]%';`;
}

// #C748: --clear-check <id,id,...>: lift the check date of finished cards (a card with one is not closed by the page on the live reading).
// Each id passes the card-id rule; the UPDATE touches only a card that has a date.
export function clearCheckSql(ids) {
  return String(ids ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((id) => {
    if (!ID.test(id)) throw new Error(`clear-check: not a card id: ${id.slice(0, 40)}`);
    return `UPDATE cards SET check_at = NULL WHERE id = ${q(id)} AND check_at IS NOT NULL;`;
  }).join("\n");
}

export function deltaSql(p, a = null, append = "", history = null) {
  const insert = (t, row) => `INSERT OR IGNORE INTO ${t} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(q).join(", ")});`;
  const asksSql = a ? [...a.asks.map((r) => insert("asks", r)), ...a.asks.map(askFixSql).filter(Boolean), ...a.asks.map(shotsFixSql).filter(Boolean), ...a.messages.map((r) => insert("messages", r)), `UPDATE counters SET next = MAX(next, ${a.counterT}) WHERE name = 'T';`] : [];
  const extra = String(append).split("\n").map((s) => s.trim()).filter(Boolean);
  // Appended lines (--append): one-off, hand-written, each a single guarded UPDATE of ships or cards and nothing else.
  for (const l of extra) {
    if (CTRL.test(l)) throw new Error("sql: a control character in the appended lines");
    if (!/^UPDATE (ships|cards) SET [^;]+ WHERE [^;]+;$/.test(l)) throw new Error(`sql: an appended line that is not a single guarded UPDATE (with a WHERE) of ships or cards: ${l.slice(0, 40)}`);
  }
  return [
    ...p.insert.map((r) => insert("cards", r)),
    ...p.insert.map((r) => `UPDATE cards SET customer_text = ${q(r.customer_text)}, look_change = ${q(r.look_change)}, skip = ${q(r.skip)} WHERE id = ${q(r.id)} AND customer_text IS NULL AND look_change IS NULL AND skip IS NULL;`),
    ...p.history.map((h) => insert("history_cards", h)),
    ...p.setRepo.map((s) => `UPDATE cards SET repo = ${q(s.repo)} WHERE id = ${q(s.id)} AND repo IS NULL;`),
    `UPDATE counters SET next = MAX(next, ${p.counterC}) WHERE name = 'C';`,
    ...asksSql,
    ...(history ? historySql(history, q) : []),
    ...extra,
  ].join("\n");
}

export function report(p) {
  return { insert: p.insert.map((r) => ({ id: r.id, num: r.num, repo: r.repo ?? null, owner_role: r.owner_role })), history: p.history.map((h) => h.id), setRepoOnExisting: p.setRepo.map((s) => s.id), refused: p.refused, notBoardCards: p.teamCards, skipped: p.skipped, counterC: p.counterC };
}

export function readInitiatives(dir) {
  const out = {};
  for (const f of readdirSync(dir)) if (f.endsWith(".json")) out[f.slice(0, -5)] = JSON.parse(readFileSync(join(dir, f), "utf8"));
  return out;
}

// Run as a script: compared as paths (fileURLToPath, real paths), so a folder with a space or another character a URL encodes still runs it.
const same = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return false; } };
if (process.argv[1] && same(fileURLToPath(import.meta.url), process.argv[1])) {
  const get = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
  if (!get("--export") || !get("--store") || !get("--repo")) { console.error("pass --export <dir>, --store <view.json> and --repo <flight-board checkout>"); process.exit(64); }
  const view = JSON.parse(readFileSync(get("--store"), "utf8"));
  const git = (args) => execFileSync("git", ["-C", get("--repo"), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  const p = planDelta(readInitiatives(join(get("--export"), "initiatives")), {
    storeIds: new Set((view.cards ?? []).map((c) => c.id)), historyIds: new Set((view.historyCards ?? []).map((c) => c.id)),
    boardIds: boardIdsFromGit(git), repoWord: get("--repo-word") ?? "flight-board", fromNum: Number(get("--from-num") ?? 719),
  });
  // The asks and threads (#C744): read when the export holds a waiting/ folder. The owner and the roster come from the board config (--config).
  let a = null, asksReport = null, mirror = null, conf = null;
  const expect = Object.fromEntries((get("--expect") ?? "").split(",").filter(Boolean).map((x) => x.split("=")).map(([k, v]) => [k, Number(v)]));
  if (existsSync(join(get("--export"), "waiting"))) {
    if (!get("--config")) { console.error("the export has asks: pass --config <board.config.json> (owner and roster)"); process.exit(64); }
    conf = JSON.parse(readFileSync(get("--config"), "utf8"));
    mirror = readMirror(get("--export"));
    a = planAsks(mirror, { owner: conf.owner ?? "", roster: conf.roster ?? [], lead: get("--lead") ?? "Manager", liveT: Number(get("--live-t") ?? 0), storeAsks: view.asks ?? [] });
    asksReport = { newAsks: a.newAsks, heldAlready: a.heldAlready, messages: a.messages.length, counts: a.counts, differencesFromOldPage: compare(a.counts, expect), unchecked: ["needs", "later", "lead"].filter((k) => expect[k] === undefined), skipped: a.skipped, refused: a.refused.filter((r) => r.kind !== "message"), refusedMessages: a.refused.filter((r) => r.kind === "message").length, notes: a.notes, droppedThreadNums: a.droppedThreadNums, askedByLead: a.defaultedAsker, stillOpenInStoreButClosedOld: a.stillOpenInStoreButClosedOld, counterT: a.counterT };
  }
  // The old board's history (#C749): with --history, the usage days, the Shipped feed, the done cards' steps and the threads closed in the
  // last --history-days (30) that the first import left out. Every row is INSERT OR IGNORE by its own key; --now is for tests and reruns.
  let h = null;
  if (process.argv.includes("--history")) {
    const hc = view.historyCards ?? [], cs = view.cards ?? [];
    h = planHistory(readHistory(get("--export")), {
      now: Number(get("--now") ?? Date.now()), days: Number(get("--history-days") ?? 30),
      owner: conf?.owner ?? "", roster: conf?.roster ?? [], lead: get("--lead") ?? "Manager",
      have: {
        askIds: new Set((view.asks ?? []).map((s) => s.id)), openAskIds: new Set((view.asks ?? []).filter((s) => !s.closed_at).map((s) => s.id)),
        threadNums: new Set((view.threads?.threads ?? []).map((t) => t.num).filter(Number.isInteger)), askNums: new Set((view.asks ?? []).map((s) => s.num).filter(Number.isInteger)),
        usageDays: new Set((view.usage ?? []).map((u) => u.day)), shipVersions: new Set((view.ships ?? []).map((s) => s.version)),
        historyCardIds: new Set(hc.map((c) => c.id)), cardIds: new Set(cs.map((c) => c.id)),
        messageIds: new Set((view.threads?.messages ?? []).map((m) => m.id)), threadIds: new Set((view.threads?.threads ?? []).map((t) => t.id)),
        cardsByNum: new Map([...hc, ...cs].filter((c) => Number.isInteger(c.num)).map((c) => [c.num, c.id])),
      },
    });
  }
  // #C824: the six tab counts and the in-flight count against the old page, a reason for every difference (needs the export's asks and history).
  const tabs = a && h ? compareTabs({ docs: { ...mirror, ...readHistory(get("--export")) }, view, p, a, h, now: Number(get("--now") ?? Date.now()), expect, windowDays: Number(get("--history-days") ?? 30) }) : null;
  const whole = JSON.stringify({ ...report(p), ...(asksReport ? { asks: asksReport } : {}), ...(h ? { history: h.report } : {}), ...(tabs ? { tabs } : {}) }, null, 2);
  // --report <file>: the whole report goes to the file and only the tab line is printed (the report is long).
  if (get("--report")) {
    writeFileSync(get("--report"), whole + "\n");
    console.log(`report written to ${get("--report")}${tabs ? `\ntabs: ${Object.values(tabs).map((t) => `${t.tab} ${t.ours}${t.oldPage !== null ? ` (old page ${t.oldPage})` : ""}`).join(" | ")}` : ""}${h?.report?.closedAsks ? `\nclosed asks: ${h.report.closedAsks.new} new, ${h.report.closedAsks.refused} refused, ${h.report.closedAsks.held} held` : ""}`);
  } else console.log(whole);
  if (get("--sql")) writeFileSync(get("--sql"), deltaSql(p, a, [get("--append") ? readFileSync(get("--append"), "utf8") : "", clearCheckSql(get("--clear-check"))].filter(Boolean).join("\n"), h) + "\n");
}
