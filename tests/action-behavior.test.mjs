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
