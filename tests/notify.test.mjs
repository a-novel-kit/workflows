import assert from "node:assert/strict";
import { test } from "node:test";
import { step, succeeds, workspace } from "./helpers.mjs";

test("notify-ci reports a failure, and a success only when it ends one", (t) => {
  const decide = step(".github/workflows/notify-ci-run.yaml", "state");
  const run = (id, number, conclusion) => ({ id, run_number: number, conclusion });
  for (const [conclusion, history, expected] of [
    ["failure", [], "failed"],
    ["success", [run(41, 9, "failure")], "succeeded"],
    ["success", [run(41, 9, "success")], undefined],
    ["success", [run(41, 9, "cancelled"), run(40, 8, "failure")], "succeeded"],
    ["success", [run(42, 10, "failure"), run(41, 9, "success")], undefined],
    ["success", [], undefined],
  ]) {
    const w = workspace(t);
    w.write("output", "");
    w.stub("gh", `console.log(${JSON.stringify(JSON.stringify({ workflow_runs: history }))})`);
    succeeds(
      w.bash(decide, {
        GITHUB_REPOSITORY: "a-novel/infra",
        WORKFLOW_ID: "7",
        RUN_ID: "42",
        RUN_NUMBER: "10",
        BRANCH: "master",
        CONCLUSION: conclusion,
        MESSAGE: "fix(deploy): retry the image copy\n\nCo-authored-by: someone",
        SHA: "0123456789abcdef",
        AUTHOR: "kushuh",
        SERVER_URL: "https://github.com",
      })
    );
    const output = w.read("output");
    assert.equal(output.match(/^post=(.*)$/m)?.[1], expected, `${conclusion} after ${JSON.stringify(history)}`);
    if (expected) {
      assert.match(
        output,
        /^fix\(deploy\): retry the image copy\n\[`0123456`\]\(https:\/\/github\.com\/a-novel\/infra\/commit\/0123456789abcdef\) by kushuh\n/m
      );
    }
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
  assert.equal(
    description,
    [
      "## What's Changed",
      "* feat(escalate): page Discord with its own push_mention by @kushuh in [#534](https://github.com/a-novel-kit/workflows/pull/534)",
      "* docs: see [the guide](https://github.com/a-novel-kit/workflows/pull/12)",
      "",
      "**Full Changelog**: [v1.46.0...v1.47.0](https://github.com/a-novel-kit/workflows/compare/v1.46.0...v1.47.0)",
    ].join("\n")
  );
});
