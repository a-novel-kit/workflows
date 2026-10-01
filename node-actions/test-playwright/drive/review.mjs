// Preserve native comparison images for private, directly viewable Drive review links.
import { copyFile, lstat, mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Failure } from "./common.mjs";

export const REVIEW_PROTOCOL = "playwright-review-v1";
const DIRECTORY = ".visual/review";
const ROLES = ["expected", "actual", "diff"];

async function png(path, roots) {
  const resolved = await realpath(path);
  if (
    !(await lstat(path)).isFile() ||
    !roots.some((root) => {
      const child = relative(resolve(root), resolved);
      return child && !child.startsWith("..") && !isAbsolute(child);
    })
  )
    throw new Failure("Review image is outside the declared screenshot directories");
  const file = await open(resolved, "r");
  try {
    const header = Buffer.alloc(8);
    await file.read(header, 0, 8, 0);
    if (!header.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new Failure("Review attachment is not a PNG image");
  } finally {
    await file.close();
  }
  return resolved;
}

/** Save comparison evidence before approved regeneration replaces test output and baselines. */
export async function captureReview(report, removed = [], added = []) {
  await rm(DIRECTORY, { recursive: true, force: true });
  await mkdir(DIRECTORY, { recursive: true });
  const entries = [];
  async function add(title, name, images, removed = false) {
    const entry = { title, name, removed, images: {} };
    for (const role of ROLES) {
      if (!images[role]) continue;
      const source = await png(images[role], ["test-results", ".visual/snapshots"]);
      const filename = `${entries.length + 1}-${role}.png`;
      await copyFile(source, join(DIRECTORY, filename));
      entry.images[role] = filename;
    }
    entries.push(entry);
  }
  const newPaths = new Set(added.map((name) => resolve(".visual/snapshots", name)));
  for (const test of report.tests ?? [])
    for (const comparison of test.comparisons ?? []) {
      const images = { ...comparison.images };
      // Playwright attaches newly written baselines as "expected" too; they have no old side.
      if (images.expected && newPaths.has(resolve(images.expected))) delete images.expected;
      await add(test.title, comparison.name, images);
    }
  for (const name of removed)
    await add("Removed screenshot", name, { expected: join(".visual/snapshots", name) }, true);
  await writeFile(join(DIRECTORY, "manifest.json"), JSON.stringify(entries));
}

function escape(text) {
  return String(text).replace(/[&<>\[\]`|\\\r\n]/g, (character) => `&#${character.charCodeAt(0)};`);
}

/** Upload review PNGs with their archive's provenance and return a Markdown review table. */
export async function uploadReview(drive, folder, batch, identityDirectory) {
  let entries;
  try {
    entries = JSON.parse(await readFile(join(DIRECTORY, "manifest.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return "\nNo screenshot comparison images were captured. See the batch diagnostics.\n";
    throw error;
  }
  if (!entries.length) return "\nNo screenshot differences were captured.\n";
  const rows = ["\n### Screenshot changes\n", "| Test / screenshot | Old | New | Diff |", "| --- | --- | --- | --- |"];
  for (const [index, entry] of entries.entries()) {
    const links = {};
    for (const role of ROLES) {
      const filename = entry.images[role];
      if (!filename) continue;
      if (!/^\d+-(expected|actual|diff)\.png$/.test(filename)) throw new Failure("Invalid review image filename");
      const source = await png(join(DIRECTORY, filename), [DIRECTORY]);
      const image = await drive.upload(
        folder,
        source,
        { ...batch.properties, batch_id: batch.id },
        join(identityDirectory, `review-${index}-${role}-id`),
        {
          protocol: REVIEW_PROTOCOL,
          name: `playwright-${batch.properties.run_number}-${batch.properties.attempt}-${index + 1}-${role}.png`,
          mimeType: "image/png",
        }
      );
      links[role] =
        `[${{ expected: "Old", actual: "New", diff: "Diff" }[role]}](https://drive.google.com/file/d/${image.id}/view)`;
    }
    rows.push(
      `| ${escape(entry.title)} / ${escape(entry.name)} | ${links.expected ?? "No baseline"} | ${links.actual ?? (entry.removed ? "Removed" : "Not captured")} | ${links.diff ?? "—"} |`
    );
  }
  rows.push(
    "\nImages require existing Drive access and expire when this batch is replaced or its branch is merged/deleted.\n"
  );
  return rows.join("\n");
}
