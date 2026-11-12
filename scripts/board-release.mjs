// A board release by the release role, like a product release (#C276). It runs only from the signed linked copy:
//   node ~/.flight-board/current/scripts/board-release.mjs <commit> [--dry-run]
// never from a checkout, whose files are unreviewed working tree. Everything else comes from the owner's install: the
// config from the gate's pinned hook in ~/.claude/settings.json, the lead's session from the fence's --send-to in the
// collector's settings, the repository from ~/Documents/Code/flight-board ($FLIGHT_BOARD_REPO to change it). The
// target's files are read from its own snapshot (git archive of the commit), never from a checkout.
// Before anything changes it checks, and refuses naming why (one summary line per check, exit 1, nothing pushed):
//   - Checker's PASS and Security's SECURE on this exact commit, read only from origin's notes fetched into private refs;
//   - the commit continues origin/main (the push is a fast-forward, never forced);
//   - no newer -vN branch of the same card is on origin (#C738: v1 of a card landed after its v2 was pushed): a tip of build/<card>[-vN] is
//     refused, naming the newer branch, when build/<card>-vM with a higher M is on origin and is a different commit;
//   - nothing the owner's install pins changed since the commit the settings pin: the gate's hooks, the refresh hook,
//     the fence, the memory hook, this release tool and every file they import (importClosure), and collector/TASK.md's
//     settings block. Those stay the owner's install. Except on top of a waiting install pack (#C412, pendingPack): when
//     every such change on the line from the pin is signed and this commit adds none of its own, it goes out, and the
//     pinned code still waits for the owner's install;
//   - the task's steps didn't change without its prompt (collector/PROMPT.txt);
//   - the page uses no capability beyond PAGE_CAPABILITIES, builds and passes its rendered scenarios.
// Then it runs the scan (this copy's), pushes the commit to origin/main, moves the collector's current link with this
// copy's scripts/current.mjs (which also fast-forwards the checkout's local main when it is clean and only behind,
// #C282), and prints the prompt when it changed (no page: #C917).
// It never touches ~/.claude/settings.json, the collector's settings or the config.
import { realpathSync, existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { OWNER_ENTRIES, TASK_FILE, importClosure, pinnedCommit, linkedCommit } from "./current.mjs";
import { checkConfig, fullConfig, boardId } from "./config.mjs";
import { packLabel } from "./pack-label.mjs";

export const NOTES = { security: "refs/notes/security", checker: "refs/notes/checker" };
// The release tool and what it runs are the owner's too (Security): a release can't loosen the next one.
export const RELEASE_ENTRIES = ["scripts/board-release.mjs", "scripts/current.mjs", "scripts/scan.mjs"];
// The capabilities the board page is published with; a new one is the owner's (README, "The page").
// mcp (#C420, #C580): the Studio's state through the owner's "Flight Board State" connector: board_state (read) and
// board_wake (the owner's word reaching the lead's session), those two tools only.
export const PAGE_CAPABILITIES = ["db", "comments", "assets", "downloads", "mcp"];
// The whole declaration the page is published with: mcp exactly this one connector and these two tools (Security). The
// publish hook passes no capabilities at all, so only a publish the owner approves can declare them; this says what that
// one is.
export const PAGE_MCP = { servers: [{ server: "Flight Board State", tools: ["board_state", "board_wake"] }] };
export const PAGE_DECLARATION = { db: {}, comments: {}, assets: {}, downloads: true, mcp: PAGE_MCP };
// The page's connector calls, each against PAGE_MCP: the names as the page's one constant line, and every callTool,
// watchTool, server, describeTool or listTools call made with exactly those constants (board_wake only by callTool: it
// writes, so it is never watched); a call by a bracketed name
// (mcp["callTool"]) refuses. [] when it fits. A scan, not a proof (an alias of the namespace would slip it): the real gate
// is the declaration the page is published with, which only a publish the owner approves can set (Security).
export function pageMcpErrors(html) {
  const s = String(html ?? ""), e = [];
  const { server, tools: [tool, wake] } = PAGE_MCP.servers[0];
  if (/\[\s*["'`](callTool|watchTool|server|describeTool|listTools|invalidate)["'`]\s*\]/.test(s)) e.push(`the page calls an mcp method by a bracketed name`);
  const decl = [...s.matchAll(/const STATE_SERVER="([^"]*)",STATE_TOOL="([^"]*)"(?:,WAKE_TOOL="([^"]*)")?/g)];
  if (/\bmcp\b/.test(s) && /claude\.use\(\s*["'`]mcp/.test(s)) {
    if (decl.length !== 1 || decl[0][1] !== server || decl[0][2] !== tool || decl[0][3] !== wake) e.push(`the page's mcp names aren't exactly ${server} / ${tool} / ${wake}`);
    for (const m of s.matchAll(/\.(callTool|watchTool|server|describeTool|listTools|invalidate)\s*\(([^)]*)/g)) {
      const args = m[2] + ")", read = /^\s*STATE_SERVER\s*,\s*STATE_TOOL\s*[,)]?/.test(args), write = m[1] === "callTool" && /^\s*STATE_SERVER\s*,\s*WAKE_TOOL\s*[,)]?/.test(args);
      if (!/^(callTool|watchTool)$/.test(m[1]) || !(read || write)) e.push(`the page calls mcp.${m[1]} beyond ${server} / ${tool} / ${wake}`);
    }
  }
  return e;
}
export const PROMPT_FILE = "collector/PROMPT.txt";
const PAGE_FILE = "page/board.template.html";

// collector/TASK.md's settings block (the collector's settings.local.json, the owner's) and its steps (the task's
// prompt, the release role's), read apart so a change to one never passes for the other.
export const settingsBlock = (text) => /```json\n([\s\S]*?)\n\s*```/.exec(String(text ?? ""))?.[1] ?? "";
export const stepsOf = (text) => { const t = String(text ?? ""), at = t.indexOf("\n## The steps"); return at < 0 ? "" : t.slice(at); };
// The capabilities a page asks for: every claude.use("<name>"). A use whose name the scan can't read (a variable, a
// template, claude["use"]) counts as a name the page computes, which no list holds, so it refuses (Checker). The
// publish call's declaration is the real limit; this keeps a release from widening it unseen.
export const COMPUTED = "(a name the page computes)";
export function pageCapabilities(html) {
  const s = String(html ?? "");
  const named = [...s.matchAll(/claude\.use\s*\(\s*["'`]([A-Za-z0-9_-]+)["'`]\s*\)/g)].map((m) => m[1]);
  const uses = [...s.matchAll(/claude\s*(?:\.\s*use|\[\s*["'`]use["'`]\s*\])\s*\(/g)].length;
  return [...new Set([...named, ...(uses > named.length ? [COMPUTED] : [])])].sort();
}
// The task's prompt: the repository's template with this team's values. A placeholder left over, or an empty value, refuses.
export function renderPrompt(template, values) {
  const text = String(template).replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => { if (!values[k]) throw new Error(`${PROMPT_FILE}: no value for {{${k}}}`); return values[k]; });
  const left = /\{\{([^}]*)\}\}/.exec(text);
  if (left) throw new Error(`${PROMPT_FILE}: no value for {{${left[1]}}}`);
  return text;
}
// The config the owner installed: the gate's pinned hook names it. The lead: the collector's fence sends only to it.
// On the store (hooks.mjs --store) gate.mjs is gone: the hooks that remain, stop.mjs and publish.mjs, name the same config.
// The gate's hooks must agree: two different configs name none, so a release refuses rather than read whichever comes first.
export const configFromSettings = (text) => {
  const all = new Set([...String(text ?? "").matchAll(/gate\/(?:gate|stop|publish)\.mjs'? --config '([^']+)'/g)].map((m) => m[1]));
  return all.size === 1 ? [...all][0] : null;
};
// The lead's session (#C586): the config's gate.managerSession first; the fence's --send-to only while the config has none.
export const leadOf = (config, settingsText) => config?.gate?.managerSession || leadFromSettings(settingsText);
export const leadFromSettings = (text) => /collector\/fence\.mjs'? [^"]*?--send-to ([A-Za-z0-9_-]{1,100})/.exec(String(text ?? ""))?.[1] ?? null;

const signed = (notes) => /^PASS\b/.test(String(notes?.checker ?? "").split("\n")[0].trim()) && /^SECURE\b/.test(String(notes?.security ?? "").split("\n")[0].trim());

// #C934: a review of a stack's tip may be a review of its whole line. Both notes on the commit (Checker's PASS, Security's SECURE) say, on their
// first line, "line from <40-hex sha>" with the same sha: they read every commit from that base (not included) up to this one. Returns the base
// sha, else null. It is only a claim: the release tool still requires the base to be an ancestor of main and this commit, and counts only the
// commits between (lineCovers); a note that says nothing, or two different bases, covers nothing.
export function lineSign(notes) {
  if (!signed(notes)) return null;
  const base = (t) => /\bline from ([0-9a-f]{40})\b/.exec(String(t ?? "").split("\n")[0])?.[1] ?? null;
  const c = base(notes.checker), s = base(notes.security);
  return c && c === s ? c : null;
}

// A page release while an install pack waits (#C412, Director: v3.19's pack waited 564 min and held four page releases;
// Security's ruling on plan A): a commit built on a signed pack S may go out before the owner installs S, if it adds no
// pinned change of its own. S is never named by anyone: it is the newest commit on the line from the installed pin to
// this one that touches what the owner's install pins (a pinned file, or TASK.md's settings block). Every such commit
// must be signed (PASS and SECURE), every commit on that line must descend from the pin (no side branch, no rollback),
// and the pinned files here must be S's byte for byte. The owner's hooks, fence, memory hook and release tool stay
// pinned until the pack; only what the link runs (the collector's own code, the page) goes out early.
// descends: the pin is an ancestor of this commit. range: the commits in pin..this, oldest first, each { sha,
// touches (a pinned change against its first parent), notes, fromPin (it descends from the pin) }. sameAs(s): this
// commit's pinned files and settings block equal s's. Returns null when nothing in the range touches a pinned file
// (no pack waits), else { sha: S or null, refusals }.
export function pendingPack({ descends, range, sameAs }) {
  const touching = (range ?? []).filter((c) => c.touches);
  if (!touching.length) return null;
  const S = touching[touching.length - 1].sha, r = [];
  if (!descends) r.push("it doesn't descend from the commit the owner's install pins");
  const side = (range ?? []).filter((c) => !c.fromPin).map((c) => c.sha.slice(0, 12));
  if (side.length) r.push(`commits on its line don't descend from the commit the owner's install pins (a side branch): ${side.join(", ")}`);
  // #C934: a commit is also signed when a later commit's line sign covers it (c.covers: the shas in base..c that the caller verified, base an
  // ancestor of main and of c). A lower commit with its own FINDINGS is covered by a later line sign too: its reviewers read the line as it ended.
  const covered = new Set((range ?? []).filter((c) => signed(c.notes) && Array.isArray(c.covers)).flatMap((c) => c.covers));
  const unsigned = touching.filter((c) => !signed(c.notes) && !covered.has(c.sha)).map((c) => c.sha.slice(0, 12));
  if (unsigned.length) r.push(`a change to what the owner's install pins, on its line, isn't signed by both Checker and Security: ${unsigned.join(", ")}`);
  if (!sameAs(S)) r.push(`it changes what the owner's install pins after the waiting pack ${S.slice(0, 12)}: a pinned change goes out with an install pack`);
  return { sha: r.length ? null : S, refusals: r };
}

// #C738: a card's branches are build/<card>, build/<card>-v2, build/<card>-v3, ... (no suffix is v1). `heads` are origin's build/ branches,
// [{ branch, sha }]. For the commit being released: the first branch of the same card with a higher version whose tip is another
// commit (its name), else null. A commit that is the tip of the card's newest branch, or of a branch that isn't named build/..., is
// never superseded; two branches at one commit (a v3 re-cut identical to v2) are the same release.
export function supersededBy(heads, sha) {
  const parse = (b) => { const m = /^(build\/.+?)(?:-v(\d{1,4}))?$/.exec(String(b)); return m ? { base: m[1], n: m[2] ? Number(m[2]) : 1 } : null; };
  const list = (Array.isArray(heads) ? heads : []).filter((h) => h && typeof h.branch === "string" && /^[0-9a-f]{40}$/.test(String(h.sha))).map((h) => ({ ...h, ...parse(h.branch) })).filter((h) => h.base);
  const mine = list.filter((h) => h.sha === sha);
  if (!mine.length) return null;
  const top = new Map();
  for (const m of mine) top.set(m.base, Math.max(top.get(m.base) ?? 0, m.n));
  const newer = list.filter((h) => h.sha !== sha && top.has(h.base) && h.n > top.get(h.base)).sort((a, b) => b.n - a.n);
  return newer[0]?.branch ?? null;
}

// The verdict, from the facts only. changed: the files that differ from the pinned commit (null: no pinned commit);
// owned: the owner's closure (OWNER_ENTRIES and RELEASE_ENTRIES) at the pinned commit and at this one. pending: what
// pendingPack found; a waiting pack it accepts (sha set) covers the pinned changes and the settings block.
// #C847: the probe finds a landed card on main by the Board-Id trailer of a main commit (the card's branch is pruned after landing), so a
// tip is refused when any commit it would land lacks one that names a card (a card id's shape: lower-case words with dashes). commits:
// [{ sha, ids }], ids the values of the commit's Board-Id trailers. Returns the shas without a good one.
export const CARD_ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const TRAILER_LOG = "%H%x1f%(trailers:key=Board-Id,valueonly,separator=%x2c)%x1e";
export function parseTrailerLog(text) {
  return String(text ?? "").split("\x1e").map((s) => s.trim()).filter(Boolean).map((rec) => { const [sha, ids = ""] = rec.split("\x1f"); return { sha, ids: ids.split(",").map((x) => x.trim()).filter(Boolean) }; });
}
export function untrailered(commits) {
  return (Array.isArray(commits) ? commits : []).filter((c) => !(Array.isArray(c?.ids) && c.ids.some((id) => CARD_ID_SHAPE.test(String(id))))).map((c) => String(c?.sha ?? ""));
}
export function verdict({ forward, notes, pinned, changed, owned, settingsChanged, stepsChanged, promptChanged, capabilities, mcpErrors = [], pending = null, superseded = null, noTrailer = [] }) {
  const r = [];
  if (noTrailer.length) r.push(`${noTrailer.length === 1 ? "a commit has" : `${noTrailer.length} commits have`} no Board-Id trailer naming a card: ${noTrailer.slice(0, 5).map((s) => s.slice(0, 12)).join(", ")}${noTrailer.length > 5 ? ", ..." : ""} (the probe finds a landed card by it: add "Board-Id: <card id>" and sign again)`);
  if (!/^PASS\b/.test(String(notes?.checker ?? "").split("\n")[0].trim())) r.push(`no PASS from Checker on it in ${NOTES.checker}`);
  if (!/^SECURE\b/.test(String(notes?.security ?? "").split("\n")[0].trim())) r.push(`no SECURE from Security on it in ${NOTES.security}`);
  if (!forward) r.push("it doesn't continue origin/main: rebase it on main and sign it again");
  if (superseded) r.push(`it is superseded: a newer branch of the same card, ${superseded}, is on origin; release that one`);
  if (!pinned || !Array.isArray(changed)) r.push("no pinned commit found in ~/.claude/settings.json to compare with: the owner's install decides");
  else if (pending?.sha) { /* the pinned changes are the waiting pack's, signed; the owner's install takes them */ }
  else if (pending) r.push(...pending.refusals);
  else {
    const mine = changed.filter((f) => owned.includes(f));
    if (mine.length) r.push(`it changes what the owner's install pins (${pinned.slice(0, 12)}): ${mine.join(", ")}`);
  }
  if (settingsChanged && !pending?.sha) r.push(`${TASK_FILE}: the collector's settings block changed, and those settings are the owner's`);
  if (stepsChanged && !promptChanged) r.push(`${TASK_FILE}: the task's steps changed but ${PROMPT_FILE} didn't`);
  const extra = (capabilities ?? []).filter((c) => !PAGE_CAPABILITIES.includes(c));
  if (extra.length) r.push(`the page asks for a capability beyond ${PAGE_CAPABILITIES.join(", ")}: ${extra.join(", ")} (a new capability is the owner's)`);
  for (const m of mcpErrors) r.push(`${m} (a wider mcp capability is the owner's)`);
  return { ok: r.length === 0, refusals: r, promptNeeded: Boolean(promptChanged) };
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const home = (p) => String(p).replace(/^~(?=\/|$)/, homedir());

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2), commit = args[0], dry = args.includes("--dry-run");
  if (!commit || !/^[0-9a-f]{40}$/.test(commit) || args.some((a, n) => n > 0 && a !== "--dry-run")) {
    console.error("Usage: node ~/.flight-board/current/scripts/board-release.mjs <full commit> [--dry-run]"); process.exit(2);
  }
  const self = dirname(fileURLToPath(import.meta.url)); // this signed copy's scripts/
  const repo = process.env.FLIGHT_BOARD_REPO || join(homedir(), "Documents/Code/flight-board");
  const git = (a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
  const quiet = (a) => { try { return git(a); } catch { return null; } };
  const line = (ok, what) => console.log(`${ok ? "ok  " : "NO  "} ${what}`);
  let tmp = null;
  // #C989: a refusal, a dry run and a release all end in process.exit inside the try, which skips the finally: the snapshot
  // folder was left in the temp folder every time. Removed on exit too.
  process.on("exit", () => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });
  try {
    // The owner's install: the settings, the config the gate's hook names, the lead the fence sends to.
    const settingsText = readFileSync(join(homedir(), ".claude/settings.json"), "utf8");
    const configPath = configFromSettings(settingsText);
    if (!configPath) throw new Error("no config named by the gate's hook in ~/.claude/settings.json");
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    const problems = checkConfig(raw);
    if (problems.length) throw new Error(`the config: ${problems.join("; ")}`);
    const config = fullConfig(raw);
    const stateDir = join(home(config.gate.stateDir), boardId(config) ?? "no-board");
    const collectorSettings = join(stateDir, ".claude/settings.local.json");
    const lead = leadOf(config, existsSync(collectorSettings) ? readFileSync(collectorSettings, "utf8") : "");
    const link = join(homedir(), ".flight-board", "current"), before = linkedCommit(link);

    // The facts, from origin and from the commit's own snapshot.
    git(["fetch", "-q", "origin"]);
    for (const [who, ref] of Object.entries(NOTES)) quiet(["fetch", "-q", "origin", `+${ref}:refs/notes/board-release/${who}`]);
    const sha = git(["rev-parse", "--verify", `${commit}^{commit}`]);
    const main = git(["rev-parse", "origin/main"]);
    const notes = Object.fromEntries(Object.keys(NOTES).map((who) => [who, quiet(["notes", `--ref=board-release/${who}`, "show", sha])]));
    const forward = quiet(["merge-base", "--is-ancestor", main, sha]) !== null;
    const pinned = pinnedCommit(settingsText);
    const heads = (quiet(["for-each-ref", "refs/remotes/origin/build", "--format=%(refname:lstrip=3) %(objectname)"]) ?? "").split("\n").filter(Boolean).map((l) => { const [branch, tip] = l.split(" "); return { branch, sha: tip }; });
    const superseded = supersededBy(heads, sha);
    // #C847: every commit this release lands (main..sha) carries a Board-Id trailer naming a card.
    const noTrailer = untrailered(parseTrailerLog(quiet(["log", `--format=${TRAILER_LOG}`, `${main}..${sha}`])));
    const known = (c) => Boolean(c) && quiet(["cat-file", "-e", `${c}^{commit}`]) !== null;
    tmp = mkdtempSync(join(tmpdir(), "board-release-"));
    execFileSync("tar", ["-x", "-C", tmp], { input: execFileSync("git", ["archive", "--format=tar", sha], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }) });
    // A file as it is at a commit, byte for byte (never trimmed, or every comparison with the snapshot would differ).
    const shown = (c, f) => { try { return execFileSync("git", ["show", `${c}:${f}`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }); } catch { return null; } };
    const at = (c) => (f) => (c === sha ? (existsSync(join(tmp, f)) ? readFileSync(join(tmp, f), "utf8") : null) : shown(c, f));
    const entries = [...OWNER_ENTRIES, ...RELEASE_ENTRIES];
    const changed = known(pinned) ? (quiet(["diff", "--name-only", pinned, sha]) ?? "").split("\n").filter(Boolean) : null;
    const owned = [...new Set([...importClosure(entries, at(sha)), ...(known(pinned) ? importClosure(entries, at(pinned)) : [])])];
    // A waiting pack (#C412): the line from the pin to this commit, each commit's pinned change against its first parent
    // and its sign-offs, read from origin's notes like this commit's.
    let pending = null;
    if (known(pinned)) {
      const list = (a) => (quiet(a) ?? "").split("\n").filter(Boolean);
      const path = new Set(list(["rev-list", "--ancestry-path", `${pinned}..${sha}`]));
      const touches = (c) => {
        const p = quiet(["rev-parse", "--verify", "-q", `${c}^1`]);
        if (!p) return true;
        return list(["diff", "--name-only", p, c]).some((f) => owned.includes(f)) || settingsBlock(at(p)(TASK_FILE)) !== settingsBlock(at(c)(TASK_FILE));
      };
      // #C934: a commit whose notes both say "line from <base>" covers base..c, when base is an ancestor of main and of c; otherwise nothing.
      const lineCovers = (c, notes) => {
        const b = lineSign(notes);
        if (!b || quiet(["merge-base", "--is-ancestor", b, main]) === null || quiet(["merge-base", "--is-ancestor", b, c]) === null) return undefined;
        // Security's LOW on #C934: the base is where the commit's line left main (git merge-base main c, or an ancestor-equal point on it),
        // so the sign covers only the branch's own commits, never main's commits between an older base and the branch point.
        const fork = quiet(["merge-base", main, c]);
        if (!fork || quiet(["merge-base", "--is-ancestor", fork, b]) === null) return undefined;
        return list(["rev-list", `${b}..${c}`]);
      };
      const range = list(["rev-list", "--reverse", `${pinned}..${sha}`]).map((c) => { const notes = Object.fromEntries(Object.keys(NOTES).map((who) => [who, quiet(["notes", `--ref=board-release/${who}`, "show", c])])); return { sha: c, fromPin: path.has(c), touches: touches(c), notes, covers: lineCovers(c, notes) }; });
      const sameAs = (s) => [...new Set([...importClosure(entries, at(sha)), ...importClosure(entries, at(s))])].every((f) => at(s)(f) === at(sha)(f)) && settingsBlock(at(s)(TASK_FILE)) === settingsBlock(at(sha)(TASK_FILE));
      pending = pendingPack({ descends: quiet(["merge-base", "--is-ancestor", pinned, sha]) !== null, range, sameAs });
    }
    const base = known(before) ? before : known(pinned) ? pinned : null; // what the task runs now
    const capabilities = pageCapabilities(at(sha)(PAGE_FILE)), mcpErrors = pageMcpErrors(at(sha)(PAGE_FILE));
    const v = verdict({
      forward, notes, pinned: known(pinned) ? pinned : null, changed, owned, capabilities, mcpErrors, pending, superseded, noTrailer,
      settingsChanged: known(pinned) && settingsBlock(at(pinned)(TASK_FILE)) !== settingsBlock(at(sha)(TASK_FILE)),
      stepsChanged: base !== null && stepsOf(at(base)(TASK_FILE)) !== stepsOf(at(sha)(TASK_FILE)),
      promptChanged: base === null || at(base)(PROMPT_FILE) !== at(sha)(PROMPT_FILE),
    });

    // The prompt and the page, both from the commit's snapshot, before anything leaves.
    const out = dirname(configPath);
    const prompt = renderPrompt(at(sha)(PROMPT_FILE) ?? "", { CONFIG: configPath, BOARD: config.artifactUrl, LEAD_ROLE: config.gate.managerRole, LEAD: lead, CURRENT: link, OUT: home(config.collector.outDir) });
    // #C917: the page is built only to check it (its scenarios), in the tool's own temporary folder, never beside the config:
    // the old artifact board is frozen and the store page ships with the owner's deploy pair, so nothing is left to republish.
    const page = join(tmp, `board-${sha.slice(0, 7)}.html`), promptPath = join(out, `collector-prompt-${sha.slice(0, 7)}.txt`);
    let built = true;
    if (v.ok) {
      // The installed pack's label goes on the page (#C609): BOARD_PACK or the pack-label file beside the config. None: no page (Version 147 nearly went out with an empty one).
      const pack = packLabel(process.env, out);
      if (!pack) { built = false; v.refusals.push(`the page has no pack label: set BOARD_PACK=vN.NN (the installed pack; two numbers, v3.5.1 is not a label) or write it in ${join(out, "pack-label")}`); }
      else {
        try { execFileSync(process.execPath, [join(tmp, "scripts/build-page.mjs"), configPath, page], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, BOARD_PACK: pack } }); }
        catch (e) { built = false; v.refusals.push(`the page didn't build: ${String(e.stderr ?? e.message).trim().split("\n")[0]}`); }
      }
    }

    line(!v.refusals.some((r) => /PASS|SECURE/.test(r)), `sign-offs on ${sha}: Checker "${String(notes.checker ?? "none").split("\n")[0]}", Security "${String(notes.security ?? "none").split("\n")[0]}"`);
    line(forward, `continues origin/main ${main.slice(0, 12)}`);
    line(!superseded, superseded ? `superseded by ${superseded}` : "no newer branch of the same card on origin");
    line(!noTrailer.length, noTrailer.length ? `no Board-Id trailer on ${noTrailer.length} commit(s)` : "every commit carries a Board-Id trailer");
    line(!v.refusals.some((r) => /owner's install|settings block|no pinned/.test(r)), pending?.sha ? `pinned changes since ${pinned.slice(0, 12)} are the waiting pack's only: ${pending.sha.slice(0, 12)}, signed (they go live with the owner's install; the link's code goes now)` : `nothing pinned changed since ${pinned ? pinned.slice(0, 12) : "(none)"}`);
    line(!v.refusals.some((r) => /PROMPT/.test(r)), v.promptNeeded ? `prompt changed: ${promptPath} (SHA-256 ${sha256(prompt)})` : "prompt unchanged");
    line(!v.refusals.some((r) => /capabilit/.test(r)), `page capabilities: ${capabilities.join(", ")}`);
    if (v.ok) line(built, built ? `page builds and its scenarios pass (SHA-256 ${sha256(readFileSync(page))})` : "page not built");
    if (v.refusals.length) { console.error(`Not released: ${sha.slice(0, 12)}\n- ${v.refusals.join("\n- ")}\nNothing changed. What the owner's install pins goes out with the owner's install, not this.`); process.exit(1); }
    if (v.promptNeeded) writeFileSync(promptPath, prompt);
    if (dry) { console.log(`Dry run: ${sha.slice(0, 12)} passes every check; nothing pushed, the link not moved.`); process.exit(0); }

    // Out: this copy's scan of what leaves, the push (a fast-forward; the checkout's own hooks never run), the link.
    execFileSync(process.execPath, [join(self, "scan.mjs"), "--pre-push", "origin"], { cwd: repo, input: `refs/heads/main ${sha} refs/heads/main ${main}\n`, stdio: ["pipe", "inherit", "inherit"] });
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "push", "-q", "origin", `${sha}:refs/heads/main`], { cwd: repo, stdio: ["ignore", "inherit", "inherit"] });
    execFileSync(process.execPath, [join(self, "current.mjs"), sha, "--repo", repo], { stdio: "inherit" });
    if (linkedCommit(link) !== sha) throw new Error(`main is ${sha.slice(0, 12)} but the current link is not: tell the lead`);
    console.log(`Released ${sha.slice(0, 12)} to flight-board main; the collector's next run uses it.`);
    if (v.promptNeeded) console.log(`Prompt: ${promptPath}. Save it into the task: update_scheduled_task ${config.collector.refresh.taskId}, the prompt set to the whole file.`);
    else console.log("Prompt: unchanged; the task stays as it is.");
  } catch (e) { console.error(`Not released: ${String(e.message).split("\n")[0]}`); process.exit(1); }
  finally { if (tmp) rmSync(tmp, { recursive: true, force: true }); }
}
