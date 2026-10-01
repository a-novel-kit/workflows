// Exact-head approval and merge-queue provenance through GitHub boundary responses.
import assert from "node:assert/strict";
import { test } from "node:test";
import { APPROVAL, COMPARISON, LABEL, Policy } from "../node-actions/test-playwright/drive/policy.mjs";
import { root, succeeds, workspace } from "./helpers.mjs";

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
  const run = {
    id: 42,
    run_number: 4,
    head_sha: "head",
    event: "push",
    path: ".github/workflows/main.yaml",
    status: "completed",
  };
  f.github.request = async (path) =>
    path.startsWith("pulls/")
      ? f.pr
      : path.startsWith("collaborators/")
        ? { permission: "write" }
        : path.includes("workflows/")
          ? { workflow_runs: [run] }
          : path.includes("/artifacts?")
            ? { artifacts: [], total_count: 0 }
            : run;
  const posts = [];
  f.policy.post = async (...args) => posts.push(args);
  await f.policy.labelEvent(event);
  assert.equal(posts[0][1].state, "success");
  assert.equal(posts[0][1].target_url, "https://github.com/example/studio/actions/runs/41/attempts/1");
  assert.equal(posts[1][0], "actions/runs/42/rerun");
  posts.length = 0;
  await f.policy.labelEvent({ ...event, action: "synchronize" });
  assert.equal(posts[0][1].state, "failure");
  assert.equal(posts.length, 1);
});

function reviewFixture() {
  const f = fixture();
  const run = {
    id: 42,
    run_number: 4,
    run_attempt: 2,
    head_sha: "head",
    event: "push",
    path: ".github/workflows/main.yaml",
    status: "completed",
    conclusion: "failure",
    run_started_at: "2026-09-01T12:00:00Z",
  };
  const artifact = { id: 9, name: "playwright-drift.html", expired: false, created_at: "2026-09-01T12:01:00Z" };
  const artifacts = [artifact];
  f.github.request = async (path) => {
    if (path.startsWith("pulls/")) return f.pr;
    if (path.includes("workflows/")) return { workflow_runs: [run] };
    if (path.includes("/artifacts?")) return { artifacts, total_count: artifacts.length };
    return run;
  };
  const posts = [];
  f.policy.post = async (...args) => posts.push(args);
  return {
    ...f,
    run,
    artifact,
    artifacts,
    posts,
    labelEvent: { action: "synchronize", number: 1, pull_request: f.pr },
  };
}

test("unapproved heads attach only a current, unexpired drift report without rerunning main", async () => {
  for (const [mutate, expected] of [
    [() => {}, true],
    [(f) => (f.artifact.expired = true), false],
    [(f) => (f.artifact.created_at = "2026-09-01T11:00:00Z"), false],
    [(f) => (f.artifact.name = "coverage"), false],
    [(f) => f.artifacts.pop(), false],
  ]) {
    const f = reviewFixture();
    mutate(f);
    const result = await f.policy.labelEvent(f.labelEvent);
    assert.equal(result.run.id, 42);
    assert.equal(Boolean(result.artifact), expected);
    assert.equal(f.posts.length, 1);
    assert.equal(f.posts[0][1].state, "failure");
  }
});

test("a new PR head stops an older approval run from attaching evidence", async () => {
  const f = reviewFixture();
  const request = f.github.request;
  let reads = 0;
  f.github.request = async (path) => {
    if (path.startsWith("pulls/") && ++reads > 1) return { ...f.pr, head: { ...f.pr.head, sha: "new-head" } };
    return request(path);
  };
  assert.equal(await f.policy.labelEvent(f.labelEvent), undefined);
  assert.equal(f.posts.length, 1);
});

test("approval waits when the main run has not appeared yet", async () => {
  const f = reviewFixture();
  const request = f.github.request;
  let listings = 0;
  f.github.request = async (path) => {
    if (path.includes("workflows/") && listings++ === 0) return { workflow_runs: [] };
    return request(path);
  };
  assert.equal((await f.policy.labelEvent(f.labelEvent)).artifact.id, 9);
});

test("approval CLI exposes the exact report for native artifact transfer and reviewer navigation", (t) => {
  const f = reviewFixture(),
    ws = workspace(t);
  ws.write("event.json", JSON.stringify(f.labelEvent));
  const stub = ws.write(
    "github.mjs",
    `
    const pr = ${JSON.stringify(f.pr)}, run = ${JSON.stringify(f.run)}, artifact = ${JSON.stringify(f.artifact)};
    globalThis.fetch = async (url, options) => new Response(JSON.stringify(
      options.method === 'POST' ? {} : url.includes('/pulls/') ? pr :
      url.includes('/workflows/') ? {workflow_runs: [run]} :
      url.includes('/artifacts?') ? {artifacts: [artifact], total_count: 1} : run
    ));
  `
  );
  succeeds(
    ws.run(process.execPath, ["--import", stub, `${root}node-actions/test-playwright/drive/policy.mjs`, "label"], {
      GITHUB_REPOSITORY: "example/studio",
      GITHUB_EVENT_PATH: `${ws.cwd}/event.json`,
      GITHUB_RUN_ID: "41",
      GITHUB_RUN_ATTEMPT: "1",
    })
  );
  assert.equal(ws.read("output"), "run_id=42\nartifact_id=9\n");
  assert.match(ws.read("summary"), /Artifacts/);
  assert.match(ws.read("summary"), /Old \/ New \/ Diff/);
  assert.match(ws.read("summary"), /actions\/runs\/42\/attempts\/2/);
});
