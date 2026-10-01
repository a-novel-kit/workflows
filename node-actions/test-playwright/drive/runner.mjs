// Run native comparisons and regenerate only after a reviewed visual-only failure.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { glob, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, posix, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as tar from "tar";
import { Failure, runCli } from "./common.mjs";
import { captureReview } from "./review.mjs";

/** Require a complete, unique inventory and distinguish visual failures from functional errors. */
export function inspectReport(report) {
  const cases = report.tests ?? [];
  if (!cases.length || cases.length !== report.expected || report.errors?.length)
    throw new Failure("Playwright did not complete the selected test suite");
  if (new Set(cases.map((test) => test.id)).size !== cases.length)
    throw new Failure("Retried tests cannot publish a reference");
  const paths = new Set();
  let visualOnly = true;
  for (const test of cases) {
    if (test.expectedStatus !== "passed") throw new Failure("Expected-failure tests cannot publish a reference");
    if ((test.snapshots ?? []).length !== test.screenshotCount)
      throw new Failure("Screenshot inventory does not match executed assertions");
    const errors = test.errors ?? [];
    if (
      !["passed", "failed"].includes(test.status) ||
      (test.status === "failed" && !errors.length) ||
      errors.some((error) => !(test.visualErrors ?? []).includes(error))
    )
      visualOnly = false;
    for (const name of test.snapshots ?? []) {
      if (isAbsolute(name) || name.split("/").includes("..") || name.includes("\\") || posix.extname(name) !== ".png")
        throw new Failure("Invalid screenshot inventory path");
      const path = posix.normalize(name);
      if (paths.has(path)) throw new Failure("Duplicate screenshot inventory path");
      paths.add(path);
    }
  }
  if (!paths.size) throw new Failure("No screenshot assertions were recorded");
  return { paths, visualOnly };
}

async function runTests(script, mode) {
  const reportPath = process.env.PLAYWRIGHT_VISUAL_REPORT;
  await rm(reportPath, { force: true });
  const result = spawnSync(
    "pnpm",
    ["run", script, `--update-snapshots=${mode}`, `--add-reporter=${join(import.meta.dirname, "reporter.mjs")}`],
    { stdio: "inherit" }
  );
  if (result.error || result.signal || !existsSync(reportPath))
    throw new Failure("Playwright visual report is missing");
  return [result.status, JSON.parse(await readFile(reportPath, "utf8"))];
}

/** Package only declared evidence and prevent symlinks from exposing workspace secrets. */
export async function archiveBatch(paths, target) {
  const sources = [...paths].sort().map((path) => `.visual/snapshots/${path}`);
  for (const folder of [
    "playwright-report",
    "test-results",
    ".visual/comparison-report",
    ".visual/comparison-results",
    ".visual/review",
  ]) {
    if (existsSync(folder) && (await lstat(folder)).isSymbolicLink())
      throw new Failure("Evidence contains an unsafe file path");
    for await (const path of glob(`${folder}/**/*`)) {
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Failure("Evidence contains an unsafe file path");
      if (info.isFile()) sources.push(path);
    }
  }
  for (const path of ["integration-services.log", ".visual/results.json", ".visual/comparison.json"])
    if (existsSync(path)) sources.push(path);
  const workspace = await realpath(process.cwd());
  for (const path of sources) {
    if (!existsSync(path) || !(await lstat(path)).isFile())
      throw new Failure("Screenshot inventory contains a missing file");
    const resolved = await realpath(path);
    if (
      (await lstat(path)).isSymbolicLink() ||
      relative(workspace, resolved).startsWith("..") ||
      isAbsolute(relative(workspace, resolved))
    )
      throw new Failure("Evidence contains an unsafe file path");
  }
  await tar.c(
    {
      file: target,
      portable: true,
      noDirRecurse: true,
      filter: (path) => sources.includes(path),
      onWriteEntry(entry) {
        if (entry.path.startsWith(".visual/snapshots/")) entry.path = entry.path.slice(".visual/".length);
      },
    },
    sources
  );
}

/** Compare the full suite and permit regeneration only for approved screenshot changes. */
export async function compare(script, { approved = false, seed = false } = {}) {
  await mkdir(".visual", { recursive: true });
  const snapshots = ".visual/snapshots";
  const previous = new Set();
  for await (const path of glob(`${snapshots}/**/*.png`)) previous.add(relative(snapshots, path));
  // Missing mode captures new images for review; inventory changes still require approval.
  const [code, report] = await runTests(script, seed ? "all" : "missing");
  let inspection;
  try {
    inspection = inspectReport(report);
  } finally {
    await captureReview(
      report,
      inspection?.visualOnly ? [...previous].filter((path) => !inspection.paths.has(path)) : [],
      [...(inspection?.paths ?? [])].filter((path) => !previous.has(path))
    );
  }
  const { paths, visualOnly } = inspection;
  const changed = code !== 0 || !isDeepStrictEqual(previous, paths);
  if (!visualOnly || (code && report.tests.every((test) => test.status === "passed")))
    throw new Failure("Test execution or screenshot capture failed; approval cannot waive it");
  if (seed) {
    if (code) throw new Failure("Initial screenshot capture failed");
  } else if (changed) {
    if (!approved) throw new Failure("Screenshot changes require approval for the current PR head");
    for (const [source, target] of [
      ["playwright-report", ".visual/comparison-report"],
      ["test-results", ".visual/comparison-results"],
      [".visual/results.json", ".visual/comparison.json"],
    ]) {
      if (existsSync(source)) await rename(source, target);
    }
    await rm(snapshots, { recursive: true, force: true });
    const [updatedCode, updatedReport] = await runTests(script, "all");
    const updated = inspectReport(updatedReport);
    if (updatedCode || !isDeepStrictEqual(updated.paths, paths))
      throw new Failure("Approved screenshot regeneration did not complete the same test inventory");
  }
  for (const path of paths)
    if (!existsSync(join(snapshots, path)) || !(await lstat(join(snapshots, path))).isFile())
      throw new Failure("A screenshot capture is missing");
  return changed;
}

async function main() {
  const mode = process.argv[2];
  if (["--diagnostics", "--archive"].includes(mode)) {
    const paths =
      mode === "--archive"
        ? inspectReport(JSON.parse(await readFile(".visual/results.json", "utf8"))).paths
        : new Set();
    await archiveBatch(paths, ".visual/batch.tar");
    return;
  }
  if (!mode) throw new Failure("A Playwright package script is required");
  const changed = await compare(mode, {
    approved: process.env.VISUAL_APPROVED === "true",
    seed: process.env.VISUAL_SEED === "true",
  });
  await writeFile(".visual/verdict.json", JSON.stringify({ changed, sha: process.env.GITHUB_SHA }));
}

runCli(import.meta.url, main, "Playwright comparison or evidence packaging failed");
