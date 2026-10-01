import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Failure } from "../node-actions/test-playwright/drive/common.mjs";
import { captureReview, REVIEW_PROTOCOL, uploadReview } from "../node-actions/test-playwright/drive/review.mjs";
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
function report(images, title = "desktop | <img src=x> [link](evil)") {
  return { tests: [{ title, comparisons: [{ name: "login", images }] }] };
}
const batch = { id: "batch-id", properties: { run_number: "12", run_id: "34", attempt: "2", sha: "head" } };

test("review links group private image uploads by test and bind them to the result batch", async (t) => {
  const work = await setup(t);
  await captureReview(report({ expected: "test-results/old.png", actual: "test-results/new.png" }));
  const uploads = [];
  const drive = {
    upload: async (folder, path, props, identity, options) => {
      assert.equal(folder, "platform-results");
      assert.deepEqual(await readFile(path), png);
      assert.equal(props.batch_id, batch.id);
      assert.equal(props.sha, "head");
      assert.equal(options.mimeType, "image/png");
      assert.equal(options.protocol, REVIEW_PROTOCOL);
      assert.ok(identity.startsWith(work.cwd));
      uploads.push(options.name);
      return { id: `image-${uploads.length}` };
    },
  };
  const summary = await uploadReview(drive, "platform-results", batch, work.cwd);
  assert.deepEqual(uploads, ["playwright-12-2-1-expected.png", "playwright-12-2-1-actual.png"]);
  assert.match(summary, /\[Old\]\(https:\/\/drive.google.com\/file\/d\/image-1\/view\)/);
  assert.match(summary, /\[New\]\(https:\/\/drive.google.com\/file\/d\/image-2\/view\)/);
  assert.ok(!summary.includes("<img"));
  assert.ok(!summary.includes("[link]"));
  assert.match(summary, /&#124;/);
  assert.match(summary, /existing Drive access/);
});

test("missing sides identify added and removed screenshots without fabricated links", async (t) => {
  const work = await setup(t);
  await mkdir(".visual/snapshots", { recursive: true });
  await writeFile(".visual/snapshots/removed.png", png);
  await captureReview(report({ actual: "test-results/new.png" }), ["removed.png"]);
  const summary = await uploadReview({ upload: async () => ({ id: "image" }) }, "results", batch, work.cwd);
  assert.match(summary, /No baseline \| \[New\]/);
  assert.match(summary, /removed.png \| \[Old\].* \| Removed \| —/);
});

test("unchanged comparisons upload no extra files and upload failures remain failures", async (t) => {
  const work = await setup(t);
  const drive = {
    upload: async () => {
      throw new Failure("upload failed");
    },
  };
  await captureReview({ tests: [] });
  assert.match(await uploadReview(drive, "results", batch, work.cwd), /No screenshot differences/);
  await captureReview(report({ actual: "test-results/new.png" }));
  await assert.rejects(uploadReview(drive, "results", batch, work.cwd), /upload failed/);
});

test("review paths reject symlinks, traversal, foreign files and disguised non-PNG content", async (t) => {
  const work = await setup(t);
  await writeFile("secret.png", png);
  await writeFile("test-results/disguised.png", "private token");
  await symlink(join(work.cwd, "secret.png"), "test-results/link.png");
  for (const path of ["test-results/../secret.png", "test-results/link.png", "test-results/disguised.png"])
    await assert.rejects(captureReview(report({ actual: path })), Failure);
  await captureReview(report({ actual: "test-results/new.png" }));
  await writeFile(
    ".visual/review/manifest.json",
    JSON.stringify([{ title: "unsafe", images: { actual: "../../secret.png" } }])
  );
  await assert.rejects(uploadReview({}, "results", batch, work.cwd), Failure);
  await rm(".visual/review", { recursive: true });
  await symlink(join(work.cwd, "test-results"), ".visual/review");
  await writeFile(
    "test-results/manifest.json",
    JSON.stringify([{ title: "unsafe", images: { actual: "1-actual.png" } }])
  );
  await writeFile("test-results/1-actual.png", png);
  await assert.rejects(uploadReview({}, "results", batch, work.cwd), Failure);
});
