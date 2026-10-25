# Flight board

A board for a team of AI agents working for one owner. It shows what is in flight and which phase each item is in, what waits on the owner, and a thread under every item, so the owner and the team talk where the work is.

The page is a claude.ai artifact with a shared database. The agents write to it; the owner reads it, presses buttons and replies in threads; each reply reaches the team's lead agent as a comment.

Everything particular to one team lives in its own `board.config.json`, outside this repository. Nothing about a team ever enters the repository: a content scan checks every pushed commit before it leaves. It is a hook, so `git push --no-verify` skips it: treat it as a guard, not a guarantee, and run `node scripts/scan.mjs --all` (every commit ever made) before making the repository public.

## What is here

| Path | What it is |
|---|---|
| `page/board.template.html` | The board page, with a `/*BOARD_CONFIG*/` block the build fills in. |
| `scripts/config.mjs` | The config's fields and their check. |
| `scripts/build-page.mjs` | Builds the page for one config into `dist/board.html`. |
| `scripts/scan.mjs`, `.githooks/pre-push` | The content scan, run before every push. |
| `scripts/install.mjs` | One-time setup for a team. |
| `tests/` | The page's rules, the config check, the build and the scan. `npm test`. |
| `board.config.example.json` | An example config, fictional. |

| `gate/` | The write gate: a PreToolUse hook on board writes and hand-off messages, and a Stop hook on the lead's replies. |
| `scripts/hooks.mjs` | The gate's entries for Claude Code's settings: printed, or written with `--write`. |

| `collector/` | The collector: each card's phase worked out from the repository (`collect.mjs`), and the scheduled task that runs it (`TASK.md`). |

Coming next: the nudges (timers that remind the lead agent).

## Set up a team

1. Write your `board.config.json` somewhere outside this repository, starting from `board.config.example.json`. The fields: `title`, `owner` (the person the board works for, as they sign), `artifactUrl`, `phases` (`[key, label]` in order), `roster` and `order` (the roles shown), `skips` (a phase only at a level, or skipped when an item field is false), `boardStart`, and the usage labels.
2. Write a private word list outside this repository: one word or name per line that must never appear here (the business's name, its people, its customers, its domain).
3. Run `node scripts/install.mjs <board.config.json> <words.txt>`. It checks the config, turns on the pre-push scan with your list, and builds `dist/board.html`.

## Publish the page

Ask your lead agent to publish `dist/board.html` with its Artifact tool: a new artifact the first time (put its link in `artifactUrl`), the same link afterwards. The page needs the `db`, `comments` and `assets` capabilities. Run `npm test` before every publish.

## Threads

Every item is a thread. The `messages` collection holds `{thread, from, text, at, assets?, kind?, resolved?}`: `thread` is the item's id, or `t-<time>` for a thread the owner started from the "Start a thread" box (`kind` question or idea). A thread is open while its newest message is the owner's. The lead agent answers with a message (`from` its role), naming the owner's message it answers (`after: <its id>`) so the answer follows it whatever the clocks said, and closes a thread with `resolved: true`. The owner can close any open thread with its Close button.

Each message from the owner pings the lead agent as a comment that reads exactly `Board thread [<thread>]: <owner>: <text>`. With `meta/board` `{ "wake": "batch" }` the page only saves, and the lead agent checks the open threads on its own schedule.

## Tests

`npm test` runs every rule's test. Each rule also had a mutation check: break the rule on purpose, a test must fail, restore.

## The write gate

Every write to the board goes through `gate/gate.mjs` first, and is refused with its reasons when it breaks a rule, so the writer fixes it and sends again:

- the board's own checks (an item's ETA, next step, level and version; an ask's steps, question and time; real clock times);
- a decision has two options or more and its context, and a look decision a screenshot per option; a command in a step is written `{text, cmd}`;
- `ctx/<Role>` is written only by that role's session, and `meta/context` `agents.<Role>` too, except by the lead role; a session's role is its title in the app (or `FLIGHT_BOARD_ROLE`, which must agree). This is an integrity check against mistakes (a session that thinks it is another role), not access control: any session can rename itself, so nothing that needs protecting may depend on it; a session with no role at all (no title, no `FLIGHT_BOARD_ROLE`) writes nothing to the board, its own steps and the stuck line included, so give every session that logs to the board a title, check-in and keeper sessions too;
- an id listed in `gate.transientPrefixes` is a passing agent state and never becomes an item;
- after three refusals in a row for one item, the gate asks for the stuck line (`meta/stuck`), which the page shows until a write for that item passes and clears it;
- a message from the lead that hands out work names its card ("board id <id>"), and the card exists;
- thread numbers and names (`threads/<thread id>` `{num, title}`, the counter `meta/threadSeq` `{next}`) are the lead's alone; a batch that numbers threads moves the counter too, with distinct numbers running up to its new `next` - 1; the counter is pinned with `if_version` once it exists and never goes back below the highest `next` the board applied. The lead numbers threads with `node scripts/thread-ids.mjs <export folder>` (an export of `messages`, `threads` and `meta`), which writes the batches to send, the counter pinned with `if_version`. On the page, `#T27` in any message links to that thread, the owner can rename a thread, and a message naming `#T27` tells the lead which threads to read first.

`gate/after.mjs` runs after a board write the board applied, and records what the gate must remember from it: the thread counter's `next`, so "never back" follows what the board holds (a refused batch can be sent again).

`gate/stop.mjs` keeps the lead from ending a turn that states a verdict (`gate.verdictWords`) without a board write, or that answers the owner's thread message without writing in that thread.

Install the hooks with `node scripts/hooks.mjs <board.config.json> --pin <signed commit>`: a dry run that prints what it would change. Add `--write` to change `~/.claude/settings.json` (keeping a copy) and `--retire <text>` to remove an older gate's hook in the same write. The hooks run a copy of that one commit, exported to `~/.flight-board/install/<sha>`, never this checkout; upgrading means installing a newer signed commit. "Signed" is the owner's choice of commit: the script checks no sign-off note. The pinned copy guards against work in progress, not against anyone who can act as the owner's user. It changes Claude Code's settings: the owner runs it, or says yes to it themselves; no agent approves it for them.

The gate is a process guard: on its own error (a config it can't read, a call it can't parse) it lets the write through with a note; a rule it applies refuses.

## The collector

The board shows what the repository says, not only what someone wrote. For each open card, `collector/collect.mjs` finds its commit: a branch head carrying a `Board-Id: <id>` trailer, a branch named for the card, or a release commit on the main branch that names the branch it shipped (`collector.shippedPattern`). It then reads:

- the sign-off notes on that commit (`collector.notes`: a review phase and its notes ref);
- whether the main branch contains it, and the version it shipped in (`collector.versionPattern`);
- whether a successful deploy run (`collector.deployWorkflow`) contains it.

From those it works out the card's phase: build, then each review not yet signed, then ship, then live. A head is READY when it carries the card's `Board-Id`, or, until every team does, when any reviewer has signed it. A card given up closes as `"dropped"` with a `dropReason`. It writes everything to one document, `derived/all`. The page shows "Repository: <phase> <version>" on each card, in red when the card says otherwise, and the gate checks phase moves, one card per role and phase, and done-only-when-closed against it.

Sign-off notes are fetched into `refs/notes/flight-board/`, so the team's own notes refs are never overwritten. Point `collector.repoPath` at a clone of its own, not at a checkout someone works in. `collector.outDir` is where the collector writes its one output, `derived-all.json` (default `<gate.stateDir>/<board id>/out`); the scheduled run sets it to a folder outside the state folder, which its settings deny to Read whole (`collector/TASK.md`).

The nudges (`collector/nudges.mjs`, settings under `nudges` in the config) come out of the same run as `NUDGE` lines: the owner waiting for an answer, a step open past its card size's median, an old memory reading, a card unchanged for a day. Each is sent once, then again only after a quiet period.

**Keep `~/.flight-board` private.** The gate's state (`gate.json`) holds the text of recent board writes, messages included, and the mirror holds a copy of the board. Leave that folder out of any backup that leaves the machine, any sync folder and any export.

Each run is a scheduled Claude session following `collector/TASK.md`; only a Claude session can write the board.

**Every READY commit carries a `Board-Id: <card id>` trailer** from now on, so the collector finds the work even when the branch has another name.
