// Exercise the shipped runner and reporter against real Chromium screenshot comparisons.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
const root = resolve(import.meta.dirname, "..");
const runner = join(root, "node-actions/test-playwright/drive/runner.mjs");

test("native comparison, additions, approval and functional failure boundaries", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "drive-browser-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const script = `node ${root}/node_modules/playwright/cli.js test -c ${root}/tests/visual-fixture/playwright.config.mjs`;
  await writeFile(join(work, "package.json"), JSON.stringify({ private: true, scripts: { e2e: script } }));
  async function run(expected, values = {}, drift = false) {
    for (const name of await readdir(join(work, ".visual")).catch(() => []))
      if (name.startsWith("comparison")) await rm(join(work, ".visual", name), { recursive: true, force: true });
    await writeFile(join(work, "output"), "");
    const result = spawnSync(process.execPath, [runner, "e2e"], {
      cwd: work,
      env: {
        ...process.env,
        PLAYWRIGHT_VISUAL_REPORT: ".visual/results.json",
        GITHUB_SHA: "a".repeat(40),
        GITHUB_OUTPUT: join(work, "output"),
        ...values,
      },
      encoding: "utf8",
    });
    assert.equal(result.status === 0, expected, result.stdout + result.stderr);
    assert.equal(await readFile(join(work, "output"), "utf8"), `drift=${drift}\n`);
    assert.equal(existsSync(reviewPath), drift);
  }
  const snapshot = (name) => join(work, ".visual/snapshots/desktop", name);
  const reviewPath = join(work, ".visual/review/playwright-drift.html");
  const review = () => readFile(reviewPath, "utf8");
  const images = async () =>
    [...(await review()).matchAll(/src="data:image\/png;base64,([^"]+)"/g)].map((match) =>
      Buffer.from(match[1], "base64")
    );
  await run(true, { VISUAL_SEED: "true" });
  const original = await readFile(snapshot("one.png"));
  await run(true);
  await run(false, { PROBE_CHANGED: "true" }, true);
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
    await page.goto(pathToFileURL(reviewPath).href);
    assert.equal(await page.title(), "Screenshot drift");
    assert.equal(await page.locator("img").count(), 6);
    assert.equal(
      await page
        .locator("img")
        .evaluateAll((images) => images.every((image) => image.complete && image.naturalWidth === 80)),
      true
    );
    assert.equal(
      await page
        .locator(".images")
        .first()
        .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length),
      3
    );
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(
      await page
        .locator(".images")
        .first()
        .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length),
      1
    );
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
  await run(false, { PROBE_ADD: "true" }, true);
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
  await run(false, { PROBE_REMOVE: "true" }, true);
  assert.match(await review(), /Removed screenshot/);
  const removed = (await images())[0];
  await run(true, { PROBE_REMOVE: "true", VISUAL_APPROVED: "true" }, true);
  assert.deepEqual((await images())[0], removed);
  assert.equal(existsSync(snapshot("two.png")), false);
});
