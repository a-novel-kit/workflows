import assert from "node:assert/strict";
import { test } from "node:test";
import { step, succeeds, workspace } from "./helpers.mjs";

const revoke = step("generic-actions/revoke-labels/action.yaml", "Remove the labels a push made stale");

/** Runs the step against a stubbed gh; returns its result and the label paths it deleted. */
function run(t, { carried, labels = "", answers = {}, pr = "7" }) {
  const w = workspace(t);
  w.write("summary", "");
  w.write("calls", "");
  w.stub(
    "gh",
    `import * as fs from 'node:fs';
    const path = process.argv.find((arg) => arg.startsWith("repos/"));
    fs.appendFileSync("calls", path + "\\n");
    const answer = JSON.parse(process.env.ANSWERS)[decodeURIComponent(path.split("/").pop())];
    if (answer) { console.error(answer); process.exit(1); }`
  );
  const env = {
    GITHUB_REPOSITORY: "a-novel/service-profile",
    GH_TOKEN: "token",
    LABELS: labels,
    PR: pr,
    CARRIED: JSON.stringify(carried),
    ANSWERS: JSON.stringify(answers),
  };
  const result = w.bash(revoke, env);
  return { result, calls: w.read("calls").trim().split("\n").filter(Boolean) };
}

test("revoke-labels deletes the carried privileged labels, and only those", (t) => {
  const { result, calls } = run(t, { carried: ["with-feature-env", "documentation", "allow-dependency-change"] });
  succeeds(result);
  assert.deepEqual(calls, [
    "repos/a-novel/service-profile/issues/7/labels/allow-dependency-change",
    "repos/a-novel/service-profile/issues/7/labels/with-feature-env",
  ]);
});

test("revoke-labels costs no call for a privileged label the pull request does not carry", (t) => {
  const { result, calls } = run(t, { carried: ["documentation"] });
  succeeds(result);
  assert.deepEqual(calls, []);
});

test("revoke-labels encodes the label in the path and reads an explicit list instead of the file", (t) => {
  const { result, calls } = run(t, { carried: ["needs review", "with-feature-env"], labels: "needs review" });
  succeeds(result);
  assert.deepEqual(calls, ["repos/a-novel/service-profile/issues/7/labels/needs%20review"]);
});

test("revoke-labels passes a label an earlier run removed and fails on any other error", (t) => {
  const gone = run(t, { carried: ["with-feature-env"], answers: { "with-feature-env": "gh: Not Found (HTTP 404)" } });
  succeeds(gone.result);
  const broken = run(t, { carried: ["with-feature-env"], answers: { "with-feature-env": "gh: HTTP 502" } });
  assert.equal(broken.result.status, 1);
  assert.match(broken.result.stdout, /::error::gh: HTTP 502/);
});

test("revoke-labels fails outside a pull request event instead of revoking nothing", (t) => {
  const { result, calls } = run(t, { carried: null, pr: "" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /runs on a pull_request event/);
  assert.deepEqual(calls, []);
});
