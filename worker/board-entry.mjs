// The deployed entry (#C719): the board Worker with the real Cloudflare Access check as its identity. Bindings: DB (D1);
// secrets ACCESS_TEAM_DOMAIN, ACCESS_AUD, ROLES (JSON: who may be what); optional var BOARD_VERSION for the header.
import worker from "./board-worker.mjs";
import { authenticate } from "./access-auth.mjs";

export default {
  fetch: (request, env, ctx) => worker.fetch(request, env, ctx, Date.now(), (r, e) => authenticate(r, e)),
};
