import assert from "node:assert/strict";
import { test } from "node:test";
import { step, succeeds, workspace } from "./helpers.mjs";

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

/**
 * Runs the shipped scan over one repository's runs, answering GraphQL from `suites` by node id.
 * Returns the step outputs, the summary, and the node ids of each GraphQL query.
 */
function scan(t, { runs = [], suites = {}, ignore = [], previous = since }) {
  const w = workspace(t);
  w.write("runs.json", JSON.stringify({ workflow_runs: runs }));
  w.write("suites.json", JSON.stringify(suites));
  w.stub(
    "gh",
    `const fs = require("node:fs");
    const args = process.argv.slice(2);
    if (args[0] === "run") console.log(${JSON.stringify(previous)});
    else if (args.includes("graphql")) {
      const { variables } = JSON.parse(fs.readFileSync(0, "utf8"));
      fs.appendFileSync("queries", JSON.stringify(variables.ids) + "\\n");
      const suites = JSON.parse(fs.readFileSync("suites.json", "utf8"));
      console.log(JSON.stringify({ data: { nodes: variables.ids.map((id) => suites[id] ?? null) } }));
    } else if (args.some((arg) => arg.startsWith("orgs/"))) console.log("a-novel/service-genai master");
    else if (args.some((arg) => arg.includes("/actions/runs?"))) process.stdout.write(fs.readFileSync("runs.json"));
    else console.log(${JSON.stringify(until)});`
  );
  const env = {
    GITHUB_REPOSITORY: "a-novel/.github",
    GITHUB_REPOSITORY_OWNER: "a-novel",
    GITHUB_RUN_ID: "1",
    CALLER: "a-novel/.github/.github/workflows/notify-warnings.yaml@refs/heads/master",
    IGNORE: JSON.stringify(ignore),
  };
  const result = w.bash(step(".github/workflows/notify-warnings-run.yaml", "scan"), env);
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
    title: output.match(/^title=(.*)$/m)?.[1],
    footer: output.match(/^footer=(.*)$/m)?.[1],
    description: output.match(/^description<<(\S+)\n([^]*?)\n?\1$/m)?.[2],
    summary: read("summary"),
    queries: read("queries")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

test("notify-warnings merges a warning raised across repositories into one line", (t) => {
  const digest = scan(t, {
    runs: [
      run("genai"),
      run("auth"),
      run("pull-request", { event: "pull_request" }),
      run("fork", { head_repository: { full_name: "someone/service-genai" } }),
      run("before", { updated_at: since }),
      run("after", { updated_at: "2026-10-20T07:00:01Z" }),
    ],
    suites: {
      genai: suite(
        "a-novel/service-genai",
        "build-rest",
        annotation("No Docker tag has been generated for run 118."),
        annotation("Process completed with exit code 1.", "FAILURE"),
        annotation("Node.js 20 is deprecated.", "NOTICE")
      ),
      auth: suite(
        "a-novel/service-authentication",
        "build-rest",
        annotation("No Docker tag has been generated for run 2045."),
        annotation("Cache size exceeded", "WARNING", "setup-go")
      ),
    },
  });
  succeeds(digest.result);
  // Only finished default-branch runs of the repository itself, inside the window, are read.
  assert.deepEqual(digest.queries, [["genai", "auth"]]);
  assert.equal(digest.count, "2");
  assert.equal(digest.title, "2 CI warnings on the default branches");
  assert.equal(digest.footer, "");
  assert.equal(
    digest.description,
    [
      "**No Docker tag has been generated for run 118.**",
      "-# `build-rest` · 2 hits · [service-authentication](https://github.com/a-novel/service-authentication/runs/1), " +
        "[service-genai](https://github.com/a-novel/service-genai/runs/1)",
      "**setup-go: Cache size exceeded**",
      "-# `build-rest` · 1 hit · [service-authentication](https://github.com/a-novel/service-authentication/runs/1)",
    ].join("\n")
  );
  assert.match(digest.summary, /between 2026-10-19T07:00:00Z and 2026-10-20T07:00:00Z/);
});

test("notify-warnings hides what an ignore rule matches and reports each rule's hits", (t) => {
  const digest = scan(t, {
    runs: [run("genai")],
    suites: {
      genai: suite(
        "a-novel/service-genai",
        "test-actions",
        annotation("Kept missing: manifests/missing answered HTTP 404"),
        annotation("Kept missing: manifests/other answered HTTP 404"),
        annotation("Could not read the merge queue")
      ),
    },
    ignore: [
      {
        reason: "clean-images fixtures",
        repo: "^a-novel/service-genai$",
        job: "^test-actions$",
        message: "^Kept missing",
      },
      { reason: "a retired action", message: "set-output" },
    ],
  });
  succeeds(digest.result);
  assert.equal(digest.count, "1");
  assert.equal(digest.footer, "2 hidden by ignore rules");
  assert.match(digest.description, /^\*\*Could not read the merge queue\*\*$/m);
  assert.match(digest.summary, /^\| clean-images fixtures \| 2 \|$/m);
  assert.match(digest.summary, /^\| a retired action \| 0, matched nothing \|$/m);
});

test("notify-warnings refuses an ignore rule without a reason, a pattern or a known field", (t) => {
  const cases = [
    ["no reason", [{ message: "x" }]],
    ["empty reason", [{ reason: "", message: "x" }]],
    ["no pattern", [{ reason: "x" }]],
    ["misspelled field", [{ reason: "x", message: "y", mesage: "z" }]],
    ["not a list", { reason: "x", message: "y" }],
  ];
  for (const [name, ignore] of cases) {
    const { result } = scan(t, { ignore });
    assert.notEqual(result.status, 0, name);
    assert.match(result.stdout, /::error::ignore must list rules/, name);
  }
});

test("notify-warnings posts nothing on a clean day and looks back a day on its first run", (t) => {
  const digest = scan(t, {
    runs: [run("genai")],
    suites: { genai: suite("a-novel/service-genai", "test-go") },
    previous: "",
  });
  succeeds(digest.result);
  assert.equal(digest.count, "0");
  assert.match(digest.summary, /between 2026-10-19T07:00:00Z and 2026-10-20T07:00:00Z\.\n\nNo warnings\./);
});

test("notify-warnings reads 50 runs per GraphQL query", (t) => {
  const ids = Array.from({ length: 51 }, (_, i) => `suite-${i}`);
  const digest = scan(t, { runs: ids.map((id) => run(id)) });
  succeeds(digest.result);
  assert.deepEqual(
    digest.queries.map((query) => query.length),
    [50, 1]
  );
});
