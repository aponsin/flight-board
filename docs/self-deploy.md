# The board Worker deploys itself from a signed main (#C968)

The design is Security's (the note `c968-credential-design.md`, in the owner's shared folder); the owner chose one Cloudflare account (B, #T1837) and the change itself on #T1779. This file says what the code does and what the owner sets up once, in the Cloudflare dashboard. Nothing here has been run against the live dashboard: **the lead checks each dashboard click below against the live page before posting it** (Cloudflare's dashboard changes).

## What the code does
Cloudflare's own Git build (Workers Builds) runs on every push to `main`. Its build command is, in this order:

```
[ "$(sha256sum scripts/self-deploy-gate.mjs | cut -c1-64)" = <the gate's sha256, typed by the owner> ] && node scripts/self-deploy-gate.mjs && node scripts/self-deploy-run.mjs
```

1. **The hash check** runs first and lives only in the dashboard. A commit to `main` cannot weaken the gate: changing `scripts/self-deploy-gate.mjs` means the owner updates one hash in the dashboard (the build fails closed until then).
2. **`scripts/self-deploy-gate.mjs`** refuses (the build fails, nothing deployed, the reasons printed) unless: the build's commit is `main`'s tip; it carries a Security note starting `SECURE` and a Checker note starting `PASS` (git notes belong to the commit, so they name that exact sha); and the Worker's current `BUILD_SHA` (read from Cloudflare with the build's token) is an ancestor of it (forward only, like the pairs). A `BUILD_SHA` it cannot read refuses: a first deploy stays the owner's, by a pair. When the commit is the one already deployed it says so and exits 0.
3. **`scripts/self-deploy-run.mjs`** runs only behind the gate's marker (`.self-deploy-ok`, ignored by git), and does what the owner's pair does: builds the store page from the build variable `BOARD_CONFIG_JSON` (written to a temporary folder outside the repository), applies the D1 migrations, and deploys with `--var BUILD_SHA:<commit>`. Wrangler is pinned. It never prints the token, the account or the config.
4. **The Worker tells the owner's phone** `board deployed <7-character sha>` once per deployed commit (`worker/push-rules.mjs`, from its own `BUILD_SHA`, through the phone push of #C904): a deploy he did not start is seen within minutes.

## What the owner sets up once (an install ask, not a chat line)
1. **Connect the Worker to the repository** in the dashboard (Workers & Pages, the board Worker, Settings, Builds): the Cloudflare GitHub app on `aponsin/flight-board` only, production branch `main` only, **preview builds off**.
2. **The deploy token.** Do NOT let Workers Builds create one (it carries Workers Routes: Edit on every zone, KV and R2). Make a custom user token under My Profile, API Tokens, for the board's account only: Account, Workers Scripts: Edit; Account, D1: Edit; Account, Account Settings: Read; **no zone permission, no KV, no R2**; an end date about six months out; no client IP filter (Cloudflare publishes no build IP ranges). Choose it in the build settings as an existing token. It can still replace any Worker and read or change any D1 database on that account (one-account trade-off, accepted on #T1837).
3. **Build variables and secrets:** `BOARD_CONFIG_JSON` (the board config, as one line of JSON; make it a secret if any of it is), and make sure the build sees `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. **Check live whether build secrets reach the build command as well as the deploy command**: the gate and the run script need them in the build command.
4. **The build command** is the line above, with the gate's sha256 typed in (`sha256sum scripts/self-deploy-gate.mjs` on a checkout of the signed commit; the lead posts it). **The deploy command must be changed** from the default `npx wrangler deploy` to a no-op such as `true`, so the build's own deploy cannot bypass the gate. Check live that the field accepts it.
5. **Cut-over, after the first self-deploy works:** delete `board.private.json` and run `npx wrangler logout` on the Mac, so no deploy-capable credential is left where agents work. Rollback then moves to the dashboard (Deployments, roll back), which the owner does himself; the pairs' rollback line stops working and the pair files stop being needed.

## What this changes in trust (said once)
Today a deploy needs the owner to run a pair whose hashes Security signs out of band. After this it needs a push to `main` plus two notes, and agents can push both, so a confused or rogue agent could deploy unreviewed Worker code. It still cannot read the token. The phone push is how the owner would notice.
