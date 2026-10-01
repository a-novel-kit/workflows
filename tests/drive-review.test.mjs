import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Failure } from "../node-actions/test-playwright/drive/common.mjs";
import { captureReview, REVIEW_FILE } from "../node-actions/test-playwright/drive/review.mjs";
import { workspace } from "./helpers.mjs";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64"
);

async function setup(t) {
  const work = workspace(t),
    previous = process.cwd();
  process.chdir(work.cwd);
  t.after(() => process.chdir(previous));
  await mkdir("test-results", { recursive: true });
  await writeFile("test-results/old.png", png);
  await writeFile("test-results/new.png", png);
  return work;
}
function report(images, drift = true) {
  return {
    tests: [
      { title: 'desktop | <img src=x onerror="alert(1)">', comparisons: [{ name: "login & form", images, drift }] },
    ],
  };
}

test("drift review embeds native PNGs and escapes untrusted test labels", async (t) => {
  await setup(t);
  assert.equal(
    await captureReview(
      report({ expected: "test-results/old.png", actual: "test-results/new.png", diff: "test-results/new.png" })
    ),
    true
  );
  const html = await readFile(REVIEW_FILE, "utf8");
  assert.equal([...html.matchAll(/src="data:image\/png;base64,([^"]+)"/g)].length, 3);
  for (const match of html.matchAll(/src="data:image\/png;base64,([^"]+)"/g))
    assert.deepEqual(Buffer.from(match[1], "base64"), png);
  assert.ok(!html.includes("<img src=x"));
  assert.match(html, /&#60;img src=x onerror=&#34;alert\(1\)&#34;&#62;/);
  assert.match(html, /login &#38; form/);
  assert.match(html, /default-src 'none'/);
});

test("new screenshots, unchanged runs and capture failures remove stale drift artifacts", async (t) => {
  await setup(t);
  await mkdir(".visual/snapshots", { recursive: true });
  await writeFile(".visual/snapshots/added.png", png);
  for (const [results, additions] of [
    [{ tests: [] }, []],
    [report({ expected: ".visual/snapshots/added.png", actual: "test-results/new.png" }, false), ["added.png"]],
    [report({ actual: "test-results/new.png" }, false), []],
  ]) {
    await captureReview(report({ expected: "test-results/old.png", actual: "test-results/new.png" }));
    assert.equal(await captureReview(results, [], additions), false);
    assert.equal(existsSync(REVIEW_FILE), false);
  }
});

test("removed screenshots show their original image and the missing new side", async (t) => {
  await setup(t);
  await mkdir(".visual/snapshots", { recursive: true });
  await writeFile(".visual/snapshots/removed.png", png);
  assert.equal(await captureReview({ tests: [] }, ["removed.png"]), true);
  const html = await readFile(REVIEW_FILE, "utf8");
  assert.match(html, /Removed screenshot \/ removed.png/);
  assert.match(html, /<figcaption>New<\/figcaption><p>Removed<\/p>/);
  assert.equal([...html.matchAll(/data:image\/png/g)].length, 1);
});

test("review paths reject symlinks, traversal, foreign files and disguised non-PNG content", async (t) => {
  const work = await setup(t);
  await writeFile("secret.png", png);
  await writeFile("test-results/disguised.png", "private token");
  await symlink(join(work.cwd, "secret.png"), "test-results/link.png");
  await symlink(join(work.cwd, "test-results/old.png"), "test-results/internal-link.png");
  for (const path of [
    "test-results/../secret.png",
    "test-results/link.png",
    "test-results/internal-link.png",
    "test-results/disguised.png",
  ])
    await assert.rejects(captureReview(report({ expected: path, actual: "test-results/new.png" })), Failure);
});
