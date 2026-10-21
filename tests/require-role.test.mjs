import assert from "node:assert/strict";
import { test } from "node:test";
import { manifest, step, workspace } from "./helpers.mjs";

const gate = "generic-actions/require-role/action.yaml";

test("require-role admits only the listed roles of the actor who started the attempt", (t) => {
  const env = manifest(gate).runs.steps[0].env;
  assert.equal(env.ACTOR, "${{ github.triggering_actor }}");
  const w = workspace(t);
  w.write("summary", "");
  w.stub(
    "gh",
    `const args = process.argv.slice(2);
    if (process.env.API_FAIL === "1") process.exit(1);
    if (!args.includes("repos/owner/repo/collaborators/invoker/permission") || !args.includes(".role_name")) process.exit(2);
    console.log(process.env.ROLE);`
  );
  const script = step(gate, "Require role");
  const cases = [
    ["admin", "admin", "0", 0],
    ["admin", "maintain", "0", 1],
    ["admin,maintain", "maintain", "0", 0],
    ["admin, maintain", "maintain", "0", 0],
    ["admin,maintain", "write", "0", 1],
    ["admin", "admin", "1", 1],
    ["admin,", "", "0", 1],
  ];
  for (const [roles, role, failed, expected] of cases) {
    const vars = { REPO_FULL: "owner/repo", ACTOR: "invoker", ROLES: roles, ROLE: role, API_FAIL: failed };
    assert.equal(w.bash(script, vars).status, expected, `roles=${roles} role=${role} failed=${failed}`);
  }
});

const gated = [
  ["generic-actions/approve-pr/action.yaml", "admin"],
  ["generic-actions/epic-rollback/action.yaml", "admin"],
  ["generic-actions/release-train/action.yaml", "admin"],
  [".github/workflows/epic-rollback-run.yaml", "admin"],
  [".github/workflows/release-train-run.yaml", "admin"],
  [".github/workflows/backport-run.yaml", "admin"],
];
for (const [path, roles] of gated) {
  test(`${path} gates on require-role before minting a token`, () => {
    const action = manifest(path);
    const steps = action.runs?.steps ?? Object.values(action.jobs).flatMap((job) => job.steps ?? []);
    const at = steps.findIndex((s) => s.uses?.startsWith("a-novel-kit/workflows/generic-actions/require-role@"));
    assert.notEqual(at, -1);
    assert.equal(steps[at].with.roles, roles);
    const mint = steps.findIndex((s) => s.uses?.startsWith("actions/create-github-app-token@"));
    assert(mint === -1 || at < mint);
  });
}

test("approve-pr approves only the pull request of the actor who started the attempt", (t) => {
  const path = "generic-actions/approve-pr/action.yaml";
  const steps = manifest(path).runs.steps;
  const own = steps.findIndex((s) => s.name === "Require own pull request");
  assert.equal(steps[own].env.ACTOR, "${{ github.triggering_actor }}");
  assert.equal(steps[own].env.GH_TOKEN, "${{ steps.token.outputs.token }}");
  assert(steps.findIndex((s) => s.id === "token") < own);
  assert(own < steps.findIndex((s) => s.uses?.startsWith("a-novel-kit/workflows/generic-actions/approve-bot@")));

  const w = workspace(t);
  w.stub(
    "gh",
    `if (process.env.API_FAIL === "1") process.exit(1);
    if (process.argv.slice(2).join(" ") !== "pr view 7 --json author --jq .author.login") process.exit(2);
    console.log(process.env.AUTHOR);`
  );
  const script = step(path, "Require own pull request");
  const cases = [
    ["invoker", "0", 0],
    ["someone", "0", 1],
    ["app/renovate", "0", 1],
    ["invoker", "1", 1],
  ];
  for (const [author, failed, expected] of cases) {
    const vars = { PR_URL: "7", ACTOR: "invoker", AUTHOR: author, API_FAIL: failed };
    assert.equal(w.bash(script, vars).status, expected, `author=${author} failed=${failed}`);
  }
});
