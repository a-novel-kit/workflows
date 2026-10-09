import assert from "node:assert/strict";
import { test } from "node:test";
import { read } from "./helpers.mjs";

const preset = (name) => JSON.parse(read(`renovate/${name}.json`));
const base = preset("base"),
  database = preset("database"),
  goTools = preset("go-tools"),
  service = preset("service");
const regex = (value) => new RegExp(value.slice(1, value.lastIndexOf("/")), value.slice(value.lastIndexOf("/") + 1));
const matches = (patterns, value) =>
  patterns.some((pattern) => (pattern.startsWith("/") ? regex(pattern).test(value) : pattern === value));
const extract = (manager, fixture) =>
  manager.matchStrings.flatMap((pattern) =>
    [...fixture.matchAll(new RegExp(pattern, "g"))].map(({ groups }) => ({ ...groups }))
  );

test("Renovate extracts hidden workflow, action-image and database tool pins", () => {
  const workflow = base.customManagers.find((m) => m.description.includes("workflow with: blocks"));
  assert(matches(workflow.managerFilePatterns, ".github/workflows/main.yaml"));
  assert.deepEqual(
    extract(workflow, '# renovate: datasource=github-releases depName=koalaman/shellcheck\nversion: "0.11.0"').map(
      ({ datasource, depName, currentValue }) => ({ datasource, depName, currentValue })
    ),
    [{ datasource: "github-releases", depName: "koalaman/shellcheck", currentValue: "0.11.0" }]
  );
  assert.deepEqual(
    extract(
      workflow,
      "container:\n  # renovate: datasource=npm depName=playwright\n  image: mcr.microsoft.com/playwright:v1.63.0-noble"
    ).map(({ datasource, depName, currentValue }) => ({ datasource, depName, currentValue })),
    [{ datasource: "npm", depName: "playwright", currentValue: "1.63.0" }]
  );
  const images = base.customManagers.find((m) => m.description.includes("composite-action input defaults"));
  assert(matches(images.managerFilePatterns, ".github/actions/start-ci-services/action.yml"));
  assert.deepEqual(
    extract(
      images,
      `inputs:
  database_image:
    default: ghcr.io/a-novel/service-json-keys/database:v2.4.1
  grpc_image:
    default: "ghcr.io/a-novel/service-json-keys/standalone-grpc:v2.4.1"
  local_image:
    default: service-under-test:ci
  callback:
    default: https://example.test:8443/path`
    ).map(({ depName, currentValue }) => ({ depName, currentValue })),
    [
      { depName: "ghcr.io/a-novel/service-json-keys/database", currentValue: "v2.4.1" },
      { depName: "ghcr.io/a-novel/service-json-keys/standalone-grpc", currentValue: "v2.4.1" },
    ]
  );
  for (const [datasource, fixture, expected] of [
    [
      "custom.pgbackrest",
      `ARG PGBACKREST_VERSION=2.59.1\nARG PGBACKREST_SHA256=${"a".repeat(64)}\n`,
      [{ currentValue: "2.59.1", currentDigest: "a".repeat(64) }],
    ],
    ["custom.pgbackrest", "ARG PGBACKREST_VERSION=2.59.1\nARG PGBACKREST_SHA256=invalid\n", []],
    ["github-tags", "go install chainguard.dev/apko@v1.4.5", [{ currentValue: "v1.4.5" }]],
    [
      "apk",
      "- postgresql-18=18.6-r3\n- pg_cron-18=1.6.8-r0\n- ca-certificates\n",
      [
        { depName: "postgresql-18", currentValue: "18.6-r3" },
        { depName: "pg_cron-18", currentValue: "1.6.8-r0" },
      ],
    ],
  ])
    assert.deepEqual(
      extract(
        database.customManagers.find((m) => m.datasourceTemplate === datasource),
        fixture
      ),
      expected
    );
});

test("Renovate groups compatible libraries and runtimes after the npm catch-all", () => {
  const rule = (name) => base.packageRules.find((r) => r.groupName === name);
  const catchAll = base.packageRules.indexOf(rule("javascript dependencies"));
  for (const [group, yes, no] of [
    ["a-novel-kit uikit", ["@a-novel-kit/uikit", "@a-novel-kit/uikit-icons"], ["@other/uikit"]],
    ["playwright runtime", ["playwright", "@playwright/test"], ["@vitest/browser-playwright"]],
    ["vitest monorepo", ["vitest", "@vitest/browser-playwright"], ["playwright"]],
    ["svelte vite toolchain", ["vite", "@sveltejs/vite-plugin-svelte"], ["svelte"]],
    ...["json-keys", "authentication", "narrative-engine", "genai"].map((service) => [
      `service ${service.replace("-", " ")}`,
      [
        `github.com/a-novel/service-${service}`,
        `ghcr.io/a-novel/service-${service}/database`,
        `@a-novel/service-${service}`,
      ],
      ["github.com/a-novel/platform-studio"],
    ]),
  ]) {
    assert(base.packageRules.indexOf(rule(group)) > catchAll);
    for (const name of yes) assert(matches(rule(group).matchPackageNames, name), name);
    for (const name of no) assert(!matches(rule(group).matchPackageNames, name), name);
  }
  // A grouped branch runs every artifact update with the config of its first upgrade by
  // depName, which is an image here, so the image must carry the Go module's tidy.
  for (const group of base.packageRules.filter(
    (r) => r.groupName?.startsWith("service ") || r.groupName === "go toolchain"
  ))
    if (!group.matchManagers?.includes("gomod"))
      assert(group.postUpdateOptions?.includes("gomodTidy"), group.groupName);
  assert(matches(rule("a-novel-kit workflows").matchPackageNames, "a-novel-kit/workflows"));
  // Renovate disables `// indirect` requires; Bun's version guard needs them re-enabled.
  for (const name of ["github.com/uptrace/bun", "github.com/uptrace/bun/dialect/pgdialect"])
    assert(matches(rule("uptrace/bun").matchPackageNames, name), name);
  assert.equal(rule("uptrace/bun").enabled, true);
  // MCR has no release timestamps: the image tag follows its annotated npm pin through the npm age gate.
  const image = base.packageRules.find((r) => r.matchPackageNames?.includes("mcr.microsoft.com/playwright"));
  assert.deepEqual([image.matchDatasources, image.enabled], [["docker"], false]);
  assert.deepEqual(base.packageRules.find((r) => r.minimumReleaseAge === "3 days").matchDatasources, ["npm"]);
});

test("Renovate discovers tool modules and compose files while excluding unrelated formats", () => {
  for (const [manager, files, expected] of [
    ["gomod", ["buf.mod", "tools/mockery.mod"], true],
    ["gomod", ["models.mod"], false],
    ["docker-compose", ["builds/podman-compose.go.test.yaml", "compose.yml"], true],
    ["docker-compose", ["builds/database.apko.yaml"], false],
  ])
    for (const file of files)
      assert.equal(matches((goTools[manager] ?? service[manager]).managerFilePatterns, file), expected, file);
  const go = base.packageRules.find(
    (r) => r.groupName === "go toolchain" && r.matchManagers?.includes("gomod") && r.matchDepNames?.includes("go")
  );
  for (const file of ["go.mod", "cli/go.mod"]) assert(matches(go.matchFileNames, file));
  for (const file of ["buf.mod", "golangci-lint.mod", "gotestsum.mod", "mockery.mod"])
    assert(!matches(go.matchFileNames, file));
  // Type-checking tools need an x/tools that reads the toolchain's export data, yet it is `// indirect`.
  const xtools = goTools.packageRules.find((r) => r.matchDepNames?.includes("golang.org/x/tools"));
  assert.equal(xtools.enabled, true);
  for (const file of ["golangci-lint.mod", "mockery.mod"]) assert(matches(xtools.matchFileNames, file), file);
  const postgres = database.packageRules[0].matchPackageNames;
  for (const [name, expected] of [
    ["postgresql-18", true],
    ["postgresql-19-contrib", true],
    ["postgresql-common", false],
    ["gosu", false],
  ])
    assert.equal(matches(postgres, name), expected);
});
