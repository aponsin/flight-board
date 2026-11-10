# Board parity: the old page on the store

The old board page (`page/board.template.html`) served by the store Worker at `/board` (#C723), against the same page on the artifact. The owner switches when every row below is **same** or **gone** (parity plan rule 6), with screenshot pairs at phone and laptop width and Designer's LOOK-OK.

Status words:
- **same**: the store's page shows it as the artifact's does.
- **gone**: left out on the store by the owner's agreement of 2026-11-04 (`docs/DATA.md`, its words quoted) or his later word. The store's page hides it (`STORE` in the page; `tests/store-gone.test.mjs`); the artifact's page still shows it.
- **not yet**: the store has no data or no write for it yet; the stage that brings it is named. The page draws what it has: an area with no data is empty, as the old page already does.

How it is checked: `tests/store-page.test.mjs` (the page as served), `tests/hostile-text.test.mjs` (no board text becomes markup, both pages), `tests/compat-view.test.mjs` and `tests/compat-routes.test.mjs` (the store's answers in the old shapes, Boardsmith), `tests/store-gone.test.mjs` (the gone rows).

## Header

| Item | Status | Where it comes from on the store |
|---|---|---|
| Live now vX | same | evidence `live` (compat `meta/live`, `derived/all.live`) |
| Live now "deploying vY" | same (data in; drawn from real readings after the deploy) | the probe's `ship` evidence, written by the evidence job since B3a; the compat probe carries it while the probe keeps rewriting it (under 3 minutes) |
| "⚠ Manager missed" after Live now | hidden on the store: a typed-field gap (row 37, "Mostly deleted with the typed fields") | |
| Clock, "Studio checked N s" | same | probe reading via the shim |
| "Board data behind, reloading" | gone: "Delete: row 2's 'fetched N s ago' covers it once there is one store" (row 3) | |
| Manager chip | same (#C730): on the store it reads the store's own wake, not the old wake watch's keys. "Manager listening" while the probe asks the store; red "Manager not listening · <the store's fix>" when a send failed, a batch went untaken, or the probe stopped asking the store (3 min) while it still writes evidence (a probe silent altogether hides the chip, as on the old page; the probe chip says so); "seen your HH:MM message · answer coming" from Manager's last typed read. Hidden until the probe has asked the store once (as the old page hid it for a probe without the keys). The "Collector has not published" red is not drawn on the store (the Collector is gone, row 38) | `wakeState`, `wake.seen_at` (compat `probe.board.wake`) |
| Safe to restart, "Don't restart: shipping" | same (data in; drawn from real readings after the deploy) | probe `agents`, `ship` (evidence keys `agents`, `ship`) |
| Board vX · page abc | same | the build's stamp |
| "Manager stuck on …" | not yet: B4 (refusals in the old shape, with the "You:" action) | `refusals` |
| "X waiting on you since" | same (data in; drawn from real readings after the deploy) | probe `stuck` (evidence key `stuck`, written by the evidence job since B3a, fresh for 3 minutes) |
| "You wrote, Manager silent N min" | same (B1) | compat `messages` |
| Comment threads full | gone: "Delete with the artifact comments" (row 11) | |
| Keeper line | gone: "Delete" (row 12) | |
| Layout link, Now / Plan / Crew views | gone: "Delete: v3 layout and plan outline removed" (row 45) | |

## Memory and crew

| Item | Status | Where it comes from on the store |
|---|---|---|
| Memory tiles: %, bar, colour, tokens, age | same (data in; drawn from real readings after the deploy) | probe `ctx` (evidence key `ctx`, written by the evidence job from before B3a) |
| "/clear me" | gone: "Delete the flag" (row 14) | |
| Refresh (↻) on a faded tile | gone: "the Refresh request" (Deleted list). Row 15's "check now" comes back with its own endpoint, later | |
| Model · effort | not yet: B4 | |
| Who is on what | partly: agents are in (evidence `agents`); the notes are B4 | probe `agents` |

## Needs you, threads, lists

| Item | Status | Where it comes from on the store |
|---|---|---|
| Tabs with counts, arrow keys | same (B1: threads too) | |
| Needs you: asks, "Your queue" | same | compat `waiting` |
| Ask row: kind, #T, title, badge, age, "For: card" | same (the chip after an answer reads the owner's messages, B1) | compat `waiting`, `messages` |
| Ask steps with Copy per command, "You should see" | not yet: B2 (steps are plain strings) | |
| Ask screenshots, picture viewer | same once Boardsmith's two hooks are in (C1): an agent stores the picture with `file_put` and names it in the ask's `screenshots` as `"<id>"`, `"<id> label"` or `"<id> A: label"` | `files` (migration 0010), `/_blob/<id>`; compat `waiting.images` |
| Reply box per kind (A/B, OK/Change, Ack, Done/Help) | same for an option, Ack and Done; not yet: B2 for a note, "Something else", files | `POST /api/compat/write` |
| Sent line "You chose …" | same for the choice; not yet: B2 for the note and files | |
| "Manager missed" on an ask | hidden on the store until B4 (Manager, 2026-11-09): its fields are not in the store yet | |
| Thread messages, "seen HH:MM" | same: the messages (B1) come with their kind, resolved flag and files, and the owner's reply, Ack and Close are written as messages. The per-message "seen HH:MM" ticks read Manager's last typed read of the store (`wake.seen_at`, #C730), not the old wake watch's seen time | compat `messages`, `probe.board.wake`, `POST /api/compat/write` |
| Thread buttons: Close, options, Rename | same (B1): Close and Ack are resolving messages (an ask is also closed), a reply on a closed ask reopens it, Rename sets the title; an agent's message does not offer options yet (the `options` column is stored, no tool writes it) | compat `threads` |
| Later tab | same | compat `waiting` (Later) |
| With the team, sub-step line | same for threads (B1); the sub-step line: B3a | |
| Resolved tab, search | same (B1: threads too) | |
| Pull request panel | same (C4): drawn from the store's Approval asks (`worker/compat-approvals.mjs`); Approve answers the open ask for that head, Withdraw clears it | |
| To-do: rank, up/down, Done, Add | same | `lists` |
| Ideas: kind, Close, Add | same | `lists` |
| "Let's start" on an idea | gone: "not part of this change" (DATA.md Changes, 2026-11-09, the lists) | |
| #T and #C links, hover, jump | same (B1: threads too) | compat `threads` |
| Files: attach, paste, drop, thumbnails, save | same once Boardsmith's hooks are in (C1): the page's own attach, paste and drop code, unchanged, now finds an `assets` and a `downloads` handle in the shim. Attach, paste and drop are on (the shim's `FILES_ON`, switched on with the answer and message hooks, B1): an answer's or a message's files are checked before it is stored and linked after it, so a refused reply leaves no link | `POST /api/files`, `/_blob/<id>`, `file_links` |

## Cards

| Item | Status | Where it comes from on the store |
|---|---|---|
| Name row: #C, repo badge, "from #T", size | same (the "from #T" link by the thread's id: B4a, #C729) | compat `initiatives` |
| Status pill | same where the probe has evidence; not yet: B3a for the rest | `derived/all.cards` |
| Check button, "checked by the Collector" | gone: "Delete with the Collector" (row 38) | |
| Source-disagreement flag | gone: "Delete: one source, nothing to flag" (row 28) | |
| ETA box | partly: the probe's readyAt, firm and waitingFor (B4b part 1, #C731) and, with part 2, the expected version (`expected`, from collector/expected.mjs, with the card words repo, batch and bump, migration 0016) and `releaseTimes` (the release log's CI times, the probe's `releases` key) are in; still to come: shippedAt, abandonedAt, workSeen, reviews and the red lines | `derived/all.cards`, `derived/all.releaseTimes` |
| Held for its done test ("Live, still open") | same where the lead sets it: card word check_at (B4b part 1, #C731), drawn as checkAt; the page already honours it | `cards` |
| Version note, "Next: vX" | not yet: B3a, B4 | |
| Track: lit phase, skips | same | `derived/all.cards` |
| Track: who · time on each tile | same (B3b: the store's phase history, with the old board's steps imported) | `derived/all.times` |
| One track per branch | not yet: B3a | probe `cards.branches` |
| Queue line, "waits on", Next (written N ago), Started, issue chips | same for next note, waiting on, started, and (B4a, #C729) the queue place, "depends on" and the five issue counts, written by card_create / card_update (depends_on, issues, queue_pos); a card written before has none; not yet: B4b for the lines the probe's readings feed (ETA, waits) | `cards` |
| "Manager missed" on a card | hidden on the store until B4 (Manager, 2026-11-09; the ETA inputs come in B4) | |
| Thread fold, closed asks | same (B1) | |
| Done in the last 24 h, search | same: the old board's done cards come in as history (B3b), and the store's own once the probe reads them at their last phase (live, or install on the board's own track), with doneAt and version (C2) | compat `initiatives` (done), `worker/compat-ships.mjs` |

## Shipped, time, usage

| Item | Status | Where it comes from on the store |
|---|---|---|
| Shipped feed, search | same once Boardsmith's hooks are in (C2): one line per version the probe read on a card's commit, "#C12 Title · #C13 Title". The old board's events come in with the import (C5) | `ships`, `worker/compat-ships.mjs` |
| Time spent: tiles, chart | partly (#C728): agent minutes from the phase history, every day shown. No runner or Actions bars: nothing posts `POST /api/probe/usage` yet, so `usage_days` stays empty (Boardsmith: the probe's usage post) | `usage_days`, `worker/compat-usage.mjs` |
| Plan-week tile | same (data in; drawn from real readings after the deploy) | probe `usage` (evidence key `usage`, written by the usage job) |
| Per-agent table | partly (#C728): drawn from the phase history (B3b), sorted by queued then working time. Queued (busy) and Gated are "—": the store's history keeps no waits and the import refuses wait steps. No rows for Manager or Ops: no phase is theirs, and the probe names who worked from the phase, not from steps the agents log (Designer shows only after a design phase). Release reads near 0: the probe reads every minute and often passes the ship phase between two readings, and live time isn't counted | compat `steps` |

## The page itself

| Item | Status |
|---|---|
| Keys, touch, copy buttons, drafts and folds kept across redraws, light and dark, phone widths | same (the page's own code) |
| Fonts | same: self-hosted (`page/fonts/`, DECISIONS) |
| Lightbox buttons | same: wired by listener, not inline |
