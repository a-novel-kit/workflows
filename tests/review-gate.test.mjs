import assert from "node:assert/strict";
import { test } from "node:test";
import { step, succeeds, workspace } from "./helpers.mjs";

const gate = step("generic-actions/review-gate/action.yaml", "Evaluate and post review-gate");
const roles = { lead: "maintain", owner: "admin", dev: "write" };

/**
 * Runs the gate against a stubbed GitHub; returns the posted check and the paths it read. An empty
 * `author` stands for a caller with no pull request payload, which reads the author as `owner`.
 */
function evaluate(
  t,
  {
    event = "pull_request",
    author = "User",
    owner = author,
    commits = [],
    reviews = [],
    labels = [],
    applied = [],
    fail = "",
  } = {}
) {
  const w = workspace(t);
  w.write("summary", "");
  w.write("reads", "");
  w.stub(
    "gh",
    `import * as fs from 'node:fs';
    const args = process.argv.slice(2);
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    fs.appendFileSync("reads", path + "\\n");
    if (path.endsWith("/check-runs")) { fs.writeFileSync("check.json", fs.readFileSync(0, "utf8")); process.exit(0); }
    if (process.env.FAIL && path.endsWith(process.env.FAIL)) process.exit(1);
    const tsv = (rows) => rows.map((row) => row.join("\\t")).join("\\n");
    const data = JSON.parse(process.env.DATA);
    const role = path.match(/collaborators\\/([^/]+)\\/permission$/);
    if (role) {
      if (role[1] === "flaky") { console.error("gh: Bad Gateway (HTTP 502)"); process.exit(1); }
      if (!(role[1] in data.roles)) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
      console.log(data.roles[role[1]]);
    }
    else if (path.endsWith("/pulls/7")) console.log(data.owner);
    else if (path.endsWith("/commits")) console.log(JSON.stringify([data.commits]));
    else if (path.endsWith("/reviews")) console.log(tsv(data.reviews));
    else if (path.endsWith("/labels")) console.log(data.labels.join("\\n"));
    else if (path.endsWith("/events")) console.log(tsv(data.applied));`
  );
  const result = w.bash(gate, {
    GITHUB_REPOSITORY: "a-novel/service-authentication",
    AGENT: "anovelbot-agent",
    PRIVILEGED: "allow-dependency-change, with-feature-env",
    EVENT: event,
    PR: "7",
    AUTHOR_TYPE: author,
    HEAD_SHA: "head",
    FAIL: fail,
    DATA: JSON.stringify({ roles, owner, commits, reviews, labels, applied }),
  });
  succeeds(result);
  const check = JSON.parse(w.read("check.json"));
  return { conclusion: check.conclusion, summary: check.output.summary, reads: w.read("reads") };
}

const approve = (login, commit = "head", type = "User") => [login, type, "APPROVED", commit];
const signed = ({ type = "Bot", committer = "web-flow", verified = true } = {}) => ({
  author: { type },
  committer: { login: committer },
  commit: { verification: { verified } },
});

test("review-gate counts only a current approval from a maintainer, an admin or the Agent App", (t) => {
  for (const [reviews, conclusion] of [
    [[approve("lead")], "success"],
    [[approve("owner")], "success"],
    [[approve("anovelbot-agent[bot]", "head", "Bot")], "success"],
    [[approve("dev")], "failure"],
    [[approve("renovate[bot]", "head", "Bot")], "failure"],
    [[approve("lead", "old")], "failure"],
    [[approve("lead"), ["lead", "User", "DISMISSED", "head"]], "failure"],
    [[["lead", "User", "CHANGES_REQUESTED", "old"], approve("lead")], "success"],
    [[approve("stranger")], "failure"],
    [[], "failure"],
  ]) {
    const check = evaluate(t, { reviews });
    assert.equal(check.conclusion, conclusion, JSON.stringify(reviews));
    if (conclusion === "failure") assert.match(check.summary, /No approval of this head/);
  }
});

test("a privileged label counts only when a maintainer, an admin or the Agent App applied it last", (t) => {
  const reviews = [approve("lead")];
  for (const [labels, applied, conclusion] of [
    [["allow-dependency-change"], [["allow-dependency-change", "lead", "User"]], "success"],
    [["allow-dependency-change"], [["allow-dependency-change", "dev", "User"]], "failure"],
    [
      ["allow-dependency-change"],
      [
        ["allow-dependency-change", "dev", "User"],
        ["allow-dependency-change", "owner", "User"],
      ],
      "success",
    ],
    [
      ["allow-dependency-change"],
      [
        ["allow-dependency-change", "lead", "User"],
        ["allow-dependency-change", "dev", "User"],
      ],
      "failure",
    ],
    [["with-feature-env"], [["with-feature-env", "anovelbot-agent[bot]", "Bot"]], "success"],
    [["with-feature-env"], [["with-feature-env", "github-actions[bot]", "Bot"]], "failure"],
    [["with-feature-env"], [], "failure"],
    [["documentation"], [["documentation", "dev", "User"]], "success"],
  ]) {
    const check = evaluate(t, { reviews, labels, applied });
    assert.equal(check.conclusion, conclusion, JSON.stringify(applied));
    if (conclusion === "failure") assert.match(check.summary, new RegExp(`\`${labels[0]}\` was last applied`));
  }
});

test("a bot's pull request passes only when GitHub signed every commit for a bot", (t) => {
  const bot = evaluate(t, { author: "Bot", commits: [signed(), signed()] });
  assert.equal(bot.conclusion, "success");
  assert.doesNotMatch(bot.reads, /\/reviews/);
  // Dependabot's job runs on workflow_run, whose event carries no pull request.
  assert.equal(evaluate(t, { author: "", owner: "Bot", commits: [signed()] }).conclusion, "success");
  for (const commit of [signed({ type: "User" }), signed({ committer: "kushuh" }), signed({ verified: false })]) {
    const check = evaluate(t, { author: "Bot", commits: [signed(), commit] });
    assert.equal(check.conclusion, "failure", JSON.stringify(commit));
    assert.match(check.reads, /\/reviews/);
  }
});

test("merge groups pass without a review", (t) => {
  const queued = evaluate(t, { event: "merge_group" });
  assert.equal(queued.conclusion, "success");
  assert.doesNotMatch(queued.reads, /\/reviews/);
});

test("an unread list or role holds the pull request", (t) => {
  for (const [options, unread] of [
    [{ reviews: [approve("lead")], fail: "/reviews" }, "the reviews"],
    [{ reviews: [approve("lead")], fail: "/labels" }, "the labels"],
    [{ reviews: [approve("lead")], fail: "/events" }, "the label history"],
    [{ author: "Bot", fail: "/commits" }, "the commits"],
    [{ author: "", fail: "/pulls/7" }, "the pull request"],
    [{ reviews: [approve("flaky")] }, "@flaky's role"],
  ]) {
    const check = evaluate(t, options);
    assert.equal(check.conclusion, "failure", unread);
    assert.match(check.summary, new RegExp(`Couldn't read ${unread}\\.`));
  }
});

test("epic-membership reads each member's review-gate from the Agent App only", (t) => {
  const resolve = step("generic-actions/epic-membership/action.yaml", "resolve");
  const w = workspace(t);
  const suites = [
    { app: { slug: "github-actions" }, checkRuns: { nodes: [{ conclusion: "SUCCESS" }] } },
    { app: { slug: "anovelkitbot-agent" }, checkRuns: { nodes: [{ conclusion: "FAILURE" }] } },
  ];
  const node = (number, checkSuites) => ({
    number,
    isDraft: false,
    reviewDecision: "APPROVED",
    headRefOid: "h",
    repository: { nameWithOwner: "a-novel-kit/x" },
    commits: { nodes: [{ commit: { checkSuites: { nodes: checkSuites } } }] },
  });
  const search = { pageInfo: { hasNextPage: false }, nodes: [node(1, suites), node(2, [suites[0]])] };
  w.stub(
    "gh",
    `const args = process.argv.slice(2);
    if (args[1] !== 'graphql') { console.error('gh: Not Found (HTTP 404)'); process.exit(1); }
    console.log(JSON.stringify({ data: { search: ${JSON.stringify(search)} } }));`
  );
  succeeds(
    w.bash(resolve, {
      OWNER: "a-novel-kit",
      EPIC: "900",
      PLANNING_REPO: ".github",
      RUNNER_TEMP: w.cwd,
      AGENT: "anovelkitbot-agent",
    })
  );
  const members = JSON.parse(w.read("output").match(/^members=(.*)$/m)[1]);
  assert.deepEqual(
    members.map((m) => m.reviewGate),
    ["FAILURE", null]
  );
});

test("merge-gate holds an Epic member that fails review-gate only once review_gate is on", (t) => {
  const evaluateEpic = step("generic-actions/merge-gate/action.yaml", "Evaluate readiness + post merge-gate");
  const member = (number, reviewGate, isDraft = false) => ({
    repo: "a-novel-kit/x",
    number,
    headRefOid: "h",
    isDraft,
    reviewDecision: "APPROVED",
    reviewGate,
    state: "OPEN",
  });
  for (const [gateOn, second, conclusion, summary] of [
    ["false", member(2, null), "success"],
    ["true", member(2, "SUCCESS"), "success"],
    ["true", member(2, "FAILURE"), "failure", /x#2 .*review-gate=FAILURE/],
    ["true", member(2, null), "failure", /x#2 .*review-gate=none/],
    ["false", member(2, null, true), "failure", /x#2 \(draft=true, review=APPROVED\)$/m],
  ]) {
    const w = workspace(t);
    w.stub("gh", `import * as fs from 'node:fs'; fs.writeFileSync('check.json', fs.readFileSync(0, 'utf8'));`);
    succeeds(
      w.bash(evaluateEpic, {
        REPO_FULL: "a-novel-kit/x",
        HEAD_SHA: "head",
        EPIC: "900",
        PR_NUMBER: "1",
        REVIEW_GATE: gateOn,
        MEMBERS: JSON.stringify([member(1, "SUCCESS"), second]),
      })
    );
    const check = JSON.parse(w.read("check.json"));
    assert.equal(check.conclusion, conclusion, `${gateOn} ${JSON.stringify(second)}`);
    if (summary) assert.match(check.output.summary, summary);
  }
});
