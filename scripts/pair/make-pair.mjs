// Makes a deploy and tree pair (#C734) from scripts/pair/deploy.template.mjs and tree.template.mjs, so the forward-only rule is the same in
// every pair and reviewed once. Usage:
//   node scripts/pair/make-pair.mjs --name pc10 --card "#C731" --what "B4b part 3" --signed <40-hex sha on main> \
//        --deploy-ok "one sentence after DEPLOY OK" --tree-ok "a few words after TREE OK" --out <the owner's board folder>
// It writes board-store-deploy-<name>.mjs and board-store-tree-<name>.mjs and prints each file's sha256 (the Security-signed pair is the
// hashed one). The values are put into string literals and comments, so each is refused if it is not printable ASCII (a control character, U+2028 and U+2029 included) or holds a quote, a backslash, a backtick, a $ or "@@".
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Printable ASCII only: a control character, and above all U+2028 / U+2029 (they end a // comment line in JS and put live code after it,
// invisible in a diff), never reach a generated file whose hash Security pins.
// #C1014: the card list of a pair that carries many cards may be longer than a sentence: up to CARD_MAX, never cut (a cut list drops cards from the owner's pack).
export const CARD_MAX = 1000;
const plain = (v, max = 300) => typeof v === "string" && v.length > 0 && v.length <= max && /^[\x20-\x7e]+$/.test(v) && !/["\\`$]|@@/.test(v);

export function makePair({ name, card, what, signed, deployOk, treeOk }) {
  if (!/^[a-z0-9]{2,12}$/.test(String(name))) throw new Error("name: letters and digits, 2 to 12");
  if (!/^[0-9a-f]{40}$/.test(String(signed))) throw new Error("signed: a full 40-hex sha");
  for (const [k, v] of Object.entries({ card, what, deployOk, treeOk })) if (!plain(v, k === "card" ? CARD_MAX : 300)) throw new Error(`${k}: a short plain sentence (no quotes, backslashes, newlines, $ or @@${k === "card" ? `; at most ${CARD_MAX} characters` : ""})`);
  const file = { deploy: `board-store-deploy-${name}.mjs`, tree: `board-store-tree-${name}.mjs` }, from = `board-store-tree-${name}.from`;
  const fill = (text, extra) => Object.entries({ CARD: card, WHAT: what, SIGNED: signed, SHORT: signed.slice(0, 8), FROM: from, DEPLOYDONE: `board-store-deploy-${name}.done`, ...extra }).reduce((t, [k, v]) => t.split(`@@${k}@@`).join(v), text);
  const deploy = fill(readFileSync(join(HERE, "deploy.template.mjs"), "utf8"), { SUCCESS: deployOk, FILE: file.deploy });
  const tree = fill(readFileSync(join(HERE, "tree.template.mjs"), "utf8"), { SUCCESS: treeOk, FILE: file.tree });
  if ((deploy + tree).split("@@GUARD-START@@").join("").split("@@GUARD-END@@").join("").includes("@@")) throw new Error("a placeholder was left");
  return { [file.deploy]: deploy, [file.tree]: tree };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, all) => (v.startsWith("--") ? [...acc, [v.slice(2), all[i + 1]]] : acc), []));
  if (typeof a.out !== "string" || !a.out) throw new Error("--out <folder> is required: the folder the owner runs the files from");
  const out = a.out;
  const files = makePair({ name: a.name, card: a.card, what: a.what, signed: a.signed, deployOk: a["deploy-ok"], treeOk: a["tree-ok"] });
  for (const [f, text] of Object.entries(files)) { writeFileSync(join(out, f), text); console.log(`${createHash("sha256").update(text).digest("hex")}  ${join(out, f)}`); }
}
