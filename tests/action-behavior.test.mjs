import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { functions, manifest, root, step, succeeds, workspace } from "./helpers.mjs";

test("generation retries transient failures and propagates exhaustion", (t) => {
  const w = workspace(t);
  const script = functions(step("go-actions/generate-go/action.yaml", "Generate Go code"), ["generate"]);
  w.stub(
    "go",
    `import * as fs from 'node:fs'; const n = Number(fs.readFileSync('attempts')) + 1;
    fs.writeFileSync('attempts', String(n)); process.exit(n <= Number(process.env.FAILURES) ? 1 : 0);`
  );
  w.stub("sleep", `import * as fs from 'node:fs'; fs.appendFileSync('delays', process.argv[2] + '\\n');`);
  for (const [failures, status, attempts, delays] of [
    [0, 0, 1, ""],
    [1, 0, 2, "5\n"],
    [3, 1, 3, "5\n10\n"],
  ]) {
    w.write("attempts", "0");
    w.write("delays", "");
    assert.equal(w.bash(`${script}\ngenerate`, { FAILURES: String(failures) }).status, status);
    assert.equal(Number(w.read("attempts")), attempts);
    assert.equal(w.read("delays"), delays);
  }
});

for (const [action, name, tool, env, findings] of [
  ["lint-semgrep", "semgrep", "docker", { RULESET: "service", SEMGREP_VERSION: "test" }, [1]],
  ["scan-secrets", "scan working tree", "gitleaks", { CONFIG: "" }, [10]],
  ["lint-workflows", "zizmor", "docker", { CONFIG: "", ZIZMOR_VERSION: "test" }, [11, 12, 13, 14]],
])
  test(`${action}: advisory waives findings, never a failed scanner`, (t) => {
    const w = workspace(t);
    w.write(".github/workflows/main.yaml", "name: fixture\n");
    w.stub(
      tool,
      `
      const args = process.argv.slice(2), index = args.indexOf('--exit-code');
      const code = process.env.SCANNER_EXIT === 'findings' ? (index < 0 ? 1 : Number(args[index + 1])) : Number(process.env.SCANNER_EXIT);
      console.error('scanner diagnostic'); process.exit(code);
    `
    );
    const script = step(`security-actions/${action}/action.yaml`, name);
    const vars = { ...env, ACTION_PATH: join(root, "security-actions", action) };
    for (const [code, advisory, expected] of [
      [0, false, 0],
      ...findings.flatMap((code) => [
        [code, false, code],
        [code, true, 0],
      ]),
      ...[1, 2, 3].filter((code) => !findings.includes(code)).map((code) => [code, true, code]),
    ]) {
      w.write("summary", "");
      assert.equal(
        w.bash(script, {
          ...vars,
          ADVISORY: String(advisory),
          SCANNER_EXIT: tool === "gitleaks" && code === 10 ? "findings" : String(code),
        }).status,
        expected
      );
      assert.match(w.read("summary"), code === 0 ? /clean/ : /scanner diagnostic/);
      if (code !== 0) assert.match(w.read("summary"), findings.includes(code) ? / findings/ : / did not run/);
    }
    const invalid = action === "lint-semgrep" ? { RULESET: "missing" } : { CONFIG: "missing" };
    assert.equal(w.bash(script, { ...vars, ...invalid, ADVISORY: "false", SCANNER_EXIT: "0" }).status, 1);
    if (action === "lint-semgrep") succeeds(w.bash(script, { ...vars, RULESET: "none", ADVISORY: "false" }));
  });

test("scanner retries only container launch failures and never masks a missing executable", (t) => {
  const w = workspace(t);
  w.stub(
    "docker",
    `
    import * as fs from 'node:fs'; const exits = JSON.parse(fs.readFileSync('exits'));
    fs.appendFileSync('attempts', '1');
    const code = exits.shift(); fs.writeFileSync('exits', JSON.stringify(exits)); process.exit(code);
  `
  );
  const runner = join(root, "security-actions/run-scan.mjs");
  for (const [exits, expected] of [
    [[125, 0], 0],
    [[125, 125, 125], 125],
    [[1], 1],
    [[2], 2],
  ]) {
    w.write("exits", JSON.stringify(exits));
    w.write("attempts", "");
    assert.equal(w.run(process.execPath, [runner, "scanner", "docker"], { SCAN_RETRY_DELAY_MS: "0" }).status, expected);
    assert.equal(w.read("attempts").length, exits.length);
  }
  assert.equal(
    w.run(process.execPath, [runner, "scanner", "missing-scanner-command"], { ADVISORY: "true" }).status,
    127
  );
});

test("browser action passes script names as data and preserves failures and collected logs", (t) => {
  const w = workspace(t);
  for (const tool of ["pnpm", "docker"])
    w.stub(
      tool,
      `
    import * as fs from 'node:fs'; fs.writeFileSync('calls', JSON.stringify(process.argv.slice(2)));
    console.log('service output'); process.exit(Number(process.env.TOOL_EXIT ?? 0));`
    );
  const scriptName = "test:browser $(touch injected)";
  for (const name of ["component-tests", "journeys"]) {
    const script = step("node-actions/test-playwright/action.yaml", name);
    succeeds(w.bash(script, { TEST_ACTION: scriptName, DRIVE_PROVIDER: "" }));
    assert.deepEqual(JSON.parse(w.read("calls")), ["run", scriptName]);
    assert.equal(existsSync(join(w.cwd, "injected")), false);
    assert.equal(w.bash(script, { TEST_ACTION: scriptName, DRIVE_PROVIDER: "", TOOL_EXIT: "17" }).status, 17);
  }
  const env = { COMPOSE_FILE: "builds/test services.yaml" };
  const logs = step("node-actions/test-playwright/action.yaml", "service-logs");
  succeeds(w.bash(logs, env));
  assert.equal(w.read("integration-services.log"), "service output\n");
  assert.deepEqual(JSON.parse(w.read("calls")), ["compose", "--file", env.COMPOSE_FILE, "logs", "--no-color"]);
  w.write("integration-services.log", "already collected\n");
  succeeds(w.bash(logs, { ...env, TOOL_EXIT: "23" }));
  assert.equal(w.read("integration-services.log"), "already collected\n");
  const cleanup = step("node-actions/test-playwright/action.yaml", "cleanup");
  succeeds(w.bash(cleanup, env));
  assert.deepEqual(JSON.parse(w.read("calls")), [
    "compose",
    "--file",
    env.COMPOSE_FILE,
    "down",
    "--volumes",
    "--remove-orphans",
  ]);
  assert.equal(w.bash(cleanup, { ...env, TOOL_EXIT: "23" }).status, 23);
});

test("drift review is one short-lived unzipped file linked even after a journey failure", (t) => {
  const w = workspace(t);
  const path = "node-actions/test-playwright/action.yaml";
  const upload = manifest(path).runs.steps.find((entry) => entry.id === "drift-upload");
  assert.match(upload.if, /always\(\).*steps.journeys.outputs.drift == 'true'/);
  assert.equal(upload.with.path, ".visual/review/playwright-drift.html");
  assert.equal(upload.with.archive, false);
  assert.equal(upload.with["retention-days"], 3);
  assert.equal(upload.with["overwrite"], true);
  const url = "https://github.com/a-novel/platform-studio/actions/runs/123/artifacts/456";
  succeeds(w.bash(step(path, "Link screenshot drift review"), { DRIFT_URL: url }));
  assert.ok(w.read("summary").includes(`](${url})`));
  assert.match(w.read("summary"), /Old \/ New \/ Diff/);
});

test("append-only gate checks real history, validates the base and honors only the configured override", (t) => {
  const w = workspace(t);
  const git = (...args) => succeeds(w.run("git", args));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  w.write("frozen/locked.txt", "locked\n");
  w.write("outside/file.txt", "outside\n");
  git("add", "frozen", "outside");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  const script = step("generic-actions/check-append-only/action.yaml", "Check append-only path");
  const env = { BASE: base, PATH_TO_CHECK: "frozen", OVERRIDE_LABEL: "override", EVENT_LABELS: "null" };
  for (const [path, content, expected] of [
    ["frozen/new file\n.txt", "new", 0],
    ["frozen/locked.txt", "changed", 1],
    ["outside/file.txt", "changed", 0],
  ]) {
    git("reset", "--hard", "-q", base);
    w.write(path, content);
    git("add", "frozen", "outside");
    git("commit", "-qm", "case");
    assert.equal(w.bash(script, env).status, expected);
  }
  git("reset", "--hard", "-q", base);
  git("mv", "frozen/locked.txt", "frozen/renamed.txt");
  git("commit", "-qm", "rename");
  assert.equal(w.bash(script, env).status, 1);
  succeeds(w.bash(script, { ...env, EVENT_LABELS: '["override"]' }));
  assert.equal(w.bash(script, { ...env, EVENT_LABELS: '["unrelated"]' }).status, 1);
  assert.equal(w.bash(script, { ...env, BASE: "--output=injected" }).status, 1);
  assert.equal(w.bash(script, { ...env, BASE: "a".repeat(40) }).status, 1);

  // A push's payload still carries the label added for the previous head, so it no longer bypasses.
  const push = { ...env, EVENT_ACTION: "synchronize", EVENT_LABELS: '["override"]' };
  assert.equal(w.bash(script, push).status, 1);
});

test("append-only gate removes an override that a push made stale", (t) => {
  const w = workspace(t);
  const git = (...args) => succeeds(w.run("git", args));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  w.write("frozen/locked.txt", "locked\n");
  git("add", "frozen");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  w.write("frozen/added.txt", "added\n");
  git("add", "frozen");
  git("commit", "-qm", "addition");
  w.stub(
    "gh",
    `require("fs").appendFileSync("gh-calls", JSON.stringify(process.argv.slice(2)) + "\\n");
    if (process.env.GH_FAIL) { console.error(process.env.GH_FAIL); process.exit(1); }`
  );
  const script = step("generic-actions/check-append-only/action.yaml", "Check append-only path");
  const push = {
    BASE: base,
    PATH_TO_CHECK: "frozen",
    OVERRIDE_LABEL: "append-only-override",
    EVENT_LABELS: '["append-only-override"]',
    EVENT_ACTION: "synchronize",
    GITHUB_REPOSITORY: "a-novel/service",
    PR: "7",
  };

  succeeds(w.bash(script, push));
  assert.equal(existsSync(join(w.cwd, "gh-calls")), false);

  succeeds(w.bash(script, { ...push, GH_TOKEN: "token" }));
  assert.deepEqual(JSON.parse(w.read("gh-calls")), [
    "api",
    "--method",
    "DELETE",
    "repos/a-novel/service/issues/7/labels/append-only-override",
    "--silent",
  ]);

  succeeds(w.bash(script, { ...push, GH_TOKEN: "token", GH_FAIL: "gh: Not Found (HTTP 404)" }));
  const denied = w.bash(script, { ...push, GH_TOKEN: "token", GH_FAIL: "gh: Forbidden (HTTP 403)" });
  assert.equal(denied.status, 1);
  assert.match(denied.stdout, /failed to remove the "append-only-override" label/);
});

test("change detection preserves literal pathspecs and fails on unreadable repositories", (t) => {
  const w = workspace(t);
  const script = step("generic-actions/check-changes/action.yaml", "check_diff");
  assert.notEqual(w.bash(script, { PATHSPEC: "." }).status, 0);
  succeeds(w.run("git", ["init", "-q"]));
  w.write("output", "");
  succeeds(w.bash(script, { PATHSPEC: "missing $(touch injected)" }));
  assert.equal(w.read("output"), "");
  w.write("space dir/file", "changed");
  succeeds(w.bash(script, { PATHSPEC: "space dir" }));
  assert.equal(w.read("output"), "diff=1\n");
  assert.equal(
    w.bash(step("generic-actions/check-changes/action.yaml", "fail if changes"), { MESSAGE: "$(touch injected)" })
      .status,
    1
  );
  assert.equal(existsSync(join(w.cwd, "injected")), false);
});

test("refresh-apko-locks summarizes each lock's package changes and stays quiet without any", (t) => {
  const action = manifest("generic-actions/refresh-apko-locks/action.yaml");
  assert.equal(action.inputs.version.required, true);
  assert.equal(action.inputs.version.default, undefined);
  const publish = action.runs.steps.find((s) => s.name === "Open or update the pull request");
  assert.equal(publish.if, "${{ steps.refresh.outputs.summary != '' }}");

  const lock = (packages) =>
    JSON.stringify({ contents: { packages: Object.entries(packages).map(([name, version]) => ({ name, version })) } });
  const w = workspace(t);
  // The stub writes NEW_LOCK where apko lock would write the lock.
  w.stub(
    "apko",
    "const args = process.argv; require('fs').writeFileSync(args[args.indexOf('--output') + 1], process.env.NEW_LOCK);"
  );
  w.write("builds/db.apko.yaml", "contents: {}\n");
  w.write("builds/db.apko.lock.json", lock({ busybox: "1.0-r0", openssl: "3.0-r0", zlib: "1.2-r0" }));
  succeeds(w.run("git", ["init", "-q"]));
  succeeds(w.run("git", ["add", "."]));
  succeeds(w.run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "locks"]));

  const refresh = step("generic-actions/refresh-apko-locks/action.yaml", "refresh");
  for (const [name, newLock, expected] of [
    [
      "changed",
      lock({ busybox: "1.0-r0", openssl: "3.1-r0", libfoo: "2.0-r0" }),
      "\n**`builds/db.apko.lock.json`**\n\n" +
        "- `libfoo`: added → 2.0-r0\n- `openssl`: 3.0-r0 → 3.1-r0\n- `zlib`: 1.2-r0 → removed\n",
    ],
    ["unchanged", lock({ busybox: "1.0-r0", openssl: "3.0-r0", zlib: "1.2-r0" }), ""],
  ]) {
    w.write("output", "");
    succeeds(w.bash(refresh, { CONFIGS: "builds/db.apko.yaml", ARCH: "x86_64", NEW_LOCK: newLock }));
    assert.equal(w.read("output"), expected && `summary<<SUMMARY_END\n${expected}\nSUMMARY_END\n`, name);
  }
});

test("refresh-apko-locks commits through the API, which signs it, and moves the branch onto it", (t) => {
  const w = workspace(t);
  w.stub(
    "gh",
    `
    const fs = require('fs'), args = process.argv.slice(2);
    const input = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : undefined;
    fs.appendFileSync('calls', JSON.stringify({ args, input }) + '\\n');
    const path = args.find((arg) => arg.startsWith('repos/')) ?? '';
    if (path.endsWith('/git/trees')) console.log('tree-sha');
    else if (path.endsWith('/git/commits')) console.log('commit-sha');
    else if (path.includes('/git/ref/')) process.exit(process.env.BRANCH_EXISTS === 'true' ? 0 : 1);
  `
  );
  w.write("builds/db.apko.yaml", "contents: {}\n");
  w.write("builds/db.apko.lock.json", "old");
  succeeds(w.run("git", ["init", "-q"]));
  succeeds(w.run("git", ["add", "."]));
  succeeds(w.run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "locks"]));
  const head = succeeds(w.run("git", ["rev-parse", "HEAD"]));
  const baseTree = succeeds(w.run("git", ["rev-parse", "HEAD^{tree}"]));
  w.write("builds/db.apko.lock.json", "new");

  const publish = step("generic-actions/refresh-apko-locks/action.yaml", "Open or update the pull request");
  const ref = "repos/a-novel/example/git/refs";
  for (const [exists, move] of [
    ["true", ["api", "-X", "PATCH", `${ref}/heads/chore/deps/apko-locks`, "-f", "sha=commit-sha", "-F", "force=true"]],
    ["false", ["api", ref, "-f", "ref=refs/heads/chore/deps/apko-locks", "-f", "sha=commit-sha"]],
  ]) {
    w.write("calls", "");
    const env = { GITHUB_REPOSITORY: "a-novel/example", BRANCH: "chore/deps/apko-locks", BRANCH_EXISTS: exists };
    succeeds(w.bash(publish, { ...env, CONFIGS: "builds/db.apko.yaml", SUMMARY: "\n- `zlib`: 1 → 2\n" }));
    const [tree, commit, , update] = w.read("calls").trim().split("\n").map(JSON.parse);
    assert.deepEqual(tree.input, {
      base_tree: baseTree,
      tree: [{ path: "builds/db.apko.lock.json", mode: "100644", type: "blob", content: "new" }],
    });
    assert.deepEqual(commit.args.slice(0, 8), [
      "api",
      "repos/a-novel/example/git/commits",
      "-f",
      "message=chore(deps): refresh apko locks",
      "-f",
      "tree=tree-sha",
      "-f",
      `parents[]=${head}`,
    ]);
    assert.deepEqual(update.args.slice(0, move.length), move, `branch exists: ${exists}`);
  }
});

test("escalate pages Discord with push_mention and keeps the GitHub mention on the ticket", (t) => {
  const w = workspace(t);
  const path = "generic-actions/escalate/action.yaml";
  const steps = manifest(path).runs.steps;
  const inputs = {
    severity: "sev1",
    summary: "release cut failed",
    dedup_key: "release-line-failed:a-novel/infra:release/v1",
    planning_repo: "a-novel/.github",
    mention: "@octocat",
    push_mention: "<@&42>",
    push_webhook: "https://discord.invalid/webhook",
    dry_run: "true",
  };
  // Bind each step's env from the manifest, so the test covers which input reaches which step.
  const bind = (id, outputs = {}) =>
    Object.fromEntries(
      Object.entries(steps.find((entry) => entry.id === id).env).map(([key, value]) => [
        key,
        value
          .replace(
            /\$\{\{ (inputs|steps\.resolve\.outputs)\.(\w+) \}\}/g,
            (_, scope, name) => (scope === "inputs" ? inputs : outputs)[name] ?? ""
          )
          .replace(/\$\{\{[^}]*\}\}/g, ""),
      ])
    );
  succeeds(w.bash(step(path, "resolve"), bind("resolve")));
  const outputs = Object.fromEntries(
    w
      .read("output")
      .trim()
      .split("\n")
      .map((line) => line.split(/=(.*)/s).slice(0, 2))
  );
  succeeds(w.bash(step(path, "push"), bind("push", outputs)));
  const page = w.read("summary");
  assert.match(page, /^cc <@&42>$/m);
  assert.doesNotMatch(page, /@octocat/);
});
