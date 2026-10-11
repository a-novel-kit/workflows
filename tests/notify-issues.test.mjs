import assert from "node:assert/strict";
import { test } from "node:test";
import { step, succeeds, workspace } from "./helpers.mjs";

const item = (name, updatedAt, assignees = [], assignedAt = null, state = "OPEN") => ({
  status: name && { name, updatedAt },
  content: {
    number: 7,
    title: "Wire the feed",
    url: "https://github.com/a-novel/infra/issues/7",
    state,
    repository: { nameWithOwner: "a-novel/infra" },
    assignees: { nodes: assignees.map(([databaseId, login]) => ({ databaseId, login })) },
    timelineItems: { nodes: assignedAt ? [{ createdAt: assignedAt }] : [] },
  },
});

test("notify-issues posts issues entering Ready and assignee changes outside Backlog", (t) => {
  const scan = step(".github/workflows/notify-issues-run.yaml", "scan");
  const before = "2026-10-12T09:00:00Z";
  const after = "2026-10-12T10:05:00Z";
  for (const [name, items, expected] of [
    ["entered Ready", [item("Ready", after, [[1, "kushuh"]])], "Ready for pickup · assigned to kushuh"],
    ["Ready before the watermark", [item("Ready", before, [[1, "kushuh"]])], undefined],
    [
      "unassigned in progress",
      [item("In progress", before, [], after)],
      "Assignees changed, status In progress · nobody assigned",
    ],
    ["assigned in Backlog", [item("Backlog", before, [[1, "kushuh"]], after)], undefined],
    ["bot assignee", [item("Ready", after, [[2, "renovate[bot]"]])], "Ready for pickup · nobody assigned"],
    ["closed issue", [item("Ready", after, [], null, "CLOSED")], undefined],
    ["off the board status", [item(null, null, [], after)], undefined],
  ]) {
    const w = workspace(t);
    const pages = [{ data: { node: { items: { nodes: items } } } }];
    w.stub(
      "gh",
      `const args = process.argv.slice(2);
      if (args[0] === 'run') console.log('2026-10-12T10:00:00Z');
      else console.log(${JSON.stringify(pages.map((page) => JSON.stringify(page)).join("\n"))});`
    );
    succeeds(
      w.bash(scan, {
        GITHUB_REPOSITORY: "a-novel/.github",
        PROJECT_ID: "PVT_x",
        BOARD_TOKEN: "token",
        CALLER: "a-novel/.github/.github/workflows/notify-issues.yaml@refs/heads/master",
      })
    );
    const events = JSON.parse(w.read("output").match(/^events=(.*)$/m)[1]);
    assert.equal(events[0]?.description, expected, name);
    if (expected) {
      assert.equal(events[0].user_ids, expected.includes("kushuh") ? "1" : "", name);
      assert.equal(events[0].repo, "a-novel/infra", name);
    }
  }
});

test("discord-users resolves mapped ids, masks them, and resolves nobody when Bitwarden fails", (t) => {
  const resolve = step("generic-actions/discord-users/action.yaml", "resolve");
  const map = [
    { key: "1", value: "111111111111111111", note: "kushuh" },
    { key: "2", value: "222222222222222222", note: "EmperorDada" },
  ];
  for (const [name, bws, env, expected] of [
    [
      "mapped and unmapped",
      `console.log(${JSON.stringify(JSON.stringify(map))})`,
      { IDS: "2, 9 1" },
      "222222222222222222 111111111111111111",
    ],
    ["Bitwarden down", "process.exit(1)", { IDS: "1" }, ""],
    ["no token", `console.log(${JSON.stringify(JSON.stringify(map))})`, { IDS: "1", BWS_ACCESS_TOKEN: "" }, ""],
  ]) {
    const w = workspace(t);
    w.stub("bws", bws);
    const result = w.bash(resolve, { BWS: "bws", BWS_ACCESS_TOKEN: "token", SERVER_URL: "", ...env });
    succeeds(result);
    assert.equal(
      w
        .read("output")
        .match(/^discord_ids=(.*)$/gm)
        .at(-1),
      `discord_ids=${expected}`,
      name
    );
    for (const id of expected.split(" ").filter(Boolean))
      assert.match(result.stdout, new RegExp(`^::add-mask::${id}$`, "m"), name);
    assert.doesNotMatch(result.stdout + result.stderr, /EmperorDada|kushuh/, name);
  }
});
