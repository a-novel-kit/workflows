import { step, succeeds, workspace } from "./helpers.mjs";

import assert from "node:assert/strict";
import test from "node:test";

const lint = "node-actions/lint-translations/action.yaml";
const approve = "generic-actions/approve-translations/action.yaml";

/** Records each call as a JSON line and answers `gh` subcommands from the test's environment. */
const gh = `
import * as fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync('calls', JSON.stringify(['gh', ...args]) + '\\n');
const [command, sub] = args;
if (command === 'api') {
  if (process.env.COMPARE_FAIL) process.exit(1);
  console.log(process.env.COMPARE_FILES ?? '');
} else if (command === 'pr' && sub === 'list') {
  console.log(process.env.PR_LABELS ?? '[]');
} else if (command === 'run' && sub === 'list') {
  const statuses = (process.env.RUN_STATUSES ?? '').split(',');
  const calls = Number(fs.existsSync('polls') ? fs.readFileSync('polls', 'utf8') : 0);
  fs.writeFileSync('polls', String(calls + 1));
  const status = statuses[Math.min(calls, statuses.length - 1)];
  if (status && status !== 'none') console.log(JSON.stringify({ databaseId: 7, status }));
} else if (command === 'run' && sub === 'view') {
  console.log(process.env.JOB_ID ?? '');
}`;

const record = (tool) => `
import * as fs from 'node:fs';
fs.appendFileSync('calls', JSON.stringify(['${tool}', ...process.argv.slice(2)]) + '\\n');
if (process.env.TOOL_OUTPUT) console.log(process.env.TOOL_OUTPUT);
process.exit(Number(process.env.TOOL_EXIT ?? 0));`;

function calls(w) {
  return w
    .read("calls")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function translations(t) {
  const w = workspace(t);
  w.write("calls", "");
  w.stub("gh", gh);
  for (const tool of ["pnpm", "git", "sleep"]) w.stub(tool, record(tool));
  return w;
}

test("structure passes the script as data and shows the diff it would apply", (t) => {
  const w = translations(t);
  const script = step(lint, "structure");
  const name = "i18n:structure $(touch injected)";

  succeeds(w.bash(script, { STRUCTURE_ACTION: name }));
  assert.deepEqual(calls(w), [["pnpm", "run", name]]);

  w.write("calls", "");
  const failed = w.bash(script, { STRUCTURE_ACTION: name, TOOL_EXIT: "1", TOOL_OUTPUT: "-  home: Return home" });
  assert.equal(failed.status, 1);
  assert.deepEqual(calls(w), [
    ["pnpm", "run", name],
    ["git", "diff"],
  ]);
});

test("approval labels come from the branch's open PR", (t) => {
  const w = translations(t);
  succeeds(
    w.bash(step(lint, "labels"), {
      GITHUB_REPOSITORY: "a-novel/platform",
      BRANCH: "feat/copy",
      PR_LABELS: '["allow-translation-drift"]',
    })
  );
  assert.equal(w.read("output"), 'names=["allow-translation-drift"]\n');
  assert.deepEqual(calls(w)[0].slice(0, 9), [
    "gh",
    "pr",
    "list",
    "--repo",
    "a-novel/platform",
    "--head",
    "feat/copy",
    "--state",
    "open",
  ]);
});

test("gaps and drift receive the merge base reference", (t) => {
  const w = translations(t);
  for (const [id, variable, name] of [
    ["gaps", "GAPS_ACTION", "i18n:gaps"],
    ["drift", "DRIFT_ACTION", "i18n:drift"],
  ]) {
    w.write("calls", "");
    succeeds(w.bash(step(lint, id), { [variable]: name, BASE_REF: "origin/master" }));
    assert.deepEqual(calls(w), [["pnpm", "run", name, "--base", "origin/master"]]);
  }
});

test("a push that changes a catalog revokes every held approval label", (t) => {
  const w = translations(t);
  const env = {
    GITHUB_REPOSITORY: "a-novel/platform",
    PR: "12",
    BEFORE: "aaa",
    AFTER: "bbb",
    CATALOGS: "src/lib/i18n/locales/",
    LABELS: '["allow-incomplete-translations","good first issue","allow-translation-drift"]',
    COMPARE_FILES: "src/routes/page.svelte\nsrc/lib/i18n/locales/fr/common.yaml",
  };

  succeeds(w.bash(step(approve, "revoke"), env));
  assert.equal(w.read("output"), "revoked=true\n");
  assert.deepEqual(
    calls(w).filter(([, command]) => command === "pr"),
    ["allow-incomplete-translations", "allow-translation-drift"].map((label) => [
      "gh",
      "pr",
      "edit",
      "12",
      "--repo",
      "a-novel/platform",
      "--remove-label",
      label,
    ])
  );
});

test("approval labels survive a push that leaves the catalogs alone", (t) => {
  const w = translations(t);
  succeeds(
    w.bash(step(approve, "revoke"), {
      GITHUB_REPOSITORY: "a-novel/platform",
      PR: "12",
      BEFORE: "aaa",
      AFTER: "bbb",
      CATALOGS: "src/lib/i18n/locales/",
      LABELS: '["allow-translation-drift"]',
      COMPARE_FILES: "src/lib/i18n/locales.ts\nsrc/routes/page.svelte",
    })
  );
  assert.equal(calls(w).length, 1);
  assert.throws(() => w.read("output"));
});

test("an unreadable push revokes, and a PR without approval labels is left alone", (t) => {
  const w = translations(t);
  const env = {
    GITHUB_REPOSITORY: "a-novel/platform",
    PR: "12",
    BEFORE: "aaa",
    AFTER: "bbb",
    CATALOGS: "src/lib/i18n/locales/",
  };

  succeeds(w.bash(step(approve, "revoke"), { ...env, LABELS: '["allow-translation-drift"]', COMPARE_FAIL: "1" }));
  assert.equal(w.read("output"), "revoked=true\n");

  w.write("calls", "");
  succeeds(w.bash(step(approve, "revoke"), { ...env, LABELS: '["good first issue"]' }));
  assert.equal(w.read("calls"), "");
});

test("the rerun waits for the head's run, then reruns only the translation job", (t) => {
  const w = translations(t);
  succeeds(
    w.bash(step(approve, "rerun"), {
      GITHUB_REPOSITORY: "a-novel/platform",
      HEAD_SHA: "bbb",
      WORKFLOW: "main.yaml",
      JOB: "lint-translations",
      RUN_STATUSES: "none,in_progress,completed",
      JOB_ID: "42",
    })
  );
  assert.deepEqual(calls(w).at(-1), ["gh", "run", "rerun", "--repo", "a-novel/platform", "--job", "42"]);
  assert.equal(calls(w).filter(([tool]) => tool === "sleep").length, 2);
});

test("the rerun fails loudly without a completed run or a matching job", (t) => {
  const w = translations(t);
  const env = {
    GITHUB_REPOSITORY: "a-novel/platform",
    HEAD_SHA: "bbb",
    WORKFLOW: "main.yaml",
    JOB: "lint-translations",
  };

  const stalled = w.bash(step(approve, "rerun"), { ...env, RUN_STATUSES: "in_progress" });
  assert.equal(stalled.status, 1);
  assert.match(stalled.stdout, /No completed main\.yaml run for bbb \(last status: in_progress\)/);

  const missing = w.bash(step(approve, "rerun"), { ...env, RUN_STATUSES: "completed", JOB_ID: "" });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /No lint-translations job in main\.yaml for bbb/);
});
