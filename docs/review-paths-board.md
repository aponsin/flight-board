# The board's own repository: which paths need Security's review (#C1108)

The rule "a board or tooling card is Quick unless it touches the Worker, the hooks, permissions or the Mac" is a table, not a memory. The mechanism is the one of #C897
(`collector/review-paths.mjs`): the repository's `reviewPaths` maps a review phase to path patterns, and a card whose branch changed one of them has that review, whatever level
it was typed at. It only raises: a Full card stays Full, a Quick card that touches none of these keeps the typed rule.

The owner's config carries the table on the board repository's entry, `collector.repos[]` for `flight-board`, beside its `notes`:

```json
{ "security": ["worker/**", "gate/**", "hooks/**", "keeper/**", "scripts/hooks.mjs", "scripts/hooks-check.mjs", "scripts/install.mjs", "scripts/state-install.mjs", "scripts/make-pair.mjs", "scripts/pack-lint.mjs", "scripts/self-deploy-*.mjs", "scripts/board-land.mjs", "scripts/board-release.mjs", "scripts/push-keys.mjs", "scripts/put-file.mjs", "scripts/scan.mjs", "scripts/trailer-check.mjs", "wrangler.jsonc", "wrangler.toml", ".github/**", ".claude/**", "*.plist", "**/*.plist", "**/settings*.json", "package.json", "package-lock.json"] }
```

`tests/review-level-from-paths-board.test.mjs` holds this list against the engine and checks that this block and the test's list are the same. A change to `reviewPaths` takes effect only
when the commit that makes it is signed (#C974), so a card cannot drop its own review by editing the table.
