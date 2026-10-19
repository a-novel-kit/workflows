import assert from "node:assert/strict";
import { test } from "node:test";
import { step, succeeds, workspace } from "./helpers.mjs";

test("notify-ci reports a failure, and a success only when it ends one, naming the author's login", (t) => {
  const decide = step(".github/workflows/notify-ci-run.yaml", "state");
  const run = (id, number, conclusion) => ({ id, run_number: number, conclusion });
  const cases = [
    ["failure", [], "failed"],
    ["failure", [], "failed", ""],
    ["success", [run(41, 9, "failure")], "succeeded"],
    ["success", [run(41, 9, "success")], undefined],
    ["success", [run(41, 9, "cancelled"), run(40, 8, "failure")], "succeeded"],
    ["success", [run(42, 10, "failure"), run(41, 9, "success")], undefined],
    ["success", [], undefined],
  ];
  for (const [conclusion, history, expected, login = "kushuh"] of cases) {
    const w = workspace(t);
    w.write("output", "");
    w.stub(
      "gh",
      `const commit = process.argv.includes('repos/a-novel/infra/commits/0123456789abcdef');
      if (commit && process.env.LOGIN === '') process.exit(1);
      console.log(commit ? process.env.LOGIN : ${JSON.stringify(JSON.stringify({ workflow_runs: history }))});`
    );
    const env = {
      GITHUB_REPOSITORY: "a-novel/infra",
      WORKFLOW_ID: "7",
      RUN_ID: "42",
      RUN_NUMBER: "10",
      BRANCH: "master",
      CONCLUSION: conclusion,
      MESSAGE: "fix(deploy): retry the image copy\n\nCo-authored-by: someone",
      SHA: "0123456789abcdef",
      AUTHOR: "Geoffroy Vincent",
      SERVER_URL: "https://github.com",
      LOGIN: login,
    };
    succeeds(w.bash(decide, env));
    const output = w.read("output");
    assert.equal(output.match(/^post=(.*)$/m)?.[1], expected, `${conclusion} after ${JSON.stringify(history)}`);
    if (expected) {
      const commitLine =
        "fix(deploy): retry the image copy\n[`0123456`](https://github.com/a-novel/infra/commit/0123456789abcdef)" +
        ` by ${login || "Geoffroy Vincent"}\n`;
      assert.ok(output.includes(commitLine), output);
    }
  }
});

test("notify-release colors a hotfix gold and every other release by the bump its tag carries", (t) => {
  const colors = [
    ["v1.60.5", "master", "started"],
    ["v1.0.10", "master", "started"],
    ["v1.61.0", "master", "succeeded"],
    ["v0.10.0", "master", "succeeded"],
    ["v2.0.0", "master", "released"],
    ["nightly", "master", "released"],
    ["v2.10.3", "release/v2.10", "upcoming"],
  ];
  for (const [tag, target, expected] of colors) {
    const w = workspace(t);
    succeeds(w.bash(step(".github/workflows/notify-release-run.yaml", "color"), { TAG: tag, TARGET: target }));
    assert.equal(w.read("output"), `color=${expected}\n`, `${tag} on ${target}`);
  }
});

test("notify-release links bare pull-request and compare URLs the way GitHub renders them", (t) => {
  const w = workspace(t);
  const body = [
    "## What's Changed",
    "* feat(escalate): page Discord with its own push_mention by @kushuh in https://github.com/a-novel-kit/workflows/pull/534",
    "* docs: see [the guide](https://github.com/a-novel-kit/workflows/pull/12)",
    "",
    "**Full Changelog**: https://github.com/a-novel-kit/workflows/compare/v1.46.0...v1.47.0",
  ].join("\n");
  succeeds(w.bash(step(".github/workflows/notify-release-run.yaml", "notes"), { BODY: body }));
  const description = w.read("output").match(/^description<<(EOF_\w+)\n([^]*)\n\1\n$/)[2];
  const linked = [
    "## What's Changed",
    "* feat(escalate): page Discord with its own push_mention by @kushuh in [#534](https://github.com/a-novel-kit/workflows/pull/534)",
    "* docs: see [the guide](https://github.com/a-novel-kit/workflows/pull/12)",
    "",
    "**Full Changelog**: [v1.46.0...v1.47.0](https://github.com/a-novel-kit/workflows/compare/v1.46.0...v1.47.0)",
  ].join("\n");
  assert.equal(description, linked);
});
