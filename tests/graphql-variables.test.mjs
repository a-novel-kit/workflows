import assert from "node:assert/strict";
import { test } from "node:test";
import { functions, ghVariables, step, succeeds, workspace } from "./helpers.mjs";

/**
 * Stubs gh to log each call and answer it with the first response whose key appears in the query. A
 * list of responses answers successive calls in turn, so a test can page.
 */
function graphql(t, responses) {
  const w = workspace(t);
  w.write("responses.json", JSON.stringify(responses));
  w.write("calls", "");
  w.stub(
    "gh",
    `
    import * as fs from 'node:fs';
    fs.appendFileSync('calls', JSON.stringify(process.argv.slice(2)) + '\\n');
    const queries = fs.readFileSync('calls', 'utf8').trim().split('\\n')
      .map((line) => JSON.parse(line).find((arg) => arg.startsWith('query=')) ?? '');
    const responses = Object.entries(JSON.parse(fs.readFileSync('responses.json')));
    const [key, answer] = responses.find(([key]) => queries.at(-1).includes(key));
    const answers = [answer].flat(), seen = queries.filter((query) => query.includes(key)).length;
    console.log(JSON.stringify(answers[Math.min(seen, answers.length) - 1]));
  `
  );
  return {
    ...w,
    variables: () =>
      w
        .read("calls")
        .trim()
        .split("\n")
        .map((line) => ghVariables(JSON.parse(line))),
  };
}

// A repository may be named "true" or "123", and every reader declares owner and repo as String!.
const pullRequest = { state: "OPEN", isDraft: false, labels: { nodes: [] }, closingIssuesReferences: { nodes: [] } };
const reader = (path, name, fn) => `${functions(step(path, name), [fn])}\n${fn} 7`;
const readers = [
  ["merge-gate", reader("generic-actions/merge-gate/action.yaml", "discover", "fetch_pr"), { OWNER: "true" }],
  [
    "detect-partial-landing",
    reader(
      "generic-actions/detect-partial-landing/action.yaml",
      "Detect + reconcile partial landings",
      "fetch_pr_labels"
    ),
    { ORG: "true" },
  ],
  ["derive-status", step("generic-actions/derive-status/action.yaml", "derive"), { OWNER: "true", PR: "7" }],
];
for (const [action, script, env] of readers)
  test(`${action} sends owner and repo as strings and the number as an Int`, (t) => {
    const w = graphql(t, { "": { data: { repository: { pullRequest } } } });
    succeeds(w.bash(script, { ...env, REPO: "123" }));
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

// The board writers page a content's items, so each test answers one empty page before the item.
// All-digit ids and cursors stand for any value -F would retype.
const page = (connection, nodes, endCursor) => ({
  data: { node: { [connection]: { pageInfo: { hasNextPage: Boolean(endCursor), endCursor }, nodes } } },
});
const pages = (connection, nodes) => [page(connection, [], "505"), page(connection, nodes)];

test("board-write sends board, content, item and field ids and cursors as strings", (t) => {
  const field = { id: "404", dataType: "SINGLE_SELECT", options: [{ id: "a1", name: "Done" }] };
  const w = graphql(t, {
    "field(name:$field)": { data: { node: { field } } },
    "projectItems(first:100": pages("projectItems", [{ id: "303", project: { id: "101" } }]),
    updateProjectV2ItemFieldValue: { data: {} },
  });
  const env = {
    PROJECT_ID: "101",
    CONTENT_ID: "202",
    FIELD: "Status",
    VALUE: "Done",
    DRY_RUN: "false",
    ONLY_IF_EMPTY: "",
  };
  succeeds(w.bash(step("generic-actions/board-write/action.yaml", "write"), env));
  assert.deepEqual(w.variables(), [
    { proj: "101", field: "Status" },
    { c: "202", field: "Status" },
    { c: "202", field: "Status", cursor: "505" },
    { proj: "101", item: "303", field: "404" },
  ]);
});

test("epic-rollback resets a Task on the board with its ids and cursors as strings", (t) => {
  const field = { id: "404", options: [{ id: "a1", name: "Ready" }] };
  const w = graphql(t, {
    updateProjectV2ItemFieldValue: { data: {} },
    'field(name:"Status")': { data: { node: { field } } },
    "projectItems(first:100": pages("projectItems", [{ id: "303", project: { id: "101" } }]),
    fieldValueByName: { data: { node: { fieldValueByName: { current: "In progress" } } } },
  });
  const reset = functions(step("generic-actions/epic-rollback/action.yaml", "mutate"), [
    "board_init",
    "board_set_ready",
  ]);
  succeeds(w.bash(`${reset}\nboard_init\nboard_set_ready 202`, { PROJECT_ID: "101", BOARD_TOKEN: "token" }));
  assert.deepEqual(w.variables(), [
    { proj: "101" },
    { c: "202" },
    { c: "202", cursor: "505" },
    { item: "303" },
    { proj: "101", item: "303", field: "404" },
  ]);
});

test("archive-board-items pages and archives with its ids and cursors as strings", (t) => {
  const item = {
    id: "303",
    isArchived: false,
    status: { name: "Done" },
    content: {
      repository: { nameWithOwner: "a-novel-kit/x" },
      number: 1,
      url: "https://github.com/a-novel-kit/x/issues/1",
    },
  };
  const w = graphql(t, { "items(first:100": pages("items", [item]), archiveProjectV2Item: { data: {} } });
  const env = {
    PROJECT_ID: "101",
    REPO_IN: "a-novel-kit/x",
    STATUS: "Done",
    ARCHIVE_CLOSED: "",
    CLOSE: "",
    DRY_RUN: "",
  };
  succeeds(
    w.bash(step("generic-actions/archive-board-items/action.yaml", "Archive (and close) terminal board items"), env)
  );
  assert.deepEqual(w.variables(), [{ proj: "101" }, { proj: "101", cursor: "505" }, { proj: "101", item: "303" }]);
});
