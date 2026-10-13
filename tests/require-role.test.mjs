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
  for (const [roles, role, failed, expected] of [
    ["admin", "admin", "0", 0],
    ["admin", "maintain", "0", 1],
    ["admin,maintain", "maintain", "0", 0],
    ["admin, maintain", "maintain", "0", 0],
    ["admin,maintain", "write", "0", 1],
    ["admin", "admin", "1", 1],
    ["admin,", "", "0", 1],
  ]) {
    assert.equal(
      w.bash(step(gate, "Require role"), {
        REPO_FULL: "owner/repo",
        ACTOR: "invoker",
        ROLES: roles,
        ROLE: role,
        API_FAIL: failed,
      }).status,
      expected,
      `roles=${roles} role=${role} failed=${failed}`
    );
  }
});

for (const [path, roles] of [
  ["generic-actions/approve-pr/action.yaml", "admin,maintain"],
  ["generic-actions/epic-rollback/action.yaml", "admin"],
  ["generic-actions/release-train/action.yaml", "admin"],
  [".github/workflows/epic-rollback-run.yaml", "admin"],
  [".github/workflows/release-train-run.yaml", "admin"],
  [".github/workflows/backport-run.yaml", "admin"],
]) {
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
