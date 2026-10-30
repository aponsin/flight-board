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
| `keeper/TASK.md` | The context keeper's scheduled task: measures each agent's context, cues resets, and picks its own wave back up (the lead last); the lead saves its prompt into the task. |
| `tests/` | Every rule's test. `npm test`. |
| `board.config.example.json` | An example config, fictional. |

## Set up a team

Four steps, in order. Every path below is a placeholder: use your own.

1. **Config, word list, install.** Write your `board.config.json` somewhere outside this repository, starting from
   `board.config.example.json`. The fields: `title`, `owner` (the person the board works for, as they sign),
   `artifactUrl` (empty until step 2), `phases` (`[key, label]` in order), `roster` and `order` (the roles shown), `skips`
   (a phase only at a level, `unlessLevel`; skipped when an item field is false, `whenFalse`; or only when one is true,
   `unlessTrue`, for a review few items need, like a designer's on `lookChange: true`), `boardStart`, the usage labels, and the `gate`,
   `collector`, `nudges` and `decisions` blocks (below; `scripts/config.mjs` lists every field and its default). Write a private word
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

A thread whose newest message is the team's is the owner's to read, under Needs you (#C451). That holds for an ask the owner already answered, once a message is newer than the reply. A thread whose card is in flight stays under With the team, its Building chip kept, whatever the team answers in it. The one exception is a `kind: "decision"` message, which asks the owner to pick, so it goes under Needs you. Such a thread shows Close, so the owner can clear it himself (#C460, the owner's #T1150: it had no button). The lead closes a thread for the owner with an update `{resolved: true}` on the thread's newest message; the page reads `resolved` only there. On the lead's side, the Stop gate owes an ask's reply only while the reply is newer than the lead's own newest message in the ask's thread, not another role's (#C460).

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
- a decision has two options or more and its context, and a look decision a screenshot per option; a decision is a look one when its text or title names one of `decisions.lookWords`, or its card's lane (its `who`, or whoever built it) is one of `decisions.visualLanes`, whatever its `look` field says; no ask sends the owner off the board (`decisions.offBoard`, "in chat"); a command in a step is written `{text, cmd}`;
- `ctx/<Role>` is written only by that role's session, and `meta/context` `agents.<Role>` too, except by the lead role; a session's role is its title in the app (or `FLIGHT_BOARD_ROLE`, which must agree). This is an integrity check against mistakes (a session that thinks it is another role), not access control: any session can rename itself, so nothing that needs protecting may depend on it; a session with no role at all (no title, no `FLIGHT_BOARD_ROLE`) writes nothing to the board, its own steps and the stuck line included, so give every session that logs to the board a title, check-in and keeper sessions too;
- an id listed in `gate.transientPrefixes` is a passing agent state and never becomes an item;
- one open phase per card: a review can't start while build is open, and ship can't while anything is; reviews overlap each other, and build may start while a review waits (a fix round after findings); a build step left open ends where the collector found the READY commit (`readyAt`, shown as a derived end); a step whose `at` no date can hold (not finite, or past ±8.64e15) is no open step;
- what a card waits on (#C444): `dependsOn: ["<card id>", …]` on a card (1 to 10 other cards' ids, each once) is the lead's alone to set or clear; a build start on the card is refused while a card it names is still open on `plan` or `build` (the repository's reading over the card's own); a closed one, or one the board doesn't have, holds nothing. The page shows one "waits on #C440, #C441" on the card, naming those that still hold its build;
- the lead's card fields (`dependsOn`, `batch`, `bump`) can't be cleared around their rule: another role's `set` of a whole card carries them exactly as the board has them (none of them when the gate has no copy of the board), and only the lead deletes a card;
- after three refusals in a row for one item, the gate asks for the stuck line (`meta/stuck`), which the page shows until a write for that item passes and clears it; each entry carries exactly one of `you` (the owner's exact action: the line is red) or `owner` (the agent it waits on: "Nothing for you", amber). `you` is an agent's text shown as the owner's to-do, so it never holds a command the owner hasn't already seen from the lead;
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

From those it works out the card's phase: build, then each review not yet signed, then ship, then live. A head is READY when it carries the card's `Board-Id`, or, until every team does, when any reviewer has signed it. A card given up closes as `"dropped"` with a `dropReason`. A card's phase is its branch's current tip's; a card is one branch (a second one is a `CONFLICT`: split the rework into a sub-card). The collector also times each phase from the evidence (`collector/timings.mjs`: the first commit, READY, each sign-off note, the ship run, the first deploy run that has the work). It writes everything to one document, `derived/all`. The page shows each card at the repository's phase when the evidence is firm (the evidence's times where it has them, the steps' elsewhere, "no record" for a finished phase with neither; steps newer than the run and further on win until the next one), with one source on it and its age (#C450): "Live: <phase> · 12 s ago" while the live state reads the card, else "Repository: <phase> <version>" and its "as of"; what disagrees with it (the steps, a typed field, a second branch) is in its hover, a dashed border marking that there is some, never inline in red; there the flag is a button that shows the same words in a muted line under the name row (no hover on a phone). The card has one ETA, its ETA box; the size's median shows only as "(usually 6 h for L)". ↻ Check shows only on a card the live state doesn't read: it reads the live state again at once and asks the Collector's next run, and says "Live state 12 s old · Collector next 05:03 PM", never "checking…". The gate checks phase moves, one card per role and phase, and done-only-when-closed against it.

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

The nudges (`collector/nudges.mjs`, settings under `nudges` in the config) come out of the same run as `NUDGE` lines: the owner waiting for an answer, a step open past its card size's median, an old memory reading, a card unchanged for a day, and a READY a required reviewer never picked up (10 minutes after the READY commit, or after the run that first saw it if it was pushed later, a review the card needs with no note on it and no step since: a review round that ended in findings waits on the fix, not on a dispatch; a second `NUDGE forward to <Role>: READY <branch>@<sha> (<level>), board card <id>` line for the lead to send on, since the collector messages the lead only). Each is sent once, then again only after a quiet period, except the
overdue one (#C441): `NUDGE overdue: <card> (ETA <hh:mm>Z, phase <phase>)`, every run, for an open card more than an hour
past its `etaLive`, not live by the evidence (that is `LIVE BUT OPEN`'s) and with no open ask tied to it, until it
closes or its ETA moves.

With `collector.contextRoles` (a list of roles, each a session's exact title), the run also fills the memory tiles from the app's own numbers instead of each agent's report: it lists the sessions, reads each role's newest session with `get_usage`, and writes `ctx/<Role>` and `meta/context` `agents.<Role>` as `{pct, tokens, at}` (`tokens`, the context in tokens, left out when the app gives none). A hook (`collector/context.mjs`) saves the readings, so the numbers never pass through the run's model; a session the app can't read (no running process) keeps its last reading. The gate lets the Collector write those and nothing else beside `derived/all`.

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

**An install pack's output is one line** (#C404): the owner pastes what a pack printed into the board, and a reply box
keeps 1000 characters (a thread message 2000), so the v3.19 output arrived cut and read as a failure. Each pack writes
its full output to a log beside it (`board-v<N>-install.log`) and prints one short line to paste: `v3.20 OK: hooks
<sha>, settings <hash>, config <hash>, log <path>`, or `v3.20 STOPPED: <its STOP line>, log <path>`. The steps name
that line. The board guards the rest: a paste over a box's limit goes cut with a line that says so, and the full text
is attached as a text file.

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

**The lead's publish of the signed page goes without asking** (#C409): `gate/publish.mjs`, a pinned PreToolUse hook
on Artifact, allows the lead's publish to this board of exactly the page the signed code builds from the current link
with today's config, and is silent on anything else. It allows a copy of the bytes it checked, in a fresh 0700 folder
(`.publish-<random>`) in the config's folder, never the file itself, so a change between the check and the publish
publishes nothing new (#C415); copies older than a day are cleared. Its reason line names the page's sha256: after a
hook-allowed publish the lead reads the board back (Artifact's read saves it) and runs
`node scripts/publish-check.mjs <read-back file> <sha256>`, which takes off the app's own document wrapping and
compares. Anything but `publish check: ok` goes to Security and the owner.

**A page release never waits behind an install pack** (#C412, Security's ruling on plan A). A release built on a
signed pack S goes out before the owner installs S, when every change to what the owner's install pins on the line
from the pin is signed (PASS and SECURE) and the release adds none of its own (its pinned files are S's, byte for byte).
Nobody names S: the release tool finds it, the newest such commit on that line, all of whose commits must descend from
the pin. The owner's hooks, fence, memory hook and release tool keep running from the old pin until the pack; only what
the link runs (the collector's own code, the page) goes live early. So every pack from then on:

- builds on the newest signed release, and its rehearsal proves its link-run code works with the old pinned gate and the
  old config: new config fields default off, and nothing reads a field only the new `checkConfig` takes (Security looks
  for that test in each pack check);
- skips its push when S is already on `main`, and keeps the `cmp` of its pinned copy against S;
- leaves the link where it is when it already points at a signed release on `main` that has S: `scripts/current.mjs`
  never moves it back, and says so. The pack's page is built from the link's commit, so the publish hook (#C409) still
  matches it;
- writes every command in its steps file out in full, ready to paste: never a command held in a shell variable (`$S`
  is one word in zsh, the Mac's shell, so v3.23's `S="node …"` shortcut ran nothing), and its rehearsal runs each step's
  command line under `zsh` as the owner would paste it;
- says, on every step that shows a secret (the connector dialog with its URL, the `secrets --show` output), not to
  screenshot it, or to crop the URL out of the shot (#C426: v3.23's Add-connector screenshot put the URL on the board,
  so it had to be rotated);
- says, on its restart step, to restart only when no scheduled run is in progress: in the app's Scheduled tasks, no
  task shows a run still going (wait for it to finish first). A run the restart cuts stays "running" and blocks every
  later run of its task (#C427: the watchdog's 21:55Z run sat running for 6 hours, waiting on an approval nobody saw).

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

## The state probe

The board shows each agent's current activity and each card's stage within about a minute and a half, from a script,
with no model and no Collector run (#C420). Three parts, all the owner's (pinned, `OWNER_ENTRIES`: a board release
changes none of them):

- **`collector/state.mjs`**, run by launchd every 60 s from the pinned copy `~/.flight-board/install/<sha>/` (never the
  current link). It reads the open cards on the last board export and, for each, its branch tip, sign-off notes, main
  and deploy (the collector's phase rule, a copy of `collector/derive.mjs`'s that a test keeps equal) and the CI run on
  it (`gh`); and each roster role's newest open session in the app (its file under `~/Library/Application Support/Claude/
  claude-code-sessions`) and its transcript's last 20 entries: working or idle, since when, the class of its last tool,
  and the card it is on (an exact board id or `#C<num>` of a card on the board). It writes `<stateDir>/<board>/state.json`
  and POSTs it to the Worker. GitHub's API is shared with every agent's `gh`, so a finished CI run is kept by commit and a
  run asks `gh` at most 10 times.
- **`worker/state-worker.mjs`**, a Cloudflare Worker (`flight-board-state`) on the owner's own account: one per owner,
  many boards. `POST /b/<board>/state` with the board's token; `POST /mcp/<path>`, a read-only remote MCP server with one
  tool, `board_state`. Each board's Worker secret holds only sha256 of its token and of its path, compared in constant time.
  At most 64 KB, one POST per 30 s, the latest only (KV); anything else, a wrong path included, is a bare 404; no CORS.
  It may share the account with other Workers, so it keeps apart from them: its own name, `wrangler.toml`, KV namespace
  and secrets, no route on any zone (its workers.dev address only), nothing else bound. KV writes are the account's, for
  every Worker on it (Workers Paid includes a million a month; Workers Free allows 1,000 a day), so it stores a POST only
  when what the page shows changed (a card's phase, head, reviews, main, CI state, version; an agent's state, tool, card,
  since), else every 15 min, and at most `WRITES_PER_DAY` a UTC day (2,000 unless `--writes` says otherwise: more than a
  day of the probe's 1,440 posts, so it only stops a runaway poster); a POST past that is a 429 until midnight UTC.
- **The page reads it as its source of stage** (board-state-probe's follow-up; it had a "Right now" section of its own
  until then), through the owner's claude.ai connector named exactly **Flight Board State** (the `mcp` capability, its
  `board_state` only; the page reads it once a minute). While its reading is under 3 min old, every place the page shows
  stage reads it first: each card's phase lights, its running sub-step (an agent working on it now), Waiting on, the ETA
  and the needs-you counts, and the agent tiles (working on its card; idle, its last card only within 15 min of its last
  activity, else "Idle since hh:mm"). Past 3 min, or without the connector, the board is what the Collector's
  `derived/all` and the steps make it. The header stamp alone says which: "live · 40 s" or "from 14:02". The Collector
  also gives a fresh reading's phase to the cards it reads (`readLiveState`, `underLive`). **No typed field
  outranks the live state** (#C449, `buildingNow`, `typedClashes`): while the reading is fresh, a card whose branch has
  a commit beyond main, or whose agent is working on it, is building, and each field below that a person types or logs
  is derived from the live state, or hidden where it contradicts it. The typed value then shows only as
  "typed: queued" in the hover of the card's source (#C450; #C449 had it as a small note by the badge); with a stale
  reading, the typed fields show as before. The gate reads the same
  `state.json` (only a fresh one that fits, `liveFresh`) and refuses `status: "queued"` on a card it shows building. The
  Collector tells the lead in one NUDGE line when a typed field has disagreed with the live state for over 5 min (nudge
  8: the card and the field, never the typed value; not a typed phase, which the run's CONFLICT line already names),
  so the next new field is caught there. The typed or logged fields
  a card shows about its progress:
  - **no step logged** (the `steps` collection): "Queued N min", the "queued · Builder" phase box, the queue line and
    "never started" read it; a card the live state shows building has started.
  - **`status`**: the badge, the agent's tile (⧗) and the queue; `queued` on a building card shows Building (at or before
    build) or In flight.
  - **`phase`**: the phase lights; the live phase shows (as since board-state-probe's follow-up).
  - **`who`**: the phase box's name; at or before build, an agent working on it (the lead aside) shows instead.
  - **`waitingOn`**: the "Waiting on" line; hidden while the card builds at or before build.
  - **`nextNote` / `nextNoteAt`**: the Next line fades as "an agent has moved since" when a step or a live agent's work
    is newer than it.
  - **`lastStepAt` and the steps' times**: "Stalled", hidden while an agent works on the card now.
  - The "Manager missed" line: "never started" goes with no step logged above; its other items (no ETA, ETA passed, no
    next step, next step over 1 h old, no review level) are about the typed fields themselves and stay.
  - Shown as typed, with nothing live to check them against: `etaLive` (the declared ETA), `queuePos`, `createdAt`,
    `size`, `level`, `issues`, `shipDetail` and `shipAt`. `issues` counts what sent the card back, one chip each:
    `bugs`, `security` (security fixes), `language` (wording fixes), `design` (design fixes) and `owner` (owner
    changes: the owner decided or changed something mid-build) (#C468). A rework is counted by the lead: a review's
    end whose note starts `FINDINGS`, or a second build start on a card that already has a review step, makes the
    Collector say `REWORK #C…: record its issues`, and the gate refuses the lead's next write of that card until it
    raises the issues' total and sets `issuesAt` (now, ms) in the same write (`collector/rework.mjs`). A card counted
    before this rule (issues, no `issuesAt`) is taken as counted. Reviewers write no card fields.
  The release tool refuses a page whose `mcp` use goes beyond that one connector and tool
  (`PAGE_MCP`, `pageMcpErrors`); the whole declaration a publish carries is `PAGE_DECLARATION`.

**What leaves the Studio** is exactly `collector/state-schema.mjs` (Security's data plan), checked by the script before
it posts, by the Worker on every POST, and again on what the tool answers (rebuilt field by field, never the stored text):
the board's id, time, probe commit and page commit; per card its number, phase, head (12 hex), the reviews signed, on main,
CI state and minutes, live version; per role its state, last activity, tool class (a fixed list, `mcp`, or `other`), card
id and since. Ids, enums, numbers and times only: no session title, no transcript text, no commit message. The scanned
text is never logged, cached or written. An error never quotes what it refused.

**The owner's install**, from the pinned copy, in the owner's own terminal (`scripts/state-install.mjs`; a pack's steps
give the exact commands). Every wrangler call is the script's, at one exact version (`WRANGLER_VERSION`), run from the
pinned copy's folder, with the login wrangler already has on that machine:

1. `node ~/.flight-board/install/<sha>/scripts/state-install.mjs whoami --config <board.config.json>`: the account wrangler
   is logged in to (its name and id); it must be the owner's. Then `… kv --config …` (the Worker's own KV namespace,
   `flight-board-state`), `… worker --config … --kv <its id> --account <the account id>` (writes
   `~/.flight-board/worker/wrangler.toml`: this copy's Worker, pinned to that account, one workers.dev address, no route,
   no preview ones) and `… deploy --config …`.
2. `… secrets --config <board.config.json> --url https://flight-board-state.<you>.workers.dev`: makes the token (32 random
   bytes) and the MCP path (16) into `<stateDir>/<board>/state-secrets/secrets.json` (0600 in a 0700 folder), hands the
   Worker their hashes on wrangler's stdin, and puts the connector URL on the clipboard. Neither is printed. It first
   checks with wrangler that the Worker is deployed, and if not stops with "run the deploy step first" before making
   anything; wrangler's own output stays on the terminal. Over SSH (`SSH_CONNECTION` or `SSH_TTY` set) the clipboard
   would be the remote Mac's, so it stops and offers `--show`: the same command with `--show` prints the URL once, with
   a warning, instead of copying it (then clear the terminal's scrollback, Cmd-K). `--show` is refused anywhere but over
   SSH, and is run in Terminal.app, never in the Claude app's Terminal panel, whose output agents can read.
3. In claude.ai, Settings, Connectors: add a custom connector named **Flight Board State** with that URL, then press
   Return in the terminal: the script clears the clipboard. The URL is a bearer secret: it goes there and nowhere else (a
   clipboard manager or Universal Clipboard may keep a copy: clear it there too). Don't screenshot the connector dialog
   or the `--show` output, or crop the URL out.
4. `node … state-install.mjs launchd --config <board.config.json>`: writes and loads
   `~/Library/LaunchAgents/com.flight-board.state.<board>.plist`; its one line per run goes to `<stateDir>/<board>/state.log`.

Each step ends with the next one's command, written in full, and every `state: STOPPED:` line says why and names the
command to run next.

**Rotation** is one command: step 2 with `--rotate` (a new token and path; the old ones stop at once), then the new URL
in the connector. A new signed pack re-runs steps 1 (deploy) and 4 for its commit.
