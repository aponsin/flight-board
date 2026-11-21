// The gate's Stop hook: node gate/stop.mjs --config <board.config.json> [--store]
// On the store (#C825) the lead's turn end is not checked here: the store's own tools and the Worker keep the board (the owner's words wake the
// lead through the board's wake, #C580), so there is no mirror, journal or live check to read, and the lead's branch does nothing (#C864 step 3:
// the old board's checks, the owner's word unanswered, a verdict with no write, a question with no item, went with the old board's files).
// A roster role other than the lead is asked, once each, to
// - arm its dispatch watch when the board dispatches and none runs (#C631);
// - act on a card the board woke it for, by a push, a post on the card's thread or a send (#C848);
// - push a build branch whose commits origin does not have (#C853).
// Exit 0 with a JSON block on stdout is the refusal (#C588). A second stop in a row (stop_hook_active) passes. --store is accepted and changes nothing:
// it is the only mode.
import { realpathSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkConfig, fullConfig, boardId, home } from "../scripts/config.mjs";
import { readLines, sessionRole, currentTurn, turnCalls } from "./session.mjs";
import { idText } from "../collector/text.mjs";
import { shQuote, writeAtomic } from "./wake.mjs";
import { DISPATCH_FILE, dispatchPidFile, dispatchWatchAlive, dispatchWokenFile, dispatchWaitCheckedFile } from "./reset.mjs";

// dispatch (#C631): { on, alive, askedAt, command } for a roster role other than the lead — whether the probe dispatches (dispatch.json
// exists), whether the role's own watch (a background Bash) is running, when this hook last asked, and the command that arms it.
// The ask is made at most every DISPATCH_ASK_GAP_MS, so a session that can't run a background command is not stopped for ever.
export const DISPATCH_ASK_GAP_MS = 10 * 60e3;
export const dispatchAsk = ({ on, alive, askedAt, command }, now) =>
  on && !alive && !(Number.isFinite(askedAt) && askedAt <= now + 5_000 && now - askedAt < DISPATCH_ASK_GAP_MS)
    ? `Dispatch watch: the board wakes you through it when a card of yours waits and you are idle, and it isn't running. Arm it now (Bash with run_in_background true and no timeout): ${command}. When it ends it has printed a DISPATCH line: act on it, then arm it again.`
    : null;
// #C848 (no-unread-questions, reshaped): nobody reads an agent's chat, so a turn that ends while the board woke the role for a card, with
// nothing pushed and nothing posted on that card's thread, is refused once. The evidence is the board's wake (the DISPATCH its watch printed,
// kept in dispatch-woken-<Role>.json: { at, cards }) and what the turn did (a `git push` in a Bash call, a store `post` to the card's thread),
// never the wording of the last message. Judged once per wake: `checkedAt` is when the last judgment was made.
const WOKEN_CARD = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STORE_POST = /^mcp__[0-9A-Za-z-]{8,64}__post$/;
// A signoff script pushes inside (npm --prefix <repo> run signoff -- checker): it is the answer as a push is.
const SIGNOFF = /(?:^|[;&|(])\s*npm\b[^\n;&|]*\brun\s+(?:signoff|ship)\b/;
const GIT_PUSH = /(?:^|[\s;&|(])git\b(?:\s+-[-\w]+(?:[= ]\S+)?)*\s+push\b/;
// A turn the board's wake started is one a background task's notification (the watch ended) or a DISPATCH line opened; a turn a person
// typed into the role's session or another session sent is not judged, and the wake stays unjudged for the turn that is.
// Only the wake watch's own notification counts (Checker F2): another background command's completion (tests, a wait) is no wake. The
// notification names the tool-use id of the call that ran; that call is found in the transcript and must have run wake-watch.mjs.
const WAKE_TURN = /\bDISPATCH(?:-LATE)?\b/;
const WATCH_CMD = /\bwake-watch\.mjs\b/;
export function startedByWake(turn, lines = []) {
  const first = (Array.isArray(turn) ? turn : []).find((l) => l?.type === "user" && !l.isMeta);
  const c = first?.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p?.type === "text" ? p.text ?? "" : p?.type === "tool_result" ? JSON.stringify(p.content ?? "") : "")).join("\n") : "";
  if (WAKE_TURN.test(text)) return true;
  const ids = [...text.matchAll(/<tool-use-id>([A-Za-z0-9_-]{1,80})<\/tool-use-id>/g)].map((m) => m[1]);
  if (!ids.length) return false;
  const watched = new Set();
  for (const l of Array.isArray(lines) ? lines : []) for (const p of Array.isArray(l?.message?.content) ? l.message.content : []) if (p?.type === "tool_use" && p.name === "Bash" && WATCH_CMD.test(String(p.input?.command ?? ""))) watched.add(p.id);
  return ids.some((i) => watched.has(i));
}
export function wokenCheck(woken, checkedAt, calls, started = true) {
  if (!started || !woken || !Number.isFinite(woken.at) || (Number.isFinite(checkedAt) && woken.at <= checkedAt)) return { judged: false, ask: null };
  const cards = (Array.isArray(woken.cards) ? woken.cards : []).filter((c) => typeof c === "string" && WOKEN_CARD.test(c));
  // Acting on a wake (Checker F1): a push, a signoff run (it pushes inside), a SendMessage (FINDINGS, PASS and READY go by it) or a background Bash call.
  const pushed = calls.some((c) => c.name === "SendMessage" || (c.name === "Bash" && (GIT_PUSH.test(String(c.input?.command ?? "")) || SIGNOFF.test(String(c.input?.command ?? "")) || c.input?.run_in_background === true)));
  const posted = new Set(calls.filter((c) => STORE_POST.test(String(c.name))).map((c) => c.input?.thread_id));
  const left = cards.filter((c) => !pushed && !posted.has(c));
  if (!left.length) return { judged: true, ask: null };
  return { judged: true, ask: `Nobody reads this chat. The board woke you for ${left.map(idText).join(", ")}, and this turn pushed nothing and posted nothing on ${left.length === 1 ? "its" : "their"} thread. If it is in your lane, do it (pushing your own build branch, sending READY and taking your next queued card need no go from anyone); otherwise post the question on the card's thread for Manager.` };
}
// #C853 (stop-hook-unpushed-build; R2: models do judgment, programs do hand-offs): a turn that ends on a local build branch with commits
// origin does not have is refused once per tip, whatever the turn said. The evidence is git, read in the session's own folder (the board's
// repository or a product worktree): the branch is build/..., and `git rev-list --count HEAD --not --remotes=origin` counts the commits no
// origin ref holds (a branch never pushed counts too). Once per tip: unpushed-refused-<Role>.json keeps { branch: sha } of the last refusal.
const BUILD_BRANCH = /^build\/[A-Za-z0-9._\/-]{1,120}$/;
export function supersededBy(branch, heads) {
  const m = /^(.*?)(?:-v([0-9]{1,4}))?$/.exec(String(branch)), base = m[1], n = m[2] ? Number(m[2]) : 1;
  return (Array.isArray(heads) ? heads : []).find((h) => { const k = /^(.*?)-v([0-9]{1,4})$/.exec(String(h)); return k && k[1] === base && Number(k[2]) > n; }) ?? null;
}
// A turn that leaves a background task running (a Bash call with run_in_background) is not judged: the agent ends it to wait, and a push now would wake the reviewer on unchecked work.
export function backgroundRunning(calls) { return (Array.isArray(calls) ? calls : []).some((c) => c.name === "Bash" && c.input?.run_in_background === true); }
export function unpushedState(cwd, run = (args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })) {
  try {
    if (typeof cwd !== "string" || !cwd.startsWith("/")) return null;
    const branch = run(["symbolic-ref", "--short", "-q", "HEAD"]).trim();
    if (!BUILD_BRANCH.test(branch)) return null;
    const sha = run(["rev-parse", "HEAD"]).trim();
    const ahead = Number(run(["rev-list", "--count", "HEAD", "--not", "--remotes=origin"]).trim());
    if (!/^[0-9a-f]{40}$/.test(sha) || !Number.isInteger(ahead) || ahead < 0) return null;
    // A re-cut lands and the older -vN is deleted from origin: a session still on it is not asked to push the dead branch back.
    const heads = run(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/build/"]).split("\n").map((l) => l.trim().replace(/^origin\//, ""));
    if (supersededBy(branch, heads)) return null;
    return { branch, sha, ahead };
  } catch { return null; }
}
// #C888: a builder works in worktrees it cuts under its own session folder (`git -C <worktree> commit`), so the folder the session started in is
// often on main and the build branch with the unpushed commit is in a linked worktree. The hook reads the session's folder AND the repository's
// worktrees whose path holds the session's id (its scratchpad); another session's worktrees are never counted. The folder's own state wins when it
// is ahead; otherwise the first worktree of this session that is.
// A stack built on purpose needs no way to say so: once stack mode is live a push no longer wakes the reviewers per slice (they are woken once, when no
// builder has a queued card left for the repository), so pushing every slice is harmless and this check and stack mode do not fight (Manager, #C888).
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function ownWorktrees(cwd, sessionId, run = (args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })) {
  try {
    if (typeof cwd !== "string" || !cwd.startsWith("/") || !SESSION_ID.test(String(sessionId))) return [];
    return run(["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9).trim())
      .filter((p) => p.startsWith("/") && p !== cwd && p.split("/").includes(sessionId));
  } catch { return []; }
}
export function unpushedAcross(cwd, sessionId, state = unpushedState, list = ownWorktrees) {
  const here = state(cwd);
  if (here && here.ahead > 0) return here;
  for (const p of list(cwd, sessionId)) { const s = state(p); if (s && s.ahead > 0) return s; }
  return here;
}
export function unpushedCheck(state, refused) {
  if (!state || !BUILD_BRANCH.test(String(state.branch)) || !(state.ahead > 0) || !/^[0-9a-f]{40}$/.test(String(state.sha))) return { ask: null, judged: null };
  if (refused && typeof refused === "object" && refused[state.branch] === state.sha) return { ask: null, judged: null };
  const n = state.ahead;
  return { judged: { branch: state.branch, sha: state.sha }, ask: `Your build branch ${state.branch} has ${n} commit${n === 1 ? "" : "s"} that origin does not have (tip ${state.sha.slice(0, 12)}). Push it once the work is green, if it is your own build branch (the owner authorises pushing your own build branch: git push origin ${state.branch}), then send READY. This is asked once per tip.` };
}
// #C1390 (11-20, twice: #C1382 then #C1383 were pushed, the turn said "next is X, not started, dispatch watch armed" and went idle; the watch did not fire and the board flagged a stall until Manager
// said go): when stack-ready has just told the builder that cards are queued behind this one ("more queued (...)" or "waiting for its group ... (... not built)"), the turn must go on to start the
// next card, not end on arming the watch. The evidence is the tool, never the wording: the last stack-ready run of the turn printed one of those two lines, and no call after it is anything but
// arming the wake watch (a Bash running wake-watch.mjs). Asked once per turn: a second stop in a row passes (stop_hook_active).
const STACK_READY = /\bstack-ready\.mjs\b/, WATCH = /\bwake-watch\.mjs\b/;
const QUEUED_LINE = /STACK-READY OK:[^\n]*?(?:more queued|waiting for its group[^(\n]*)\s*\(([^)\n]{1,300})\)/;
export function nextCardCheck(turn) {
  const results = new Map(), calls = [];
  for (const l of Array.isArray(turn) ? turn : []) {
    if (l?.type === "user" && Array.isArray(l.message?.content)) for (const p of l.message.content) if (p?.type === "tool_result") results.set(p.tool_use_id, typeof p.content === "string" ? p.content : Array.isArray(p.content) ? p.content.map((c) => c?.text ?? "").join("\n") : "");
    if (l?.type === "assistant" && Array.isArray(l.message?.content)) for (const p of l.message.content) if (p?.type === "tool_use") calls.push(p);
  }
  const at = calls.findLastIndex((c) => c.name === "Bash" && STACK_READY.test(String(c.input?.command ?? "")));
  if (at < 0) return { ask: null };
  const m = QUEUED_LINE.exec(String(results.get(calls[at].id) ?? ""));
  if (!m) return { ask: null };
  const ids = m[1].replace(/\s+not built\s*$/, "").split(",").map((s) => s.trim()).filter((s) => WOKEN_CARD.test(s));
  if (!ids.length) return { ask: null };
  if (calls.slice(at + 1).some((c) => !(c.name === "Bash" && WATCH.test(String(c.input?.command ?? ""))))) return { ask: null };
  return { ask: `stack-ready says ${ids.length === 1 ? "a card" : `${ids.length} cards`} of yours ${ids.length === 1 ? "is" : "are"} queued behind this one (${ids.map(idText).join(", ")}), and this turn ends without starting ${ids.length === 1 ? "it" : "the next"}. Start the next card now (cut its worktree on this tip and make the first commit); do not end on "next is X, dispatch watch armed": the watch fires only when the board sees you idle. Taking your next queued card needs no go from anyone.` };
}
// The checks for one stop: the lead is never refused here; a roster role is asked the things above.
export function stopRun(lines, { config, env = {}, now = Date.now(), dispatch = null, unpushed = null }) {
  const { role } = sessionRole(lines, env.FLIGHT_BOARD_ROLE);
  if (!role || role === config.gate.managerRole || !config.roster.includes(role)) return { errs: [], record: null, note: null, liveNext: null, dispatchAsked: false };
  const ask = dispatch ? dispatchAsk(dispatch, now) : null;
  const wait = dispatch ? wokenCheck(dispatch.woken, dispatch.checkedAt, turnCalls(currentTurn(lines)), startedByWake(currentTurn(lines), lines)) : { judged: false, ask: null };
  const push = unpushed && !backgroundRunning(turnCalls(currentTurn(lines))) ? unpushedCheck(unpushed.state, unpushed.refused) : { ask: null, judged: null };
  const next = nextCardCheck(currentTurn(lines));
  const errs = [ask, wait.ask, push.ask, next.ask].filter(Boolean);
  return { errs, record: null, note: null, liveNext: null, dispatchAsked: !!ask, waitJudged: wait.judged, unpushedJudged: push.judged };
}

// An owner's dispatch state for the ask (#C631): dispatch.json there (the probe dispatches), the role's watch running (its pid file
// beaten and the process alive), when this hook last asked (dispatch-asked-<Role>.json), and the command that arms the watch.
export function dispatchState(config, configPath, role, now) {
  const dir = join(home(config.gate.stateDir), boardId(config) ?? "no-board");
  const on = (() => { try { readFileSync(join(dir, DISPATCH_FILE), "utf8"); return true; } catch { return false; } })();
  let askedAt = null;
  try { const a = JSON.parse(readFileSync(join(dir, `dispatch-asked-${role}.json`), "utf8")); askedAt = Number.isFinite(a?.at) ? a.at : null; } catch { /* never */ }
  const script = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts", "wake-watch.mjs");
  const readJ = (name) => { try { return JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { return null; } };
  const checked = readJ(dispatchWaitCheckedFile(role));
  return { on, woken: readJ(dispatchWokenFile(role)), checkedAt: Number.isFinite(checked?.at) ? checked.at : null, alive: dispatchWatchAlive(join(dir, dispatchPidFile(role)), now), askedAt, command: `node ${shQuote(script)} --config ${shQuote(configPath)} --role ${shQuote(role)} --once --pinned` };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const at = process.argv.indexOf("--config");
  let config;
  try {
    const raw = JSON.parse(readFileSync(process.argv[at + 1], "utf8"));
    if (at < 0 || checkConfig(raw).length) throw new Error("bad config");
    config = fullConfig(raw);
  } catch { process.exit(0); }
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    let input = {};
    try { input = JSON.parse(raw); } catch { process.exit(0); }
    if (!input.transcript_path) process.exit(0);
    const now = Date.now(), lines = readLines(input.transcript_path);
    const sessionRoleName = sessionRole(lines, process.env.FLIGHT_BOARD_ROLE).role;
    const roster = !!sessionRoleName && sessionRoleName !== config.gate.managerRole && config.roster.includes(sessionRoleName);
    let dispatch = null;
    if (roster) { try { dispatch = dispatchState(config, process.argv[at + 1], sessionRoleName, now); } catch { /* none: no ask */ } }
    // #C853: the session's own folder, read as git sees it; the last refusal per branch (one per tip).
    const dir = join(home(config.gate.stateDir), boardId(config) ?? "no-board");
    const refusedPath = join(dir, `unpushed-refused-${sessionRoleName}.json`);
    let unpushed = null;
    if (roster) {
      let refused = null;
      try { refused = JSON.parse(readFileSync(refusedPath, "utf8")); } catch { /* none */ }
      unpushed = { state: unpushedAcross(input.cwd, input.session_id ?? basename(String(input.transcript_path), ".jsonl")), refused };
    }
    const { errs, dispatchAsked, waitJudged, unpushedJudged } = stopRun(lines, { config, env: process.env, now, dispatch, unpushed });
    if (unpushedJudged) { try { mkdirSync(dirname(refusedPath), { recursive: true, mode: 0o700 }); writeAtomic(refusedPath, JSON.stringify(Object.fromEntries([...Object.entries(unpushed.refused && typeof unpushed.refused === "object" ? unpushed.refused : {}), [unpushedJudged.branch, unpushedJudged.sha]].slice(-20)))); } catch { /* asked again at this tip */ } }
    if (dispatchAsked && !input.stop_hook_active) { try { writeAtomic(join(dir, `dispatch-asked-${sessionRoleName}.json`), JSON.stringify({ at: now })); } catch { /* asks again */ } }
    if (waitJudged) { try { writeAtomic(join(dir, dispatchWaitCheckedFile(sessionRoleName)), JSON.stringify({ at: now })); } catch { /* judged again next stop */ } }
    if (input.stop_hook_active) process.exit(0);
    // A refusal is a JSON block on stdout with exit 0 (#C588), as the red-ask hook does: the app read exit 2 with a phrase
    // like "can't open" in the stderr text as a missing script and let the stop through, so the refusal never reached the role.
    if (errs.length) { process.stdout.write(JSON.stringify({ decision: "block", reason: `Before you finish:\n- ${errs.join("\n- ")}` })); process.exit(0); }
    process.exit(0);
  });
}
