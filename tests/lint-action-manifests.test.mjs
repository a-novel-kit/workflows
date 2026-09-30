import assert from "node:assert/strict";
import { test } from "node:test";
import { violations } from "../.github/scripts/lint-action-manifests.mjs";

const composite = (body) => `runs:\n  using: 'composite'\n  steps:\n    - shell: bash\n      run: |\n        ${body}\n`;

test("composite contexts respect expression boundaries, quoting and access syntax", () => {
  for (const expression of [
    "vars.FLAG",
    "inputs.flag || vars.FLAG",
    "format('{0}', secrets.TOKEN)",
    "toJSON(needs.build.outputs.x)",
    "matrix.os",
    "strategy.job-index",
    "vars['FLAG']",
    "inputs.flag ||\n        vars.FLAG",
    "format('}}', secrets.TOKEN)",
    "VARS.FLAG",
    "toJSON(vars)",
    "needs",
  ])
    assert.equal(violations(composite(`\u0024{{ ${expression} }}`)).length, 1, expression);
  for (const body of [
    "# Caller passes vars.FLAG",
    "${{ inputs.flag }} ${{ github.repository }}",
    "${{ inputs.myvars.thing }}",
    "${{ inputs.vars }}",
    "${{ inputs . vars }}",
    "${{ format('vars.FLAG', inputs.flag) }}",
    "${{ 'it''s secrets.TOKEN' }}",
  ])
    assert.deepEqual(violations(composite(body)), [], body);
  assert.deepEqual(violations("runs:\n  using: node24\n  main: index.js\n# ${{ vars.FLAG }}"), []);
});
