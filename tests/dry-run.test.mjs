// Every dry_run input resolves once to "true" or "false", and only "false" runs live.
import assert from "node:assert/strict";
import { globSync } from "node:fs";
import { test } from "node:test";
import { manifest, root, succeeds, workspace } from "./helpers.mjs";

/** Each dry_run value with the value it resolves to. */
const values = [
  ["false", "false"],
  ["FALSE", "false"],
  [" False\n", "false"],
  ["true", "true"],
  ["", "true"],
  ["yes", "true"],
  ["no", "true"],
  ["0", "true"],
];

const actions = globSync("*-actions/*/action.yaml", { cwd: root }).filter((path) => manifest(path).inputs?.dry_run);
assert.notEqual(actions.length, 0);

for (const path of [...actions, ".github/workflows/token-expiry.yaml"])
  test(`${path} runs live only on a dry_run of "false"`, (t) => {
    const doc = manifest(path);
    const steps = doc.runs?.steps ?? Object.values(doc.jobs).flatMap((job) => job.steps);
    // One step reads the input, and every later read takes the value it resolves.
    const readers = steps.filter((entry) => JSON.stringify(entry).includes("inputs.dry_run"));
    assert.equal(readers.length, 1);
    const [{ env, run }] = readers;
    assert.equal(env.DRY_RUN, "${{ inputs.dry_run }}");
    assert.doesNotMatch(run, /"\$DRY_RUN"/);

    // The two lines that resolve it may call a one-line helper of the same step.
    const lines = run.split("\n");
    const at = lines.findIndex((line) => line.includes("${DRY_RUN"));
    const helpers = lines.filter((line) => /^\s*\w+\(\) \{.*\}$/.test(line));
    const resolve = [...helpers, ...lines.slice(at, at + 2), 'printf %s "$dry"'].join("\n");
    const w = workspace(t);
    for (const [value, dry] of values)
      assert.equal(succeeds(w.bash(resolve, { DRY_RUN: value })), dry, JSON.stringify(value));
  });
