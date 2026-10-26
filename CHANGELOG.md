# Changelog

## 0.3.1 - Unreleased

### Added
- The plan layer, step 1 of v3 (data and gate only; the page doesn't show it yet): a `plan` collection of nodes (`objective`, `milestone`, `step`, nested by `parent`, with `outcome`, `measure`, `due`, `waitsOn`, a declared `state` with `evidence`). Only the lead writes it; a node is never deleted, and one that has cards is replaced (`replacedBy`, `changedAt`, `why`), never edited in its `text` or `outcome`. Every new card names the plan node it serves (`plan`), a real node that wasn't replaced. The collector exports `plan` too (optional: a board without a plan still exports complete).

### Changed
- The collector also runs on demand: when the lead's turn ends after a ship, an item marked done or the owner's "refresh", a Stop hook (`collector/refresh.mjs`) tells it to start the collector task now. At most once per 10 minutes, never while a run is in flight. New config block `collector.refresh` (repos, taskId, debounceMin, flightMin).
- A thread shows its newest message first, under one reply box at the top. An ask you haven't answered keeps only its own box (its buttons and note), so the thread's box no longer shows a second time after the last message. Once you have answered, the thread's box takes its place.
- The collector's fence (`collector/fence.mjs`): a PreToolUse hook on every tool, in the collector's state folder only, that lets through exactly the steps of TASK.md (the two collect commands, the board's exports into the run's scratchpad, set `derived/all` from its file, one message to the lead) and refuses everything else, failing closed. It is what makes the collector safe to run in auto mode, where the board write no longer asks every hour (Security).
- Every ask, answer and initiative shows its thread's #T number (copy on click) and, once renamed, its name on its top line, before it opens. With no name of its own, a thread is named by its item's text, so none is ever unnamed.
- The gate's journal (laid over the mirror) and its known cards are written by `gate/after.mjs`, once the board applied a write: a write the gate let through but the app or a stale pin refused no longer shows as done (Security).
- A reply's or thread message's files: an image is a thumbnail that opens in the board's lightbox (← →, zoom, Esc), with that message's other images; any other file downloads in place. No new tab, which a sandboxed board can't open (the links were broken).
- The "Start a thread" box takes files like a reply box: Attach, paste or drop images and files; they go on the new thread's first message.
- Text boxes work like the chat app where a box has one action (a thread's Send, Send to Manager, an answer's Ack): Enter sends; Shift+Enter or ⌘+Enter (Ctrl+Enter off a Mac) adds a line. Where a box has two outcomes (Done or "Something went wrong", OK or "Change something", options), Enter does nothing and the box says to click a button. Nothing while an input method composes, in an empty box or on a disabled button.
- The collector runs hourly (the app's scheduler): the gate counts its mirror fresh for 75 minutes, not 30 (`gate.mirrorMaxAgeMin`), so the board-state rules keep running between runs. A scheduled run's session takes the task's own title, so the task is titled `Collector` and the role rule is unchanged.
- The collector's first run (TASK.md): the folder is set in the app's view of the task and checked after saving; the export's folder (`mirror.next`) and step 3's `out` are the task's `additionalDirectories`, never their parent; the lead is messaged by session id, since a scheduled run reaches no session by name; a correct run asks for nothing, so any prompt is answered Deny and the run stopped (an "always allow" stays on the task).
- The collector's second run asked about ten times (TASK.md, Security): its commands run exactly as allowed (no `cd … &&`); it may read only step 3's `derived-all.json` (the export, mirror, gate state, config folder and `~/.claude` denied, no bare Read deny, which blocked the write from file); it messages the lead with `mcp__ccd_session_mgmt__send_message` by session id (SendMessage can't from a scheduled run), the tools that stop, clear, archive, delete or re-permission a session denied; ToolSearch and the plan tools allowed; `model: haiku`.
- The collector runs in the board's own state folder (`<gate.stateDir>/<board id>`), its settings file there, the code by the pinned install's full path: a scheduled run saves exports only inside its own folder (`additionalDirectories` didn't help; the second trial asked for every export). Step 3's version read saves to `<dir>/out`.
- The collector's export goes to the run's own scratchpad, the one place a scheduled run saves without asking (a throwaway task showed it, 2026-10-25): `--prepare` notes the time; step 2 takes only this run's export (made after it, all seven collections, a real folder under this folder's scratchpad root) by moving it into place, keeps only `<collection>/<doc>.json` files, and stops with an error when there is none. The run's scratchpad is denied to Read.
- `collector.outDir` (config): where the collector writes `derived-all.json`. The scheduled run sets it outside its own folder, so its settings deny Read on the whole state folder (it holds the mirror, the gate's state and a clone, and anything added later) and allow only that file; the shell's readers are denied too (Security).

### Added
- The Threads panel in order: Start a thread, Needs you, Waiting on Manager, Later, then Resolved threads (last 7 days, folded) with a search box that finds any resolved thread, whatever its age, by name, #T number, item text or any message.
- `gate/after.mjs`, a PostToolUse hook (installed with the others): after a board write the board applied, it records the thread counter, so the gate's "never back" follows what the board holds and a refused batch can be sent again. Both hooks write the gate's state whole (a file of its own, renamed into place).
- Thread numbers and names: each thread gets a number (#T27) in the order threads opened, shown with a copy button; the Threads panel shows its name in bold, and a renamed thread shows its name on top. `#T27` in any message links to that thread; a message naming one tells the lead which threads to read first. The owner renames a thread from the board; the lead numbers them (`scripts/thread-ids.mjs`, backfill included), the gate keeping both the lead's.
- A Close button on every open thread: the owner's message marks it resolved (and closes an ask or idea), with no ping; it folds into Resolved.
- A message may name the one it answers (`after: <message id>`); it then always comes after it, whatever the clocks said.

### Fixed
- Send takes the text out of the box at once: no kept draft after sending, no second send of the same text; a failed save puts it back.
- The gate lays every write it let through since the mirror's export over the mirror, so a card closed since shows closed and the board-state rules keep running (a card closed earlier showed as still on build).

## 0.3.0 - Unreleased

### Added
- The collector (`collector/`): each open card's phase from the repository (Board-Id trailers, branches, release commits that name shipped branches, sign-off notes, the main branch, the deploy run), with its version; conflicts with the card's own phase and the cards live but still open; `derived/all` for the page and the gate; `TASK.md` for the scheduled run.
- The gate's rules that need the board's state, against the collector's mirror: phases only move forward, one card per role per build or review phase, done only with the owner answered, no open ask and live by the evidence.
- The page shows "Repository: <phase> <version>" on each card, marked when the card disagrees.
- Hardening (Security): a sha from a commit subject reaches git only as plain hex; `collect.mjs --prepare` makes a fresh export folder, which the run swaps in whole as the mirror, only under `<stateDir>/<board id>`.
- Review fixes (Checker, Manager's rules): a sign-off note on a card's head means READY until heads carry Board-Id, and missing evidence is no conflict; one card per owner only in `collector.lanePhases` (build, test), while reviews and shipping queue; a card given up closes as "dropped" with a `dropReason`, shown as Dropped, with no live evidence needed.

## 0.2.0 - Unreleased

### Added
- The write gate (`gate/`): the board's rules on every write; decisions with two options or more, context and per-option screenshots for a look; commands as `{text, cmd}`; each role's own memory tile (the lead keeps the keeper's writes); passing agent states never become items; the stuck line after three refusals in a row, shown on the page and cleared by the item's next good write; hand-offs name an existing card; the Stop hook for verdicts and thread answers.
- `scripts/hooks.mjs`: the gate's settings entries, printed or written, every path single-quoted for sh (nothing in it expands); `--retire <text>` removes an older gate's hook in the same write; a one-line summary of the change and a timestamped backup. `--pin <signed commit>` (required) exports that commit with git archive to `~/.flight-board/install/<sha>` and points the hooks there, so they never run a checkout someone is editing; upgrading is installing a newer signed sha.
- The gate refuses an edit in place (str_replace) on the board, and lets only the lead set or delete the whole of meta/context or meta/stuck (Checker).
- `DECISIONS.md`: the role check is an integrity check, never access control; the gate fails open on its own errors.
- Not in the gate: a reused id (the board's server refuses a set without if_version); phase order, one item per role and phase, and done-only-when-closed come with the collector, which keeps the board's mirror.

## 0.1.0 - Unreleased

### Added
- The board page as a template, with everything particular to one team in its own `board.config.json`: title, owner, phases, roles, skips, usage labels.
- Threads: every item is a thread (`messages`); a "Start a thread" box (question or idea); a reply reopens a resolved ask or idea; each message from the owner pings the lead agent as `Board thread [<thread>]: <owner>: <text>`, or waits for its check with `meta/board.wake` "batch".
- A bare Ack on an answer closes it; a note on any button also goes in the item's thread, so a question in it waits for an answer.
- The content scan before every push, against the team's private word list and for artifact links, real emails and phone numbers, and tokens.
- `scripts/install.mjs`, `scripts/build-page.mjs`, and tests for every rule.

### Fixed (review, before 0.1.0)
- The pre-push scan reads what the push sends: every file each pushed commit adds or changes, and each commit's message, not the working tree. `--all` scans every commit ever made, for the check before going public.
- The scan also catches phone numbers written as digits (+13035550100 style), Stripe, webhook, Resend and fine-grained GitHub keys; it refuses a word list with no words; no-reply addresses pass.
- `install.mjs` keeps the config and word list outside the repository from any folder in it.
- The scan reads a merge's own changes, ranges a push against that remote only (a first push to a new remote scans everything), and scans pushed annotated tags (tagger and message, not the time) and every commit's author and committer.
