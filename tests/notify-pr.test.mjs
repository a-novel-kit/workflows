import assert from "node:assert/strict";
import { test } from "node:test";
import { ghVariables, step, succeeds, workspace, manifest } from "./helpers.mjs";

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
  pull_request: { number: 7, draft: false, user: { login: "kushuh", type: "User" } },
  ...fields,
});

const runEvent = (branch, fields = {}) => ({
  workflow_run: {
    id: 900,
    name: "main",
    run_number: 41,
    run_attempt: 1,
    head_branch: branch,
    head_sha: "c0ffee",
    updated_at: "2026-10-12T11:00:00Z",
    html_url: "https://github.com/a-novel/service-authentication/actions/runs/900",
    ...fields,
  },
});

const run = (
  id,
  head_branch,
  conclusion,
  { run_attempt = 1, head_sha = "0ld", updated_at = "2026-10-12T10:30:00Z" } = {}
) => ({
  id,
  head_branch,
  conclusion,
  run_attempt,
  head_sha,
  updated_at,
});

/** Runs the decision against a stubbed gh and returns its outputs and the gh calls it made. */
function notify(
  t,
  eventName,
  event,
  pr,
  { runs = [], jobs = [], pulls = "7", at = settled, pull = {}, reviews = [], main = true, env: extra = {} } = {}
) {
  const w = workspace(t);
  w.write("output", "");
  w.write("gh.log", "");
  w.write("event.json", JSON.stringify(event));
  w.stub("sleep", "");
  w.stub(
    "gh",
    `const args = process.argv.slice(2);
    require("fs").appendFileSync(process.env.GH_LOG, JSON.stringify(args) + "\\n");
    if (args.includes("graphql")) console.log(process.env.PR);
    else if (args.some((arg) => arg.endsWith("/reviews"))) console.log(process.env.REVIEWS);
    else if (args.some((arg) => arg.split("/").length === 5 && arg.split("/")[3] === "pulls")) console.log(process.env.PULL);
    else if (args.some((arg) => arg.endsWith("/pulls"))) console.log(process.env.PULLS);
    else if (args.some((arg) => arg.includes("/runs?"))) {
      // gh skips --jq on an error and prints the body before failing.
      if (!process.env.MAIN) {
        console.log('{"message":"Not Found","status":"404"}');
        console.error("gh: Not Found (HTTP 404)");
        process.exit(1);
      }
      console.log(process.env.RUNS);
    }
    else if (args.some((arg) => arg.endsWith("/jobs"))) console.log(process.env.JOBS);
    else if (args.some((arg) => arg.includes("/actions/runs/"))) console.log(process.env.AT);`
  );
  const env = {
    GITHUB_EVENT_NAME: eventName,
    GITHUB_EVENT_PATH: `${w.cwd}/event.json`,
    GITHUB_REPOSITORY: "a-novel/service-authentication",
    GITHUB_RUN_ID: "555",
    AT: at,
    GH_LOG: `${w.cwd}/gh.log`,
    APP_TOKEN: "token",
    PR: JSON.stringify(pr),
    RUNS: runs.map((entry) => JSON.stringify(entry)).join("\n"),
    MAIN: main ? "true" : "",
    JOBS: JSON.stringify(jobs),
    PULLS: pulls,
    PULL: JSON.stringify(pull),
    REVIEWS: reviews.map((entry) => JSON.stringify(entry)).join("\n"),
    ...extra,
  };
  succeeds(w.bash(decide, env));
  const outputs = Object.fromEntries(
    [...w.read("output").matchAll(/^(\w+)<<(EOF_\w+)\n([^]*?)\n?\2$/gm)].map(([, key, , value]) => [key, value])
  );
  const calls = w.read("gh.log").trim().split("\n").filter(Boolean).map(JSON.parse);
  return { outputs, calls };
}

const headline = (description) => description.split("\n")[0];

test("notify-pr posts a person's merge and merge-queue drop, pinging its owner, never the sender", (t) => {
  const issue = (assignees) => ({
    number: 3,
    url: "https://github.com/a-novel/.github/issues/3",
    repository: { nameWithOwner: "a-novel/.github" },
    assignees: { nodes: assignees },
    projectItems: { nodes: [] },
  });
  const conflict = { dropped: { nodes: [{ reason: "MERGE_CONFLICT" }] } };
  const dropped = "**Dropped from the merge queue** · merge conflict";
  const cases = [
    ["merged", "closed", {}, { state: "MERGED" }, ["released", "**Merged**", "", "false"]],
    ["closed", "closed", {}, { state: "CLOSED" }, [""]],
    ["dropped from the queue", "dequeued", {}, conflict, ["failed", dropped, "1", "false"]],
    ["dropped by its owner", "dequeued", { sender: { id: 1 } }, conflict, ["failed", dropped, "", "false"]],
    [
      "owned through its issue",
      "dequeued",
      { sender: { id: 1 } },
      { ...conflict, assignees: { nodes: [] }, closingIssuesReferences: { nodes: [issue([dada])] } },
      ["failed", dropped, "2", "false"],
    ],
    ["owned by nobody", "dequeued", {}, { ...conflict, assignees: { nodes: [] } }, ["failed", dropped, "", "true"]],
    ["timed out, re-queued", "dequeued", {}, { dropped: { nodes: [{ reason: "CHECKS_TIMED_OUT" }] } }, [""]],
    [
      "timed out past the re-queues",
      "dequeued",
      {},
      { dropped: { nodes: Array(4).fill({ reason: "CHECKS_TIMED_OUT" }) } },
      ["failed", "**Dropped from the merge queue** · checks timed out", "1", "false"],
    ],
    ["dropped as it merged", "dequeued", {}, { state: "MERGED", dropped: { nodes: [{ reason: "MERGED" }] } }, [""]],
    ["assigned", "assigned", {}, {}, [""]],
    ["back to draft", "converted_to_draft", {}, { isDraft: true }, [""]],
    ["reopened", "reopened", {}, {}, [""]],
  ];
  for (const [name, action, event, pr, expected] of cases) {
    const { outputs } = notify(t, "pull_request_target", prEvent(action, event), pullRequest(pr));
    const [color, title, users, role] = expected;
    assert.equal(outputs.channel, "reviews", name);
    assert.equal(outputs.color, color, name);
    if (!color) continue;
    assert.equal(headline(outputs.description), title, name);
    assert.equal(outputs.users, users, name);
    assert.equal(outputs.role, role, name);
  }
});

test("notify-pr asks for a reviewer, follows review requests, and tells the owner a review landed", (t) => {
  const review = (state, body = "", login = "EmperorDada") => ({
    review: { state, body, user: { login }, html_url: "https://github.com/a-novel/service-authentication/pull/7#r1" },
  });
  const link = " · [read the review](https://github.com/a-novel/service-authentication/pull/7#r1)";
  const requested = { reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", ...dada } }] } };
  const approved = { latestOpinionatedReviews: { nodes: [{ state: "APPROVED", author: { login: "EmperorDada" } }] } };
  const cases = [
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
    ["ready after a review", "pull_request_target", "opened", {}, approved, [""]],
    [
      "last reviewer removed",
      "pull_request_target",
      "review_request_removed",
      { requested_reviewer: { id: 2, login: "EmperorDada" } },
      {},
      ["upcoming", "**Needs a reviewer**", "", "true"],
    ],
    [
      "last request removed after a review",
      "pull_request_target",
      "review_request_removed",
      { requested_reviewer: { id: 2, login: "EmperorDada" } },
      approved,
      ["cancelled", "**Review request removed** for EmperorDada", "", "false"],
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
  ];
  for (const [name, eventName, action, event, pr, expected] of cases) {
    const { outputs } = notify(t, eventName, prEvent(action, event), pullRequest(pr));
    const [color, title, users, role] = expected;
    assert.equal(outputs.channel, "reviews", name);
    assert.equal(outputs.color, color, name);
    if (!color) continue;
    assert.equal(headline(outputs.description), title, name);
    assert.equal(outputs.users, users, name);
    assert.equal(outputs.role, role, name);
  }
});

test("notify-pr reads its pull request with owner and name as strings and the number as an Int", (t) => {
  const env = { GITHUB_REPOSITORY: "true/123" };
  const { calls } = notify(t, "pull_request_target", prEvent("ready_for_review"), pullRequest(), { env });
  assert.deepEqual(ghVariables(calls.find((args) => args.includes("graphql"))), {
    owner: "true",
    name: "123",
    number: 7,
  });
});

test("notify-pr folds the changes of a pull request's first ready minute into its ready post", (t) => {
  const reviewer = { requested_reviewer: { id: 2, login: "EmperorDada" } };
  // GitHub does not document whether these events bump updated_at, so the run's creation dates them.
  const stale = {
    ...reviewer,
    pull_request: { number: 7, updated_at: settling, user: { login: "kushuh", type: "User" } },
  };
  const timings = [
    ["reviewer requested within the minute", "review_requested", reviewer, settling, false],
    ["reviewer requested after it, stale updated_at", "review_requested", stale, settled, true],
    ["reviewer requested after it", "review_requested", reviewer, settled, true],
    ["reviewer removed within the minute", "review_request_removed", reviewer, settling, false],
  ];
  for (const [name, action, event, at, posts] of timings) {
    const { outputs } = notify(t, "pull_request_target", prEvent(action, event), pullRequest(), { at });
    assert.equal(Boolean(outputs.color), posts, name);
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
  const { outputs } = notify(t, "pull_request_target", prEvent("opened"), pr);
  assert.equal(outputs.title, "a-novel/service-authentication#7 · feat(session): rotate refresh tokens");
  assert.equal(outputs.url, "https://github.com/a-novel/service-authentication/pull/7");
  // The Target date wins over the milestone's, read at noon UTC so every time zone shows its day.
  const details = [
    "Status: in the merge queue · Review: approved by EmperorDada · waiting on core",
    "Closes [a-novel/.github#3](https://github.com/a-novel/.github/issues/3) · Milestone [Sessions](https://github.com/a-novel/m/1)",
    "Due <t:1792843200:D> (<t:1792843200:R>) · Opened <t:1791799200:R> by kushuh",
  ];
  assert.deepEqual(outputs.description.split("\n").slice(1), details);
  const merged = notify(t, "pull_request_target", prEvent("closed"), { ...pr, state: "MERGED", mergeQueueEntry: null });
  assert.equal(
    merged.outputs.description.split("\n")[1],
    "Status: merged · Review: approved by EmperorDada",
    "a merged pull request waits on nobody"
  );
  const plain = notify(t, "pull_request_target", prEvent("opened"), pullRequest()).outputs;
  const plainDetails = ["Status: open · Review: no reviewer", "Opened <t:1791799200:R> by kushuh"];
  assert.deepEqual(plain.description.split("\n").slice(1, 3), plainDetails);
});

test("notify-pr gives a pull request waiting on a reviewer the commands to take its review or self-approve it", (t) => {
  const waiting = notify(t, "pull_request_target", prEvent("opened"), pullRequest()).outputs;
  assert.deepEqual(waiting.description.split("\n").slice(3), [
    "Assign yourself as reviewer:",
    "```sh",
    'gh pr edit 7 -R a-novel/service-authentication --add-reviewer "$(gh api user -q .login)"',
    "```",
    "Self-approve your own pull request (repository admins and core only):",
    "```sh",
    "gh workflow run approve-pr.yaml -R a-novel/service-authentication -f pull_request=7",
    "```",
  ]);
  const requested = { reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", ...dada } }] } };
  const event = prEvent("ready_for_review", { sender: { id: 1 } });
  const reviewing = notify(t, "pull_request_target", event, pullRequest(requested)).outputs;
  assert.equal(reviewing.color, "started");
  assert(!reviewing.description.includes("```"), "a pull request with a reviewer carries no commands");
});

test("notify-pr flags a bot's failing pull request once, then its refails, merge or close", (t) => {
  const failed = run(800, "renovate/golib", "failure");
  const queued = run(801, "gh-readonly-queue/master/pr-7-0123abcd", "failure");
  const rerun = run(802, "renovate/golib", "success", { run_attempt: 2 });
  // Renovate's opened and labeled events each start a run of the same commit.
  const twin = (updated_at) => run(899, "renovate/golib", "failure", { head_sha: "c0ffee", updated_at });
  const other = [run(700, "renovate/other", "failure"), run(701, "gh-readonly-queue/master/pr-17-abcd", "failure")];
  const cases = [
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
      "same commit, already reported",
      "workflow_run",
      runEvent("renovate/golib"),
      bot(),
      [twin("2026-10-12T10:59:00Z")],
      [""],
    ],
    [
      "same commit, reported after this one",
      "workflow_run",
      runEvent("renovate/golib"),
      bot(),
      [twin("2026-10-12T11:01:00Z")],
      ["failed", "**CI failed**", "true"],
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
  ];
  for (const [name, eventName, event, pr, runs, expected] of cases) {
    const { outputs, calls } = notify(t, eventName, event, pr, { runs, jobs: ["test-go", "lint-go"] });
    const [color, title, role] = expected;
    assert.equal(outputs.color, color, name);
    const graphql = calls.find((args) => args.includes("graphql"));
    assert.ok(graphql.includes("number=7"), name);
    if (!color) continue;
    assert.equal(outputs.channel, "dependencies", name);
    assert.equal(headline(outputs.description), title, name);
    assert.equal(outputs.users, "", name);
    assert.equal(outputs.role, role, name);
    if (eventName === "workflow_run") {
      assert.equal(
        outputs.description.split("\n").at(-1),
        "[main #41](https://github.com/a-novel/service-authentication/actions/runs/900) failed: test-go, lint-go",
        name
      );
    }
  }
});

test("notify-pr posts nothing when a bot merges in a repository without a main workflow", (t) => {
  const { outputs, calls } = notify(t, "pull_request_target", prEvent("closed"), bot({ state: "MERGED" }), {
    main: false,
  });
  assert.equal(outputs.color, "");
  assert.ok(calls.some((args) => args.some((arg) => arg.includes("/workflows/main.yaml/runs?"))));
});

test("notify-pr skips a failed run whose branch no longer has an open pull request", (t) => {
  const { outputs, calls } = notify(t, "workflow_run", runEvent("renovate/gone"), bot(), { pulls: "" });
  assert.deepEqual(outputs, {});
  assert.ok(calls.every((args) => !args.includes("graphql")));
});

test("notify-pr reads a relayed review back from the pull request instead of trusting the run", (t) => {
  const relayed = (fields = {}) =>
    runEvent("feature", { name: "pr-relay", event: "pull_request_review", pull_requests: [{ number: 7 }], ...fields });
  const person = { number: 7, draft: false, user: { login: "kushuh", type: "User" } };
  const reviewed = (state, at) => ({
    state,
    body: "",
    submitted_at: at,
    user: { id: 2, login: "EmperorDada" },
    html_url: "https://github.com/a-novel/service-authentication/pull/7#r9",
  });
  const older = reviewed("COMMENTED", "2026-10-12T10:00:00Z");
  const link = " · [read the review](https://github.com/a-novel/service-authentication/pull/7#r9)";
  const cases = [
    [
      "approval",
      relayed(),
      person,
      [older, reviewed("APPROVED", "2026-10-12T11:00:00Z")],
      ["succeeded", `**Approved** by EmperorDada${link}`, "1"],
    ],
    [
      "dismissal",
      relayed(),
      person,
      [older, reviewed("DISMISSED", "2026-10-12T11:00:00Z")],
      ["in-progress", "**Review dismissed** · EmperorDada", "1"],
    ],
    // A run that names no pull request: the commit's open pull request stands in.
    [
      "unnamed pull request",
      relayed({ pull_requests: [] }),
      person,
      [reviewed("APPROVED", "2026-10-12T11:00:00Z")],
      ["succeeded", `**Approved** by EmperorDada${link}`, "1"],
    ],
    [
      "bot's pull request",
      relayed(),
      { ...person, user: { login: "renovate[bot]", type: "Bot" } },
      [reviewed("APPROVED", "2026-10-12T11:00:00Z")],
      [undefined],
    ],
    ["draft", relayed(), { ...person, draft: true }, [reviewed("APPROVED", "2026-10-12T11:00:00Z")], [undefined]],
    [
      "relayed merge group",
      relayed({ event: "merge_group" }),
      person,
      [reviewed("APPROVED", "2026-10-12T11:00:00Z")],
      [undefined],
    ],
  ];
  for (const [name, event, pull, reviews, expected] of cases) {
    const { outputs } = notify(t, "workflow_run", event, pullRequest(), { pull, reviews });
    const [color, title, users] = expected;
    assert.equal(outputs.color, color, name);
    if (!color) continue;
    assert.equal(headline(outputs.description), title, name);
    assert.equal(outputs.users, users, name);
  }
  // The job admits a relayed review; the step reads everything else back.
  const condition = manifest(".github/workflows/notify-pr-run.yaml").jobs.notify.if;
  assert.match(condition, /github\.event_name == 'workflow_run' && github\.event\.workflow_run\.name == 'pr-relay'/);
  assert.match(condition, /workflow_run\.event == 'pull_request_review'/);
});
