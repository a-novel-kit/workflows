import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const ROLES = { reference: "expected", actual: "actual", diff: "diff" };
const MISSING = "No existing reference screenshot found";

/** One test's entry in the report runner.mjs inspects, built from Vitest's public reporter API. */
function entry(testCase) {
  const result = testCase.result();
  const errors = (result.errors ?? []).map((error) => stripVTControlCharacters(error.message));
  const snapshots = testCase
    .annotations()
    .filter((annotation) => annotation.type === "visual-snapshot")
    .map((annotation) => annotation.message);
  // Vitest copies each attachment to a file named after the SHA-1 of its original path, so hashing
  // the declared paths names the screenshot again for the review page.
  const declared = new Map(
    snapshots.map((name) => [
      createHash("sha1").update(resolve(process.env.PLAYWRIGHT_SNAPSHOT_DIR, name)).digest("hex"),
      name,
    ])
  );
  // Vitest records a toMatchScreenshot artifact only when the assertion fails.
  const comparisons = testCase
    .artifacts()
    .filter((artifact) => artifact.type === "internal:toMatchScreenshot")
    .map(({ message, attachments }) => {
      const images = Object.fromEntries(attachments.map(({ name, path }) => [ROLES[name], path]));
      const copy = basename(images.expected ?? "");
      // A mismatch carries the actual image; a missing reference or an unstable capture does not.
      return {
        name: declared.get(basename(copy, extname(copy))) ?? copy,
        images,
        drift: Boolean(images.actual),
        message,
      };
    });
  const visual = comparisons.filter((comparison) => comparison.drift || comparison.message.startsWith(MISSING));
  return {
    id: testCase.id,
    expectedStatus: testCase.options.fails ? "failed" : result.state === "skipped" ? "skipped" : "passed",
    status: result.state,
    title: testCase.fullName,
    comparisons,
    errors,
    visualErrors: errors.filter((error) => visual.some((comparison) => error.includes(comparison.message))),
    // Passing assertions leave no trace, so runner.mjs checks the captured files against the annotations.
    screenshotCount: snapshots.length,
    snapshots,
  };
}

/** Records a Vitest run so visual approval cannot hide another assertion failure. */
export default class VisualReporter {
  onTestRunEnd(testModules, unhandledErrors, reason) {
    const cases = testModules.flatMap((module) => [...module.children.allTests()]);
    const errors = [...unhandledErrors, ...testModules.flatMap((module) => module.errors())].map(
      (error) => error.message ?? "Vitest runner failed"
    );
    if (reason === "interrupted") errors.push("The Vitest run was interrupted");
    if (cases.some((testCase) => testCase.diagnostic()?.retryCount))
      errors.push("Retried tests cannot publish a reference");
    writeFileSync(
      process.env.PLAYWRIGHT_VISUAL_REPORT,
      JSON.stringify({
        expected: cases.length,
        tests: cases.filter((testCase) => testCase.result().state !== "pending").map(entry),
        errors,
      })
    );
  }
}
