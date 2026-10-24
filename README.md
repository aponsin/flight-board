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

Coming next, one step at a time: the write gate (rules checked before a write reaches the board), the collector (each item's phase worked out from the repository and its review notes), and the nudges (timers that remind the lead agent).

## Set up a team

1. Write your `board.config.json` somewhere outside this repository, starting from `board.config.example.json`. The fields: `title`, `owner` (the person the board works for, as they sign), `artifactUrl`, `phases` (`[key, label]` in order), `roster` and `order` (the roles shown), `skips` (a phase only at a level, or skipped when an item field is false), `boardStart`, and the usage labels.
2. Write a private word list outside this repository: one word or name per line that must never appear here (the business's name, its people, its customers, its domain).
3. Run `node scripts/install.mjs <board.config.json> <words.txt>`. It checks the config, turns on the pre-push scan with your list, and builds `dist/board.html`.

## Publish the page

Ask your lead agent to publish `dist/board.html` with its Artifact tool: a new artifact the first time (put its link in `artifactUrl`), the same link afterwards. The page needs the `db`, `comments` and `assets` capabilities. Run `npm test` before every publish.

## Threads

Every item is a thread. The `messages` collection holds `{thread, from, text, at, assets?, kind?, resolved?}`: `thread` is the item's id, or `t-<time>` for a thread the owner started from the "Start a thread" box (`kind` question or idea). A thread is open while its newest message is the owner's. The lead agent answers with a message (`from` its role), and closes a started thread with `resolved: true`.

Each message from the owner pings the lead agent as a comment that reads exactly `Board thread [<thread>]: <owner>: <text>`. With `meta/board` `{ "wake": "batch" }` the page only saves, and the lead agent checks the open threads on its own schedule.

## Tests

`npm test` runs every rule's test. Each rule also had a mutation check: break the rule on purpose, a test must fail, restore.
