import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { root, succeeds, workspace } from "./helpers.mjs";

const waiter = join(root, "build-actions/wait-container.mjs");

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
      STATES: JSON.stringify(states),
      IMAGE_NAME: "owner/image",
      RUN_ARGS: '--env "LABEL=two words" --env \'VALUE=$(touch injected)\' --env DB="${DB}" --env SIMPLE=$SIMPLE',
      DB: 'postgres://two words/"$(touch injected)',
      SIMPLE: "value",
    });
    if (ok) succeeds(result);
    else {
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(message));
    }
    const calls = JSON.parse(w.read("calls.json"));
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
    assert.deepEqual(calls[0], started);
    assert.equal(existsSync(join(w.cwd, "injected")), false);
    assert.deepEqual(
      calls.filter(([cmd]) => ["stop", "logs"].includes(cmd)).map(([cmd]) => cmd),
      ok ? [] : ["stop", "logs"]
    );
  }
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
  const invalid = [
    ["0", ""],
    ["-1", ""],
    ["bad", ""],
    ["2", "--env 'unclosed"],
  ];
  for (const [limit, args] of invalid) {
    assert.notEqual(w.run(process.execPath, [waiter, "job", limit], { RUN_ARGS: args }).status, 0);
    assert.equal(existsSync(join(w.cwd, "started")), false);
  }
});
