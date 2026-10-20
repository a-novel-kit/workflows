import assert from "node:assert/strict";
import { test } from "node:test";
import { digest, parseRules, post, selectSuites, summary } from "../generic-actions/collect-warnings/collect.mjs";
import { root, succeeds, workspace } from "./helpers.mjs";

const until = "2026-10-20T07:00:00Z";
const since = "2026-10-19T07:00:00Z";

const run = (suite, changes = {}) => ({
  check_suite_node_id: suite,
  event: "push",
  updated_at: "2026-10-19T12:00:00Z",
  head_repository: { full_name: "a-novel/service-genai" },
  repository: { full_name: "a-novel/service-genai" },
  ...changes,
});
const annotation = (message, annotationLevel = "WARNING", title = null) => ({ annotationLevel, title, message });
const suite = (repo, job, ...annotations) => ({
  repository: { nameWithOwner: repo },
  checkRuns: {
    nodes: [{ name: job, url: `https://github.com/${repo}/runs/1`, annotations: { nodes: annotations } }],
  },
});

test("collect-warnings reads only finished default-branch runs of the repository itself, inside the window", () => {
  const runs = [
    run("push"),
    run("schedule", { event: "schedule" }),
    run("pull-request", { event: "pull_request" }),
    run("fork", { head_repository: { full_name: "someone/service-genai" } }),
    run("before", { updated_at: since }),
    run("after", { updated_at: "2026-10-20T07:00:01Z" }),
  ];
  assert.deepEqual(selectSuites(runs, since, until), ["push", "schedule"]);
});

test("collect-warnings merges a warning raised across repositories into one line", () => {
  const result = digest(
    [
      suite(
        "a-novel/service-genai",
        "build-rest",
        annotation("No Docker tag has been generated for run 118."),
        annotation("Process completed with exit code 1.", "FAILURE"),
        annotation("Node.js 20 is deprecated.", "NOTICE")
      ),
      null,
      suite(
        "a-novel/service-authentication",
        "build-rest",
        annotation("No Docker tag has been generated for run 2045."),
        annotation("Cache size exceeded", "WARNING", "setup-go")
      ),
    ],
    []
  );
  const genai = { repo: "a-novel/service-genai", url: "https://github.com/a-novel/service-genai/runs/1" };
  const auth = {
    repo: "a-novel/service-authentication",
    url: "https://github.com/a-novel/service-authentication/runs/1",
  };
  assert.deepEqual(result.warnings, [
    { message: "No Docker tag has been generated for run 118.", hits: 2, jobs: ["build-rest"], repos: [auth, genai] },
    { message: "setup-go: Cache size exceeded", hits: 1, jobs: ["build-rest"], repos: [auth] },
  ]);
  assert.deepEqual(post(result), {
    count: 2,
    title: "2 CI warnings on the default branches",
    footer: "",
    description: [
      "**No Docker tag has been generated for run 118.**",
      `-# \`build-rest\` · 2 hits · [service-authentication](${auth.url}), [service-genai](${genai.url})`,
      "**setup-go: Cache size exceeded**",
      `-# \`build-rest\` · 1 hit · [service-authentication](${auth.url})`,
    ].join("\n"),
  });
  assert.match(summary(result, since, until), /^\| setup-go: Cache size exceeded \| 1 \| build-rest \| \[a-novel\//m);
});

test("collect-warnings hides what an ignore rule matches and reports each rule's hits", () => {
  const rules = parseRules(
    JSON.stringify([
      {
        reason: "clean-images fixtures",
        repo: "^a-novel/service-genai$",
        job: "^test-actions$",
        message: "^Kept missing",
      },
      { reason: "a retired action", message: "set-output" },
    ])
  );
  const result = digest(
    [
      suite(
        "a-novel/service-genai",
        "test-actions",
        annotation("Kept missing: manifests/missing answered HTTP 404"),
        annotation("Kept missing: manifests/other answered HTTP 404"),
        annotation("Could not read the merge queue")
      ),
      suite(
        "a-novel/service-json-keys",
        "test-actions",
        annotation("Kept missing: manifests/missing answered HTTP 404")
      ),
    ],
    rules
  );
  assert.deepEqual(
    result.warnings.map(({ message, repos }) => [message, repos.map(({ repo }) => repo)]),
    [
      ["Could not read the merge queue", ["a-novel/service-genai"]],
      ["Kept missing: manifests/missing answered HTTP 404", ["a-novel/service-json-keys"]],
    ]
  );
  assert.equal(post(result).footer, "2 hidden by ignore rules");
  const table = summary(result, since, until);
  assert.match(table, /^\| clean-images fixtures \| 2 \|$/m);
  assert.match(table, /^\| a retired action \| 0, matched nothing \|$/m);
});

test("collect-warnings refuses an ignore rule without a reason, a pattern or a known field", () => {
  const cases = [
    ["no reason", [{ message: "x" }]],
    ["empty reason", [{ reason: "", message: "x" }]],
    ["no pattern", [{ reason: "x" }]],
    ["misspelled field", [{ reason: "x", message: "y", mesage: "z" }]],
    ["pattern not a string", [{ reason: "x", job: 1 }]],
    ["not a list", { reason: "x", message: "y" }],
  ];
  for (const [name, rules] of cases) {
    assert.throws(() => parseRules(JSON.stringify(rules)), /ignore must list rules/, name);
  }
  assert.throws(() => parseRules('[{"reason": "x", "message": "("}]'), SyntaxError, "invalid regular expression");
});

/**
 * Runs the shipped script against stubbed `gh` answers: the caller's previous success, one
 * repository's runs, and GraphQL answering from `suites` by node id. Returns the outputs, the
 * summary, the queried ids per GraphQL call, and the runs listing URL.
 */
function collect(t, { runs = [], suites = {}, previous = since, ignore = [] }) {
  const w = workspace(t);
  w.write("output", "");
  w.write("summary", "");
  w.write("runs.json", JSON.stringify([{ workflow_runs: runs }]));
  w.write("suites.json", JSON.stringify(suites));
  w.stub(
    "gh",
    `const fs = require("node:fs");
    const args = process.argv.slice(2);
    const path = args.find((arg) => arg.startsWith("orgs/") || arg.startsWith("repos/")) ?? "";
    if (args[0] === "run") console.log(${JSON.stringify(previous)});
    else if (args.includes("graphql")) {
      const { variables } = JSON.parse(fs.readFileSync(0, "utf8"));
      fs.appendFileSync("queries", JSON.stringify(variables.ids) + "\\n");
      const suites = JSON.parse(fs.readFileSync("suites.json", "utf8"));
      console.log(JSON.stringify({ data: { nodes: variables.ids.map((id) => suites[id] ?? null) } }));
    } else if (path.startsWith("orgs/")) {
      const repos = [{ full_name: "a-novel/service-genai", default_branch: "master", archived: false },
        { full_name: "a-novel/old", default_branch: "main", archived: true }];
      console.log(JSON.stringify([repos]));
    } else if (path.includes("/actions/runs?")) {
      fs.appendFileSync("listings", path + "\\n");
      process.stdout.write(fs.readFileSync("runs.json"));
    } else console.log(${JSON.stringify(until)});`
  );
  const env = {
    GITHUB_REPOSITORY: "a-novel/.github",
    GITHUB_REPOSITORY_OWNER: "a-novel",
    GITHUB_RUN_ID: "1",
    CALLER: "a-novel/.github/.github/workflows/notify-warnings.yaml@refs/heads/master",
    IGNORE: JSON.stringify(ignore),
  };
  const result = w.run("node", [`${root}generic-actions/collect-warnings/collect.mjs`], env);
  const read = (path) => {
    try {
      return w.read(path);
    } catch {
      return "";
    }
  };
  const output = read("output");
  return {
    result,
    count: output.match(/^count=(.*)$/m)?.[1],
    description: output.match(/^description<<(\S+)\n([^]*?)\n\1$/m)?.[2],
    summary: read("summary"),
    listings: read("listings").split("\n").filter(Boolean),
    queries: read("queries")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

test("collect-warnings reads the window since the caller's last success and queries 50 runs at a time", (t) => {
  const ids = Array.from({ length: 51 }, (_, i) => `suite-${i}`);
  const warned = suite("a-novel/service-genai", "test-go", annotation("Cache size exceeded"));
  const out = collect(t, { runs: ids.map((id) => run(id)), suites: { "suite-50": warned } });
  succeeds(out.result);
  assert.deepEqual(
    out.queries.map((ids) => ids.length),
    [50, 1]
  );
  // Archived repositories are skipped, and the listing reaches back a day before the window.
  assert.deepEqual(out.listings, [
    "repos/a-novel/service-genai/actions/runs?branch=master&status=completed&created=>=2026-10-18T07:00:00Z&per_page=100",
  ]);
  assert.equal(out.count, "1");
  assert.match(out.description, /^\*\*Cache size exceeded\*\*\n-# `test-go` · 1 hit · /);
  assert.match(out.summary, /between 2026-10-19T07:00:00Z and 2026-10-20T07:00:00Z/);
});

test("collect-warnings looks back a day on its first run and stops on an invalid rule", (t) => {
  const first = collect(t, {
    runs: [run("genai")],
    suites: { genai: suite("a-novel/service-genai", "test-go") },
    previous: "",
  });
  succeeds(first.result);
  assert.equal(first.count, "0");
  assert.match(first.summary, /between 2026-10-19T07:00:00Z and 2026-10-20T07:00:00Z\.\n\nNo warnings\./);

  const invalid = collect(t, { ignore: [{ message: "x" }] });
  assert.notEqual(invalid.result.status, 0);
  assert.match(invalid.result.stdout, /^::error::ignore must list rules/m);
  assert.deepEqual(invalid.listings, []);
});
