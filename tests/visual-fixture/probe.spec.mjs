import { expect, test } from "playwright/test";

test("captures complete stable screenshots", async ({ page }, info) => {
  const color = process.env.PROBE_CHANGED === "true" ? "blue" : "red";
  await page.setContent(`<body style="margin:0;background:${color}"></body>`);
  if (process.env.PROBE_CAPTURE_FAILURE === "true") await page.close();
  for (const name of process.env.PROBE_REMOVE === "true" ? ["one"] : ["one", "two"]) {
    info.annotations.push({ type: "visual-snapshot", description: `desktop/${name}.png` });
    await expect.soft(page).toHaveScreenshot(`${name}.png`);
  }
});

test("keeps functional failures blocking", () => {
  expect(process.env.PROBE_FUNCTIONAL_FAILURE).not.toBe("true");
});
