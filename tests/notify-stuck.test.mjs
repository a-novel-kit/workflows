import assert from "node:assert/strict";
import { test } from "node:test";
import { step, succeeds, workspace } from "./helpers.mjs";

const until = "2026-10-13T12:00:00Z";
const hoursBefore = (hours) => new Date(Date.parse(until) - hours * 3_600_000).toISOString().replace(".000", "");

const pull = (changes = {}) => ({
  number: 1526,
  title: "chore(deps): refresh apko locks",
  url: "https://github.com/a-novel/service-authentication/pull/1526",
  isInMergeQueue: false,
  mergeStateStatus: "BLOCKED",
  reviewDecision: "APPROVED",
  author: { __typename: "Bot" },
  repository: { nameWithOwner: "a-novel/service-authentication" },
  autoMergeRequest: { enabledAt: hoursBefore(3) },
  reviewRequests: { nodes: [] },
  commits: {
    nodes: [{ commit: { committedDate: hoursBefore(3), signature: null, statusCheckRollup: { state: "SUCCESS" } } }],
  },
  dropped: { nodes: [] },
  ...changes,
});
const head = (commit) => ({ commits: { nodes: [{ commit: { ...pull().commits.nodes[0].commit, ...commit } }] } });

/** Runs the shipped scan over one search result, the caller's last success at `since`. */
function scan(t, node, since = hoursBefore(2)) {
  const w = workspace(t);
  // A search for issues and pull requests returns an empty node for each issue.
  const page = { data: { search: { pageInfo: { hasNextPage: false }, nodes: [node, {}] } } };
  w.stub(
    "gh",
    `const args = process.argv.slice(2);
    if (args[0] === 'run') console.log(${JSON.stringify(since)});
    else if (args[1].includes('/actions/runs/')) console.log(${JSON.stringify(until)});
    else console.log(${JSON.stringify(JSON.stringify(page))});`
  );
  const env = {
    GITHUB_REPOSITORY: "a-novel/.github",
    GITHUB_REPOSITORY_OWNER: "a-novel",
    GITHUB_RUN_ID: "1",
    APP_TOKEN: "token",
    CALLER: "a-novel/.github/.github/workflows/notify-stuck.yaml@refs/heads/master",
    STUCK_HOURS: "2",
  };
  succeeds(w.bash(step(".github/workflows/notify-stuck-run.yaml", "scan"), env));
  return JSON.parse(w.read("output").match(/^events=(.*)$/m)[1]);
}

test("notify-stuck posts each green bot pull request outside the queue once, after the threshold", (t) => {
  const stuck = "**Stuck** · green but not merging 2h after its last commit";
  const cases = [
    ["stuck since the last run", pull(), `${stuck} · blocked · approved · unsigned head`],
    ["already posted by an earlier run", pull(head({ committedDate: hoursBefore(5) })), undefined],
    ["not stuck yet", pull(head({ committedDate: hoursBefore(1) })), undefined],
    ["first run", pull(head({ committedDate: hoursBefore(30) })), `${stuck} · blocked · approved · unsigned head`, ""],
    ["queued", pull({ isInMergeQueue: true }), undefined],
    ["a person's", pull({ author: { __typename: "User" } }), undefined],
    ["red", pull(head({ statusCheckRollup: { state: "FAILURE" } })), undefined],
    ["pending", pull(head({ statusCheckRollup: { state: "PENDING" } })), undefined],
    [
      "dropped and disarmed",
      pull({
        mergeStateStatus: "CLEAN",
        reviewDecision: null,
        autoMergeRequest: null,
        dropped: { nodes: [{ reason: "CHECKS_TIMED_OUT" }] },
        ...head({ signature: { isValid: true } }),
      }),
      `${stuck} · clean · no review · auto-merge off · last dropped: checks timed out`,
    ],
  ];
  for (const [name, node, expected, since] of cases) {
    const events = scan(t, node, since);
    assert.deepEqual(
      events.map(({ repo, description, review }) => ({ repo, description, review })),
      expected ? [{ repo: "a-novel/service-authentication", description: expected, review: false }] : [],
      name
    );
  }
});

test("notify-stuck sends a stuck pull request waiting on a review to its requested reviewers", (t) => {
  const requested = (...reviewers) => ({ nodes: reviewers.map((requestedReviewer) => ({ requestedReviewer })) });
  const cases = [
    [
      "a person and a team",
      requested({ __typename: "User", databaseId: 1, login: "kushuh" }, { __typename: "Team", name: "maintainers" }),
      "**Stuck waiting on a review** · requested from kushuh, maintainers",
      "1",
    ],
    [
      "a team only",
      requested({ __typename: "Team", name: "maintainers" }),
      "**Stuck waiting on a review** · requested from maintainers",
      "",
    ],
    ["nobody", requested(), "**Stuck waiting on a review** · nobody requested", ""],
  ];
  for (const [name, reviewRequests, review_description, user_ids] of cases) {
    const [event] = scan(t, pull({ reviewDecision: "REVIEW_REQUIRED", reviewRequests }));
    assert.deepEqual(
      { review: event.review, review_description: event.review_description, user_ids: event.user_ids },
      { review: true, review_description, user_ids },
      name
    );
    assert.match(event.description, / · review required · /, name);
  }
});

/** Runs the shipped notify-audit check, the caller's last success at `since` and notify-audit's at `last`. */
function watch(t, { since = hoursBefore(1), last, webhook = "https://discord.test/hook" }) {
  const w = workspace(t);
  w.write("output", "");
  w.stub(
    "gh",
    `const args = process.argv.slice(2);
    if (args.includes('notify-audit.yaml')) console.log(${JSON.stringify(last ?? "")});
    else if (args[0] === 'run') console.log(${JSON.stringify(since)});
    else console.log(${JSON.stringify(until)});`
  );
  const env = {
    GITHUB_REPOSITORY: "a-novel/.github",
    GITHUB_RUN_ID: "1",
    CALLER: "a-novel/.github/.github/workflows/notify-stuck.yaml@refs/heads/master",
    WEBHOOK: webhook,
  };
  succeeds(w.bash(step(".github/workflows/notify-stuck-run.yaml", "audit"), env));
  return w.read("output").match(/^silent=(.*)$/m)?.[1];
}

test("notify-stuck alerts once when notify-audit's last success turns 2 hours old", (t) => {
  const cases = [
    ["turned silent since the last run", { last: hoursBefore(2.5) }, "true"],
    ["silent, already posted by an earlier run", { last: hoursBefore(4) }, "false"],
    ["succeeded within 2 hours", { last: hoursBefore(0.5) }, "false"],
    ["first run, silent", { since: "", last: hoursBefore(30) }, "true"],
    ["no success on record", {}, "true"],
    ["no security webhook", { last: hoursBefore(2.5), webhook: "" }, undefined],
  ];
  for (const [name, options, expected] of cases) assert.equal(watch(t, options), expected, name);
});
