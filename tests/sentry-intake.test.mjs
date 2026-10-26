import assert from "node:assert/strict";
import { test } from "node:test";
import { manifest, step, succeeds, workspace } from "./helpers.mjs";

const intake = ".github/workflows/sentry-intake-run.yaml";

// The job condition compares one event field with a literal, as GitHub evaluates it.
function admits(condition, event) {
  const [, path, literal] = condition.match(/^github\.event\.([\w.]+) == '([^']*)'$/);
  return path.split(".").reduce((value, key) => value?.[key], event) === literal;
}

test("sentry-intake boards only the issues Sentry's App opens", () => {
  const job = manifest(intake).jobs.intake;
  // GitHub records the App's issues under its bot account, with no performed_via_github_app.
  const opened = (login, app = null) => ({
    action: "opened",
    issue: {
      number: 7,
      node_id: "I_x",
      user: { login, type: login.endsWith("[bot]") ? "Bot" : "User" },
      performed_via_github_app: app,
    },
  });
  const cases = [
    ["the Sentry App", opened("sentry[bot]"), true],
    ["a person", opened("kushuh"), false],
    ["another App", opened("anovelbot-agent[bot]", { id: 3549319, slug: "anovelbot-agent" }), false],
  ];
  for (const [name, event, boarded] of cases) assert.equal(admits(job.if, event), boarded, name);

  const [board, label] = job.steps;
  assert.match(board.uses, /^a-novel-kit\/workflows\/generic-actions\/board-write@v\d+\.\d+\.\d+$/);
  assert.deepEqual(
    { content_id: board.with.content_id, field: board.with.field, value: board.with.value },
    { content_id: "${{ github.event.issue.node_id }}", field: "Status", value: "Triage" }
  );
  assert.equal(board.with.kill_switch, "${{ inputs.kill_switch }}");
  assert.equal(label.if, "${{ !cancelled() }}");
  assert.deepEqual(job.permissions, { issues: "write" });
});

test("sentry-intake labels the issue and fails when GitHub drops its Bug type", (t) => {
  const w = workspace(t);
  w.stub(
    "gh",
    `const fs = require('fs'); const args = process.argv.slice(2);
    fs.appendFileSync('calls', JSON.stringify(args) + '\\n');
    if (args.includes('PATCH')) console.log(process.env.TYPE);`
  );
  const env = { GITHUB_REPOSITORY: "a-novel/service-authentication", NUMBER: "7", GH_TOKEN: "token" };
  succeeds(w.bash(step(intake, "Type and label the issue"), { ...env, TYPE: "Bug" }));
  assert.deepEqual(
    w
      .read("calls")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line)),
    [
      ["api", "repos/a-novel/service-authentication/issues/7/labels", "-f", "labels[]=sentry", "--silent"],
      [
        "api",
        "-X",
        "PATCH",
        "repos/a-novel/service-authentication/issues/7",
        "-f",
        "type=Bug",
        "--jq",
        '.type.name // ""',
      ],
    ]
  );
  assert.match(w.read("summary"), /Typed #7 Bug and labelled it `sentry`/);

  const dropped = w.bash(step(intake, "Type and label the issue"), { ...env, TYPE: "" });
  assert.equal(dropped.status, 1);
  assert.match(dropped.stdout, /^::error::GitHub did not set the Bug type on #7\.$/m);
});
