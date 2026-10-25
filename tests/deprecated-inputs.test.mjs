import assert from "node:assert/strict";
import { test } from "node:test";
import { manifest, succeeds, workspace } from "./helpers.mjs";

/**
 * Evaluates the expressions a renamed input is read through: input references and quoted literals
 * joined by `||`, which GitHub resolves to the first non-empty operand. Any other expression fails the
 * test, so a read written another way cannot pass unevaluated.
 */
function evaluate(text, inputs) {
  return String(text).replace(/\$\{\{ (.*?) \}\}/g, (_, expression) => {
    const operands = expression.split(" || ").map((operand) => {
      const literal = /^'([^']*)'$/.exec(operand)?.[1];
      const input = /^inputs\.([\w-]+)$/.exec(operand)?.[1];
      assert(literal !== undefined || input, `unsupported expression: ${expression}`);
      return literal ?? inputs[input] ?? "";
    });
    return operands.find((value) => value !== "") ?? "";
  });
}

/** The `with:` and `env:` values of an action's steps that read any of the named inputs. */
function reads(action, names) {
  const pattern = new RegExp(`inputs\\.(?:${names.join("|")})(?![\\w-])`);
  return action.runs.steps.flatMap((s, i) =>
    [...Object.entries(s.with ?? {}), ...Object.entries(s.env ?? {})]
      .filter(([, text]) => pattern.test(String(text)))
      .map(([key, text]) => [`step ${i} ${key}`, text])
  );
}

test("a deprecated input reaches every step its replacement reaches, and the replacement wins", () => {
  const renames = [
    ["go-actions/lint-go/action.yaml", "working-directory", "working_directory"],
    ["build-actions/docker/action.yaml", "secret-envs", "secret_envs"],
    ["build-actions/docker/action.yaml", "secret-files", "secret_files"],
  ];
  for (const [path, old, replacement] of renames) {
    const action = manifest(path);
    // The runner logs this message whenever a caller sets the old name.
    assert.match(action.inputs[old].deprecationMessage, new RegExp(`Rename it ${replacement} `), path);
    const fields = reads(action, [old, replacement]);
    assert.notEqual(fields.length, 0, path);
    const passed = (inputs) => fields.map(([field, text]) => [field, evaluate(text, inputs)]);
    const renamed = passed({ [replacement]: "value" });
    assert.deepEqual(passed({ [old]: "value" }), renamed, `${path}: ${old}`);
    assert.deepEqual(passed({ [old]: "stale", [replacement]: "value" }), renamed, `${path}: both names`);
  }
});

test("docker-job warns, then runs docker in job mode with every input it takes", (t) => {
  const job = manifest("build-actions/docker-job/action.yaml");
  const docker = manifest("build-actions/docker/action.yaml");
  // docker-job publishes through docker, so it inherits the same attestation.
  const [warn, build] = job.runs.steps;
  assert.equal(job.runs.steps.length, 2);
  assert.equal(build.uses.replace(/@.*/, ""), "a-novel-kit/workflows/build-actions/docker");
  assert.equal(job.outputs.digest.value, "${{ steps.build.outputs.digest }}");

  // Each input reaches docker under its snake_case name, which docker reads without a warning.
  const names = Object.keys(job.inputs);
  const inputs = Object.fromEntries(names.map((name) => [name, `<${name}>`]));
  const passed = Object.fromEntries(Object.entries(build.with).map(([key, text]) => [key, evaluate(text, inputs)]));
  const expected = Object.fromEntries(names.map((name) => [name.replaceAll("-", "_"), `<${name}>`]));
  assert.deepEqual(passed, { mode: "job", ...expected });
  for (const key of Object.keys(passed)) {
    assert.equal(typeof docker.inputs[key], "object", key);
    assert.equal(docker.inputs[key].deprecationMessage, undefined, key);
  }

  const w = workspace(t);
  assert.match(succeeds(w.bash(warn.run)), /^::warning::build-actions\/docker-job is deprecated\. /);
});
