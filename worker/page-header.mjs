// The page header (#C719, brief item 6 "Header check"). It stays on ONE row at phone width (375) and laptop width in every
// state, the longest included (deploying, from one version to the next): long text shortens or drops its detail, it never
// wraps the header. "Live now" is only the probe's reading of the product's /version.json with its age; past 5 minutes (3 until #C996's
// stopgap) it is marked stale (red), never shown as live. Pure string functions: the Worker serves them inside the page.
import { STALE_AFTER_MS } from "./board-rules.mjs";
import { mtTime } from "./team-time.mjs";
import { JOBS } from "./probe-jobs.mjs";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export const ageText = (ms) => (ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : ms < 5_400_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`);

// view.live from readView ({ state, version, age }); deploying = { from, to } or null (from GitHub's running deploy).
export function liveChip(live, deploying) {
  if (!live || live.state === "unknown") return { cls: "warn", short: "Live now ?", long: "Live now: unknown", detail: "" };
  const stale = live.state === "stale";
  const age = ageText(live.age);
  const dep = deploying ? ` → ${deploying.to}` : "";
  return {
    cls: stale ? "bad" : "ok",
    // The short form is what survives at phone width: version and the stale mark, no arrow detail.
    short: `${stale ? "STALE " : ""}${live.version}`,
    long: `${stale ? "Live now (stale)" : "Live now"} ${live.version}${dep} · read ${age} ago`,
    // What follows the version on a laptop: the arrow and the age, never the version again (Designer).
    detail: `${dep} · read ${age} ago`,
  };
}

export function headerHtml(view, { deploying = null, boardVersion = "", wake = { state: "idle" } } = {}) {
  const live = liveChip(view.live, deploying);
  const wakeCls = wake.state === "red" ? "bad" : "ok";
  const wakeText = wake.state === "red" ? `Manager: ${wake.reason ?? "cannot reach"}` : "Manager listening";
  const wakeDetail = wake.state === "red" ? (wake.reason ?? "cannot reach") : "listening";
  const silent = view.probe?.state === "silent";
  // #C962: why the probe is failing (the evidence job's last error line) or that its run is slow (past 150 s of its 170 s limit, worker/probe-jobs.mjs), beside "silent since".
  const why = typeof view.probe?.why === "string" && view.probe.why ? view.probe.why : "", slow = Number.isFinite(view.probe?.slow) ? view.probe.slow : null;
  const probeDetail = silent || why
    ? `${silent ? `silent${view.probe?.since ? ` since ${mtTime(view.probe.since)}` : ""}` : "failing"}${why ? `: ${why}` : ""}`
    : `slow: ${slow} s of ${JOBS.evidence.limitSec}`;
  const probeShown = silent || why || slow !== null;
  const probeCls = silent || why ? "bad" : "warn";
  // #C982: the last board deploy failed and no later one has succeeded: "Deploy failed: <reason>" (view.deployFailed, the reason; the page sets it only while the
  // probe's reading is fresh). The label stays on a phone, the reason is the detail.
  const dfail = typeof view.deployFailed === "string" ? (view.deployFailed.trim() || "failed") : null;
  const deployChip = dfail === null ? "" : `<span class="chip bad" title="Deploy failed: ${esc(dfail)}"><span class="dot"></span><span class="lbl">Deploy failed</span><span class="detail">${esc(dfail)}</span></span>\n`;
  // A one-word label stays on a phone (the detail drops), so two red dots are never indistinguishable.
  const ver = String(boardVersion), bare = ver.replace(/^board\s+/i, ""), prefix = ver.length > bare.length ? `<span class="detail">board </span>` : "";
  return `<header class="hd" role="banner">
<span class="chip live ${live.cls}" title="${esc(live.long)}"><b>${esc(live.short)}</b><span class="detail">${esc(live.detail)}</span></span>
<span class="chip ${wakeCls}" title="${esc(wakeText)}"><span class="dot"></span><span class="lbl">Manager</span><span class="detail">${esc(wakeDetail)}</span></span>
${probeShown ? `<span class="chip ${probeCls}" title="probe ${esc(probeDetail)}"><span class="dot"></span><span class="lbl">Probe</span><span class="detail">${esc(probeDetail)}</span></span>\n` : ""}${deployChip}<span class="chip ver" title="Board ${esc(ver)}">${prefix}${esc(bare)}</span>
</header>`;
}

// One row, never wrapping: nowrap + a hard height, each chip shrinks and ellipsizes, details drop below 600 px.
export const HEADER_CSS = `
.hd{display:flex;flex-wrap:nowrap;align-items:center;gap:8px;height:40px;padding:0 12px;overflow:hidden;white-space:nowrap;box-sizing:border-box;font:14px/1 system-ui,sans-serif}
.hd .chip{display:inline-flex;align-items:center;gap:6px;min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;padding:4px 8px;border-radius:12px;background:#eee}
.hd .chip.live{flex:1 1 0}
.hd .chip.bad{background:#fdd;color:#900}
.hd .chip.warn{background:#ffe9b0}
.hd .dot{width:8px;height:8px;border-radius:50%;background:currentColor;flex:none}
.hd .chip b{font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0}
.hd .detail{margin-left:4px}
.hd .ver{flex:0 1 auto}
@media (prefers-color-scheme:dark){.hd .chip{background:#2a2a2a}.hd .chip.bad{background:#4a1c1c;color:#fbb}.hd .chip.warn{background:#4a3a10}}
@media (max-width:600px){.hd .detail{display:none}.hd .chip{padding:4px 6px}}
`;

// The longest state, for the width test: deploying, from one long version to the next, stale, Manager unreachable.
export const LONGEST = {
  view: { live: { state: "stale", version: "v1.200.12-rc.3+build.20261109", age: 17 * 60_000 }, probe: { state: "silent", since: 1_800_000_000_000 } },
  opts: { deploying: { from: "v1.200.12-rc.3+build.20261109", to: "v1.200.13-rc.1+build.20261110" }, boardVersion: "board 3b9fa7d · v3.76", wake: { state: "red", reason: "login lapsed: run claude /login" } },
};
export { STALE_AFTER_MS };
