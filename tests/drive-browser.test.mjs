// Exercise the shipped runner and reporters against real Chromium screenshot comparisons.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
const root = resolve(import.meta.dirname, "..");
const runner = join(root, "node-actions/test-playwright/drive/runner.mjs");

/** A workspace whose package script runs the screenshot tests, and the runner and review helpers over it. */
async function workspace(t, script, env = {}) {
  const work = await mkdtemp(join(tmpdir(), "drive-browser-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  await writeFile(join(work, "package.json"), JSON.stringify({ private: true, scripts: { visual: script } }));
  const reviewPath = join(work, ".visual/review/playwright-drift.html");
  const review = () => readFile(reviewPath, "utf8");
  async function run(expected, values = {}, drift = false, approval = false) {
    for (const name of await readdir(join(work, ".visual")).catch(() => []))
      if (name.startsWith("comparison")) await rm(join(work, ".visual", name), { recursive: true, force: true });
    await writeFile(join(work, "output"), "");
    const result = spawnSync(process.execPath, [runner, "visual"], {
      cwd: work,
      env: {
        ...process.env,
        PLAYWRIGHT_VISUAL_REPORT: ".visual/results.json",
        GITHUB_SHA: "a".repeat(40),
        GITHUB_OUTPUT: join(work, "output"),
        ...env,
        ...values,
      },
      encoding: "utf8",
    });
    assert.equal(result.status === 0, expected, result.stdout + result.stderr);
    assert.equal(
      await readFile(join(work, "output"), "utf8"),
      `drift=${drift}\n${approval ? "approval=required\n" : ""}`
    );
    assert.equal(existsSync(reviewPath), drift);
  }
  return {
    work,
    run,
    review,
    reviewPath,
    snapshot: (name) => join(work, ".visual/snapshots/desktop", name),
    images: async () =>
      [...(await review()).matchAll(/src="data:image\/png;base64,([^"]+)"/g)].map((match) =>
        Buffer.from(match[1], "base64")
      ),
  };
}

test("native comparison, additions, approval and functional failure boundaries", async (t) => {
  const script = `node ${root}/node_modules/playwright/cli.js test -c ${root}/tests/visual-fixture/playwright.config.mjs`;
  const { work, run, review, reviewPath, snapshot, images } = await workspace(t, script);
  await run(true, { VISUAL_SEED: "true" });
  const original = await readFile(snapshot("one.png"));
  await run(true);
  await run(false, { PROBE_CHANGED: "true" }, true, true);
  assert.deepEqual(await readFile(snapshot("one.png")), original);
  const differences = await images();
  assert.equal(differences.length, 6);
  assert.deepEqual(differences[0], original);
  const actual = differences[1];
  assert.notDeepEqual(actual, original);
  assert.notDeepEqual(differences[2], actual);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const loaded = (images) => images.every((image) => image.complete && image.naturalWidth === 80);
    const columns = () =>
      page
        .locator(".images")
        .first()
        .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
    await page.goto(pathToFileURL(reviewPath).href);
    assert.equal(await page.title(), "Screenshot drift");
    assert.equal(await page.locator("img").count(), 6);
    assert.equal(await page.locator("img").evaluateAll(loaded), true);
    assert.equal(await columns(), 3);
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await columns(), 1);
  } finally {
    await browser.close();
  }
  await run(true, { PROBE_CHANGED: "true", VISUAL_APPROVED: "true" }, true);
  assert.deepEqual((await images())[0], original);
  assert.deepEqual((await images())[1], actual);
  const changed = await readFile(snapshot("one.png"));
  assert.notDeepEqual(changed, original);
  await run(false, { PROBE_CHANGED: "true", PROBE_FUNCTIONAL_FAILURE: "true", VISUAL_APPROVED: "true" });
  assert.deepEqual(await readFile(snapshot("one.png")), changed);
  await run(false, { PROBE_CAPTURE_FAILURE: "true", VISUAL_APPROVED: "true" });
  await run(false, { PROBE_CAPTURE_ONCE: "true", VISUAL_APPROVED: "true" });
  assert.deepEqual(await readFile(snapshot("one.png")), changed);
  await run(true, { PROBE_CHANGED: "true", PROBE_ADD: "true" });
  assert.deepEqual(await readFile(snapshot("one.png")), changed);
  assert.ok(existsSync(snapshot("three.png")));
  assert.equal(JSON.parse(await readFile(join(work, ".visual/verdict.json"))).changed, false);
  const report = JSON.parse(await readFile(join(work, ".visual/results.json")));
  assert.ok(report.tests.every((test) => test.status === "passed" && !test.errors.length));
  await rm(snapshot("three.png"));
  await run(false, { PROBE_ADD: "true" }, true, true);
  assert.equal((await images()).length, 6);
  assert.ok(!(await review()).includes("three"));
  await rm(snapshot("three.png"));
  await run(false, {
    PROBE_CHANGED: "true",
    PROBE_ADD: "true",
    PROBE_FUNCTIONAL_FAILURE: "true",
    VISUAL_APPROVED: "true",
  });
  await rm(join(work, ".visual"), { recursive: true, force: true });
  await run(true, { VISUAL_SEED: "true" });
  await run(false, { PROBE_REMOVE: "true" }, true, true);
  assert.match(await review(), /Removed screenshot/);
  const removed = (await images())[0];
  await run(true, { PROBE_REMOVE: "true", VISUAL_APPROVED: "true" }, true);
  assert.deepEqual((await images())[0], removed);
  assert.equal(existsSync(snapshot("two.png")), false);
});

test("Vitest comparisons keep the same approval and inventory boundaries", async (t) => {
  const script = `node ${root}/node_modules/vitest/vitest.mjs run`;
  const env = { VISUAL_RUNNER: "vitest", PLAYWRIGHT_SNAPSHOT_DIR: ".visual/snapshots" };
  const { work, run, review, snapshot, images } = await workspace(t, script, env);
  // A Vitest project resolves its imports and serves its files from its own root, as a consumer's does.
  for (const name of ["vitest.config.mjs", "probe.test.mjs"])
    await copyFile(join(root, "tests/visual-fixture-vitest", name), join(work, name));
  await symlink(join(root, "node_modules"), join(work, "node_modules"));
  await run(true, { VISUAL_SEED: "true" });
  const original = await readFile(snapshot("one.png"));
  await run(true);
  const report = JSON.parse(await readFile(join(work, ".visual/results.json")));
  assert.deepEqual(report.tests[0].snapshots, ["desktop/one.png", "desktop/two.png"]);
  await run(false, { PROBE_CHANGED: "true" }, true, true);
  assert.deepEqual(await readFile(snapshot("one.png")), original);
  assert.equal((await images()).length, 6);
  assert.deepEqual((await images())[0], original);
  assert.match(await review(), /captures complete stable screenshots \/ desktop\/one\.png/);
  await run(true, { PROBE_CHANGED: "true", VISUAL_APPROVED: "true" }, true);
  const changed = await readFile(snapshot("one.png"));
  assert.notDeepEqual(changed, original);
  await run(false, { PROBE_FUNCTIONAL_FAILURE: "true", VISUAL_APPROVED: "true" }, true);
  await run(false, { PROBE_CHANGED: "true", PROBE_UNSTABLE: "true", VISUAL_APPROVED: "true" });
  assert.deepEqual(await readFile(snapshot("one.png")), changed);
  await run(false, { PROBE_CHANGED: "true", PROBE_UNDECLARED: "true" });
  await rm(snapshot("four.png"));
  await run(true, { PROBE_CHANGED: "true", PROBE_ADD: "true" });
  assert.ok(existsSync(snapshot("three.png")));
  assert.equal(JSON.parse(await readFile(join(work, ".visual/verdict.json"))).changed, false);
  await run(false, { PROBE_CHANGED: "true", PROBE_REMOVE: "true" }, true, true);
  assert.match(await review(), /Removed screenshot/);
  await run(true, { PROBE_CHANGED: "true", PROBE_REMOVE: "true", VISUAL_APPROVED: "true" }, true);
  assert.equal(existsSync(snapshot("two.png")), false);
  await run(false, { PROBE_INCOMPLETE: "true" });
});
