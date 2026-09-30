import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { functions, step, succeeds, workspace } from "./helpers.mjs";

const script = step("generic-actions/detect-partial-landing/action.yaml", "Detect + reconcile partial landings");
const setup = script.slice(0, script.indexOf("# ---- Shared GraphQL"));
const library = functions(script, [
  "extract_marker",
  "epic_issue",
  "epic_paused",
  "build_claim_index",
  "epic_claiming",
  "snapshot_buckets",
  "union_buckets",
  "evaluate_epic",
  "per_pr_main",
]);
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
const old = ago(40),
  recent = ago(5),
  boundary = ago(20);
const node = (repo, number, state, time = recent, provenance = "timeline") => ({
  number,
  state,
  headRefOid: `sha${number}`,
  baseRefName: "master",
  isDraft: false,
  repository: { nameWithOwner: `a-novel-kit/${repo}` },
  mergedAt: state === "MERGED" ? time : null,
  closedAt: state !== "OPEN" ? time : null,
  labels: { nodes: provenance === "label" ? [{ name: "epic:900" }] : [] },
  timelineItems: { nodes: provenance === "timeline" ? [{ label: { name: "epic:900" }, createdAt: time }] : [] },
});
const a = node("repo-a", 1, "MERGED", old),
  b = node("repo-b", 2, "CLOSED"),
  c = node("repo-c", 3, "OPEN");
const members = [b, c].map((n) => ({ repo: n.repository.nameWithOwner, number: n.number }));
const marker = (value) =>
  `<!-- epic-membership:snapshot:start -->\n_Membership note._\n${JSON.stringify(value)}\n<!-- epic-membership:snapshot:end -->`;
const frozen = (values = {}) => marker({ status: "frozen", members, ...values });
const response = (...nodes) => ({ data: Object.fromEntries(nodes.map((n, i) => [`m${i}`, { pullRequest: n }])) });

function evaluate(t, changes = {}, mode = "evaluate", env = {}) {
  const w = workspace(t);
  const fixture = {
    body: "",
    labels: [],
    issues: [],
    rehydrate: response(b, c),
    merged: [a],
    closed: [],
    open: [c],
    queue: [{ number: 3, state: "QUEUED", headOid: "sha3" }],
    rest: {
      "a-novel-kit/repo-a#1": "closed true",
      "a-novel-kit/repo-b#2": "closed false",
      "a-novel-kit/repo-c#3": "open false",
    },
    ...changes,
  };
  w.write("fixture.json", JSON.stringify(fixture));
  w.write("calls", "");
  w.write("failures", String(fixture.retries ?? 0));
  for (const name of [
    "gh",
    "search_prs",
    "merge_queue_entries",
    "rest_pr_state",
    "fetch_pr_labels",
    "freeze_post",
    "sleep",
  ])
    w.stub(
      name,
      `
    import * as fs from 'node:fs'; const f = JSON.parse(fs.readFileSync('fixture.json'));
    const name = ${JSON.stringify(name)}, args = process.argv.slice(2);
    fs.appendFileSync('calls', JSON.stringify({ name, args }) + '\\n');
    const fail = (text = '') => { console.error(text); process.exit(1); };
    let output = '';
    if (name === 'gh') {
      if (args.includes('graphql')) {
        const remaining = Number(fs.readFileSync('failures'));
        if (remaining > 0) { fs.writeFileSync('failures', String(remaining - 1)); fail(); }
        if (f.rehydrate === 'FAIL') fail(); output = f.rehydrate;
      } else if (args.some(a => a.includes('issues?state=open'))) {
        if (f.issues === 'FAIL') fail(); output = f.issues;
      } else {
        if (f.body === 'FAIL404') fail('gh: Not Found (HTTP 404)');
        if (f.body === 'FAIL') fail('gh: HTTP 502');
        output = { body: f.body, labels: f.labels };
      }
    } else if (name === 'search_prs') {
      const key = args[0].includes('is:merged') ? 'merged' : args[0].includes('is:unmerged') ? 'closed' : 'open';
      if (f.searchFail === true || f.searchFail === key) fail();
      const floor = args[0].match(/(?:merged|closed):>=(\\S+)/)?.[1];
      output = f[key].filter(n => !floor || (n.mergedAt ?? n.closedAt ?? '9999') >= floor);
    } else if (name === 'merge_queue_entries') {
      if (f.queue === 'FAIL') fail();
      output = f.queue.filter(q => (!q.repo || q.repo === args[0] + '/' + args[1]) && (!q.base || q.base === args[2]));
    } else if (name === 'rest_pr_state') {
      output = f.rest[args[0] + '#' + args[1]]; if (!output || output === 'FAIL') fail();
    } else if (name === 'fetch_pr_labels') {
      if (f.prLabels === 'FAIL') fail(); output = f.prLabels ?? [];
    }
    process.stdout.write(typeof output === 'string' ? output : JSON.stringify(output));
  `
    );
  const call =
    mode === "evaluate"
      ? `
    evaluate_epic 900 > evaluation.log
    jq -cn --arg decision "$EV_DECISION" --arg reason "$EV_REASON" --argjson open "$EV_OPEN" \
      --argjson strays "$EV_STRAYS" --arg counts "$EV_MERGED_COUNT/$EV_CLOSED_COUNT/$EV_OPEN_COUNT" \
      '{decision:$decision, reason:$reason, open:$open, strays:$strays, counts:$counts}'
  `
      : mode === "claims"
        ? 'build_claim_index > evaluation.log; epic_claiming "$REPO_FULL" "$PR_NUMBER"'
        : "per_pr_main > evaluation.log";
  const result = w.bash(`${setup}\n${library}\n${call}`, {
    ORG: "a-novel-kit",
    PLANNING_REPO: ".github",
    GRACE_MINUTES: "30",
    MODE: "test",
    REPO_FULL: "a-novel-kit/repo-c",
    PR_NUMBER: "3",
    HEAD_SHA: "a".repeat(40),
    TMPDIR: w.cwd,
    ...env,
  });
  const output = succeeds(result);
  return {
    ...(mode === "evaluate" ? JSON.parse(output) : { output }),
    calls: w.read("calls").trim().split("\n").filter(Boolean).map(JSON.parse),
    summary: existsSync(join(w.cwd, "summary")) ? w.read("summary") : "",
  };
}

test("frozen membership remembers abandonment and fresh state without losing live members", (t) => {
  assert.equal(evaluate(t).decision, "clear");
  const abandoned = evaluate(t, { body: frozen() });
  assert.equal(abandoned.decision, "frozen");
  assert.equal(abandoned.counts, "1/1/1");
  assert.match(abandoned.reason, /closed without merging/);
  const merged = evaluate(t, { body: frozen(), rehydrate: response(node("repo-b", 2, "MERGED"), c) });
  assert.equal(merged.counts, "2/0/1");
  assert.equal(merged.decision, "clear");
  const open = evaluate(t, {
    body: frozen(),
    rehydrate: response(node("repo-b", 2, "OPEN"), c),
    rest: { "a-novel-kit/repo-a#1": "closed true", "a-novel-kit/repo-b#2": "open false" },
  });
  assert.deepEqual(
    open.open.map((pr) => [pr.number, pr.liveMember]),
    [
      [2, false],
      [3, true],
    ]
  );
  const fresh = evaluate(t, { body: frozen(), open: [b, c], rehydrate: response(node("repo-b", 2, "MERGED"), c) });
  assert.equal(fresh.counts, "2/0/1");
  const renamed = evaluate(t, {
    body: frozen(),
    rehydrate: response(node("renamed", 2, "CLOSED"), c),
    rest: { "a-novel-kit/repo-a#1": "closed true", "a-novel-kit/renamed#2": "closed false" },
  });
  assert.equal(renamed.decision, "frozen");
});

test("snapshot members require current labels or timeline evidence in this wave", (t) => {
  for (const provenance of ["none", "label", "timeline"]) {
    const result = evaluate(t, {
      body: frozen(),
      rehydrate: response(node("repo-b", 2, "CLOSED", recent, provenance), c),
    });
    assert.equal(result.decision, provenance === "none" ? "error" : "frozen");
  }
  for (const time of [old, boundary, recent]) {
    const result = evaluate(t, {
      body: frozen({ since: boundary }),
      rehydrate: response(node("repo-b", 2, "CLOSED", time), c),
    });
    assert.equal(result.decision, time === old ? "error" : "clear");
  }
  const wrongEpic = node("repo-b", 2, "CLOSED");
  wrongEpic.timelineItems.nodes[0].label.name = "epic:901";
  assert.equal(evaluate(t, { body: frozen(), rehydrate: response(wrongEpic, c) }).decision, "error");
});

test("malformed snapshot identities never reach the rehydration query", (t) => {
  for (const invalid of [
    [],
    [{ repo: "attacker/repo", number: 1 }],
    [{ repo: "a-novel-kit/repo\n", number: 1 }],
    [{ repo: 'a-novel-kit/x\"){viewer{login}}', number: 1 }],
    [{ repo: "a-novel-kit/a", number: "1" }],
    [{ repo: "a-novel-kit/a", number: 0 }],
    [{ repo: "a-novel-kit/a", number: 1.5 }],
    [{ repo: "a-novel-kit/a", number: 2147483648 }],
    Array.from({ length: 51 }, (_, i) => ({ repo: "a-novel-kit/a", number: i + 1 })),
  ]) {
    const result = evaluate(t, { body: frozen({ members: invalid }) });
    assert.equal(result.decision, "clear");
    assert(!result.calls.some((call) => call.args.includes("graphql")));
  }
  const duplicate = evaluate(t, {
    body: frozen({ members: [...members, { ...members[0], repo: "A-NOVEL-KIT/REPO-B" }] }),
  });
  assert.equal(duplicate.counts, "1/1/1");
  const query = duplicate.calls.find((call) => call.args.includes("graphql")).args.join(" ");
  for (const field of ["createdAt", "LABELED_EVENT", "headRefOid", "baseRefName", "state", "nameWithOwner"])
    assert(query.includes(field));
});

test("unusable or future wave boundaries retain unbounded history", (t) => {
  for (const since of [
    "yesterday",
    "2026-13-45T99:00:00Z",
    "2026-02-30T10:00:00Z",
    `${boundary}\n::error::forged`,
    ago(-60),
  ]) {
    const result = evaluate(t, { body: marker({ status: "retired", since }), queue: [] });
    assert.equal(result.decision, "frozen", since);
    assert(!result.calls.some((call) => call.name === "search_prs" && call.args[0].includes(":>=")));
    assert(!result.summary.includes("\n::error::forged"));
  }
  const result = evaluate(t, { body: marker({ status: "retired", since: boundary }), queue: [] });
  assert.equal(result.decision, "clear");
  assert.equal(result.counts, "0/0/1");
  for (const call of result.calls.filter((call) => call.name === "search_prs")) {
    assert(call.args[0].includes('label:"epic:900" org:a-novel-kit'));
    assert.equal(call.args[0].includes(":>="), !call.args[0].includes("is:open"));
  }
});

test("incomplete API answers and read failures cannot clear an existing freeze", (t) => {
  for (const rehydrate of [
    "FAIL",
    { data: {} },
    response(b),
    response(b, null),
    { ...response(b, c), errors: [{ message: "partial" }] },
    response({ ...b, number: 99 }, c),
    response({ ...b, state: null }, c),
  ]) {
    assert.equal(evaluate(t, { body: frozen(), rehydrate }).decision, "error");
  }
  const recovered = evaluate(t, { body: frozen(), retries: 2 });
  assert.equal(recovered.decision, "frozen");
  assert.equal(recovered.calls.filter((call) => call.args.includes("graphql")).length, 3);
  for (const changes of [
    { body: "FAIL" },
    { searchFail: "merged" },
    { searchFail: "closed" },
    { searchFail: "open" },
    { queue: "FAIL" },
    { closed: [b], rest: {} },
    { queue: [], rest: {} },
  ]) {
    assert.equal(evaluate(t, changes).decision, "error", JSON.stringify(changes));
  }
  assert.equal(evaluate(t, { body: "FAIL404" }).decision, "clear");
});

test("strays require elapsed grace and REST confirmation; no merge means no partial landing", (t) => {
  for (const [changes, expected] of [
    [{ queue: [] }, "frozen"],
    [{ queue: [], merged: [node("repo-a", 1, "MERGED")] }, "clear"],
    [{ queue: [], merged: [] }, "clear"],
    [{ closed: [b], merged: [] }, "clear"],
    [{ closed: [b], rest: { "a-novel-kit/repo-a#1": "open false" } }, "error"],
    [{ closed: [b], rest: { "a-novel-kit/repo-a#1": "closed true", "a-novel-kit/repo-b#2": "open false" } }, "error"],
    [{ queue: [], rest: { "a-novel-kit/repo-c#3": "closed true" } }, "clear"],
    [{ queue: [], merged: [{ ...a, mergedAt: "invalid" }] }, "clear"],
  ])
    assert.equal(evaluate(t, changes).decision, expected);
  const result = evaluate(t, { queue: [], merged: [node("repo-a", 1, "MERGED")] });
  assert.equal(result.strays[0].liveMember, true);
});

test("claim index keeps de-labeled members held and honors paused or unrelated issues", (t) => {
  const issue = { number: 900, body: frozen(), labels: [] };
  assert.equal(evaluate(t, { issues: [issue] }, "claims").output, "900");
  for (const issues of [
    [],
    "FAIL",
    [{ ...issue, pull_request: {} }],
    [{ ...issue, body: marker({ status: "pending", members }) }],
  ]) {
    assert.equal(evaluate(t, { issues }, "claims").output, "");
  }
  for (const [changes, env, expected] of [
    [{ issues: [issue], body: frozen() }, { EVENT_PR: "3", EVENT_LABELS: "[]" }, "failure"],
    [
      { issues: [{ ...issue, labels: [{ name: "automation:paused" }] }] },
      { EVENT_PR: "3", EVENT_LABELS: "[]" },
      "success",
    ],
    [{}, { EVENT_PR: "3", EVENT_LABELS: "[]" }, "success"],
    [{ body: "FAIL" }, { EVENT_PR: "3", EVENT_LABELS: '["epic:900"]' }, "success"],
    [{}, { IN_QUEUE: "sha", MG_HEAD_REF: "unidentifiable" }, "failure"],
    [{}, { PR_NUMBER: "" }, "failure"],
  ]) {
    const result = evaluate(t, changes, "per-pr", env);
    const posted = result.calls.filter((call) => call.name === "freeze_post");
    assert.equal(posted.length, 1);
    assert.equal(posted[0].args[2], expected);
  }
});
