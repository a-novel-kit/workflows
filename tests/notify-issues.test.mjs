import assert from "node:assert/strict";
import { test } from "node:test";
import { step, succeeds, workspace } from "./helpers.mjs";

const item = (status, updatedAt, { assignees = [], assignedAt = null, state = "OPEN", number = 7 } = {}) => ({
  status: status && { name: status, updatedAt },
  content: {
    number,
    title: "Wire the feed",
    url: `https://github.com/a-novel/infra/issues/${number}`,
    state,
    repository: { nameWithOwner: "a-novel/infra" },
    assignees: { nodes: assignees.map(([databaseId, login]) => ({ databaseId, login })) },
    timelineItems: { nodes: assignedAt ? [{ createdAt: assignedAt }] : [] },
  },
});
const kushuh = [[1, "kushuh"]];
const before = "2026-10-12T09:00:00Z";
const after = "2026-10-12T10:05:00Z";

// Runs the scan step against a stubbed board, whose previous run started at 10:00. `live` answers the
// scan of unarchived items and `archived` the scan of archived ones, which records its filter.
function scan(t, live, archived = []) {
  const w = workspace(t);
  const page = (nodes) => JSON.stringify({ data: { node: { items: { nodes } } } });
  w.stub(
    "gh",
    `const args = process.argv.slice(2);
    if (args[0] === 'run') console.log('2026-10-12T10:00:00Z');
    else if (args.includes('states=ARCHIVED')) {
      require('node:fs').writeFileSync('filter', args.find((arg) => arg.startsWith('filter=')));
      console.log(${JSON.stringify(page(archived))});
    } else console.log(${JSON.stringify(page(live))});`
  );
  succeeds(
    w.bash(step(".github/workflows/notify-issues-run.yaml", "scan"), {
      GITHUB_REPOSITORY: "a-novel/.github",
      PROJECT_ID: "PVT_x",
      BOARD_TOKEN: "token",
      CALLER: "a-novel/.github/.github/workflows/notify-issues.yaml@refs/heads/master",
    })
  );
  return { events: JSON.parse(w.read("output").match(/^events=(.*)$/m)[1]), filter: w.read("filter") };
}

test("notify-issues colors each Status change and pings for Triage, Ready and assignee changes", (t) => {
  const cases = [
    [
      "entered Ready",
      [item("Ready", after, { assignees: kushuh })],
      [],
      { description: "Ready for pickup · assigned to kushuh", color: "started", ping: true, user_ids: "1" },
    ],
    ["Ready before the watermark", [item("Ready", before, { assignees: kushuh })], [], undefined],
    [
      "entered Triage",
      [item("Triage", after)],
      [],
      { description: "Moved to Triage · nobody assigned", color: "released", ping: true, user_ids: "" },
    ],
    [
      "entered In progress",
      [item("In progress", after, { assignees: kushuh })],
      [],
      { description: "Moved to In progress · assigned to kushuh", color: "succeeded", ping: false, user_ids: "1" },
    ],
    [
      "entered In review",
      [item("In review", after, { assignees: kushuh })],
      [],
      { description: "Moved to In review · assigned to kushuh", color: "upcoming", ping: false, user_ids: "1" },
    ],
    [
      "merged and archived",
      [],
      [item("Awaiting release", after, { assignees: kushuh, state: "CLOSED" })],
      {
        description: "Moved to Awaiting release · assigned to kushuh",
        color: "succeeded",
        ping: false,
        user_ids: "1",
      },
    ],
    [
      "unassigned in progress",
      [item("In progress", before, { assignedAt: after })],
      [],
      {
        description: "Assignees changed, status In progress · nobody assigned",
        color: "succeeded",
        ping: true,
        user_ids: "",
      },
    ],
    ["assigned in Backlog", [item("Backlog", before, { assignees: kushuh, assignedAt: after })], [], undefined],
    ["moved to Backlog", [item("Backlog", after)], [], undefined],
    [
      "bot assignee",
      [item("Ready", after, { assignees: [[2, "renovate[bot]"]] })],
      [],
      { description: "Ready for pickup · nobody assigned", color: "started", ping: true, user_ids: "" },
    ],
    [
      "assignees changed on a closed issue",
      [item("In progress", before, { assignedAt: after, state: "CLOSED" })],
      [],
      undefined,
    ],
    ["off the board status", [item(null, null, { assignedAt: after })], [], undefined],
  ];
  for (const [name, live, archived, expected] of cases) {
    const { events } = scan(t, live, archived);
    assert.ok(events.length <= 1, name);
    const [event] = events;
    assert.deepEqual(
      event && { description: event.description, color: event.color, ping: event.ping, user_ids: event.user_ids },
      expected,
      name
    );
  }
});

test("notify-issues posts each issue once, in event order, with archived items from the day before", (t) => {
  const review = item("In review", "2026-10-12T10:07:00Z", { number: 8 });
  const { events, filter } = scan(
    t,
    [review, item("Ready", "2026-10-12T10:03:00Z", { number: 9 })],
    [item("Awaiting release", "2026-10-12T10:05:00Z", { number: 10, state: "CLOSED" }), review]
  );
  assert.deepEqual(
    events.map((event) => `${event.repo}#${event.number}`),
    ["a-novel/infra#9", "a-novel/infra#10", "a-novel/infra#8"]
  );
  assert.equal(filter, "filter=updated:>=2026-10-11");
});

test("discord-users resolves mapped ids, masks them, and resolves nobody when Bitwarden fails", (t) => {
  const resolve = step("generic-actions/discord-users/action.yaml", "resolve");
  const map = [
    { key: "1", value: "111111111111111111", note: "kushuh" },
    { key: "2", value: "222222222222222222", note: "EmperorDada" },
  ];
  const cases = [
    [
      "mapped and unmapped",
      `console.log(${JSON.stringify(JSON.stringify(map))})`,
      { IDS: "2, 9 1" },
      "222222222222222222 111111111111111111",
    ],
    ["Bitwarden down", "process.exit(1)", { IDS: "1" }, ""],
    ["no token", `console.log(${JSON.stringify(JSON.stringify(map))})`, { IDS: "1", BWS_ACCESS_TOKEN: "" }, ""],
  ];
  for (const [name, bws, env, expected] of cases) {
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
