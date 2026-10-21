import assert from "node:assert/strict";
import { test } from "node:test";
import { step, succeeds, workspace } from "./helpers.mjs";

/** An expiry `days` from now, an hour past the day boundary so the count stays stable during a run. */
const inDays = (days) => new Date(Date.now() + days * 86_400_000 + 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Runs the shipped sweep as a dry run over the listed tokens and returns its step summary. */
function sweep(t, tokens) {
  const w = workspace(t);
  w.stub("gh", `console.log(${JSON.stringify(JSON.stringify(tokens))})`);
  const env = {
    ORG: "a-novel",
    WEBHOOK: "",
    DEFAULT_MENTION: "",
    DRY_RUN: "true",
    TEST_RUN: "false",
    RUNNER_TEMP: w.cwd,
  };
  succeeds(w.bash(step(".github/workflows/token-expiry.yaml", "Enumerate org PATs and ping on milestones"), env));
  return w.read("summary");
}

test("token-expiry keeps a token's empty metadata fields in place", (t) => {
  const summary = sweep(t, [
    { token_name: "no-expiry", owner: { login: "a" }, token_expired: false },
    {
      token_name: "no-grant",
      owner: { login: "b" },
      token_expires_at: inDays(3),
      token_expired: false,
      repository_selection: "selected",
      permissions: { repository: { issues: "read" } },
    },
  ]);
  assert.match(summary, /- no-expiry \(a\): no expiry metadata — skipped/);
  assert.match(summary, / -> \*\*Scope\*\*: Selected repositories\n -> \*\*Permissions\*\*: issues: read/);
});
