import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isWatched,
  parseRules,
  phrase,
  post,
  select,
  summary,
  text,
} from "../generic-actions/collect-audit-alerts/collect.mjs";
import { root, succeeds, workspace } from "./helpers.mjs";

const at = Date.parse("2026-10-21T19:52:47Z");
const override = (changes = {}) => ({
  "@timestamp": at,
  _document_id: "override",
  action: "protected_branch.policy_override",
  actor: "kushuh",
  repo: "a-novel/infra",
  branch: "refs/heads/master",
  before: "f867061e0ae73e818b33697241b792d3fdbfafef",
  overridden_codes: ["merge_queue"],
  reasons: [{ code: "merge_queue", message: "Changes must be made through the merge queue" }],
  programmatic_access_type: "OAuth access token",
  user_agent: "GitHub CLI v2.102.0",
  ...changes,
});

test("collect-audit-alerts watches whole categories and single actions, and reads them in one search", () => {
  assert.ok(isWatched("protected_branch.policy_override"));
  assert.ok(isWatched("hook.create"));
  assert.ok(isWatched("repo.access"));
  assert.ok(!isWatched("repo.change_merge_setting"));
  assert.ok(!isWatched("protected_branch_extra.create"));
  assert.ok(!isWatched("pull_request.merge"));
  assert.match(phrase("2026-10-21T18:52:47+00:00"), /^created:>=2026-10-21T18:52:47\+00:00 action:protected_branch /);
});

test("collect-audit-alerts matches a list as its sorted values and a missing field as empty", () => {
  assert.equal(text(["required_status_checks", "merge_queue"]), "merge_queue,required_status_checks");
  assert.equal(text([]), "");
  assert.equal(text(undefined), "");
  assert.equal(text({ code: "creation" }), '{"code":"creation"}');
  assert.equal(text(42), "42");
});

test("collect-audit-alerts refuses an ignore rule without a reason or a pattern", () => {
  assert.throws(() => parseRules('[{"actor": "^kushuh$"}]'), /reason/);
  assert.throws(() => parseRules('[{"reason": "nothing to match"}]'), /pattern/);
  assert.throws(() => parseRules('[{"reason": "a list", "actor": ["kushuh"]}]'), /string pattern/);
  assert.throws(() => parseRules('{"reason": "not a list"}'), /must list/);
});

test("collect-audit-alerts hides what a rule matches whole, skips unwatched entries and counts each rule's hits", () => {
  const rules = parseRules(
    JSON.stringify([
      {
        reason: "An admin merges a reviewed, green pull request past the merge queue",
        action: "^protected_branch\\.policy_override$",
        branch: "^refs/heads/master$",
        overridden_codes: "^merge_queue$",
      },
      { reason: "Nothing matches this", actor: "^nobody$" },
    ])
  );
  const direct = override({
    _document_id: "direct",
    overridden_codes: ["merge_queue", "required_status_checks", "review_policy_not_satisfied"],
  });
  const tag = override({ _document_id: "tag", branch: "refs/tags/v1.0.0", overridden_codes: [] });
  const result = select(
    [override(), override({ _document_id: "again" }), direct, tag, { action: "pull_request.merge", actor: "kushuh" }],
    rules
  );
  assert.deepEqual(
    result.alerts.map((entry) => entry._document_id),
    ["direct", "tag"]
  );
  assert.deepEqual(result.rules, [
    { reason: "An admin merges a reviewed, green pull request past the merge queue", hidden: 2 },
    { reason: "Nothing matches this", hidden: 0 },
  ]);
});

test("collect-audit-alerts posts a burst across repositories as one line", () => {
  const codes = ["merge_queue", "required_status_checks", "review_policy_not_satisfied"];
  const fresh = [
    override({ _document_id: "a", repo: "a-novel/service-genai", overridden_codes: codes }),
    override({ _document_id: "b", repo: "a-novel/infra", overridden_codes: codes, "@timestamp": at - 60_000 }),
    {
      "@timestamp": at,
      _document_id: "c",
      action: "hook.create",
      actor: "intruder",
      repo: "a-novel/infra",
      name: "web",
      programmatic_access_type: "Fine-grained personal access token",
    },
  ];
  assert.deepEqual(post("a-novel", fresh, [{ reason: "routine", hidden: 3 }]), {
    count: 3,
    title: "3 audit-log alerts in a-novel",
    url: "https://github.com/organizations/a-novel/settings/audit-log",
    footer: "3 routine entries hidden by ignore rules",
    description: [
      "**protected_branch.policy_override** · `kushuh` · `refs/heads/master` · `merge_queue, required_status_checks, review_policy_not_satisfied`",
      "-# [infra](https://github.com/a-novel/infra), [service-genai](https://github.com/a-novel/service-genai) · 2026-10-21 19:51Z · OAuth access token · GitHub CLI v2.102.0",
      "**hook.create** · `intruder` · `web`",
      "-# [infra](https://github.com/a-novel/infra) · 2026-10-21 19:52Z · Fine-grained personal access token",
    ].join("\n"),
  });
  assert.equal(post("a-novel", [], []).footer, "");
});

test("collect-audit-alerts keeps the alerts themselves out of the public step summary", () => {
  const table = summary({
    since: "2026-10-21T18:52:47+00:00",
    read: 12,
    alerts: 3,
    fresh: 1,
    rules: [
      { reason: "An admin merges | past the queue", hidden: 9 },
      { reason: "Stale", hidden: 0 },
    ],
  });
  assert.match(
    table,
    /^Audit-log entries since 2026-10-21T18:52:47\+00:00: 12 read, 3 alerting, 1 not posted before\.$/m
  );
  assert.match(table, /^\| An admin merges \\\| past the queue \| 9 \|$/m);
  assert.match(table, /^\| Stale \| 0, matched nothing \|$/m);
});

/**
 * Runs the shipped script against stubbed `gh` answers: the caller's previous success, the seen list
 * its artifact holds, and one page of audit-log entries. Returns the outputs, the summary, the seen
 * list written for the next run, and each call's arguments with the token it carried.
 */
function collect(
  t,
  { previous = [{ databaseId: 7, createdAt: "2026-10-21T19:00:00Z" }], seen, entries = [], ignore = [] }
) {
  const w = workspace(t);
  w.write("output", "");
  w.write("summary", "");
  w.stub(
    "gh",
    `const fs = require("node:fs");
    const path = require("node:path");
    const args = process.argv.slice(2);
    fs.appendFileSync("calls", JSON.stringify({ token: process.env.GH_TOKEN, args }) + "\\n");
    if (args[0] === "run" && args[1] === "list") console.log(${JSON.stringify(JSON.stringify(previous))});
    else if (args[0] === "run" && args[1] === "download") {
      ${seen === undefined ? 'process.stderr.write("no artifact"); process.exit(1);' : ""}
      const dir = args[args.indexOf("--dir") + 1];
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "seen.json"), ${JSON.stringify(JSON.stringify(seen ?? []))});
    } else console.log(${JSON.stringify(JSON.stringify([entries]))});`
  );
  const env = {
    GITHUB_REPOSITORY: "a-novel/.github",
    GITHUB_REPOSITORY_OWNER: "a-novel",
    GITHUB_TOKEN: "default-token",
    AUDIT_TOKEN: "app-token",
    RUNNER_TEMP: w.cwd,
    CALLER: "a-novel/.github/.github/workflows/notify-audit.yaml@refs/heads/master",
    IGNORE: JSON.stringify(ignore),
  };
  const result = w.run("node", [`${root}generic-actions/collect-audit-alerts/collect.mjs`], env);
  const read = (file) => {
    try {
      return w.read(file);
    } catch {
      return "";
    }
  };
  const output = read("output");
  return {
    result,
    count: output.match(/^count=(.*)$/m)?.[1],
    description: output.match(/^description<<(\S+)\n([^]*?)\n\1$/m)?.[2],
    seen: JSON.parse(read("notify-audit-seen/seen.json") || "null"),
    summary: read("summary"),
    calls: read("calls")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

test("collect-audit-alerts rereads an hour before the last success and posts only what it did not record", (t) => {
  const tag = override({ _document_id: "tag", branch: "refs/tags/v1.0.0", overridden_codes: [] });
  const hook = {
    "@timestamp": at,
    _document_id: "hook",
    action: "hook.create",
    actor: "intruder",
    repo: "a-novel/infra",
  };
  const out = collect(t, {
    seen: ["tag"],
    entries: [tag, hook, override({ _document_id: "merge" })],
    ignore: [{ reason: "Reviewed merges", overridden_codes: "^merge_queue$" }],
  });
  succeeds(out.result);
  const [list, download, audit] = out.calls;
  assert.equal(list.token, "default-token");
  assert.deepEqual(download.args.slice(0, 6), ["run", "download", "7", "--repo", "a-novel/.github", "--name"]);
  assert.equal(audit.token, "app-token");
  assert.equal(
    new URL(audit.args.at(-1), "https://api.github.com/").searchParams.get("phrase"),
    phrase("2026-10-21T18:00:00+00:00")
  );
  assert.equal(out.count, "1");
  assert.match(out.description, /^\*\*hook\.create\*\* · `intruder`/);
  // The next run skips both alerts the window holds, the one recorded earlier included.
  assert.deepEqual(out.seen, ["tag", "hook"]);
  assert.match(out.summary, /: 3 read, 2 alerting, 1 not posted before\./);
});

test("collect-audit-alerts reads the last hour on a first run, warns on a lost seen list, and stops on an invalid rule", (t) => {
  const first = collect(t, { previous: [], entries: [] });
  succeeds(first.result);
  assert.equal(first.calls.filter(({ args }) => args[1] === "download").length, 0);
  assert.equal(first.count, "0");

  const lost = collect(t, { entries: [override({ overridden_codes: ["non_fast_forward"] })] });
  succeeds(lost.result);
  assert.match(lost.result.stdout, /^::warning::Run 7 left no notify-audit-seen artifact/m);
  assert.equal(lost.count, "1");

  const invalid = collect(t, { ignore: [{ actor: "x" }] });
  assert.notEqual(invalid.result.status, 0);
  assert.match(invalid.result.stdout, /^::error::ignore must list rules/m);
  assert.equal(invalid.calls.length, 0);
});
