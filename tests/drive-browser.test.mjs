// Exercise the shipped runner and reporter against real Chromium screenshot comparisons.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
const root = resolve(import.meta.dirname, "..");
const runner = join(root, "node-actions/test-playwright/drive/runner.mjs");

test("native comparison, approval and functional failure boundaries", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "drive-browser-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const script = `node ${root}/node_modules/playwright/cli.js test -c ${root}/tests/visual-fixture/playwright.config.mjs`;
  await writeFile(join(work, "package.json"), JSON.stringify({ private: true, scripts: { e2e: script } }));
  async function run(expected, values = {}) {
    for (const name of await readdir(join(work, ".visual")).catch(() => []))
      if (name.startsWith("comparison")) await rm(join(work, ".visual", name), { recursive: true, force: true });
    const result = spawnSync(process.execPath, [runner, "e2e"], {
      cwd: work,
      env: { ...process.env, PLAYWRIGHT_VISUAL_REPORT: ".visual/results.json", GITHUB_SHA: "a".repeat(40), ...values },
      encoding: "utf8",
    });
    assert.equal(result.status === 0, expected, result.stdout + result.stderr);
  }
  const snapshot = (name) => join(work, ".visual/snapshots/desktop", name);
  const review = async () => JSON.parse(await readFile(join(work, ".visual/review/manifest.json"), "utf8"));
  const image = (name) => readFile(join(work, ".visual/review", name));
  await run(true, { VISUAL_SEED: "true" });
  const original = await readFile(snapshot("one.png"));
  await run(true);
  assert.deepEqual(await review(), []);
  await run(false, { PROBE_CHANGED: "true" });
  assert.deepEqual(await readFile(snapshot("one.png")), original);
  const differences = await review();
  assert.equal(differences.length, 2);
  assert.deepEqual(Object.keys(differences[0].images), ["expected", "actual", "diff"]);
  assert.deepEqual(await image(differences[0].images.expected), original);
  const actual = await image(differences[0].images.actual);
  assert.notDeepEqual(actual, original);
  assert.notDeepEqual(await image(differences[0].images.diff), actual);
  await run(true, { PROBE_CHANGED: "true", VISUAL_APPROVED: "true" });
  assert.deepEqual(await image((await review())[0].images.expected), original);
  assert.deepEqual(await image((await review())[0].images.actual), actual);
  const changed = await readFile(snapshot("one.png"));
  assert.notDeepEqual(changed, original);
  await run(false, { PROBE_CHANGED: "true", PROBE_FUNCTIONAL_FAILURE: "true", VISUAL_APPROVED: "true" });
  assert.deepEqual(await readFile(snapshot("one.png")), changed);
  await run(false, { PROBE_CAPTURE_FAILURE: "true", VISUAL_APPROVED: "true" });
  await run(false, { PROBE_CAPTURE_ONCE: "true", VISUAL_APPROVED: "true" });
  assert.deepEqual(await readFile(snapshot("one.png")), changed);
  await run(false, { PROBE_CHANGED: "true", PROBE_ADD: "true" });
  assert.deepEqual(Object.keys((await review())[0].images), ["actual"]);
  assert.deepEqual(await readFile(snapshot("one.png")), changed);
  await rm(snapshot("three.png"));
  await run(false, {
    PROBE_CHANGED: "true",
    PROBE_ADD: "true",
    PROBE_FUNCTIONAL_FAILURE: "true",
    VISUAL_APPROVED: "true",
  });
  await rm(snapshot("three.png"));
  await run(true, { PROBE_CHANGED: "true", PROBE_ADD: "true", VISUAL_APPROVED: "true" });
  assert.deepEqual(Object.keys((await review())[0].images), ["actual"]);
  assert.ok(existsSync(snapshot("three.png")));
  await rm(join(work, ".visual"), { recursive: true, force: true });
  await run(true, { VISUAL_SEED: "true" });
  await run(false, { PROBE_REMOVE: "true" });
  assert.equal((await review())[0].removed, true);
  const removed = await image((await review())[0].images.expected);
  await run(true, { PROBE_REMOVE: "true", VISUAL_APPROVED: "true" });
  assert.deepEqual(await image((await review())[0].images.expected), removed);
  assert.equal(existsSync(snapshot("two.png")), false);
});
