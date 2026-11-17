import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { root, step, succeeds, workspace } from "./helpers.mjs";

const waiter = join(root, "build-actions/wait-container.mjs");
const runArgs = '--env "LABEL=two words" --env \'VALUE=$(touch injected)\' --env DB="${DB}" --env SIMPLE=$SIMPLE';
const runEnv = { DB: 'postgres://two words/"$(touch injected)', SIMPLE: "value", IMAGE_NAME: "owner/image" };
const started = [
  "run",
  "-d",
  "--network=host",
  "--env",
  "LABEL=two words",
  "--env",
  "VALUE=$(touch injected)",
  "--env",
  'DB=postgres://two words/"$(touch injected)',
  "--env",
  "SIMPLE=value",
  "--name",
  "test-container",
  "ghcr.io/owner/image:test",
];

test("container smoke tests wait for readiness, fail promptly and preserve diagnostics", (t) => {
  const cases = [
    [
      "service",
      [
        { Status: "running", Health: { Status: "starting" } },
        { Status: "running", Health: { Status: "healthy" } },
      ],
      true,
    ],
    ["job", [{ Status: "running" }, { Status: "exited", ExitCode: 0 }], true],
    ["service", [{ Status: "running", Health: { Status: "unhealthy" } }], false, "failed"],
    ["service", [{ Status: "exited", ExitCode: 1 }], false, "failed"],
    ["job", [{ Status: "exited", ExitCode: 23 }], false, "code 23"],
    ["job", [{ Status: "running" }], false, "timed out"],
    ["service", [null], false, "docker inspect"],
  ];
  for (const [mode, states, ok, message] of cases) {
    const w = workspace(t);
    w.stub(
      "docker",
      `
      import * as fs from 'node:fs'; const args = process.argv.slice(2);
      const calls = fs.existsSync('calls.json') ? JSON.parse(fs.readFileSync('calls.json')) : [];
      const index = calls.filter(c => c[0] === 'inspect').length;
      calls.push(args); fs.writeFileSync('calls.json', JSON.stringify(calls));
      if (args[0] === 'inspect') {
        const states = JSON.parse(process.env.STATES), state = states[Math.min(index, states.length - 1)];
        if (!state) process.exit(1);
        console.log(JSON.stringify([{State: state}]));
      }
    `
    );
    const result = w.run(process.execPath, [waiter, mode, "2"], {
      ...runEnv,
      STATES: JSON.stringify(states),
      RUN_ARGS: runArgs,
    });
    if (ok) succeeds(result);
    else {
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(message));
    }
    const calls = JSON.parse(w.read("calls.json"));
    assert.deepEqual(calls[0], started);
    assert.equal(existsSync(join(w.cwd, "injected")), false);
    assert.deepEqual(
      calls.filter(([cmd]) => ["stop", "logs"].includes(cmd)).map(([cmd]) => cmd),
      ok ? [] : ["stop", "logs"]
    );
  }
});

test("run_args_file holds the smoke run's flags in the syntax of run_args", (t) => {
  const w = workspace(t);
  w.stub(
    "docker",
    "require('fs').writeFileSync('started.json', JSON.stringify(process.argv.slice(2))); process.exit(1);"
  );
  w.write("builds/image.run-args", runArgs.replaceAll(" --env", "\n--env") + "\n");
  w.run(process.execPath, [waiter, "service", "2"], { ...runEnv, RUN_ARGS_FILE: "builds/image.run-args" });
  assert.deepEqual(JSON.parse(w.read("started.json")), started);
  assert.equal(existsSync(join(w.cwd, "injected")), false);
});

test("container startup failures do not print arguments containing credentials", (t) => {
  const w = workspace(t);
  w.stub("docker", "process.exit(1)");
  const result = w.run(process.execPath, [waiter, "job", "2"], {
    RUN_ARGS: "--env PASSWORD=private-fixture-value",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Container failed to start/);
  assert(!result.stderr.includes("private-fixture-value"));
});

test("invalid container timeouts and malformed flags fail before starting Docker", (t) => {
  const w = workspace(t);
  w.stub("docker", "import * as fs from 'node:fs'; fs.writeFileSync('started', '')");
  w.write("flags", "--env A=1\n");
  const invalid = [
    ["0", {}],
    ["-1", {}],
    ["bad", {}],
    ["2", { RUN_ARGS: "--env 'unclosed" }],
    ["2", { RUN_ARGS: "--env A=1", RUN_ARGS_FILE: "flags" }],
    ["2", { RUN_ARGS_FILE: "missing" }],
  ];
  for (const [limit, env] of invalid) {
    assert.notEqual(w.run(process.execPath, [waiter, "job", limit], env).status, 0, JSON.stringify(env));
    assert.equal(existsSync(join(w.cwd, "started")), false);
  }
});

test("check-reproducible fails unless two isolated builds of the file give one digest", (t) => {
  const w = workspace(t);
  const script = step("build-actions/check-reproducible/action.yaml", "Build the image twice");
  // Each builder writes its own call log, since the two builds run at once.
  w.stub(
    "docker",
    `
    import * as fs from 'node:fs'; const args = process.argv.slice(2);
    const builder = args[args.indexOf(args[1] === 'create' ? '--name' : '--builder') + 1];
    fs.appendFileSync('calls-' + builder, JSON.stringify(args) + '\\n');
    if (args[1] !== 'build') process.exit(0);
    const digest = JSON.parse(process.env.DIGESTS)[builder];
    if (!digest) process.exit(1);
    fs.writeFileSync(args[args.indexOf('--metadata-file') + 1], JSON.stringify({'containerimage.digest': digest}));
  `
  );
  const env = { FILE: "builds/image.Dockerfile", CONTEXT: "builds", RUNNER_TEMP: w.cwd };
  const same = `sha256:${"a".repeat(64)}`;
  const other = `sha256:${"b".repeat(64)}`;
  // [digests per builder, exit status, annotation]
  const cases = [
    [{ first: same, second: same }, 0, /^$/],
    [
      { first: same, second: other },
      1,
      new RegExp(`^::error::builds/image.Dockerfile rebuilt to ${other} instead of ${same}\\.$`, "m"),
    ],
    [{ first: same }, 1, /^$/],
  ];
  for (const [digests, status, annotation] of cases) {
    w.write("summary", "");
    const result = w.bash(script, { ...env, DIGESTS: JSON.stringify(digests) });
    assert.equal(result.status, status, JSON.stringify(digests) + result.stdout + result.stderr);
    assert.match(
      result.stdout
        .split("\n")
        .filter((line) => line.startsWith("::"))
        .join("\n"),
      annotation
    );
    if (status === 0) assert.equal(w.read("summary"), `builds/image.Dockerfile reproduces as ${same}.\n`);
  }
  for (const builder of ["first", "second"]) {
    const build = w
      .read(`calls-${builder}`)
      .trim()
      .split("\n")
      .map(JSON.parse)
      .find((args) => args[1] === "build");
    assert.deepEqual([build[build.indexOf("--file") + 1], build.at(-1)], ["builds/image.Dockerfile", "builds"]);
    assert(build.includes(`type=oci,dest=${w.cwd}/${builder}.tar,rewrite-timestamp=true`), builder);
  }
});

test("compose-up starts the services, and on a failure prints their state and logs and keeps the status", (t) => {
  const w = workspace(t);
  const path = "build-actions/compose-up/action.yaml";
  w.stub(
    "docker",
    `
    import * as fs from 'node:fs'; const args = process.argv.slice(2);
    const stdin = args[0] === 'login' ? fs.readFileSync(0, 'utf8') : undefined;
    fs.appendFileSync('calls', JSON.stringify({ args, stdin }) + '\\n');
    if (args.includes('up')) process.exit(Number(process.env.UP_STATUS));
  `
  );
  const calls = () => w.read("calls").trim().split("\n").map(JSON.parse);
  const compose = ["compose", "--file", "builds/compose.ci.yaml"];
  const up = [...compose, "up", "--detach", "--no-build", "--wait", "--wait-timeout", "120", "postgres", "valkey"];
  const env = { FILE: "builds/compose.ci.yaml", SERVICES: "postgres valkey" };
  for (const [status, after] of [
    [0, []],
    [
      3,
      [
        [...compose, "ps", "--all"],
        [...compose, "logs", "--no-color"],
      ],
    ],
  ]) {
    w.write("calls", "");
    assert.equal(w.bash(step(path, "Start the services"), { ...env, UP_STATUS: String(status) }).status, status);
    assert.deepEqual(
      calls().map(({ args }) => args),
      [up, ...after]
    );
  }

  w.write("calls", "");
  const login = { GH_TOKEN: "token-fixture", REGISTRY_USERNAME: "octocat" };
  succeeds(w.bash(step(path, "Log in to the container registry"), login));
  assert.deepEqual(calls(), [
    { args: ["login", "ghcr.io", "--username", "octocat", "--password-stdin"], stdin: "token-fixture" },
  ]);
});
