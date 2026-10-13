import assert from "node:assert/strict";
import { test } from "node:test";
import { step, workspace } from "./helpers.mjs";

const check = step("generic-actions/check-dependencies/action.yaml", "Check dependency manifests");

/** Runs the gate against a stubbed gh; returns its exit status, output and the gh calls it made. */
function gate(
  t,
  { event = "pull_request", action = "opened", author = "User", files = [], commits = [], labels = [] }
) {
  const w = workspace(t);
  w.write("summary", "");
  w.write("gh.log", "");
  w.stub(
    "gh",
    `const args = process.argv.slice(2);
    require("fs").appendFileSync(process.env.GH_LOG, JSON.stringify(args) + "\\n");
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (args.includes("DELETE")) process.exit(0);
    if (path.endsWith("/files")) console.log(process.env.FILES);
    else if (path.endsWith("/commits")) console.log(process.env.COMMITS);
    else if (path.endsWith("/labels")) console.log(process.env.LABELS);`
  );
  const result = w.bash(check, {
    GH_TOKEN: "token",
    GITHUB_REPOSITORY: "a-novel/service-authentication",
    GH_LOG: `${w.cwd}/gh.log`,
    LABEL: "allow-dependency-change",
    EVENT: event,
    ACTION: action,
    PR: "7",
    AUTHOR_TYPE: author,
    FILES: files.join("\n"),
    COMMITS: commits.join("\n"),
    LABELS: labels.join("\n"),
  });
  const calls = w
    .read("gh.log")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { status: result.status, output: result.stdout + result.stderr, calls, summary: w.read("summary") };
}

const removed = (calls) =>
  calls.some((args) => args.includes("DELETE") && args.some((arg) => arg.endsWith("/labels/allow-dependency-change")));

test("check-dependencies holds a person's manifest change until a reviewer acknowledges it", (t) => {
  const label = ["allow-dependency-change"];
  for (const [name, input, passes] of [
    ["merge-queue group", { event: "merge_group", files: ["go.mod"] }, true],
    ["code only", { files: ["internal/core/session.go", "README.md"] }, true],
    ["lockfiles only", { files: ["go.sum", "pnpm-lock.yaml", "golangci-lint.sum"] }, true],
    ["look-alike names", { files: ["docs/package.json.md", "go.modules"] }, true],
    ["go.mod", { files: ["go.mod", "go.sum"] }, false],
    ["a tool's modfile", { files: ["golangci-lint.mod"] }, false],
    ["go.work", { files: ["go.work"] }, false],
    ["nested package.json", { files: ["pkg/js/package.json"] }, false],
    ["pnpm workspace", { files: ["pnpm-workspace.yaml"] }, false],
    ["acknowledged", { action: "labeled", files: ["go.mod"], labels: ["dependencies", ...label] }, true],
    ["another label", { action: "labeled", files: ["go.mod"], labels: ["dependencies"] }, false],
    ["bot and its commits", { author: "Bot", files: ["go.mod"], commits: ["Bot", "Bot"] }, true],
    ["a person's commit on a bot's branch", { author: "Bot", files: ["go.mod"], commits: ["Bot", "User"] }, false],
    ["an unlinked commit author on a bot's branch", { author: "Bot", files: ["go.mod"], commits: ["none"] }, false],
    ["bot commits, a person's pull request", { files: ["go.mod"], commits: ["Bot"] }, false],
  ]) {
    const { status, output } = gate(t, input);
    assert.equal(status === 0, passes, `${name}: ${output}`);
    if (!passes) assert.match(output, /::error::This pull request changes dependency manifests: /, name);
  }
});

test("check-dependencies names the manifests and records an acknowledgement", (t) => {
  const failed = gate(t, { files: ["go.mod", "go.sum", "pkg/js/package.json"] });
  assert.match(
    failed.output,
    /manifests: go\.mod, pkg\/js\/package\.json\. A reviewer acknowledges them with the "allow-dependency-change" label\./
  );

  const passed = gate(t, { action: "labeled", files: ["go.mod"], labels: ["allow-dependency-change"] });
  assert.equal(passed.status, 0, passed.output);
  assert.equal(passed.summary, "## Dependency manifests\n\nAcknowledged by `allow-dependency-change`:\n\n- `go.mod`\n");
  assert.equal(removed(passed.calls), false);
});

test("check-dependencies removes the acknowledgement when a push changes the head", (t) => {
  const pushed = gate(t, { action: "synchronize", files: ["go.mod"], labels: ["allow-dependency-change"] });
  assert.equal(pushed.status, 1, pushed.output);
  assert.equal(removed(pushed.calls), true);

  // Without a manifest change, a push leaves the label to the reviewer.
  const unrelated = gate(t, { action: "synchronize", files: ["main.go"], labels: ["allow-dependency-change"] });
  assert.equal(unrelated.status, 0, unrelated.output);
  assert.equal(removed(unrelated.calls), false);

  // A merge-queue group never reads the pull request.
  assert.deepEqual(gate(t, { event: "merge_group", files: ["go.mod"] }).calls, []);
});
