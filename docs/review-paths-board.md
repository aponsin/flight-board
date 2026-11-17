# The board's own repository: which paths need Security's review (#C1108)

The rule "a board or tooling card is Quick unless it touches the Worker, the hooks, permissions or the Mac" is a table, not a memory. The mechanism is the one of #C897
(`collector/review-paths.mjs`): the repository's `reviewPaths` maps a review phase to path patterns, and a card whose branch changed one of them has that review, whatever level
it was typed at. It only raises: a Full card stays Full, a Quick card that touches none of these keeps the typed rule.

The owner's config carries the table on the board repository's entry, `collector.repos[]` for `flight-board`, beside its `notes`:

```json
{ "security": ["worker/**", "gate/**", "hooks/**", "keeper/**", ".githooks/**", ".github/**", ".claude/**", "scripts/hooks.mjs", "scripts/hooks-check.mjs", "scripts/install.mjs", "scripts/state-install.mjs", "scripts/make-pair.mjs", "scripts/pack-lint.mjs", "scripts/pair/**", "scripts/current.mjs", "scripts/self-deploy-*.mjs", "scripts/board-land.mjs", "scripts/board-release.mjs", "scripts/board-recut.mjs", "scripts/push-keys.mjs", "scripts/put-file.mjs", "scripts/scan.mjs", "scripts/trailer-check.mjs", "scripts/stack-ready.mjs", "scripts/sign-note.mjs", "scripts/approvals-check.mjs", "scripts/config.mjs", "collector/review-paths.mjs", "scripts/wake-watch.mjs", "scripts/prompt-watch.mjs", "scripts/pickup-watch.mjs", "scripts/restart-check.mjs", "scripts/restart-ready.mjs", "page/**", "scripts/build-page.mjs", "scripts/build-store-page.mjs", "wrangler.jsonc", "wrangler.toml", "*.plist", "**/*.plist", "**/settings*.json", "package.json", "package-lock.json"] }
```

Left out on purpose, until the owner decides on the board: `collector/**` as a whole (only `collector/review-paths.mjs`, the engine that decides who reviews, is listed) stays Quick. Two
breadth calls are Security's asks and the owner's to prune: `page/**` (the page renders agent text) and the scripts a model acts on (the watches and restart checks).

The level a card shows reads Full whenever Security's review is in play on it (waiting, or signed), whatever was typed (`shownLevel` in `worker/compat-view.mjs`); the typed value is never rewritten.

`tests/review-level-from-paths-board.test.mjs` holds this list against the engine and checks that this block and the test's list are the same. A change to `reviewPaths` takes effect only
when the commit that makes it is signed (#C974), so a card cannot drop its own review by editing the table.
