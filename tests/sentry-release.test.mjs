import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { command, manifest, root, step, succeeds, workspace } from "./helpers.mjs";

const release = "publish-actions/sentry-release/action.yaml";

// The download stands in for sentry-cli: it logs each call with the directory, project and token it sees.
function sentryCli(t) {
  const w = workspace(t);
  const binary = `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const { SENTRY_PROJECT, SENTRY_AUTH_TOKEN } = process.env;
appendFileSync("${w.cwd}/calls", JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), SENTRY_PROJECT, SENTRY_AUTH_TOKEN }) + "\\n");
`;
  w.stub(
    "curl",
    `const a = process.argv; const fs = require('fs');
    fs.appendFileSync('downloads', a.find((arg) => arg.startsWith('https://')) + '\\n');
    fs.writeFileSync(a[a.indexOf('-o') + 1], process.env.BINARY);`
  );
  const env = {
    BINARY: binary,
    RUNNER_TEMP: w.cwd,
    GITHUB_REPOSITORY: "a-novel/service-authentication",
    RELEASE_VERSION: "1.2.3",
    SENTRY_AUTH_TOKEN: "sntrys_token",
    SENTRY_CLI_VERSION: "3.8.2",
    SENTRY_CLI_SHA256: createHash("sha256").update(binary).digest("hex"),
  };
  // The runner starts the step in the action's `path`, the workspace root unless the caller names one.
  const run = (extra = {}, cwd = w.cwd) =>
    command("bash", ["--noprofile", "--norc", "-c", step(release, "Record the release")], {
      cwd,
      env: { ...w.env, ...env, ...extra },
    });
  const calls = () =>
    existsSync(join(w.cwd, "calls"))
      ? w
          .read("calls")
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  const reset = () => ["calls", "downloads", "summary"].forEach((f) => rmSync(join(w.cwd, f), { force: true }));
  return { w, run, calls, reset };
}

test("sentry-release names the release after the repository and records its commits", (t) => {
  const { w, run, calls, reset } = sentryCli(t);
  const name = "service-authentication@1.2.3";
  const expected = [
    ["releases", "new", name],
    ["releases", "set-commits", name, "--auto", "--ignore-missing"],
    ["releases", "finalize", name],
  ];
  // A tag's leading v drops from both versions, and a re-run over the existing release succeeds.
  for (const [extra, runs] of [
    [{}, 2],
    [{ RELEASE_VERSION: "v1.2.3", SENTRY_CLI_VERSION: "v3.8.2" }, 1],
  ]) {
    reset();
    for (let i = 0; i < runs; i++) succeeds(run(extra));
    const seen = calls();
    assert.deepEqual(
      seen.map((call) => call.args),
      Array.from({ length: runs }, () => expected).flat()
    );
    // The token reaches sentry-cli through its environment, never its arguments.
    for (const call of seen) {
      assert.equal(call.SENTRY_PROJECT, "service-authentication");
      assert.equal(call.SENTRY_AUTH_TOKEN, "sntrys_token");
      assert(!call.args.includes("sntrys_token"));
    }
    assert.equal(
      w.read("downloads"),
      "https://github.com/getsentry/sentry-cli/releases/download/3.8.2/sentry-cli-Linux-x86_64\n".repeat(runs)
    );
    assert.match(w.read("summary"), /Recorded the Sentry release `service-authentication@1\.2\.3`/);
  }
});

test("sentry-release skips without a token and runs nothing on a bad version or pin", (t) => {
  const { w, run, calls, reset } = sentryCli(t);
  reset();
  succeeds(run({ SENTRY_AUTH_TOKEN: "" }));
  assert(!existsSync(join(w.cwd, "downloads")));
  assert.match(w.read("summary"), /No Sentry auth token/);

  const refusals = [
    [{ RELEASE_VERSION: "" }, /^::error::release_version must be a version/m],
    [{ RELEASE_VERSION: "1.2" }, /^::error::release_version must be a version/m],
    [{ SENTRY_CLI_SHA256: "0".repeat(64) }, /^::error::sentry-cli 3\.8\.2 does not match the pinned sha256$/m],
    [{ SENTRY_CLI_SHA256: "" }, /^::error::sentry-cli 3\.8\.2 has no pinned sha256/m],
  ];
  for (const [extra, annotation] of refusals) {
    reset();
    const result = run(extra);
    assert.equal(result.status, 1, JSON.stringify(extra));
    assert.match(result.stdout, annotation);
    assert.deepEqual(calls(), [], JSON.stringify(extra));
  }
});

test("a hotfix cut records its patch from the release line it checked out and tagged", (t) => {
  const { w, run, calls } = sentryCli(t);
  // release-line-run hands sentry-release the cut's version and release-core-hotfix's checkout.
  const hotfix = "publish-actions/release-core-hotfix/action.yaml";
  const checkout = manifest(hotfix).runs.steps.find((s) => s.name === "Checkout").with.path;
  const steps = manifest(".github/workflows/release-line-run.yaml").jobs.cut.steps;
  const record = steps[steps.findIndex((s) => s.id === "cut") + 1];
  assert.match(record.uses, /\/sentry-release@/);
  assert.equal(record.with.release_version, "${{ steps.cut.outputs.version }}");
  assert.equal(record.with.path, checkout);
  assert.equal(manifest(release).runs.steps[0]["working-directory"], "${{ inputs.path }}");

  const line = join(w.cwd, checkout);
  mkdirSync(line);
  const git = (...args) => succeeds(w.run("git", ["-C", line, ...args]));
  git("init", "-q", "-b", "master");
  w.write(`${checkout}/package.json`, '{"version":"1.2.3"}');
  git("add", "package.json");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "baseline");
  git("tag", "v1.2.3");
  succeeds(w.run("git", ["init", "-q", "--bare", "remote.git"]));
  git("remote", "add", "origin", join(w.cwd, "remote.git"));
  git("push", "-q", "origin", "master:release/v1.2", "v1.2.3");
  w.stub("gh", "");
  const env = {
    ...w.env,
    GITHUB_ACTION_PATH: join(root, "publish-actions/release-core-hotfix"),
    GITHUB_REPOSITORY: "a-novel/service-authentication",
    GH_TOKEN: "release-token",
    APP_SLUG: "fixture",
    STAMP_NEEDED: "false",
    BRANCH: "release/v1.2",
    DRY_RUN: "false",
  };
  succeeds(command("bash", ["--noprofile", "--norc", "-c", step(hotfix, "cut")], { cwd: line, env }));
  const version = w.read("output").match(/^version=(.+)$/m)[1];
  succeeds(run({ RELEASE_VERSION: version }, join(w.cwd, record.with.path)));

  // set-commits --auto reads the HEAD of the checkout it runs in, which the cut left on the tagged patch.
  assert.equal(git("rev-parse", "HEAD"), git("rev-parse", "v1.2.4^{commit}"));
  assert(calls().every((call) => call.cwd === realpathSync(line)));
  assert.deepEqual(calls()[1].args, [
    "releases",
    "set-commits",
    "service-authentication@1.2.4",
    "--auto",
    "--ignore-missing",
  ]);
});
