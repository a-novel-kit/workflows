import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { step, succeeds, workspace } from "./helpers.mjs";

const release = "publish-actions/sentry-release/action.yaml";

// The download stands in for sentry-cli: it logs each call with the project and token it sees.
function sentryCli(t) {
  const w = workspace(t);
  const binary = `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const { SENTRY_PROJECT, SENTRY_AUTH_TOKEN } = process.env;
appendFileSync("${w.cwd}/calls", JSON.stringify({ args: process.argv.slice(2), SENTRY_PROJECT, SENTRY_AUTH_TOKEN }) + "\\n");
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
  const run = (extra = {}) => w.bash(step(release, "Record the release"), { ...env, ...extra });
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

test("sentry-release names the release after the repository and records its commits and deploy", (t) => {
  const { w, run, calls, reset } = sentryCli(t);
  const name = "service-authentication@1.2.3";
  const expected = [
    ["releases", "new", name],
    ["releases", "set-commits", name, "--auto", "--ignore-missing"],
    ["releases", "finalize", name],
    ["deploys", "new", "--release", name, "--env", "production"],
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
