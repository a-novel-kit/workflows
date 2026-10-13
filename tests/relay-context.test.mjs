import assert from "node:assert/strict";
import { test } from "node:test";
import { manifest, step, succeeds, workspace } from "./helpers.mjs";

const resolve = step("generic-actions/relay-context/action.yaml", "Resolve the relayed event");
const queued = "gh-readonly-queue/master/pr-7-" + "a".repeat(40);

/** Runs the step against a stubbed GitHub; returns its outputs as an object. */
function relay(t, { event, sha = "b".repeat(40), branch = "feature", runPulls = [], commitPulls = "", heads = {} }) {
  const w = workspace(t);
  w.write("output", "");
  w.stub(
    "gh",
    `const args = process.argv.slice(2);
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    const heads = JSON.parse(process.env.HEADS);
    if (path.endsWith("/pulls") && path.includes("/commits/")) console.log(process.env.COMMIT_PULLS);
    else { const n = path.split("/").pop(); if (n in heads) console.log(heads[n]); }`
  );
  succeeds(
    w.bash(resolve, {
      GITHUB_REPOSITORY: "a-novel/service-authentication",
      EVENT: event,
      RUN_HEAD_SHA: sha,
      RUN_HEAD_BRANCH: branch,
      RUN_PULL_REQUESTS: JSON.stringify(runPulls),
      COMMIT_PULLS: commitPulls,
      HEADS: JSON.stringify(heads),
    })
  );
  return Object.fromEntries(
    w
      .read("output")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("="))
  );
}

test("relay-context accepts a merge group only on a merge-queue branch", (t) => {
  assert.deepEqual(relay(t, { event: "merge_group", sha: "c".repeat(40), branch: queued }), {
    event: "merge_group",
    head_sha: "c".repeat(40),
    merge_group_head_ref: "refs/heads/" + queued,
  });
  assert.deepEqual(relay(t, { event: "merge_group", branch: "gh-readonly-queue-lookalike" }), {});
  assert.deepEqual(relay(t, { event: "merge_group", sha: "not-a-sha", branch: queued }), {});
});

test("relay-context posts a review on the pull request's current head, not the run's", (t) => {
  const current = "d".repeat(40);
  assert.deepEqual(relay(t, { event: "pull_request_review", runPulls: [{ number: 7 }], heads: { 7: current } }), {
    event: "pull_request_review",
    pull_request_number: "7",
    head_sha: current,
  });
  // The run lists no pull request: the commit's open pull request stands in.
  assert.deepEqual(relay(t, { event: "pull_request_review", commitPulls: "9", heads: { 9: current } }), {
    event: "pull_request_review",
    pull_request_number: "9",
    head_sha: current,
  });
  // A closed pull request, or none, is not gated.
  assert.deepEqual(relay(t, { event: "pull_request_review", runPulls: [{ number: 7 }], heads: {} }), {});
  assert.deepEqual(relay(t, { event: "pull_request_review" }), {});
});

test("relay-context ignores a run of any other event", (t) => {
  // A branch can add a push trigger to the relay; its run wakes nothing.
  assert.deepEqual(
    relay(t, { event: "push", branch: queued, runPulls: [{ number: 7 }], heads: { 7: "e".repeat(40) } }),
    {}
  );
});

test("the gates take their queue context from inputs a relayed run can supply", () => {
  for (const path of ["generic-actions/merge-gate/action.yaml", "generic-actions/detect-partial-landing/action.yaml"]) {
    const action = manifest(path);
    assert.equal(action.inputs.merge_group_head_ref.default, "${{ github.event.merge_group.head_ref }}", path);
    for (const s of action.runs.steps.filter((s) => s.env?.IN_QUEUE !== undefined)) {
      assert.equal(s.env.IN_QUEUE, "${{ inputs.merge_group_head_ref }}", `${path}: ${s.name}`);
    }
  }
  const gate = manifest("generic-actions/review-gate/action.yaml");
  assert.equal(gate.runs.steps.find((s) => s.env?.EVENT).env.EVENT, "${{ inputs.event }}");

  const run = manifest(".github/workflows/merge-gate-run.yaml");
  const evaluate = run.jobs.evaluate.steps[0].with;
  assert.equal(
    evaluate.merge_group_head_ref,
    "${{ inputs.merge_group_head_ref || github.event.merge_group.head_ref }}"
  );
  assert.equal(evaluate.pull_request_number, "${{ inputs.pull_request_number || github.event.pull_request.number }}");
  assert.match(run.jobs["auto-merge"].if, /pull_request_target/);
});
