import assert from "node:assert/strict";
import { test } from "node:test";
import { unpinned, violations } from "../.github/scripts/lint-action-manifests.mjs";
import { command, succeeds } from "./helpers.mjs";

const composite = (body) => `runs:\n  using: 'composite'\n  steps:\n    - shell: bash\n      run: |\n        ${body}\n`;

test("composite contexts respect expression boundaries, quoting and access syntax", () => {
  const violating = [
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
  ];
  for (const expression of violating)
    assert.equal(violations(composite(`\u0024{{ ${expression} }}`)).length, 1, expression);
  const allowed = [
    "# Caller passes vars.FLAG",
    "${{ inputs.flag }} ${{ github.repository }}",
    "${{ inputs.myvars.thing }}",
    "${{ inputs.vars }}",
    "${{ inputs . vars }}",
    "${{ format('vars.FLAG', inputs.flag) }}",
    "${{ 'it''s secrets.TOKEN' }}",
    "${{ 'example ${{ secrets.TOKEN }}' }}",
  ];
  for (const body of allowed) assert.deepEqual(violations(composite(body)), [], body);
  assert.deepEqual(violations("runs:\n  using: node24\n  main: index.js\n# ${{ vars.FLAG }}"), []);
});

test("malformed expressions with repeated quotes cannot stall manifest validation", () => {
  const source = composite("${{{{" + "'".repeat(40_000));
  const checker = new URL("../.github/scripts/lint-action-manifests.mjs", import.meta.url).href;
  const script = `import { violations } from ${JSON.stringify(checker)};
    import { readFileSync } from 'node:fs'; console.log(JSON.stringify(violations(readFileSync(0, 'utf8'))));`;
  assert.equal(
    succeeds(command(process.execPath, ["--input-type=module", "-e", script], { input: source, timeout: 5000 })),
    "[]"
  );
});

test("third-party actions are pinned to a commit with their release beside it", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const steps = (...refs) => `runs:\n  using: composite\n  steps:\n${refs.map((r) => `    - uses: ${r}\n`).join("")}`;
  const pinned = [
    `actions/checkout@${sha} # v7.0.1`,
    `actions/cache/restore@${sha} # v6.1.0`,
    `"actions/setup-go@${sha}" # v7.0.0`,
    "a-novel-kit/workflows/generic-actions/pull-bot@v1.66.0",
    "./local",
    "$/.github/actions/local",
    "docker://alpine:3.22",
  ];
  assert.deepEqual(unpinned(steps(...pinned)), []);
  const unpinnedRefs = [
    "actions/checkout@v7",
    "actions/checkout@v7.0.1",
    `actions/checkout@${sha}`,
    `actions/checkout@${sha} # v7`,
    `actions/checkout@${sha.slice(0, 7)} # v7.0.1`,
    "evil/a-novel-kit/workflows@v1.66.0",
  ];
  for (const ref of unpinnedRefs) assert.deepEqual(unpinned(steps(ref)), [{ line: 4, uses: ref.split(" ")[0] }], ref);
  assert.deepEqual(unpinned(`runs:\n  steps:\n    - name: Token\n      uses: actions/create-github-app-token@v3\n`), [
    { line: 4, uses: "actions/create-github-app-token@v3" },
  ]);
});
