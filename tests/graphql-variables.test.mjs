import assert from "node:assert/strict";
import { test } from "node:test";
import { functions, step, succeeds, workspace } from "./helpers.mjs";

/**
 * Stubs gh to record the variables of each GraphQL call, typed as `gh api` types them: -f sends a
 * string, while -F sends an integer, a boolean or null when the value reads as one. The stub answers
 * with the first response whose key appears in the query.
 */
function graphql(t, responses) {
  const w = workspace(t);
  w.write("responses.json", JSON.stringify(responses));
  w.write("variables", "");
  w.stub(
    "gh",
    `
    import * as fs from 'node:fs';
    const args = process.argv.slice(2), variables = {};
    const literals = ['true', 'false', 'null'];
    const typed = (v) => (/^[+-]?\\d+$/.test(v) ? Number(v) : literals.includes(v) ? JSON.parse(v) : v);
    let query = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== '-f' && args[i] !== '-F') continue;
      const [key, value] = args[i + 1].split(/=(.*)/s);
      if (key === 'query') query = value;
      else variables[key] = args[i] === '-F' ? typed(value) : value;
      i++;
    }
    fs.appendFileSync('variables', JSON.stringify(variables) + '\\n');
    const responses = Object.entries(JSON.parse(fs.readFileSync('responses.json')));
    console.log(JSON.stringify(responses.find(([key]) => query.includes(key))[1]));
  `
  );
  return { ...w, variables: () => w.read("variables").trim().split("\n").map(JSON.parse) };
}

// A repository may be named "true" or "123", and both readers declare owner and repo as String!.
const readers = [
  ["generic-actions/merge-gate/action.yaml", "discover", "fetch_pr", { OWNER: "true" }],
  [
    "generic-actions/detect-partial-landing/action.yaml",
    "Detect + reconcile partial landings",
    "fetch_pr_labels",
    { ORG: "true" },
  ],
];
for (const [path, name, reader, env] of readers)
  test(`${reader} sends owner and repo as strings and the number as an Int`, (t) => {
    const w = graphql(t, { "": { data: { repository: { pullRequest: { labels: { nodes: [] } } } } } });
    succeeds(w.bash(`${functions(step(path, name), [reader])}\n${reader} 7`, { ...env, REPO: "123" }));
    assert.deepEqual(w.variables(), [{ owner: "true", repo: "123", num: 7 }]);
  });

test("rollup-board sends an all-digit Status option id as a string", (t) => {
  // Project option ids are 8 hex characters, so some of them are all digits.
  const statuses = ["Triage", "Ready", "In progress", "In review", "Done", "Awaiting release", "Tracking"];
  const options = statuses.map((name, i) => ({ id: name === "In progress" ? "12345678" : `a${i}`, name }));
  const fields = {
    nodes: [
      { id: "F_status", name: "Status", options },
      { id: "F_start", name: "Start date" },
    ],
  };
  const issue = (number, type, parent, children) => ({
    number,
    state: "OPEN",
    repository: { nameWithOwner: "a-novel-kit/x" },
    issueType: { name: type },
    parent,
    subIssues: { totalCount: children.length, nodes: children },
  });
  const nodes = [
    { id: "I_epic", status: { name: "Ready" }, content: issue(1, "Epic", null, [{ state: "OPEN" }]) },
    {
      id: "I_task",
      status: { name: "In progress" },
      content: issue(2, "Task", { number: 1, repository: { nameWithOwner: "a-novel-kit/x" } }, []),
    },
  ];
  const w = graphql(t, {
    "fields(first:50)": { data: { node: { fields } } },
    "items(first:100": { data: { node: { items: { pageInfo: { hasNextPage: false }, nodes } } } },
    updateProjectV2ItemFieldValue: { data: {} },
  });
  const env = { PROJECT_ID: "PVT_board", DRY_RUN: "false", KILL_SWITCH: "" };
  succeeds(w.bash(step("generic-actions/rollup-board/action.yaml", "Roll up epics"), env));
  assert.deepEqual(w.variables(), [
    { p: "PVT_board" },
    { proj: "PVT_board" },
    { p: "PVT_board", i: "I_epic", f: "F_status", o: "12345678" },
  ]);
});
