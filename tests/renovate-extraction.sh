#!/bin/bash
# Verify Renovate extracts hidden workflow and composite-action dependency pins.

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ACTION="$ROOT/generic-actions/renovate/action.yaml"

config=$(python3 - "$ACTION" <<'PY'
import json
import sys

import yaml

with open(sys.argv[1], encoding="utf-8") as stream:
    manifest = yaml.safe_load(stream)

renovate_step = next(
    step
    for step in manifest["runs"]["steps"]
    if "RENOVATE_CUSTOM_MANAGERS" in step.get("env", {})
)

print(json.dumps({
    "customManagers": json.loads(renovate_step["env"]["RENOVATE_CUSTOM_MANAGERS"]),
    "packageRules": json.loads(renovate_step["env"]["RENOVATE_PACKAGE_RULES"]),
}))
PY
)

RENOVATE_CONFIG="$config" node --input-type=module <<'NODE'
import assert from "node:assert/strict";

const { customManagers, packageRules } = JSON.parse(process.env.RENOVATE_CONFIG);

function compileRenovateRegex(value) {
  const separator = value.lastIndexOf("/");
  assert.equal(value[0], "/");
  return new RegExp(value.slice(1, separator), value.slice(separator + 1));
}

function extract(manager, fixture) {
  return manager.matchStrings.flatMap((pattern) =>
    [...fixture.matchAll(new RegExp(pattern, "g"))].map(({ groups }) => groups),
  );
}

const workflowManager = customManagers.find(({ description }) =>
  description.includes("workflow with: blocks"),
);
assert(workflowManager, "workflow annotation manager is missing");
assert(
  workflowManager.managerFilePatterns.some((pattern) =>
    compileRenovateRegex(pattern).test(".github/workflows/main.yaml"),
  ),
  "workflow annotation manager does not scan caller workflows",
);
assert.deepEqual(
  extract(
    workflowManager,
    `# renovate: datasource=github-releases depName=koalaman/shellcheck
version: "0.11.0"`,
  ).map(({ datasource, depName, currentValue }) => ({ datasource, depName, currentValue })),
  [
    {
      datasource: "github-releases",
      depName: "koalaman/shellcheck",
      currentValue: "0.11.0",
    },
  ],
);

const imageManager = customManagers.find(({ description }) =>
  description.includes("composite-action input defaults"),
);
assert(imageManager, "composite-action image manager is missing");
assert.equal(imageManager.datasourceTemplate, "docker");
assert.equal(imageManager.versioningTemplate, "docker");
assert(
  imageManager.managerFilePatterns.some((pattern) =>
    compileRenovateRegex(pattern).test(".github/actions/start-ci-services/action.yml"),
  ),
  "composite-action image manager does not scan repository-local actions",
);

const imagePins = extract(
  imageManager,
  `inputs:
  database_image:
    default: ghcr.io/a-novel/service-json-keys/database:v2.4.1
  grpc_image:
    default: "ghcr.io/a-novel/service-json-keys/standalone-grpc:v2.4.1"
  local_image:
    default: service-under-test:ci
  callback:
    default: https://example.test:8443/path`,
).map(({ depName, currentValue }) => ({ depName, currentValue }));

assert.deepEqual(imagePins, [
  {
    depName: "ghcr.io/a-novel/service-json-keys/database",
    currentValue: "v2.4.1",
  },
  {
    depName: "ghcr.io/a-novel/service-json-keys/standalone-grpc",
    currentValue: "v2.4.1",
  },
]);

const jsonKeysRule = packageRules.find(({ groupName }) => groupName === "service json keys");
assert(jsonKeysRule, "service JSON Keys group rule is missing");
const groupPatterns = jsonKeysRule.matchPackageNames.map(compileRenovateRegex);
for (const dependency of [
  "github.com/a-novel/service-json-keys/v2",
  "ghcr.io/a-novel/service-json-keys/database",
  "ghcr.io/a-novel/service-json-keys/standalone-grpc",
]) {
  assert(
    groupPatterns.some((pattern) => pattern.test(dependency)),
    `${dependency} does not join the service JSON Keys group`,
  );
}

const goDirectiveRule = packageRules.find(
  ({ groupName, matchManagers, matchDepNames, rangeStrategy }) =>
    groupName === "go toolchain" &&
    matchManagers?.includes("gomod") &&
    matchDepNames?.includes("go") &&
    rangeStrategy === "bump",
);
assert(goDirectiveRule, "main Go directive rule is missing");
const goFilePatterns = goDirectiveRule.matchFileNames.map(compileRenovateRegex);
for (const mainModule of ["go.mod", "cli/go.mod"]) {
  assert(
    goFilePatterns.some((pattern) => pattern.test(mainModule)),
    `${mainModule} does not join the Go toolchain group`,
  );
}
for (const toolModule of ["buf.mod", "golangci-lint.mod", "gotestsum.mod", "mockery.mod"]) {
  assert(
    goFilePatterns.every((pattern) => !pattern.test(toolModule)),
    `${toolModule} must keep its existing Go compatibility floor`,
  );
}

assert.equal(
  packageRules.filter(({ dependencyDashboardApproval }) => dependencyDashboardApproval).length,
  0,
  "Dependency Dashboard approval must not gate Renovate updates",
);

const protobufRule = packageRules.find(({ matchPackageNames }) =>
  matchPackageNames?.includes("google.golang.org/protobuf"),
);
assert(protobufRule, "protobuf regeneration rule is missing");
assert.deepEqual(protobufRule.matchDepTypes, ["require"]);
const protobufFilePatterns = protobufRule.matchFileNames.map(compileRenovateRegex);
assert(
  protobufFilePatterns.some((pattern) => pattern.test("go.mod")),
  "protobuf regeneration must match the root module",
);
assert(protobufFilePatterns.every((pattern) => !pattern.test("cli/go.mod")));
assert.deepEqual(protobufRule.postUpgradeTasks, {
  commands: ["go tool -modfile=buf.mod buf generate"],
  executionMode: "branch",
});

const golangciHold = packageRules.find(({ matchPackageNames }) =>
  matchPackageNames?.includes("github.com/golangci/golangci-lint/v2"),
);
assert(golangciHold, "golangci-lint v2.13.0 hold is missing");
assert.equal(golangciHold.allowedVersions, "<2.13.0 || >2.13.0");

console.log("renovate-extraction: all assertions passed");
NODE
