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
const pin = ({ datasource, depName, currentValue }) => ({ datasource, depName, currentValue });

/** A `groups` case for one first-party service: its module, image and client join the group, the platform stays out. */
function serviceGroup(service) {
  return [
    `service ${service.replace("-", " ")}`,
    [
      `github.com/a-novel/service-${service}`,
      `ghcr.io/a-novel/service-${service}/database`,
      `@a-novel/service-${service}`,
    ],
    ["github.com/a-novel/platform-studio"],
  ];
}

test("Renovate extracts hidden workflow, action-image and database tool pins", () => {
  const workflow = base.customManagers.find((m) => m.description.includes("workflow with: blocks"));
  assert(matches(workflow.managerFilePatterns, ".github/workflows/main.yaml"));
  const release = '# renovate: datasource=github-releases depName=koalaman/shellcheck\nversion: "0.11.0"';
  assert.deepEqual(extract(workflow, release).map(pin), [
    { datasource: "github-releases", depName: "koalaman/shellcheck", currentValue: "0.11.0" },
  ]);
  // A digest moves with its version: an image's after `@`, a release file's sha256 on the next line.
  // A sha256 anywhere else stays out of the match.
  const hash = "d".repeat(64);
  const shellcheck = '# renovate: datasource=custom.shellcheck depName=koalaman/shellcheck\nversion: "0.11.0"';
  const digests = [
    [
      `# renovate: datasource=docker depName=ghcr.io/zizmorcore/zizmor\nversion: "1.31.1@sha256:${hash}"`,
      "1.31.1",
      `sha256:${hash}`,
    ],
    [`${shellcheck}\nsha256: "${hash}"`, "0.11.0", hash],
    [`${shellcheck}\npaths: x\nsha256: "${hash}"`, "0.11.0", undefined],
  ];
  for (const [fixture, currentValue, currentDigest] of digests)
    assert.deepEqual(
      extract(workflow, fixture).map((groups) => [groups.currentValue, groups.currentDigest]),
      [[currentValue, currentDigest]],
      fixture
    );
  const container =
    "container:\n  # renovate: datasource=npm depName=playwright\n  image: mcr.microsoft.com/playwright:v1.63.0-noble";
  assert.deepEqual(extract(workflow, container).map(pin), [
    { datasource: "npm", depName: "playwright", currentValue: "1.63.0" },
  ]);
  const images = base.customManagers.find((m) => m.description.includes("composite-action input defaults"));
  assert(matches(images.managerFilePatterns, ".github/actions/start-ci-services/action.yml"));
  const defaults = `inputs:
  database_image:
    default: ghcr.io/a-novel/service-json-keys/database:v2.4.1
  grpc_image:
    default: "ghcr.io/a-novel/service-json-keys/standalone-grpc:v2.4.1"
  pinned_image:
    default: ghcr.io/a-novel/service-authentication/database:v2.14.0@sha256:${"c".repeat(64)}
  local_image:
    default: service-under-test:ci
  callback:
    default: https://example.test:8443/path`;
  assert.deepEqual(
    extract(images, defaults).map(({ depName, currentValue, currentDigest }) => ({
      depName,
      currentValue,
      currentDigest,
    })),
    [
      { depName: "ghcr.io/a-novel/service-json-keys/database", currentValue: "v2.4.1", currentDigest: undefined },
      {
        depName: "ghcr.io/a-novel/service-json-keys/standalone-grpc",
        currentValue: "v2.4.1",
        currentDigest: undefined,
      },
      // A digest written after the tag moves with it.
      {
        depName: "ghcr.io/a-novel/service-authentication/database",
        currentValue: "v2.14.0",
        currentDigest: `sha256:${"c".repeat(64)}`,
      },
    ]
  );
  const databasePins = [
    [
      "custom.pgbackrest",
      `ARG PGBACKREST_VERSION=2.59.1\nARG PGBACKREST_SHA256=${"a".repeat(64)}\n`,
      [{ currentValue: "2.59.1", currentDigest: "a".repeat(64) }],
    ],
    ["custom.pgbackrest", "ARG PGBACKREST_VERSION=2.59.1\nARG PGBACKREST_SHA256=invalid\n", []],
    [
      "custom.apko",
      `ARG APKO_VERSION=1.4.11\nARG APKO_CHECKSUMS_SHA256=${"b".repeat(64)}\n`,
      [{ currentValue: "1.4.11", currentDigest: "b".repeat(64) }],
    ],
    [
      "apk",
      "- postgresql-18=18.6-r3\n- pg_cron-18=1.6.8-r0\n- ca-certificates\n",
      [
        { depName: "postgresql-18", currentValue: "18.6-r3" },
        { depName: "pg_cron-18", currentValue: "1.6.8-r0" },
      ],
    ],
  ];
  for (const [datasource, fixture, expected] of databasePins) {
    const manager = database.customManagers.find((m) => m.datasourceTemplate === datasource);
    assert.deepEqual(extract(manager, fixture), expected);
  }
});

test("Renovate groups compatible libraries and runtimes after the npm catch-all", () => {
  const rule = (name) => base.packageRules.find((r) => r.groupName === name);
  const catchAll = base.packageRules.indexOf(rule("javascript dependencies"));
  const groups = [
    ["a-novel-kit uikit", ["@a-novel-kit/uikit", "@a-novel-kit/uikit-icons"], ["@other/uikit"]],
    ["playwright runtime", ["playwright", "@playwright/test"], ["@vitest/browser-playwright"]],
    ["vitest monorepo", ["vitest", "@vitest/browser-playwright"], ["playwright"]],
    ["svelte vite toolchain", ["vite", "@sveltejs/vite-plugin-svelte"], ["svelte"]],
    ...["json-keys", "authentication", "narrative-engine", "genai"].map(serviceGroup),
  ];
  for (const [group, yes, no] of groups) {
    assert(base.packageRules.indexOf(rule(group)) > catchAll);
    for (const name of yes) assert(matches(rule(group).matchPackageNames, name), name);
    for (const name of no) assert(!matches(rule(group).matchPackageNames, name), name);
  }
  // A grouped branch runs every artifact update with the config of its first upgrade by depName.
  // That upgrade is an image here, so every group outside the gomod manager carries the Go module's tidy.
  const goGroups = base.packageRules.filter(
    (r) => r.groupName?.startsWith("service ") || r.groupName === "go toolchain"
  );
  for (const group of goGroups)
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
  // First-party releases skip the age gates, so the exemption follows every gate and names each form.
  const exempt = base.packageRules.findIndex((r) => r.minimumReleaseAge === null);
  assert(exempt > base.packageRules.findLastIndex((r) => typeof r.minimumReleaseAge === "string"));
  const firstParty = [
    "a-novel-kit/workflows",
    "@a-novel-kit/nodelib-config",
    "@a-novel/service-authentication-rest",
    "github.com/a-novel-kit/golib",
    "github.com/a-novel/service-json-keys",
    "ghcr.io/a-novel/service-json-keys/standalone",
  ];
  for (const name of firstParty) assert(matches(base.packageRules[exempt].matchPackageNames, name), name);
  const lookalikes = [
    "a-novel-kitchen/x",
    "@a-novelist/x",
    "github.com/someone/a-novel-kit",
    "evil/a-novel-kit/workflows",
  ];
  for (const name of lookalikes) assert(!matches(base.packageRules[exempt].matchPackageNames, name), name);
  // First-party images are pinned by digest wherever the manager adds one, so the approver checks it.
  const pinned = base.packageRules.find((r) => r.pinDigests === true);
  assert.deepEqual(pinned.matchManagers, ["docker-compose", "dockerfile"]);
  for (const name of ["ghcr.io/a-novel/service-json-keys/database", "ghcr.io/a-novel-kit/tools"])
    assert(matches(pinned.matchPackageNames, name), name);
  for (const name of ["ghcr.io/zizmorcore/zizmor", "ghcr.io/a-novelist/x", "a-novel-kit/workflows"])
    assert(!matches(pinned.matchPackageNames, name), name);
});

test("Renovate pins third-party actions to their release commit and keeps the workflows actions on tags", () => {
  assert(base.extends.includes("helpers:pinGitHubActionDigestsToSemver"));
  const actions = base.packageRules.filter((r) => r.matchManagers?.includes("github-actions"));
  // A digest update means the upstream tag moved, or a pinned release file was replaced: it
  // overrides the automerge rule before it.
  const moved = actions.find((r) => r.matchUpdateTypes?.includes("digest"));
  assert.equal(moved.automerge, false);
  assert(moved.matchManagers.includes("custom.regex"));
  // Publishers rebuild image tags as routine, so an image's digest update keeps merging on its own.
  assert.deepEqual(moved.matchDatasources, ["!docker"]);
  // Each release-file datasource waits for its assets like a GitHub release does.
  const published = base.packageRules.find((r) => r.matchDatasources?.includes("github-releases"));
  for (const name of Object.keys(base.customDatasources))
    assert(published.matchDatasources.includes(`custom.${name}`), name);
  assert(base.packageRules.indexOf(moved) > base.packageRules.findIndex((r) => r.automerge === true));
  assert.equal(actions.find((r) => r.minimumReleaseAge).minimumReleaseAge, "3 days");
  assert.equal(base.packageRules.find((r) => r.groupName === "a-novel-kit workflows").pinDigests, false);
  assert.equal(preset("workflows").packageRules, undefined);
});

test("Renovate holds only dated releases, and security fixes skip the hold", () => {
  const holds = base.packageRules.filter((r) => typeof r.minimumReleaseAge === "string");
  assert.equal(holds.find((r) => r.matchDatasources?.includes("go")).minimumReleaseAge, "3 days");
  // An undated release never clears a hold. Renovate has no date for node or golang on Docker Hub,
  // whose anonymous tag listing stops at 1,000 tags, nor for the images and runners a workflow names.
  assert(!holds.some((r) => r.matchDatasources?.includes("docker")));
  assert.deepEqual(holds.find((r) => r.matchManagers?.includes("github-actions")).matchDepTypes, [
    "action",
    "workflow",
  ]);
  // The object merges into Renovate's default, whose `minimumReleaseAge: null` every alert update is forced to.
  assert(!("minimumReleaseAge" in base.vulnerabilityAlerts));
});

test("Renovate discovers tool modules and compose files while excluding unrelated formats", () => {
  const managerFiles = [
    ["gomod", ["buf.mod", "tools/mockery.mod", "govulncheck.mod"], true],
    ["gomod", ["models.mod"], false],
    ["docker-compose", ["builds/podman-compose.go.test.yaml", "compose.yml"], true],
    ["docker-compose", ["builds/database.apko.yaml"], false],
  ];
  for (const [manager, files, expected] of managerFiles)
    for (const file of files)
      assert.equal(matches((goTools[manager] ?? service[manager]).managerFilePatterns, file), expected, file);
  // Each tool modfile updates on its own branch, or its options would reach another modfile's.
  const tools = goTools.gomod.managerFilePatterns[0].match(/\(\?:([^)]+)\)/)[1].split("|");
  for (const tool of tools) {
    const rule = [...goTools.packageRules, ...service.packageRules].find(
      (r) => r.matchFileNames?.includes(`${tool}.mod`) && r.additionalBranchPrefix
    );
    assert.equal(rule?.additionalBranchPrefix, `${tool}-`, tool);
  }
  const go = base.packageRules.find(
    (r) => r.groupName === "go toolchain" && r.matchManagers?.includes("gomod") && r.matchDepNames?.includes("go")
  );
  for (const file of ["go.mod", "cli/go.mod"]) assert(matches(go.matchFileNames, file));
  for (const file of ["buf.mod", "golangci-lint.mod", "gotestsum.mod", "mockery.mod"])
    assert(!matches(go.matchFileNames, file));
  // go.dev lists a release before Docker Hub tags its image, so the directive reads the image the group bumps.
  const image = base.packageRules.find((r) => r.groupName === "go toolchain" && r !== go);
  assert.deepEqual([go.overrideDatasource, go.overridePackageName], ["docker", image.matchDepNames[0]]);
  const version = (tag) => tag.match(new RegExp(go.extractVersion))?.groups.version;
  assert.deepEqual(["1.27.3-alpine", "1.27.3-alpine3.24", "1.27.3", "1.28rc1-alpine"].map(version), [
    "1.27.3",
    undefined,
    undefined,
    undefined,
  ]);
  // Type-checking tools need an x/tools that reads the toolchain's export data, yet it is `// indirect`.
  const xtools = goTools.packageRules.find((r) => r.matchDepNames?.includes("golang.org/x/tools"));
  assert.equal(xtools.enabled, true);
  // Security PRs must re-enable what other rules disable, such as `// indirect` requires.
  assert.deepEqual([base.osvVulnerabilityAlerts, base.vulnerabilityAlerts.enabled], [true, true]);
  for (const file of ["golangci-lint.mod", "mockery.mod"]) assert(matches(xtools.matchFileNames, file), file);
  const postgres = database.packageRules[0].matchPackageNames;
  const packages = [
    ["postgresql-18", true],
    ["postgresql-19-contrib", true],
    ["postgresql-common", false],
    ["gosu", false],
  ];
  for (const [name, expected] of packages) assert.equal(matches(postgres, name), expected);
});
