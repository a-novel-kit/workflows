import assert from "node:assert/strict";
import { test } from "node:test";
import { step, succeeds, workspace } from "./helpers.mjs";

const decide = step(".github/workflows/notify-pr-run.yaml", "state");
const kushuh = { databaseId: 1, login: "kushuh" };
const dada = { databaseId: 2, login: "EmperorDada" };
// The pull request turns ready at 10:00, so its posts settle at 10:01.
const settling = "2026-10-12T10:00:30Z";
const settled = "2026-10-12T10:05:00Z";

const pullRequest = (fields = {}) => ({
  number: 7,
  title: "feat(session): rotate refresh tokens",
  url: "https://github.com/a-novel/service-authentication/pull/7",
  state: "OPEN",
  isDraft: false,
  createdAt: "2026-10-12T10:00:00Z",
  headRefName: "feat/session/rotate",
  baseRefName: "master",
  reviewDecision: "REVIEW_REQUIRED",
  author: { __typename: "User", login: "kushuh" },
  assignees: { nodes: [kushuh] },
  reviewRequests: { nodes: [] },
  latestOpinionatedReviews: { nodes: [] },
  mergeQueueEntry: null,
  milestone: null,
  closingIssuesReferences: { nodes: [] },
  ready: { nodes: [] },
  dropped: { nodes: [] },
  ...fields,
});

const bot = (fields = {}) =>
  pullRequest({
    title: "chore(deps): update golib",
    headRefName: "renovate/golib",
    author: { __typename: "Bot", login: "anovelbot-dependencies" },
    ...fields,
  });

const prEvent = (action, fields = {}) => ({
  action,
  sender: { id: 2, login: "EmperorDada" },
  pull_request: { number: 7, draft: false, updated_at: settled, user: { login: "kushuh", type: "User" } },
  ...fields,
});

const runEvent = (branch, fields = {}) => ({
  workflow_run: {
    id: 900,
    name: "main",
    run_number: 41,
    run_attempt: 1,
    head_branch: branch,
    html_url: "https://github.com/a-novel/service-authentication/actions/runs/900",
    ...fields,
  },
});

const run = (id, head_branch, conclusion, run_attempt = 1) => ({ id, head_branch, conclusion, run_attempt });

/** Runs the decision against a stubbed gh and returns its outputs and the gh calls it made. */
function notify(t, eventName, event, pr, { runs = [], jobs = [], pulls = "7" } = {}) {
  const w = workspace(t);
  w.write("output", "");
  w.write("event.json", JSON.stringify(event));
  w.stub("sleep", "");
  w.stub(
    "gh",
    `const args = process.argv.slice(2);
    require("fs").appendFileSync(process.env.GH_LOG, JSON.stringify(args) + "\\n");
    if (args.includes("graphql")) console.log(process.env.PR);
    else if (args.some((arg) => arg.endsWith("/pulls"))) console.log(process.env.PULLS);
    else if (args.some((arg) => arg.includes("/runs?"))) console.log(process.env.RUNS);
    else if (args.some((arg) => arg.endsWith("/jobs"))) console.log(process.env.JOBS);`
  );
  succeeds(
    w.bash(decide, {
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: `${w.cwd}/event.json`,
      GITHUB_REPOSITORY: "a-novel/service-authentication",
      GH_LOG: `${w.cwd}/gh.log`,
      APP_TOKEN: "token",
      PR: JSON.stringify(pr),
      RUNS: runs.map((entry) => JSON.stringify(entry)).join("\n"),
      JOBS: JSON.stringify(jobs),
      PULLS: pulls,
    })
  );
  const outputs = Object.fromEntries(
    [...w.read("output").matchAll(/^(\w+)<<(EOF_\w+)\n([^]*?)\n?\2$/gm)].map(([, key, , value]) => [key, value])
  );
  const calls = w
    .read("gh.log")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return { outputs, calls };
}

const headline = (description) => description.split("\n")[0];

test("notify-pr posts a person's pull request lifecycle and pings its owner, never the sender", (t) => {
  const issue = (assignees) => ({
    number: 3,
    url: "https://github.com/a-novel/.github/issues/3",
    repository: { nameWithOwner: "a-novel/.github" },
    assignees: { nodes: assignees },
    projectItems: { nodes: [] },
  });
  for (const [name, action, event, pr, expected] of [
    ["ready", "opened", {}, {}, ["started", "**Ready for review** · assigned to kushuh", "1", "false"]],
    ["ready by its owner", "ready_for_review", { sender: { id: 1 } }, {}, ["started", undefined, "", "false"]],
    [
      "owned through its issue",
      "opened",
      { sender: { id: 1 } },
      { assignees: { nodes: [] }, closingIssuesReferences: { nodes: [issue([dada])] } },
      ["started", "**Ready for review** · nobody assigned", "2", "false"],
    ],
    [
      "owned by nobody",
      "opened",
      {},
      { assignees: { nodes: [] } },
      ["started", "**Ready for review** · nobody assigned", "", "true"],
    ],
    ["assigned while it settles", "assigned", { pull_request: { number: 7, updated_at: settling } }, {}, [""]],
    ["assigned later", "assigned", {}, {}, ["upcoming", "**Assignees changed** · assigned to kushuh", "1", "false"]],
    ["back to draft", "converted_to_draft", {}, { isDraft: true }, ["cancelled", "**Back to draft**", "", "false"]],
    ["merged", "closed", {}, { state: "MERGED" }, ["succeeded", "**Merged**", "", "false"]],
    ["closed", "closed", {}, { state: "CLOSED" }, ["cancelled", "**Closed** without merging", "", "false"]],
    ["reopened", "reopened", {}, {}, ["started", "**Reopened** · assigned to kushuh", "1", "false"]],
    [
      "dropped from the queue",
      "dequeued",
      {},
      { dropped: { nodes: [{ reason: "MERGE_CONFLICT" }] } },
      ["failed", "**Dropped from the merge queue** · merge conflict", "1", "false"],
    ],
    ["timed out, re-queued", "dequeued", {}, { dropped: { nodes: [{ reason: "CHECKS_TIMED_OUT" }] } }, [""]],
    [
      "timed out past the re-queues",
      "dequeued",
      {},
      { dropped: { nodes: Array(4).fill({ reason: "CHECKS_TIMED_OUT" }) } },
      ["failed", "**Dropped from the merge queue** · checks timed out", "1", "false"],
    ],
    ["dropped as it merged", "dequeued", {}, { state: "MERGED", dropped: { nodes: [{ reason: "MERGED" }] } }, [""]],
  ]) {
    const { outputs } = notify(t, "pull_request_target", prEvent(action, event), pullRequest(pr));
    const [color, title, users, role] = expected;
    assert.equal(outputs.lifecycle_color, color, name);
    if (!color) continue;
    assert.equal(outputs.lifecycle_channel, "pull_requests", name);
    if (title) assert.equal(headline(outputs.lifecycle_description), title, name);
    assert.equal(outputs.lifecycle_users, users, name);
    assert.equal(outputs.lifecycle_role, role, name);
  }
});

test("notify-pr asks for a reviewer, follows review requests, and tells the owner a review landed", (t) => {
  const review = (state, body = "", login = "EmperorDada") => ({
    review: { state, body, user: { login }, html_url: "https://github.com/a-novel/service-authentication/pull/7#r1" },
  });
  const link = " · [read the review](https://github.com/a-novel/service-authentication/pull/7#r1)";
  const requested = { reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", ...dada } }] } };
  for (const [name, eventName, action, event, pr, expected] of [
    [
      "ready without reviewers",
      "pull_request_target",
      "opened",
      {},
      {},
      ["upcoming", "**Needs a reviewer**", "", "true"],
    ],
    [
      "ready with a reviewer",
      "pull_request_target",
      "ready_for_review",
      { sender: { id: 1 } },
      requested,
      ["started", "**Review requested** from EmperorDada", "2", "false"],
    ],
    [
      "reviewer requested later",
      "pull_request_target",
      "review_requested",
      { sender: { id: 1 }, requested_reviewer: { id: 2, login: "EmperorDada" } },
      requested,
      ["started", "**Review requested** from EmperorDada", "2", "false"],
    ],
    [
      "reviewer requested while it settles",
      "pull_request_target",
      "review_requested",
      { pull_request: { number: 7, updated_at: settling }, requested_reviewer: { id: 2, login: "EmperorDada" } },
      requested,
      [""],
    ],
    [
      "last reviewer removed",
      "pull_request_target",
      "review_request_removed",
      { requested_reviewer: { id: 2, login: "EmperorDada" } },
      {},
      ["upcoming", "**Needs a reviewer**", "", "true"],
    ],
    [
      "approved",
      "pull_request_review",
      "submitted",
      review("approved"),
      {},
      ["succeeded", `**Approved** by EmperorDada${link}`, "1", "false"],
    ],
    [
      "changes requested",
      "pull_request_review",
      "submitted",
      review("changes_requested"),
      {},
      ["in-progress", `**Changes requested** by EmperorDada${link}`, "1", "false"],
    ],
    ["thread reply", "pull_request_review", "submitted", review("commented"), {}, [""]],
    ["author's own note", "pull_request_review", "submitted", review("commented", "Done.", "kushuh"), {}, [""]],
    [
      "comment review",
      "pull_request_review",
      "submitted",
      review("commented", "Looks close."),
      {},
      ["upcoming", `**Reviewed** by EmperorDada${link}`, "1", "false"],
    ],
    [
      "approval dismissed",
      "pull_request_review",
      "dismissed",
      review("dismissed"),
      {},
      ["in-progress", "**Review dismissed** · EmperorDada", "1", "false"],
    ],
    [
      "dismissed, still approved",
      "pull_request_review",
      "dismissed",
      review("dismissed"),
      { reviewDecision: "APPROVED" },
      ["in-progress", "**Review dismissed** · EmperorDada", "", "false"],
    ],
  ]) {
    const { outputs } = notify(t, eventName, prEvent(action, event), pullRequest(pr));
    const [color, title, users, role] = expected;
    assert.equal(outputs.review_color, color, name);
    if (!color) continue;
    assert.equal(headline(outputs.review_description), title, name);
    assert.equal(outputs.review_users, users, name);
    assert.equal(outputs.review_role, role, name);
  }
});

test("notify-pr describes status, reviews, links and dates beyond the headline", (t) => {
  const pr = pullRequest({
    mergeQueueEntry: { state: "QUEUED" },
    milestone: { title: "Sessions", url: "https://github.com/a-novel/m/1", dueOn: "2026-10-31T07:00:00Z" },
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: "Team", name: "core" } }] },
    latestOpinionatedReviews: { nodes: [{ state: "APPROVED", author: { login: "EmperorDada" } }] },
    closingIssuesReferences: {
      nodes: [
        {
          number: 3,
          url: "https://github.com/a-novel/.github/issues/3",
          repository: { nameWithOwner: "a-novel/.github" },
          assignees: { nodes: [] },
          projectItems: { nodes: [{ target: null }, { target: { date: "2026-10-24" } }] },
        },
      ],
    },
  });
  const { outputs } = notify(t, "pull_request_target", prEvent("reopened"), pr);
  assert.equal(outputs.title, "a-novel/service-authentication#7 · feat(session): rotate refresh tokens");
  assert.equal(outputs.url, "https://github.com/a-novel/service-authentication/pull/7");
  // The Target date wins over the milestone's, read at noon UTC so every time zone shows its day.
  assert.deepEqual(outputs.lifecycle_description.split("\n").slice(1), [
    "Status: in the merge queue · Review: approved by EmperorDada · waiting on core",
    "Closes [a-novel/.github#3](https://github.com/a-novel/.github/issues/3) · Milestone [Sessions](https://github.com/a-novel/m/1)",
    "Due <t:1792843200:D> (<t:1792843200:R>) · Opened <t:1791799200:R> by kushuh",
  ]);
  const merged = notify(t, "pull_request_target", prEvent("closed"), { ...pr, state: "MERGED", mergeQueueEntry: null });
  assert.equal(
    merged.outputs.lifecycle_description.split("\n")[1],
    "Status: merged · Review: approved by EmperorDada",
    "a merged pull request waits on nobody"
  );
  const plain = notify(t, "pull_request_target", prEvent("reopened"), pullRequest()).outputs;
  assert.deepEqual(plain.lifecycle_description.split("\n").slice(1), [
    "Status: open · Review: no reviewer",
    "Opened <t:1791799200:R> by kushuh",
  ]);
});

test("notify-pr flags a bot's failing pull request once, then its refails, merge or close", (t) => {
  const failed = run(800, "renovate/golib", "failure");
  const queued = run(801, "gh-readonly-queue/master/pr-7-0123abcd", "failure");
  const rerun = run(802, "renovate/golib", "success", 2);
  const other = [run(700, "renovate/other", "failure"), run(701, "gh-readonly-queue/master/pr-17-abcd", "failure")];
  for (const [name, eventName, event, pr, runs, expected] of [
    ["first failure", "workflow_run", runEvent("renovate/golib"), bot(), other, ["failed", "**CI failed**", "true"]],
    [
      "failed again",
      "workflow_run",
      runEvent("renovate/golib"),
      bot(),
      [failed],
      ["failed", "**CI failed again**", "false"],
    ],
    [
      "failed again in the queue",
      "workflow_run",
      runEvent("gh-readonly-queue/master/pr-7-0123abcd"),
      bot(),
      [queued],
      ["failed", "**CI failed again**", "false"],
    ],
    [
      "rerun failed",
      "workflow_run",
      runEvent("renovate/golib", { run_attempt: 2 }),
      bot(),
      [],
      ["failed", "**CI failed again**", "false"],
    ],
    ["already closed", "workflow_run", runEvent("renovate/golib"), bot({ state: "CLOSED" }), [], [""]],
    [
      "a person's queue failure",
      "workflow_run",
      runEvent("gh-readonly-queue/master/pr-7-0123abcd"),
      pullRequest(),
      [],
      [""],
    ],
    [
      "merged after failing",
      "pull_request_target",
      prEvent("closed"),
      bot({ state: "MERGED" }),
      [failed],
      ["succeeded", "**Merged** after failing CI", "false"],
    ],
    [
      "merged after a rerun",
      "pull_request_target",
      prEvent("closed"),
      bot({ state: "MERGED" }),
      [rerun],
      ["succeeded", "**Merged** after failing CI", "false"],
    ],
    [
      "closed after failing",
      "pull_request_target",
      prEvent("closed"),
      bot({ state: "CLOSED" }),
      [queued],
      ["cancelled", "**Closed** after failing CI", "false"],
    ],
    ["merged clean", "pull_request_target", prEvent("closed"), bot({ state: "MERGED" }), other, [""]],
  ]) {
    const { outputs, calls } = notify(t, eventName, event, pr, { runs, jobs: ["test-go", "lint-go"] });
    const [color, title, role] = expected;
    assert.equal(outputs.lifecycle_color, color, name);
    assert.equal(outputs.review_color, "", name);
    const graphql = calls.find((args) => args.includes("graphql"));
    assert.ok(graphql.includes("number=7"), name);
    if (!color) continue;
    assert.equal(outputs.lifecycle_channel, "dependencies", name);
    assert.equal(headline(outputs.lifecycle_description), title, name);
    assert.equal(outputs.lifecycle_users, "", name);
    assert.equal(outputs.lifecycle_role, role, name);
    if (eventName === "workflow_run") {
      assert.equal(
        outputs.lifecycle_description.split("\n").at(-1),
        "[main #41](https://github.com/a-novel/service-authentication/actions/runs/900) failed: test-go, lint-go",
        name
      );
    }
  }
});

test("notify-pr skips a failed run whose branch no longer has an open pull request", (t) => {
  const { outputs, calls } = notify(t, "workflow_run", runEvent("renovate/gone"), bot(), { pulls: "" });
  assert.deepEqual(outputs, {});
  assert.ok(calls.every((args) => !args.includes("graphql")));
});
