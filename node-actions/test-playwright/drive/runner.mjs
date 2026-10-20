// Run native comparisons and regenerate only after a reviewed visual-only failure.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, glob, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, posix, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Failure, runCli, testedHead } from "./common.mjs";
import { captureReview } from "./review.mjs";

/** Report folders and files a batch archives beside its screenshots, when a run produced them. */
const EVIDENCE_FOLDERS = [
  "playwright-report",
  "test-results",
  ".visual/comparison-report",
  ".visual/comparison-results",
  ".visual/review",
];
const EVIDENCE_FILES = ["integration-services.log", ".visual/results.json", ".visual/comparison.json"];
/** Where an approved regeneration keeps the failing comparison's evidence. */
const COMPARISON_EVIDENCE = [
  ["playwright-report", ".visual/comparison-report"],
  ["test-results", ".visual/comparison-results"],
  [".visual/results.json", ".visual/comparison.json"],
];

/** Each runner's arguments for an update mode, named as Playwright's, and the reporter that writes the report. */
const RUNNERS = {
  playwright: (mode) => [`--update-snapshots=${mode}`, `--add-reporter=${join(import.meta.dirname, "reporter.mjs")}`],
  // Vitest's attachments land in test-results, beside Playwright's, so evidence and review treat both alike.
  vitest: (mode) => [
    `--update=${{ all: "all", missing: "new", none: "none" }[mode]}`,
    "--reporter=default",
    `--reporter=${join(import.meta.dirname, "vitest-reporter.mjs")}`,
    "--attachmentsDir=test-results",
  ],
};

/** Require a complete, unique inventory and distinguish visual failures from functional errors. */
export function inspectReport(report) {
  const cases = report.tests ?? [];
  if (!cases.length || cases.length !== report.expected || report.errors?.length)
    throw new Failure("The test runner did not complete the selected suite");
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
  const runner = RUNNERS[process.env.VISUAL_RUNNER || "playwright"];
  if (!runner) throw new Failure("Unknown visual test runner");
  await rm(reportPath, { force: true });
  const result = spawnSync("pnpm", ["run", script, ...runner(mode)], { stdio: "inherit" });
  if (result.error || result.signal || !existsSync(reportPath)) throw new Failure("The visual report is missing");
  return [result.status, JSON.parse(await readFile(reportPath, "utf8"))];
}

/** The screenshots on disk, relative to the snapshot directory. */
async function captures(snapshots) {
  const paths = new Set();
  for await (const path of glob(`${snapshots}/**/*.png`)) paths.add(relative(snapshots, path));
  return paths;
}

/** Fail when a run wrote a screenshot that no visual-snapshot annotation declares. */
async function requireDeclared(snapshots, declared) {
  const undeclared = [...(await captures(snapshots)).difference(declared)];
  if (undeclared.length)
    throw new Failure(`Screenshots captured without a visual-snapshot annotation: ${undeclared.sort().join(", ")}`);
}

/** Package only declared evidence and prevent symlinks from exposing workspace secrets. */
export async function archiveBatch(paths, target) {
  const sources = [...paths].sort().map((path) => `.visual/snapshots/${path}`);
  for (const folder of EVIDENCE_FOLDERS) {
    if (existsSync(folder) && (await lstat(folder)).isSymbolicLink())
      throw new Failure("Evidence contains an unsafe file path");
    for await (const path of glob(`${folder}/**/*`)) {
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Failure("Evidence contains an unsafe file path");
      if (info.isFile()) sources.push(path);
    }
  }
  for (const path of EVIDENCE_FILES) if (existsSync(path)) sources.push(path);
  const workspace = await realpath(process.cwd());
  for (const path of sources) {
    if (!existsSync(path) || !(await lstat(path)).isFile())
      throw new Failure("Screenshot inventory contains a missing file");
    const resolved = relative(workspace, await realpath(path));
    if (resolved.startsWith("..") || isAbsolute(resolved)) throw new Failure("Evidence contains an unsafe file path");
  }
  // A NUL-separated stdin list avoids argument limits, and verbatim names cannot act as options.
  execFileSync(
    "tar",
    [
      "--create",
      `--file=${target}`,
      "--no-recursion",
      "--transform=s,^\\.visual/snapshots/,snapshots/,",
      "--null",
      "--verbatim-files-from",
      "--files-from=-",
    ],
    { input: sources.join("\0") }
  );
}

/** Compare the full suite and permit regeneration only for approved screenshot changes. */
export async function compare(script, { approved = false, seed = false } = {}) {
  await mkdir(".visual", { recursive: true });
  const snapshots = ".visual/snapshots";
  const previous = await captures(snapshots);
  // Missing mode captures new images without overwriting any existing reference.
  let [code, report] = await runTests(script, seed ? "all" : "missing");
  let inspection;
  try {
    inspection = inspectReport(report);
    await requireDeclared(snapshots, previous.union(inspection.paths));
    const added = !inspection.paths.isSubsetOf(previous);
    const existingDrift = report.tests.some((test) => test.comparisons?.some((comparison) => comparison.drift));
    if (!seed && added && inspection.visualOnly && !existingDrift) {
      const inventory = inspection.paths;
      // A fresh comparison gives additions a normal passing report; real failures are never retried.
      [code, report] = await runTests(script, "none");
      inspection = inspectReport(report);
      if (!isDeepStrictEqual(inspection.paths, inventory))
        throw new Failure("New screenshot capture changed the test inventory");
    }
  } finally {
    const captured = inspection?.paths ?? new Set();
    const removed = inspection?.visualOnly ? [...previous.difference(captured)] : [];
    const drift = await captureReview(report, removed, [...captured.difference(previous)]);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `drift=${drift}\n`);
  }
  const { paths, visualOnly } = inspection;
  const changed = code !== 0 || !previous.isSubsetOf(paths);
  if (!visualOnly || (code && report.tests.every((test) => test.status === "passed")))
    throw new Failure("Test execution or screenshot capture failed; approval cannot waive it");
  if (seed) {
    if (code) throw new Failure("Initial screenshot capture failed");
  } else if (changed) {
    if (!approved) {
      // Only this failure is waiting on a reviewer, so only it asks for the label.
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, "approval=required\n");
      throw new Failure("Screenshot changes require approval for the current PR head");
    }
    for (const [source, target] of COMPARISON_EVIDENCE) if (existsSync(source)) await rename(source, target);
    await rm(snapshots, { recursive: true, force: true });
    const [updatedCode, updatedReport] = await runTests(script, "all");
    const updated = inspectReport(updatedReport);
    if (updatedCode || !isDeepStrictEqual(updated.paths, paths))
      throw new Failure("Approved screenshot regeneration did not complete the same test inventory");
    await requireDeclared(snapshots, paths);
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
  if (!mode) throw new Failure("A visual test package script is required");
  const changed = await compare(mode, {
    approved: process.env.VISUAL_APPROVED === "true",
    seed: process.env.VISUAL_SEED === "true",
  });
  await writeFile(".visual/verdict.json", JSON.stringify({ changed, sha: testedHead() }));
}

runCli(import.meta.url, main, "Screenshot comparison or evidence packaging failed");
