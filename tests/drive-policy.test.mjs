// Exact-head approval and merge-queue provenance through GitHub boundary responses.
import assert from "node:assert/strict";
import { test } from "node:test";
import { APPROVAL, COMPARISON, LABEL, Policy } from "../node-actions/test-playwright/drive/policy.mjs";

function fixture() {
  const pr = {
    number: 1,
    state: "open",
    head: { sha: "head", repo: { full_name: "example/studio" } },
    base: { ref: "master" },
  };
  const event = {
    event: "labeled",
    label: { name: LABEL },
    created_at: "2026-09-01T10:00:00Z",
    id: 1,
    actor: { type: "User", login: "reviewer" },
  };
  const receipt = {
    context: APPROVAL,
    creator: { login: "github-actions[bot]" },
    state: "success",
    created_at: "2026-09-01T10:00:01Z",
    target_url: "https://github.com/example/studio/actions/runs/41/attempts/1",
  };
  const comparison = {
    ...receipt,
    context: COMPARISON,
    created_at: "2026-09-01T10:01:00Z",
    description: "approved",
    target_url: "https://github.com/example/studio/actions/runs/42/attempts/2",
  };
  const events = [event],
    statuses = [comparison, receipt];
  const github = {
    repository: "example/studio",
    pages: async (path) => (path.startsWith("issues/") ? events : statuses),
    request: async (path) =>
      path.startsWith("collaborators/")
        ? { permission: "write" }
        : path.includes("/41/")
          ? {
              event: "pull_request_target",
              path: ".github/workflows/visual-tests.yaml",
              display_title: "Visual approval 1 head master labeled",
            }
          : { head_sha: "head", path: ".github/workflows/main.yaml", event: "push" },
    successfulJob: async () => true,
    successfulBrowserRun: async () => true,
  };
  return { pr, event, receipt, comparison, events, statuses, github, policy: new Policy(github) };
}
test("approval requires human write access and a current-head receipt", async () => {
  let value = fixture();
  assert.equal(await value.policy.approved(value.pr), true);
  for (const mutate of [
    (f) => (f.event.actor.type = "Bot"),
    (f) => (f.event.performed_via_github_app = {}),
    (f) => (f.receipt.state = "failure"),
    (f) => (f.receipt.target_url = "another-pr"),
    (f) => (f.receipt.created_at = "2026-09-01T09:00:00Z"),
    (f) => (f.github.request = async () => ({ permission: "read" })),
  ]) {
    value = fixture();
    mutate(value);
    assert.equal(await value.policy.approved(value.pr), false);
  }
});
test("candidate statuses cannot forge trusted approval receipts", async () => {
  let f = fixture();
  f.receipt.target_url = f.comparison.target_url;
  assert.equal(await f.policy.approved(f.pr), false);
  f = fixture();
  const request = f.github.request;
  f.github.request = async (path) =>
    path.includes("/41/")
      ? { ...(await request(path)), display_title: "Visual approval 1 previous-head master labeled" }
      : request(path);
  assert.equal(await f.policy.approved(f.pr), false);
});
test("label removal revokes approval while preserving pre-merge history", async () => {
  const f = fixture();
  f.events.push({ ...f.event, event: "unlabeled", id: 2, created_at: "2026-09-01T12:00:00Z" });
  assert.equal(await f.policy.approved(f.pr), false);
  assert.equal(await f.policy.approved(f.pr, "2026-09-01T11:00:00Z"), true);
});
test("proof requires a successful browser job and matching baseline", async () => {
  const f = fixture();
  assert.equal(await f.policy.proof(f.pr, "base"), "approved");
  f.github.successfulBrowserRun = async () => false;
  assert.equal(await f.policy.proof(f.pr, "base"), null);
  f.github.successfulBrowserRun = async () => true;
  f.comparison.description = "matched:base";
  assert.equal(await f.policy.proof(f.pr, "base"), "matched");
  assert.equal(await f.policy.proof(f.pr, "new-base"), null);
  f.comparison.target_url = "https://github.com/other/repo/actions/runs/42/attempts/2";
  assert.equal(await f.policy.proof(f.pr, "base"), null);
});
test("queue requires proof for every PR", async () => {
  const f = fixture(),
    group = { merge_group: { base_sha: "base", head_sha: "group" } };
  f.policy.associated = async () => [f.pr, { ...f.pr, number: 2 }];
  for (const [proofs, expected] of [
    [["approved", "matched"], true],
    [["approved", null], false],
    [["matched", "matched"], false],
  ]) {
    f.policy.proof = async () => proofs.shift();
    assert.equal(await f.policy.allows(group, "merge_group", "group", "queue", "base"), expected);
  }
  assert.equal(await f.policy.allows(group, "merge_group", "different", "queue", "base"), false);
});
test("unassociated direct commits cannot borrow another PR approval", async () => {
  const f = fixture();
  const commits = [
    { sha: "head", parents: [{ sha: "base" }] },
    { sha: "unreviewed", parents: [{ sha: "head" }] },
  ];
  f.github.request = async () => ({ commits });
  f.github.pages = async (path) => (path.includes("/head/") ? [f.pr] : []);
  assert.deepEqual(await f.policy.associated("base", "unreviewed", false), []);
  commits[1] = { sha: "queue-merge", parents: [{ sha: "base" }, { sha: "head" }] };
  assert.deepEqual(await f.policy.associated("base", "queue-merge", false), [f.pr]);
});
test("label reruns the completed head and synchronize invalidates approval", async () => {
  const f = fixture();
  process.env.GITHUB_RUN_ID = "41";
  process.env.GITHUB_RUN_ATTEMPT = "1";
  const event = {
    action: "labeled",
    label: { name: LABEL },
    number: 1,
    pull_request: f.pr,
    sender: { type: "User", login: "reviewer" },
  };
  f.github.request = async (path) =>
    path.startsWith("pulls/")
      ? f.pr
      : path.startsWith("collaborators/")
        ? { permission: "write" }
        : path.includes("workflows/")
          ? { workflow_runs: [{ id: 42, run_number: 4 }] }
          : { id: 42, status: "completed" };
  const posts = [];
  f.policy.post = async (...args) => posts.push(args);
  await f.policy.labelEvent(event);
  assert.equal(posts[0][1].state, "success");
  assert.equal(posts[1][0], "actions/runs/42/rerun");
  posts.length = 0;
  await f.policy.labelEvent({ ...event, action: "synchronize" });
  assert.equal(posts[0][1].state, "failure");
  assert.equal(posts.length, 1);
});
