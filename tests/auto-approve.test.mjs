import assert from "node:assert/strict";
import { test } from "node:test";
import { step, succeeds, workspace } from "./helpers.mjs";

const guard = step(".github/workflows/auto-approve-dependabot-run.yaml", "guard");
const bot = "anovelbot-dependencies[bot]";

/** A pull request commit as the REST API lists it; the bot's own commits are signed by GitHub. */
const commit = ({ author = bot, committer = "web-flow", verified = true } = {}) => ({
  author: { login: author },
  committer: { login: committer },
  commit: { verification: { verified } },
});

/** Runs the guard against a stubbed gh and reports whether it withheld the approval. */
function skips(
  t,
  { authors = bot, commits = [commit()], age = "success", choice = "renovate/x anovelbot-dependencies true" } = {}
) {
  const w = workspace(t);
  w.write("output", "");
  w.stub(
    "gh",
    `const args = process.argv.slice(2);
    if (args[0] === "pr") console.log(process.env.AUTHORS);
    else if (args[1] === "graphql") console.log(process.env.CHOICE);
    else if (args.includes("--slurp")) console.log(JSON.stringify([JSON.parse(process.env.COMMITS)]));
    else if (args.some((arg) => arg.endsWith("/status"))) console.log(process.env.AGE);`
  );
  const env = {
    GITHUB_REPOSITORY: "a-novel/infra",
    GH_TOKEN: "app-token",
    STATUS_TOKEN: "workflow-token",
    PR: "https://github.com/a-novel/infra/pull/7",
    BOT: bot,
    SHA: "c0ffee",
    AUTHORS: authors,
    COMMITS: JSON.stringify(commits),
    AGE: age,
    CHOICE: choice,
  };
  succeeds(w.bash(guard, env));
  return w.read("output").includes("skip=true");
}

test("auto-approve trusts only signed bot commits, aged updates, and Renovate's own auto-merge choice", (t) => {
  const cases = [
    ["the bot's own commits", {}, false],
    ["a person's commit", { authors: `${bot},kushuh` }, true],
    // A push can claim the bot's email and sign as its pusher; only GitHub signs as web-flow.
    ["a pushed commit claiming the bot", { commits: [commit(), commit({ committer: "kushuh" })] }, true],
    ["an unverified commit", { commits: [commit({ verified: false })] }, true],
    ["an update still aging", { age: "pending" }, true],
    // The branch, the first to enable auto-merge, and whether it is on now.
    ["a Renovate update left to review", { choice: "renovate/x none false" }, true],
    ["a Renovate update a person took off auto-merge", { choice: "renovate/x anovelbot-dependencies false" }, true],
    ["a Renovate update another actor put on auto-merge", { choice: "renovate/x anovelbot-agent true" }, true],
    ["the bot's own pull request, which Renovate never arms", { choice: "chore/deps/audit none false" }, false],
    ["a backport", { choice: "backport/v1.2-0123456789ab none false" }, false],
  ];
  for (const [name, options, skipped] of cases) {
    assert.equal(skips(t, options), skipped, name);
  }
});
