import { writeFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";

/** Records public Playwright events so visual approval cannot hide another assertion failure. */
export default class VisualReporter {
  expected = 0;
  results = [];
  errors = [];
  visualErrors = new WeakMap();
  screenshots = new WeakMap();

  onBegin(_config, suite) {
    this.expected = suite.allTests().length;
  }

  onStepEnd(_test, result, step) {
    if (step.category !== "expect" || !/\btoHaveScreenshot\b/.test(step.title)) return;
    this.screenshots.set(result, (this.screenshots.get(result) ?? 0) + 1);
    const message = stripVTControlCharacters(step.error?.message ?? "").replace(/^Error: /, "");
    const missing = message.startsWith("A snapshot doesn't exist at ") && message.endsWith(".png.");
    // Stable mismatch evidence distinguishes a reviewable diff from capture/timeout failures.
    const stableDifference =
      message.includes("captured a stable screenshot") &&
      ["-actual.png", "-expected.png"].every((suffix) =>
        step.attachments.some(
          (attachment) => attachment.contentType === "image/png" && attachment.name.endsWith(suffix)
        )
      );
    if (step.error && (missing || stableDifference)) {
      const errors = this.visualErrors.get(result) ?? [];
      errors.push(step.error.message);
      this.visualErrors.set(result, errors);
    }
  }

  onTestEnd(test, result) {
    this.results.push({
      id: test.id,
      expectedStatus: test.expectedStatus,
      status: result.status,
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
