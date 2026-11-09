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
| Manager chip | not yet: B1 ("seen your message" needs messages) | `wakeState` |
| Safe to restart, "Don't restart: shipping" | same (data in; drawn from real readings after the deploy) | probe `agents`, `ship` (evidence keys `agents`, `ship`) |
| Board vX · page abc | same | the build's stamp |
| "Manager stuck on …" | not yet: B4 (refusals in the old shape, with the "You:" action) | `refusals` |
| "X waiting on you since" | same (data in; drawn from real readings after the deploy) | probe `stuck` (evidence key `stuck`, written by the evidence job since B3a, fresh for 3 minutes) |
| "You wrote, Manager silent N min" | not yet: B1 | messages |
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
| Tabs with counts, arrow keys | same for asks and lists; not yet: B1 for threads | |
| Needs you: asks, "Your queue" | same | compat `waiting` |
| Ask row: kind, #T, title, badge, age, "For: card" | same; the chip after an answer: B1 | compat `waiting` |
| Ask steps with Copy per command, "You should see" | not yet: B2 (steps are plain strings) | |
| Ask screenshots, picture viewer | same once Boardsmith's two hooks are in (C1): an agent stores the picture with `file_put` and names it in the ask's `screenshots` as `"<id>"`, `"<id> label"` or `"<id> A: label"` | `files` (migration 0010), `/_blob/<id>`; compat `waiting.images` |
| Reply box per kind (A/B, OK/Change, Ack, Done/Help) | same for an option, Ack and Done; not yet: B2 for a note, "Something else", files | `POST /api/compat/write` |
| Sent line "You chose …" | same for the choice; not yet: B2 for the note and files | |
| "Manager missed" on an ask | hidden on the store until B4 (Manager, 2026-11-09): its fields are not in the store yet | |
| Thread messages, "seen HH:MM" | not yet: B1 | |
| Thread buttons: Close, options, Rename | not yet: B1 (asks close today) | |
| Later tab | same | compat `waiting` (Later) |
| With the team, sub-step line | not yet: B1, B3a | |
| Resolved tab, search | same for closed asks; not yet: B1 for threads | |
| Pull request panel | same (C4): drawn from the store's Approval asks (`worker/compat-approvals.mjs`); Approve answers the open ask for that head, Withdraw clears it | |
| To-do: rank, up/down, Done, Add | same | `lists` |
| Ideas: kind, Close, Add | same | `lists` |
| "Let's start" on an idea | gone: "not part of this change" (DATA.md Changes, 2026-11-09, the lists) | |
| #T and #C links, hover, jump | same for asks and cards; not yet: B1 for threads | |
| Files: attach, paste, drop, thumbnails, save | same once Boardsmith's hooks are in (C1): the page's own attach, paste and drop code, unchanged, now finds an `assets` and a `downloads` handle in the shim. Attach, paste and drop stay hidden until the answer and message hooks are in (the shim's `FILES_ON`, switched on in the same change), so no upload is made that a refused reply would leave unlinked; saving works now | `POST /api/files`, `/_blob/<id>`, `file_links` |

## Cards

| Item | Status | Where it comes from on the store |
|---|---|---|
| Name row: #C, repo badge, "from #T", size | same | compat `initiatives` |
| Status pill | same where the probe has evidence; not yet: B3a for the rest | `derived/all.cards` |
| Check button, "checked by the Collector" | gone: "Delete with the Collector" (row 38) | |
| Source-disagreement flag | gone: "Delete: one source, nothing to flag" (row 28) | |
| ETA box | not yet: B3b, B4 | |
| Version note, "Next: vX" | not yet: B3a, B4 | |
| Track: lit phase, skips | same | `derived/all.cards` |
| Track: who · time on each tile | same (B3b: the store's phase history, with the old board's steps imported) | `derived/all.times` |
| One track per branch | not yet: B3a | probe `cards.branches` |
| Queue line, "waits on", Next (written N ago), Started, issue chips | same for next note, waiting on, started; not yet: B4 for the rest | |
| "Manager missed" on a card | hidden on the store until B4 (Manager, 2026-11-09; the ETA inputs come in B4) | |
| Thread fold, closed asks | not yet: B1 | |
| Done in the last 24 h, search | same: the old board's done cards come in as history (B3b), and the store's own once the probe reads them at their last phase (live, or install on the board's own track), with doneAt and version (C2) | compat `initiatives` (done), `worker/compat-ships.mjs` |

## Shipped, time, usage

| Item | Status | Where it comes from on the store |
|---|---|---|
| Shipped feed, search | same once Boardsmith's hooks are in (C2): one line per version the probe read on a card's commit, "#C12 Title · #C13 Title". The old board's events come in with the import (C5) | `ships`, `worker/compat-ships.mjs` |
| Time spent: tiles, chart | same once Boardsmith's hooks are in (C3): agent minutes from the phase history; runner and automation minutes and the Actions cost from `usage_days`, which the probe writes through `POST /api/probe/usage`. The runner and automation minutes themselves: same (not written on either; the old board's last row is 2026-10-31) | `usage_days`, `worker/compat-usage.mjs` |
| Plan-week tile | same (data in; drawn from real readings after the deploy) | probe `usage` (evidence key `usage`, written by the usage job) |
| Per-agent table | same: drawn from the phase history (B3b) | compat `steps` |

## The page itself

| Item | Status |
|---|---|
| Keys, touch, copy buttons, drafts and folds kept across redraws, light and dark, phone widths | same (the page's own code) |
| Fonts | same: self-hosted (`page/fonts/`, DECISIONS) |
| Lightbox buttons | same: wired by listener, not inline |
