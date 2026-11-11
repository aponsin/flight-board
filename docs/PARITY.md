# Board parity: the old page on the store

The old board page (`page/board.template.html`) served by the store Worker at `/board` (#C723), against the same page on the artifact. The owner switches when every row below is **same** or **gone** (parity plan rule 6), with screenshot pairs at phone and laptop width and Designer's LOOK-OK.

Status words:
- **same**: the store's page shows it as the artifact's does.
- **untested**: the page and the data may well be in, but no test draws it from store data (a store view or store rows, through the compat view or the Worker, then the page), so it is not counted as same and the switch waits on it (#C883). It becomes **same** when its test is named in `tests/fixtures/parity-tests.json`; `tests/parity-same-rows.test.mjs` fails for a **same** row with no named test, a named test that is not in its file, and a row whose source is a `derived/all` key the feed sends empty.
- **gone**: left out on the store by the owner's agreement of 2026-11-04 (`docs/DATA.md`, its words quoted) or his later word. The store's page hides it (`STORE` in the page; `tests/store-gone.test.mjs`); the artifact's page still shows it.
- **not yet**: the store has no data or no write for it yet; the stage that brings it is named. The page draws what it has: an area with no data is empty, as the old page already does.

How it is checked: `tests/store-page.test.mjs` (the page as served), `tests/hostile-text.test.mjs` (no board text becomes markup, both pages), `tests/compat-view.test.mjs` and `tests/compat-routes.test.mjs` (the store's answers in the old shapes, Boardsmith), `tests/store-gone.test.mjs` (the gone rows).

## Header

| Item | Status | Where it comes from on the store |
|---|---|---|
| Live now vX | untested (was same: no test draws it from store data) | evidence `live` (compat `meta/live`, `derived/all.live`) |
| Live now "deploying vY" | untested (was same (data in; drawn from real readings after the deploy); no test draws it on the page from store data and asserts its text) | the probe's `ship` evidence, written by the evidence job since B3a; the compat probe carries it while the probe keeps rewriting it (under 3 minutes) |
| "⚠ Manager missed" after Live now | hidden on the store: a typed-field gap (row 37, "Mostly deleted with the typed fields") | |
| Clock, "Studio checked N s" | untested (was same: the only test draws a hand-built probe payload, not store data) | probe reading via the shim |
| "Board data behind, reloading" | gone: "Delete: row 2's 'fetched N s ago' covers it once there is one store" (row 3) | |
| Manager chip | same (#C730): on the store it reads the store's own wake, not the old wake watch's keys. "Manager listening" while the probe asks the store; red "Manager not listening · <the store's fix>" when a send failed, a batch went untaken, or the probe stopped asking the store (3 min) while it still writes evidence (a probe silent altogether hides the chip, as on the old page; the probe chip says so); "seen your HH:MM message · answer coming" from Manager's last typed read. Hidden until the probe has asked the store once (as the old page hid it for a probe without the keys). The "Collector has not published" red is not drawn on the store (the Collector is gone, row 38) | `wakeState`, `wake.seen_at` (compat `probe.board.wake`) |
| Safe to restart, "Don't restart: shipping" | untested (was same: data in; the only test draws a hand-built probe payload, not store data) | probe `agents`, `ship` (evidence keys `agents`, `ship`) |
| Board vX · page abc | untested (was same: no test asserts the stamp in the store page) | the build's stamp |
| "Manager stuck on …" | not yet: B5 (refusals in the old shape, with the "You:" action); the page has no code for it on the store yet. **A difference for the owner's list.** | `refusals` |
| "X waiting on you since" | untested (was same (data in; drawn from real readings after the deploy); no test draws it on the page from store data and asserts its text) | probe `stuck` (evidence key `stuck`, written by the evidence job since B3a, fresh for 3 minutes) |
| "You wrote, Manager silent N min" | untested (was same (B1); no test draws it on the page from store data and asserts its text) | compat `messages` |
| Comment threads full | gone: "Delete with the artifact comments" (row 11) | |
| Keeper line | gone: "Delete" (row 12) | |
| Layout link, Now / Plan / Crew views | gone: "Delete: v3 layout and plan outline removed" (row 45) | |

## Memory and crew

| Item | Status | Where it comes from on the store |
|---|---|---|
| Memory tiles: %, bar, colour, tokens, age | untested (was same: data in; no test draws the probe's `ctx` reading from store data) | probe `ctx` (evidence key `ctx`, written by the evidence job from before B3a) |
| "/clear me" | gone: "Delete the flag" (row 14) | |
| Refresh (↻) on a faded tile | gone: "the Refresh request" (Deleted list). Row 15's "check now" comes back with its own endpoint, later | |
| Model · effort | not yet: B5; neither the store nor the page has it. **A difference for the owner's list.** | |
| Who is on what | partly: agents are in (evidence `agents`); the agent notes under it are B5. **A difference for the owner's list.** | probe `agents` |

## Needs you, threads, lists

| Item | Status | Where it comes from on the store |
|---|---|---|
| Tabs with counts, arrow keys | untested (was same (B1: threads too): the only test draws hand-built page documents, not store data) | |
| Needs you: asks, "Your queue" | same | compat `waiting` |
| Ask row: kind, #T, title, badge, age, "For: card" | untested (was same (the chip after an answer reads the owner's messages, B1); no test draws it on the page from store data and asserts its text) | compat `waiting`, `messages` |
| Ask steps with Copy per command, "You should see" | untested (was same (B2, #C725): an Action's steps may be `{text, cmd}`, the page shows `cmd` with a Copy button, and the `ask` tool's schema allows it; no test draws it on the page from store data and asserts its text) | compat `waiting` |
| Ask screenshots, picture viewer | untested (was same once Boardsmith's two hooks are in (C1): an agent stores the picture with `file_put` and names it in the ask's `screenshots` as `"<id>"`, `"<id> label"` or `"<id> A: label"`; no test draws it on the page from store data and asserts its text) | `files` (migration 0010), `/_blob/<id>`; compat `waiting.images` |
| Reply box per kind (A/B, OK/Change, Ack, Done/Help) | untested (was same (B2, #C725): an option with its note, "Something else" (the note says what), Ack, Done and Help (a note or a file), kept as the button and the note (migration 0013); no test draws it on the page from store data and asserts its text) | `POST /api/compat/write` |
| Sent line "You chose …" | untested (was same (B2); the only test that draws the line uses a hand-built page document, not store data): "You chose B: <note>", "something else" and "asked for help" as on the old page | |
| "Manager missed" on an ask | hidden on the store until B4 (Manager, 2026-11-09): its fields are not in the store yet | |
| Thread messages, "seen HH:MM" | same: the messages (B1) come with their kind, resolved flag and files, and the owner's reply, Ack and Close are written as messages. The per-message "seen HH:MM" ticks read Manager's last typed read of the store (`wake.seen_at`, #C730), not the old wake watch's seen time | compat `messages`, `probe.board.wake`, `POST /api/compat/write` |
| Thread buttons: Close, options, Rename | untested (was same (B1): Close and Ack are resolving messages (an ask is also closed), a reply on a closed ask reopens it, Rename sets the title; an agent's message offers options as buttons (B1b, #C725: the `post` tool takes a kind and, with `decision`, two to four A to D options); no test draws it on the page from store data and asserts its text) | compat `threads` |
| Later tab | same | compat `waiting` (Later) |
| With the team, sub-step line | untested (was same for threads (B1); the sub-step line: B3a; no test draws it on the page from store data and asserts its text) | |
| Resolved tab, search | untested (was same (B1: threads too); no test draws it on the page from store data and asserts its text) | |
| Pull request panel | same (C4): drawn from the store's Approval asks (`worker/compat-approvals.mjs`); Approve answers the open ask for that head, Withdraw clears it | |
| To-do: rank, up/down, Done, Add | untested (was same; no test draws it on the page from store data and asserts its text) | `lists` |
| Ideas: kind, Close, Add | untested (was same; no test draws it on the page from store data and asserts its text) | `lists` |
| "Let's start" on an idea | gone: "not part of this change" (DATA.md Changes, 2026-11-09, the lists) | |
| #T and #C links, hover, jump | untested (was same (B1: threads too): the only test draws hand-built page documents, not store data; none for hover) | compat `threads` |
| Files: attach, paste, drop, thumbnails, save | untested (was same once Boardsmith's hooks are in (C1): the page's own attach, paste and drop code, unchanged, now finds an `assets` and a `downloads` handle in the shim. Attach, paste and drop are on (the shim's `FILES_ON`, switched on with the answer and message hooks, B1): an answer's or a message's files are checked before it is stored and linked after it, so a refused reply leaves no link; no test draws it on the page from store data and asserts its text) | `POST /api/files`, `/_blob/<id>`, `file_links` |

## Cards

| Item | Status | Where it comes from on the store |
|---|---|---|
| Name row: #C, repo badge, "from #T", size | untested (was same (the "from #T" link by the thread's id: B4a, #C729); no test draws it on the page from store data and asserts its text) | compat `initiatives` |
| Status pill | same where the probe has evidence; not yet: B3a for the rest | `derived/all.cards` |
| Check button, "checked by the Collector" | gone: "Delete with the Collector" (row 38) | |
| Source-disagreement flag | gone: "Delete: one source, nothing to flag" (row 28) | |
| ETA box | partly: the probe's readyAt, firm and waitingFor (B4b part 1, #C731) and, with part 2, the expected version (`expected`, from collector/expected.mjs, with the card words repo, batch and bump, migration 0016) and `releaseTimes` (the release log's CI times, the probe's `releases` key) are in; with part 3 the probe's reviews (when each review was signed), workSeen and shippedAt; still to come: abandonedAt (the step `wait` column it needs is written by the step tool, #C739, and the probe does not read it yet). The data is in, but the page still draws "—" for the ETA on the store (`STORE` in the page, #C730): **a difference for the owner's list.** The red lines are not built (next row) | `derived/all.cards`, `derived/all.releaseTimes` |
| Card red lines (#C662: "queued but has a step of its own", "past build with no build end step", "on ship with nothing on main", a field outside its list) | **not needed on the store (by construction); a difference for the owner to review before the switch: the page draws no red lines on the store.** (1) The four step rules (queued-phase, queued-step, no-build-end, no-ship-evidence) compare a card's declared phase and status with the step log and the repository; on the store a card's phase is never declared, the probe's lit phase is the evidence, so they cannot disagree. (2) The field rules (unknown field, null, a typed field outside its list) are refused at the write by the store's card tools, so no stored card can carry one. (3) Without `derived/all.cards[id].red` the page draws nothing, so no false red is possible. (4) The two false reds the designer named are fixed on their own: "Manager not listening" (#C730) and a paused card showing "LIVE IN" (#C732). No store-only rule is added (owner's lead, 2026-11-10) | `gate/card-rules.mjs` (old board only) |
| Held for its done test ("Live, still open") | untested (was same where the lead sets it: card word check_at (B4b part 1, #C731), drawn as checkAt; the page already honours it; no test draws it on the page from store data and asserts its text) | `cards` |
| Version note, "Next: vX" | partly: the data is in (`expected`, B4b part 2, #C731, in `derived/all.cards`) and the page's version note is not hidden on the store; not checked against real readings of a card in review since the deploy, so not marked same. **A difference for the owner's list until it is.** | `derived/all.cards[id].expected` |
| Track: lit phase, skips | same | `derived/all.cards` |
| Track: who · time on each tile | same (B3b: the store's phase history, with the old board's steps imported) | compat `steps` (the store's phase history as the old steps, drawn by the tile). The feed's derived times are sent empty (`times: {}`) and the tile does not read them: the row once named them as its source while they were always empty (#C883) |
| One track per branch | not yet: the probe writes `branches` for a card with two or more branch tips (#C621) and the page draws one track per branch, but the store's `derived/all.cards` (`derivedDoc` in `worker/compat-view.mjs`) does not carry `branches` yet. **A difference for the owner's list.** | probe `cards.branches` |
| Queue line, "waits on", Next (written N ago), Started, issue chips | untested (was same for next note, waiting on, started, and (B4a, #C729) the queue place, "depends on" and the five issue counts, written by card_create / card_update (depends_on, issues, queue_pos); a card written before has none; not yet: B4b for the lines the probe's readings feed (ETA, waits); no test draws it on the page from store data and asserts its text) | `cards` |
| "Manager missed" on a card | hidden on the store until B4 (Manager, 2026-11-09; the ETA inputs come in B4) | |
| Thread fold, closed asks | untested (was same (B1): no test draws a closed ask's fold from store data) | |
| Done in the last 24 h, search | same: the old board's done cards come in as history (B3b), and the store's own once the probe reads them at their last phase (live, or install on the board's own track), with doneAt and version (C2) | compat `initiatives` (done), `worker/compat-ships.mjs` |

## Shipped, time, usage

| Item | Status | Where it comes from on the store |
|---|---|---|
| Shipped feed, search | same once Boardsmith's hooks are in (C2): one line per version the probe read on a card's commit, "#C12 Title · #C13 Title", timed by the probe's shippedAt (when the work reached main, within the last 30 days) rather than by the probe's first reading; a later card with an earlier shippedAt moves the ship back to it. The old board's events come in with the import (C5) | `ships`, `worker/compat-ships.mjs` |
| Time spent: tiles, chart | partly (#C728, #C736): agent minutes from the phase history, every day shown. The usage job now posts the day's runner and Actions minutes and cost (`collector/actions-usage.mjs`, the old usage script's count) to `POST /api/probe/usage`, today and yesterday; the bars fill: its first two days were posted on 2026-11-10 after the pc13 deploy and tree step (the store's view then carried the runner and automation minutes and the Actions cost for 11-09 and 11-10). Queued and Gated hours come from the wait steps agents log with the step tool (#C739): data, not code, so they match the old board only for days the wait steps cover | `usage_days`, `worker/compat-usage.mjs` |
| Plan-week tile | untested (was same: data in; no test draws the probe's `usage` reading from store data) | probe `usage` (evidence key `usage`, written by the usage job) |
| Per-agent table | partly (#C728): drawn from the phase history (B3b), sorted by queued then working time. Queued (busy) and Gated come from the wait steps agents log with the step tool (#C739, the history's `wait` column): empty for the days before any were logged, because the import refuses the old board's wait steps (**a difference for the owner's list**). No rows for Manager or Ops: no phase is theirs, and the probe names who worked from the phase, not from steps the agents log (Designer shows only after a design phase). Release reads near 0: the probe reads every minute and often passes the ship phase between two readings, and live time isn't counted | compat `steps` |

## The page itself

| Item | Status |
|---|---|
| Keys, touch, copy buttons, drafts and folds kept across redraws, light and dark, phone widths | untested (was same (the page's own code): the tests run it on artifact-shaped fixtures, none on store data) |
| Fonts | same: self-hosted (`page/fonts/`, DECISIONS) |
| Lightbox buttons | untested (was same: wired by listener, not inline; no test draws it on the page from store data and asserts its text) |
