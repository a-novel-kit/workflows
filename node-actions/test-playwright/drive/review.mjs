// Preserve existing screenshot drift in one self-contained, directly viewable artifact.
import { appendFile, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Failure } from "./common.mjs";

const DIRECTORY = ".visual/review";
export const REVIEW_FILE = `${DIRECTORY}/playwright-drift.html`;
const ROLES = { expected: "Old", actual: "New", diff: "Diff" };

async function png(path) {
  const resolved = await realpath(path);
  if (
    !(await lstat(path)).isFile() ||
    !["test-results", ".visual/snapshots"].some((root) => {
      const child = relative(resolve(root), resolved);
      return child && !child.startsWith("..") && !isAbsolute(child);
    })
  )
    throw new Failure("Review image is outside the declared screenshot directories");
  const data = await readFile(resolved);
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Failure("Review attachment is not a PNG image");
  return data.toString("base64");
}

function escape(text) {
  return String(text).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

/** Capture only existing drift and removals, before approved regeneration replaces the evidence. */
export async function captureReview(report, removed = [], added = []) {
  await rm(DIRECTORY, { recursive: true, force: true });
  const newPaths = new Set(added.map((name) => resolve(".visual/snapshots", name)));
  const entries = [];
  for (const test of report.tests ?? [])
    for (const comparison of test.comparisons ?? [])
      if (comparison.drift && comparison.images.expected && !newPaths.has(resolve(comparison.images.expected)))
        entries.push({ title: test.title, ...comparison });
  for (const name of removed)
    entries.push({
      title: "Removed screenshot",
      name,
      images: { expected: join(".visual/snapshots", name) },
      removed: true,
    });
  if (!entries.length) return false;
  await mkdir(DIRECTORY, { recursive: true });
  await writeFile(
    REVIEW_FILE,
    `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>Screenshot drift</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;margin:2rem;color:#202124;background:#fff}
h1{font-size:1.8rem}h2{font-size:1.2rem;overflow-wrap:anywhere}section{margin-block:2rem}
.images{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem}
figure{margin:0;min-width:0}figcaption{font-weight:bold;margin-bottom:.5rem}img{max-width:100%;height:auto;border:1px solid #ddd}
@media(max-width:48rem){.images{grid-template-columns:1fr}}
</style><h1>Screenshot drift</h1><p>${entries.length} existing screenshot${entries.length === 1 ? "" : "s"} changed or removed.</p>
<main>`
  );
  for (const entry of entries) {
    await appendFile(
      REVIEW_FILE,
      `<section><h2>${escape(entry.title)} / ${escape(entry.name)}</h2><div class="images">`
    );
    for (const [role, label] of Object.entries(ROLES)) {
      const image = entry.images[role];
      const content = image
        ? `<img alt="${label} screenshot" src="data:image/png;base64,${await png(image)}">`
        : `<p>${entry.removed && role === "actual" ? "Removed" : "Not available"}</p>`;
      await appendFile(REVIEW_FILE, `<figure><figcaption>${label}</figcaption>${content}</figure>`);
    }
    await appendFile(REVIEW_FILE, "</div></section>");
  }
  await appendFile(REVIEW_FILE, "</main></html>\n");
  return true;
}
