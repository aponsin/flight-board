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
import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cardRow, ID } from "./import-mirror.mjs";

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
  const out = { insert: [], history: [], setRepo: [], refused: [], teamCards: [], skipped: { belowNum: 0, alreadyThere: 0 }, counterC: 0 };
  for (const [id, d] of Object.entries(docs).sort(([a], [b]) => a.localeCompare(b))) {
    // No number at all is not a card (left alone, as before); a number that is not an integer from 1 to 1e6 is refused, never counted.
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

export function deltaSql(p) {
  const insert = (t, row) => `INSERT OR IGNORE INTO ${t} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(q).join(", ")});`;
  return [
    ...p.insert.map((r) => insert("cards", r)),
    ...p.insert.map((r) => `UPDATE cards SET customer_text = ${q(r.customer_text)}, look_change = ${q(r.look_change)}, skip = ${q(r.skip)} WHERE id = ${q(r.id)} AND customer_text IS NULL AND look_change IS NULL AND skip IS NULL;`),
    ...p.history.map((h) => insert("history_cards", h)),
    ...p.setRepo.map((s) => `UPDATE cards SET repo = ${q(s.repo)} WHERE id = ${q(s.id)} AND repo IS NULL;`),
    `UPDATE counters SET next = MAX(next, ${p.counterC}) WHERE name = 'C';`,
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
  console.log(JSON.stringify(report(p), null, 2));
  if (get("--sql")) writeFileSync(get("--sql"), deltaSql(p) + "\n");
}
