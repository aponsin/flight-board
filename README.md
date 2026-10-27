# Flight board

A board for a team of AI agents working for one owner. It shows what is in flight and which phase each item is in, what waits on the owner, and a thread under every item, so the owner and the team talk where the work is.

The page is a claude.ai artifact with a shared database. The agents write to it; the owner reads it, presses buttons and replies in threads; each reply reaches the team's lead agent as a comment.

Everything particular to one team lives in its own `board.config.json`, outside this repository. Nothing about a team ever enters the repository: a content scan checks every pushed commit before it leaves. It is a hook, so `git push --no-verify` skips it: treat it as a guard, not a guarantee, and run `node scripts/scan.mjs --all` (every commit ever made) before making the repository public.

## What is here

| Path | What it is |
|---|---|
| `page/board.template.html` | The board page, with a `/*BOARD_CONFIG*/` block the build fills in. |
| `scripts/config.mjs` | The config's fields, their defaults and their check. |
| `scripts/build-page.mjs` | Builds the page for one config into `dist/board.html`, only if the built page passes every rendered scenario. |
| `scripts/fixtures.mjs`, `tests/fixtures/board/` | Rendered scenarios: board documents and what the owner must see for each item, drawn by the page's own script. |
| `scripts/install.mjs` | One-time setup for a team: checks the config, turns on the scan, builds the page. |
| `scripts/scan.mjs`, `.githooks/pre-push` | The content scan, run before every push. |
| `scripts/hooks.mjs` | Installs the hooks below into Claude Code's settings, from a pinned copy of one signed commit. |
| `scripts/thread-ids.mjs` | The lead's tool for numbering and naming threads. |
| `scripts/steps-archive.mjs` | The lead's tool for archiving closed cards' steps: each card's steps go to `timings/<card id>`, then leave `steps`; the page counts a closed card's steps from both, each once, so a late one still counts. Only the lead writes `timings` or deletes a step (the gate). |
| `gate/` | The write gate: a PreToolUse hook on board writes and hand-off messages, a PostToolUse hook that records what the board applied, and a Stop hook on the lead's replies. |
| `collector/collect.mjs` | The collector: each card's phase worked out from the repository, and the nudges. |
| `collector/TASK.md` | The scheduled task that runs the collector: its folder, settings, mode and steps. |
| `collector/fence.mjs` | The collector's fence: a hook that lets its run make only its own steps. |
| `collector/context.mjs` | Memory tiles from the app's own numbers: a hook that saves each role's context reading for the collector to write. |
| `collector/refresh.mjs` | A Stop hook that tells the lead to run the collector now, after a ship or the owner's word. |
| `tests/` | Every rule's test. `npm test`. |
| `board.config.example.json` | An example config, fictional. |

## Set up a team

Four steps, in order. Every path below is a placeholder: use your own.

1. **Config, word list, install.** Write your `board.config.json` somewhere outside this repository, starting from
   `board.config.example.json`. The fields: `title`, `owner` (the person the board works for, as they sign),
   `artifactUrl` (empty until step 2), `phases` (`[key, label]` in order), `roster` and `order` (the roles shown), `skips`
   (a phase only at a level, `unlessLevel`; skipped when an item field is false, `whenFalse`; or only when one is true,
   `unlessTrue`, for a review few items need, like a designer's on `lookChange: true`), `boardStart`, the usage labels, and the `gate`,
   `collector` and `nudges` blocks (below; `scripts/config.mjs` lists every field and its default). Write a private word
   list outside this repository too: one word or name per line that must never appear here (the business's name, its
   people, its customers, its domain). Then run `node scripts/install.mjs <board.config.json> <words.txt>`: it checks the
   config, turns on the pre-push scan with your list, and builds `dist/board.html`.
2. **Publish the page.** Ask your lead agent to publish `dist/board.html` with its Artifact tool: a new artifact the
   first time (put its link in `artifactUrl` and build again), the same link afterwards. The page needs the `db`,
   `comments`, `assets` and `downloads` capabilities, declared together (a declaration is the whole set): `downloads`
   lets a thread's non-image files be saved; without it they show by name only. Run `npm test` before every publish.
3. **Install the hooks.** Pick the commit you trust (its tests green, reviewed), then
   `node scripts/hooks.mjs <board.config.json> --pin <commit>` prints what it would change; add `--write` to change
   `~/.claude/settings.json` (it keeps a copy). Run it from a checkout of that very commit (a detached worktree is
   simplest): the script that writes the hooks is the checkout's, so an older branch writes older hooks. This changes
   Claude Code's settings, so the owner runs it, or says yes to it themselves; no agent approves it for them.
4. **Create the collector's task.** Follow `collector/TASK.md`: the folder `<gate.stateDir>/<board id>`, the task
   created from a one-off session started there, its settings file with the fence, the prompt, and Auto mode in the
   task's Edit form. Run it once by hand, then schedule it hourly. For runs on demand, set `collector.refresh.taskId` in
   the config to the task's id (the id the create call returned, not its title; the default is `board-collector`), list
   your checkouts in `collector.refresh.repos`, and give the lead an allow rule for
   `mcp__scheduled-tasks__run_scheduled_task`.

## Threads

Every item is a thread. The `messages` collection holds `{thread, from, text, at, assets?, kind?, resolved?}`: `thread` is the item's id, or `t-<time>` for a thread the owner started from the "Start a thread" box (`kind` question or idea). A thread is open while its newest message is the owner's. The lead agent answers with a message (`from` its role), naming the owner's message it answers (`after: <its id>`) so the answer follows it whatever the clocks said, and closes a thread with `resolved: true`. The owner can close any open thread with its Close button.

Each message from the owner pings the lead agent as a comment that reads exactly `Board thread [<thread>]: <owner>: <text>`. With `meta/board` `{ "wake": "batch" }` the page only saves, and the lead agent checks the open threads on its own schedule.

## Card numbers and ETAs

Every card has a number, `#C12`, from `meta/cardSeq` (`{next}`), the way threads have `#T27`: a new card takes `num`
equal to the counter's `next` and moves the counter in the same batch, pinned with `if_version`; a card keeps its number
for good. `node scripts/card-ids.mjs <export folder>` numbers the open cards, and those closed in the last 30 days,
that have none. A card's "Live in" is worked out from its phase (the medians of the phases still ahead, from the cards
that went live; in ship, the release start plus about 10 minutes); the `etaLive` a card was made with is only the
fallback.

## The plan

Where the work is going (board v3). The `plan` collection holds nodes `{parent, order, text, kind, outcome?, measure?,
due?, waitsOn?, state?, evidence?, replacedBy?, changedAt?, why?, decisionThread?, note?}`: `kind` is `objective`,
`milestone` or `step`, nested by `parent` (`null` at the top), with no depth limit. Every card names the node it serves in
its `plan` field (a "keep the lights on" node takes the rest), and the gate refuses a new card without one. Only the lead
writes the plan, and never deletes from it: a node that has cards is replaced, not edited (the old node gets
`replacedBy`, `changedAt` and `why` and stays, struck through; the new one sits below it). `state` is only ever
declared `done` with `evidence`; the collector works out the rest.

The collector writes each node's state into `derived/all` (`plan.nodes`): replaced, done (declared, or every card and
node below it done), in progress (an open card on it or below it), gated (a `waitsOn` entry naming a node or card not
done, any other `waitsOn` text until the lead removes it, or an open ask tied to one of its cards) or next. Each objective
gets its bar (done over all the nodes below it) and a chip against its `due` day (ending 23:59:59 UTC): done, blocked
(all that is left is gated), at risk (the size medians of what is left, `nudges.etaHours`, run past it) or on track.
At the top of the new layout, whatever the tab, sit what needs you and the "Start a thread" box. It opens on **Now**: the open cards grouped under the plan node they serve, in the plan's order, unlinked cards last, and folded below what shipped and the threads resolved in the last 24 hours. Its **Crew** view has a tile per agent (model and effort, memory, what it is on) and the last 7 days' time by phase. Its **Plan** view shows the outline with those states, the cards on each node, and the open ideas at the bottom.
It sits behind "Try the new layout" (or `#v3` in the link); the current board stays the default, and the choice is
remembered in that browser only.

## Tests

`npm test` runs every rule's test. Each rule also had a mutation check: break the rule on purpose, a test must fail, restore.

Rendered scenarios check the page as the owner sees it. Each file in `tests/fixtures/board/` is a set of board documents (times written `now-5m`, the owner `@owner`) and, for each item, what must show: its `section` (`needs-you`, `waiting-on-manager`, `later`, `resolved`, `board`, `done` or `none`), how many `rows`, its `badge`, `threadUnder` and `replyRow`, and for a card its `phase`, `status`, `version` and `gated`. `scripts/fixtures.mjs` draws the whole board with the page's own script and compares; `node scripts/fixtures.mjs [page.html]` prints each result. `npm test` runs them on the template, and `scripts/build-page.mjs` refuses to build a page that fails one. A display fault the owner reports becomes a fixture first, which must fail before its fix.

## The write gate

Every write to the board goes through `gate/gate.mjs` first, and is refused with its reasons when it breaks a rule, so the writer fixes it and sends again:

- the board's own checks (an item's ETA, next step, level and version; an ask's steps, question and time; real clock times);
- a decision has two options or more and its context, and a look decision a screenshot per option; a command in a step is written `{text, cmd}`;
- `ctx/<Role>` is written only by that role's session, and `meta/context` `agents.<Role>` too, except by the lead role; a session's role is its title in the app (or `FLIGHT_BOARD_ROLE`, which must agree). This is an integrity check against mistakes (a session that thinks it is another role), not access control: any session can rename itself, so nothing that needs protecting may depend on it; a session with no role at all (no title, no `FLIGHT_BOARD_ROLE`) writes nothing to the board, its own steps and the stuck line included, so give every session that logs to the board a title, check-in and keeper sessions too;
- an id listed in `gate.transientPrefixes` is a passing agent state and never becomes an item;
- one open phase per card: a review can't start while build is open, and ship can't while anything is; reviews overlap each other, and build may start while a review waits (a fix round after findings); a build step left open ends where the collector found the READY commit (`readyAt`, shown as a derived end);
- after three refusals in a row for one item, the gate asks for the stuck line (`meta/stuck`), which the page shows until a write for that item passes and clears it;
- a message from the lead that hands out work names its card ("board id <id>"), and the card exists;
- thread numbers and names (`threads/<thread id>` `{num, title}`, the counter `meta/threadSeq` `{next}`) are the lead's alone; a batch that numbers threads moves the counter too, with distinct numbers running up to its new `next` - 1; the counter is pinned with `if_version` once it exists and never goes back below the highest `next` the board applied. The lead numbers threads with `node scripts/thread-ids.mjs <export folder>` (an export of `messages`, `threads` and `meta`), which writes the batches to send, the counter pinned with `if_version`. On the page, `#T27` in any message links to that thread, the owner can rename a thread, and a message naming `#T27` tells the lead which threads to read first.
- every thread has its number from the start: a new waiting item, and a message that opens a thread the board hasn't numbered, come with `threads/<id>` `{num, title}` in the same batch (the counter moves with it); a thread the owner starts from the board is numbered by the lead's next `scripts/thread-ids.mjs` run, which also numbers waiting items with none and names every thread without a title;

`gate/after.mjs` runs after a board write the board applied, and records what the gate must remember from it: the thread counter's `next`, so "never back" follows what the board holds (a refused batch can be sent again).

`gate/stop.mjs` keeps the lead from ending a turn that states a verdict (`gate.verdictWords`) without a board write, or that answers the owner's thread message without writing in that thread.

Install the hooks with `node scripts/hooks.mjs <board.config.json> --pin <signed commit>`: a dry run that prints what it would change. Add `--write` to change `~/.claude/settings.json` (keeping a copy) and `--retire <text>` to remove an older gate's hook in the same write. The hooks run a copy of that one commit, exported to `~/.flight-board/install/<sha>`, never this checkout; upgrading means installing a newer signed commit. "Signed" is the owner's choice of commit: the script checks no sign-off note. The pinned copy guards against work in progress, not against anyone who can act as the owner's user. It changes Claude Code's settings: the owner runs it, or says yes to it themselves; no agent approves it for them.

The gate is a process guard: on its own error (a config it can't read, a call it can't parse) it lets the write through with a note; a rule it applies refuses.

## The collector

The board shows what the repository says, not only what someone wrote. For each open card, `collector/collect.mjs` finds its commit: a branch head carrying a `Board-Id: <id>` trailer, a branch named for the card, or a release commit on the main branch that names the branch it shipped (`collector.shippedPattern`). It then reads:

- the sign-off notes on that commit (`collector.notes`: a review phase and its notes ref);
- whether the main branch contains it, and the version it shipped in (`collector.versionPattern`);
- whether a successful deploy run (`collector.deployWorkflow`) contains it.

Each card's version is the repository's, never written by hand (`plannedVersion` is retired; the gate refuses it): live or deploying, the version it went out in; in the ship run on now, "Shipping now" (`collector.candidatePattern`: the run's own branch, which exists only while it runs and whose commits name each branch@sha it ships); signed and waiting, "Queued (n)" by when each went READY; else "In review" or "Building". The refresh hook starts the collector when such a branch appears or goes, so a ship shows within minutes. With `collector.liveUrl` set, the collector reads the build the live site serves from its page (`collector.liveTag`: version and commit, by default a `<meta name="generator">` tag), and the header's "Live now" shows it, with "deploying v…" while the main line names a newer version.

From those it works out the card's phase: build, then each review not yet signed, then ship, then live. A head is READY when it carries the card's `Board-Id`, or, until every team does, when any reviewer has signed it. A card given up closes as `"dropped"` with a `dropReason`. A card's phase is its branch's current tip's; a card is one branch (a second one is a `CONFLICT`: split the rework into a sub-card). The collector also times each phase from the evidence (`collector/timings.mjs`: the first commit, READY, each sign-off note, the ship run, the first deploy run that has the work). It writes everything to one document, `derived/all`. The page shows each card at the repository's phase when the evidence is firm (the evidence's times where it has them, the steps' elsewhere, "no record" for a finished phase with neither; steps newer than the run and further on win until the next one), with "Repository: <phase> <version>" on it, in red with "steps say …" when the steps disagree, and the gate checks phase moves, one card per role and phase, and done-only-when-closed against it.

Cards whose work lives in another repository (the board's own cards, in flight-board) are read from it with
`collector.repos` (#C278): each a name, a clone of its own (`path`), its main branch, its review notes, the card ids it
holds (`idPrefixes`; a card's own `repo` field wins) and `installedLink`, the link whose commit is what's installed
(`~/.flight-board/current` for the board). The same derivation runs there, with "deployed" meaning installed, and every
review signed becomes a wait the repository explains: "Queued for board release" until the commit is on main, then
"Waiting for install" until the link includes it, then live. Neither wait is a stall: the page raises no stalled, never
started or stale next-step alarm, and the collector no step-overdue or unchanged nudge, while it lasts.

Sign-off notes are fetched into `refs/notes/flight-board/`, so the team's own notes refs are never overwritten. Point `collector.repoPath` at a clone of its own, not at a checkout someone works in. `collector.outDir` is where the collector writes its one output, `derived-all.json` (default `<gate.stateDir>/<board id>/out`); the scheduled run sets it to a folder outside the state folder, which its settings deny to Read whole (`collector/TASK.md`).

A thread with no number yet (the owner's own new thread from the page, which only the lead numbers) is one more
`NUDGE` line every run until the lead numbers it with `scripts/thread-ids.mjs`.

The nudges (`collector/nudges.mjs`, settings under `nudges` in the config) come out of the same run as `NUDGE` lines: the owner waiting for an answer, a step open past its card size's median, an old memory reading, a card unchanged for a day. Each is sent once, then again only after a quiet period.

With `collector.contextRoles` (a list of roles, each a session's exact title), the run also fills the memory tiles from the app's own numbers instead of each agent's report: it lists the sessions, reads each role's newest session with `get_usage`, and writes `ctx/<Role>` and `meta/context` `agents.<Role>` as `{pct, at}`. A hook (`collector/context.mjs`) saves the readings, so the numbers never pass through the run's model; a session the app can't read (no running process) keeps its last reading. The gate lets the Collector write those and nothing else beside `derived/all`.

**Keep `~/.flight-board` private.** The gate's state (`gate.json`) holds the text of recent board writes, messages included, and the mirror holds a copy of the board. Leave that folder out of any backup that leaves the machine, any sync folder and any export.

Each run is a scheduled Claude session following `collector/TASK.md`; only a Claude session can write the board.

### The fence

The run is unattended and in Auto mode (its one board write asks for consent once per session, and "Allow once" is all
the consent offers, so in the default mode every run would wait for the owner). Auto lets the mode's own check approve
calls, so `collector/fence.mjs` decides first: a PreToolUse hook on every tool, in the collector's folder only, that
lets through exactly the steps of `collector/TASK.md` and refuses anything else. Each call may carry only its known
fields; paths and links compare as exact strings; the board's rows go only to files in the run's scratchpad, never into
the session. Any failure refuses, a crash or a missing file included (`|| exit 2` on its command). It never grants
anything: it only refuses.

### The current link

Every collector change used to cost the owner an install. Now only what constrains an agent does (#C223):

- **The owner's install** (`scripts/hooks.mjs --pin`, the collector's settings): the gate's hooks, the refresh hook,
  the fence and the memory hook, each pinned by commit in the settings, and every file they import (`importClosure` in `scripts/current.mjs`).
  The fence takes only `collector/export.mjs` (two constants, no imports), so the collector's own code
  (`collect.mjs`, `derive.mjs`, `facts.mjs`, `nudges.mjs` …) is not pinned: it goes out as a board release, under
  Security's Full review (#C278).
  A change to them waits for the owner's next install, so batch them.
- **No owner** (the collector's code, the page, the task's steps): the scheduled run starts
  `~/.flight-board/current/collector/collect.mjs`. `current` is a symlink to a pinned copy
  (`~/.flight-board/install/<full commit>`). `node scripts/current.mjs <commit>`, from a checkout, moves it, and only to a
  commit on `origin/main` that carries Security's `SECURE` note (`refs/notes/security`, on this repository's origin). The
  move is one rename. The script says when the commit also changes the owner's files (they wait for the install) or
  `collector/TASK.md` (the lead saves the new steps into the task, `update_scheduled_task`). The lead republishes the page.
  It compares with the commit the settings pin, and uses a copy already in `install/` only when it is exactly that
  commit (`git archive`, file by file, nothing extra); anything else is refused. Then it fast-forwards the checkout's
  local `main` to the commit, but only as a fast-forward and only when `main` is not checked out or is checked out
  clean, and not mid-rebase or mid-merge. It never resets anything, and it says what it did or why it left `main` alone.

**A board release is the release role's** (#C276), like a product release, and runs only from the signed linked copy:
`node ~/.flight-board/current/scripts/board-release.mjs <full commit> [--dry-run]`, never from a checkout. It takes
the config from the gate's pinned hook, the lead's session from the fence's `--send-to`, and the target's files from
the commit's own snapshot. Before anything changes it checks Checker's `PASS` (`refs/notes/checker`) and Security's
`SECURE` on that exact commit (origin's notes, fetched into private refs), that it continues `origin/main`, that nothing
the owner's install pins changed since the commit the settings pin (the owner's closure above, this release tool and
its closure, and `collector/TASK.md`'s settings block), that the steps didn't change without the prompt
(`collector/PROMPT.txt`, the task's prompt with the team's values filled in), and that the page asks for no capability
beyond db, comments, assets and downloads, builds and passes its scenarios. It prints one line per check; on any
refusal it names each file and changes nothing, and those changes go out with the owner's install. Otherwise it runs
its own copy's scan, pushes the commit to `main` (a fast-forward), moves the link with its own copy's
`scripts/current.mjs`, and prints the page to republish and, when it changed, the prompt to save into the task.

**What gates a collector change is Security's review**, not the fence. The fence bounds the session's tool calls, but
`collect.mjs` is a Node process with the owner's user rights (no sandbox: it fetches from GitHub, asks `gh`, reads the
live site and writes the repository clone's refs), and a `SECURE` note is a process, not an identity: any session that
can push may write one. So every change the link carries (the collector, the page, the task) gets Full review, and
Security signs with `git notes --ref=security add -m "SECURE" <commit>` and `git push origin refs/notes/security`.

The fence lets the two steps run from its own pinned copy or from `current`, and from `current` only while it is a
symlink to `<install root>/<full commit>` holding the collector. Step 1 records which copy it ran; step 2 refuses to run
any other ("run step 1 again"), so a move mid-run never mixes two versions. The owner's settings deny Edit and Write on
`~/.flight-board/**` (`"deny": ["Edit(~/.flight-board/**)", "Write(~/.flight-board/**)"]` in `~/.claude/settings.json`),
so no session's file tools can plant or edit a copy there; a shell command still can, which the copy check above catches
at the next move and Security's install check catches after.

### Runs on demand

Besides the hourly run, `collector/refresh.mjs` (a Stop hook `scripts/hooks.mjs` installs next to the gate's) holds the
lead's turn end once with "start the collector now" when, since the last run started:

- a checkout listed in `collector.refresh.repos` shows its `origin/main` moved (local refs only, no fetch: a ship pushed
  from this machine updates them; `--prepare` notes them when a run starts);
- the owner marked an item done;
- the owner wrote "refresh" (typed, in a thread, or in a reply's note).

It names only `run_scheduled_task <collector.refresh.taskId>`, and never fires while a run is in flight
(`flightMin`, 15), within `debounceMin` (10) of the last run or of its own last ask, or twice in a row. It is advisory:
on any error it lets the turn end.

**Every READY commit carries a `Board-Id: <card id>` trailer** from now on, so the collector finds the work even when the branch has another name.
