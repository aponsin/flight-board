// #C900 (stacks-json-product-row, the board half of #C860): the probe writes the product's stack switch to a fixed file the product's release tool reads.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productSwitchOn, writeProductSwitch, prepareStoreState } from "../collector/store-cards.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "stack-switch-file-"));
const card = { id: "card-a", num: 5, title: "A card", owner_role: "Builder", paused: 0, dropped: 0, created_at: 10, updated_at: 20 };
const viewWith = (stackSwitch) => async () => ({ ok: true, status: 200, json: async () => ({ cards: [card], stackSwitch }) });
const mode = (f) => statSync(f).mode & 0o777;

// A real prepareStoreState run in a scratch folder: returns where the switch file went.
async function run(stackSwitch, extra = {}) {
  const real = tmp(), priv = tmp(), out = join(tmp(), "dot-flight-board", "stack-switch.json");
  mkdirSync(join(real, "AbCdEf123456"), { recursive: true });
  const cfg = join(real, "board.config.json");
  writeFileSync(cfg, JSON.stringify({ gate: { stateDir: "~/.flight-board" }, collector: { liveUrl: "https://live.test/" } }));
  await prepareStoreState({ privateDir: priv, stateFile: join(real, "AbCdEf123456", "state.json"), configPath: cfg, base: "https://x.test", headers: {}, fetchImpl: viewWith(stackSwitch), now: 1234567, switchFile: out, ...extra });
  return out;
}

test("the product's row decides the key: on writes true, off writes false, no row writes false; the board's row does not count", async () => {
  assert.deepEqual(JSON.parse(readFileSync(await run([{ repo: "product", stack: true }, { repo: "board", stack: false }]), "utf8")), { at: 1234567, product: true });
  assert.deepEqual(JSON.parse(readFileSync(await run([{ repo: "product", stack: false }, { repo: "board", stack: true }]), "utf8")), { at: 1234567, product: false });
  assert.deepEqual(JSON.parse(readFileSync(await run([]), "utf8")), { at: 1234567, product: false }, "a view with no row reads as off");
  assert.equal(productSwitchOn([{ repo: "product", stack: 1 }]), true);
  assert.equal(productSwitchOn([{ repo: "product", stack: "yes" }]), false, "only true or 1");
  assert.equal(productSwitchOn(undefined), false);
});

test("the file is written whole under a temporary name and renamed, mode 600, whatever the temporary file held before", () => {
  const dir = join(tmp(), "d"), file = join(dir, "stack-switch.json");
  writeProductSwitch({ file, at: 1, product: true });
  assert.equal(mode(file), 0o600);
  assert.deepEqual(readdirSync(dir), ["stack-switch.json"], "no temporary file is left behind");
  writeFileSync(`${file}.tmp`, "half a file", { mode: 0o644 }); // a crash left a loose temporary file
  writeProductSwitch({ file, at: 2, product: false });
  assert.equal(mode(file), 0o600, "a leftover temporary file's mode does not carry over");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { at: 2, product: false });
  assert.deepEqual(readdirSync(dir), ["stack-switch.json"]);
  writeProductSwitch({ file, at: 3, product: "true" });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).product, false, "only a real true writes true");
});

test("a failed write of the switch file never stops the evidence run, and says so in the log; no path asked for, no file written", async () => {
  const logged = [];
  const blocked = join(tmp(), "a-file");
  writeFileSync(blocked, "x"); // a file where the folder should be
  await run([{ repo: "product", stack: true }], { switchFile: join(blocked, "stack-switch.json"), log: (m) => logged.push(m) });
  assert.ok(logged.some((m) => /stack-switch\.json not written/.test(m)), logged.join(" | "));
  const none = tmp();
  await run([{ repo: "product", stack: true }], { switchFile: null });
  assert.equal(existsSync(join(none, "stack-switch.json")), false);
});
