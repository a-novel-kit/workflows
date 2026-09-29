#!/bin/bash
# Verify Renovate extracts hidden workflow and composite-action dependency pins.

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
node --input-type=module - "$ROOT" <<'NODE'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const preset = (name) =>
  JSON.parse(readFileSync(`${process.argv[2]}/renovate/${name}.json`, "utf8"));
const { customManagers, packageRules, extends: baseExtends } = preset("base");
const runtime = JSON.parse(readFileSync(`${process.argv[2]}/generic-actions/renovate/config.json`, "utf8"));
assert.deepEqual(baseExtends, ["config:recommended"]);
assert.deepEqual(runtime.allowedCommands, ["^pnpm (install|i|format|dedupe)( |$)"]);
assert.equal(runtime.customEnvVariables["npm_config_//npm.pkg.github.com/:_authToken"], "{{ secrets.GITHUB_TOKEN }}");
for (const name of ["service", "platform", "library", "infra", "workflows", "meta"]) {
  assert(preset(name).extends.includes("./base"), `${name} must inherit the base`);
}

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

const grpcHold = packageRules.find(({ matchPackageNames }) =>
  matchPackageNames?.includes("google.golang.org/grpc"),
);
assert(grpcHold, "gRPC v1.84.0 security hold is missing");
assert.equal(grpcHold.allowedVersions, "<1.84.0 || >1.84.0");

const ubuntuHold = packageRules.find(({ matchPackageNames }) =>
  matchPackageNames?.includes("ubuntu"),
);
assert(ubuntuHold, "unavailable Ubuntu v26 runner hold is missing");
assert.equal(ubuntuHold.allowedVersions, "<26");

const terraformGoogleGroup = packageRules.find(
  ({ groupName }) => groupName === "terraform google",
);
assert(terraformGoogleGroup, "Terraform Google provider group is missing");
assert.deepEqual(terraformGoogleGroup.matchManagers, ["terraform"]);
assert.deepEqual(terraformGoogleGroup.matchPackageNames, ["hashicorp/google"]);

const javascriptGroupIndex = packageRules.findIndex(
  ({ groupName }) => groupName === "javascript dependencies",
);
const uikitGroupIndex = packageRules.findIndex(
  ({ groupName }) => groupName === "a-novel-kit uikit",
);
const playwrightGroupIndex = packageRules.findIndex(
  ({ groupName }) => groupName === "playwright runtime",
);
const vitestGroupIndex = packageRules.findIndex(
  ({ groupName }) => groupName === "vitest monorepo",
);
const svelteViteGroupIndex = packageRules.findIndex(
  ({ groupName }) => groupName === "svelte vite toolchain",
);
assert(javascriptGroupIndex >= 0, "javascript dependency group is missing");
for (const [name, index] of [
  ["uikit", uikitGroupIndex],
  ["Playwright", playwrightGroupIndex],
  ["Vitest", vitestGroupIndex],
  ["Svelte/Vite", svelteViteGroupIndex],
]) {
  assert(index > javascriptGroupIndex, name + " must override the npm catch-all");
}

const uikitRule = packageRules[uikitGroupIndex];
assert.equal(uikitRule.automerge, false);
assert(compileRenovateRegex(uikitRule.matchCurrentVersion).test("0.3.1"));
assert(!compileRenovateRegex(uikitRule.matchCurrentVersion).test("1.0.0"));
assert(compileRenovateRegex(uikitRule.matchPackageNames[0]).test("@a-novel-kit/uikit"));
assert(compileRenovateRegex(uikitRule.matchPackageNames[0]).test("@a-novel-kit/uikit-icons"));

const playwrightRule = packageRules[playwrightGroupIndex];
assert.deepEqual(playwrightRule.matchPackageNames, [
  "playwright",
  "/^@playwright\\//",
  "mcr.microsoft.com/playwright",
]);
assert(
  playwrightRule.matchPackageNames.every((pattern) =>
    pattern.startsWith("/")
      ? !compileRenovateRegex(pattern).test("@vitest/browser-playwright")
      : pattern !== "@vitest/browser-playwright",
  ),
  "Vitest Playwright adapters must remain in the Vitest group",
);

const vitestRule = packageRules[vitestGroupIndex];
assert.deepEqual(vitestRule.matchPackageNames, ["vitest", "/^@vitest\\//"]);

const svelteViteRule = packageRules[svelteViteGroupIndex];
assert.deepEqual(svelteViteRule.matchPackageNames, ["vite", "@sveltejs/vite-plugin-svelte"]);
assert.deepEqual(svelteViteRule.matchUpdateTypes, ["major"]);

const service = preset("service");
for (const [manager, matches, misses] of [
  ["gomod", ["buf.mod", "tools/mockery.mod"], ["models.mod"]],
  ["docker-compose", ["builds/podman-compose.go.test.yaml", "compose.yml"], ["builds/database.apko.yaml"]],
]) {
  const patterns = service[manager].managerFilePatterns.map(compileRenovateRegex);
  for (const [files, expected] of [[matches, true], [misses, false]]) {
    for (const file of files) {
      assert.equal(patterns.some((pattern) => pattern.test(file)), expected, file);
    }
  }
}

const database = preset("database");
assert(service.extends.includes("./database"));
assert.deepEqual(database.packageRules.find(({ registryUrls }) => registryUrls), {
  matchFileNames: ["builds/database.apko.yaml"],
  matchDatasources: ["apk"],
  registryUrls: ["https://packages.wolfi.dev/os?arch=x86_64"],
});
for (const [datasource, fixture, expected] of [
  [
    "custom.pgbackrest",
    `ARG PGBACKREST_VERSION=2.59.1\nARG PGBACKREST_SHA256=${"a".repeat(64)}\n`,
    [{ currentValue: "2.59.1", currentDigest: "a".repeat(64) }],
  ],
  ["custom.pgbackrest", "ARG PGBACKREST_VERSION=2.59.1\nARG PGBACKREST_SHA256=invalid\n", []],
  ["github-tags", "go install chainguard.dev/apko@v1.4.5", [{ currentValue: "v1.4.5" }]],
  ["apk", "- postgresql-18=18.6-r3\n- ca-certificates\n", [{ depName: "postgresql-18", currentValue: "18.6-r3" }]],
]) {
  const manager = database.customManagers.find(({ datasourceTemplate }) => datasourceTemplate === datasource);
  assert.deepEqual(extract(manager, fixture).map((groups) => ({ ...groups })), expected, datasource);
}

const postgresPatterns = database.packageRules[0].matchPackageNames.map(compileRenovateRegex);
for (const [name, grouped] of [
  ["postgresql-18", true], ["postgresql-18-client", true],
  ["postgresql-19-contrib", true], ["postgresql-common", false], ["gosu", false],
]) {
  assert.equal(postgresPatterns.some((pattern) => pattern.test(name)), grouped, name);
}

const workflowsGroup = packageRules.find(({ groupName }) => groupName === "a-novel-kit workflows");
assert(workflowsGroup.matchPackageNames.some((pattern) => compileRenovateRegex(pattern).test("a-novel-kit/workflows")));

console.log("renovate-extraction: all assertions passed");
NODE
