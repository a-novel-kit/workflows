import { writeFileSync } from "node:fs";

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
    if (step.error) {
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
