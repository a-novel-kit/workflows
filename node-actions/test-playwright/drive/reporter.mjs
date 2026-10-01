import { writeFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";

/** Records public Playwright events so visual approval cannot hide another assertion failure. */
export default class VisualReporter {
  expected = 0;
  results = [];
  errors = [];
  visualErrors = new WeakMap();
  screenshots = new WeakMap();
  comparisons = new WeakMap();

  onBegin(_config, suite) {
    this.expected = suite.allTests().length;
  }

  onStepEnd(_test, result, step) {
    if (step.category !== "expect" || !/\btoHaveScreenshot\b/.test(step.title)) return;
    this.screenshots.set(result, (this.screenshots.get(result) ?? 0) + 1);
    const images = {};
    let name;
    for (const attachment of step.attachments) {
      const match = attachment.name.match(/^(.*)-(expected|actual|diff)\.png$/);
      if (match && attachment.contentType === "image/png" && attachment.path) {
        name = match[1];
        images[match[2]] = attachment.path;
      }
    }
    const message = stripVTControlCharacters(step.error?.message ?? "").replace(/^Error: /, "");
    const missing = message.startsWith("A snapshot doesn't exist at ") && /\.png(?:, writing actual)?\.$/.test(message);
    // Stable mismatch evidence distinguishes a reviewable diff from capture/timeout failures.
    const stableDifference =
      message.includes("captured a stable screenshot") &&
      ["-actual.png", "-expected.png"].every((suffix) =>
        step.attachments.some(
          (attachment) => attachment.contentType === "image/png" && attachment.name.endsWith(suffix)
        )
      );
    if (name) {
      const comparisons = this.comparisons.get(result) ?? [];
      comparisons.push({ name, images, drift: stableDifference });
      this.comparisons.set(result, comparisons);
    }
    if (step.error && (missing || stableDifference)) {
      const errors = this.visualErrors.get(result) ?? [];
      errors.push(step.error.message);
      this.visualErrors.set(result, errors);
    } else if (!step.error && images.expected && images.actual && !images.diff) {
      // Missing-mode soft errors belong to the test; Playwright leaves the step error empty.
      const errors = this.visualErrors.get(result) ?? [];
      errors.push(`Error: A snapshot doesn't exist at ${images.expected}, writing actual.`);
      this.visualErrors.set(result, errors);
    }
  }

  onTestEnd(test, result) {
    this.results.push({
      id: test.id,
      expectedStatus: test.expectedStatus,
      status: result.status,
      title: test.titlePath().join(" › "),
      comparisons: this.comparisons.get(result) ?? [],
      errors: result.errors.map((error) => error.message),
      visualErrors: this.visualErrors.get(result) ?? [],
      screenshotCount: this.screenshots.get(result) ?? 0,
      snapshots: result.annotations
        .filter((annotation) => annotation.type === "visual-snapshot")
        .map((annotation) => annotation.description),
    });
  }

  onError(error) {
    this.errors.push(error.message ?? "Playwright runner failed");
  }

  onEnd() {
    writeFileSync(
      process.env.PLAYWRIGHT_VISUAL_REPORT,
      JSON.stringify({ expected: this.expected, tests: this.results, errors: this.errors })
    );
  }
}
