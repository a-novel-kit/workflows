import { expect, inject, test } from "vitest";
import { page } from "vitest/browser";

const probes = inject("probes");
const probe = (name) => probes[`PROBE_${name}`] === "true";

if (probe("INCOMPLETE")) throw new Error("The probe module failed to load");

test("captures complete stable screenshots", async ({ annotate }) => {
  document.body.style.cssText = `margin:0;background:${probe("CHANGED") ? "blue" : "red"}`;
  if (probe("UNSTABLE"))
    requestAnimationFrame(function flicker(time) {
      document.body.style.background = `hsl(${(time * 7) % 360} 90% 50%)`;
      requestAnimationFrame(flicker);
    });
  const names = probe("REMOVE") ? ["one"] : ["one", "two"];
  if (probe("ADD")) names.push("three");
  // Vitest refuses an annotation once a soft assertion has failed the test, so declare every screenshot first.
  for (const name of names) await annotate(`desktop/${name}.png`, "visual-snapshot");
  for (const name of names) await expect.soft(page).toMatchScreenshot(`${name}.png`);
  if (probe("UNDECLARED")) await expect.soft(page).toMatchScreenshot("four.png");
});

test("keeps functional failures blocking", () => {
  expect(probe("FUNCTIONAL_FAILURE")).toBe(false);
});
