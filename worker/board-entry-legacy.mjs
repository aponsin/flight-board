// The deployed entry that serves the OLD board page (#C723 A1): board-entry.mjs plus the built page. The page is generated from the
// team's config by `node scripts/build-legacy.mjs <board.config.json>` (git-ignored), so this entry exists apart: deploy it with
// `npx wrangler deploy worker/board-entry-legacy.mjs --config worker/wrangler.board.toml` after building. Nothing else differs.
import worker from "./board-worker.mjs";
import { authenticate } from "./access-auth.mjs";
import LEGACY_HTML from "./legacy-page.generated.mjs";

export default {
  fetch: (request, env, ctx) => worker.fetch(request, { ...env, LEGACY_HTML }, ctx, Date.now(), (r, e) => authenticate(r, e)),
};
