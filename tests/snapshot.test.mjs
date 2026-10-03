import assert from "node:assert/strict";
import { test } from "node:test";
import { manifest, step, succeeds, workspace } from "./helpers.mjs";

const script = step("generic-actions/merge-gate/action.yaml", "Capture activation snapshot");
const start = script.match(/^START='(.*)'$/m)[1];
const end = script.match(/^END='(.*)'$/m)[1];
const now = "2026-07-22T10:00:00Z";
const old = "2026-07-22T09:55:00Z";
const boundary = "2026-07-21T10:00:00Z";
const members = [
  { repo: "a-novel-kit/a", number: 5 },
  { repo: "a-novel-kit/b", number: 2 },
];
const marker = (status, values = {}) => ({ status, members, at: old, ...values });
const body = (value) =>
  `Human introduction.\n${value ? `${start}\n_Membership note._\n${JSON.stringify(value)}\n${end}\n` : ""}Human conclusion.\n`;

function fixture(t, options = {}) {
  const w = workspace(t);
  w.write("body", options.body ?? body(options.before));
  w.write("state.json", JSON.stringify({ reads: 0, writes: 0, ...options.server }));
  w.stub("date", `console.log(${JSON.stringify(now)});`);
  w.stub("sleep", "");
  w.stub(
    "gh",
    `
    import * as fs from 'node:fs';
    const args = process.argv.slice(2), state = JSON.parse(fs.readFileSync('state.json'));
    let output = '', status = 0;
    if (args[0] === 'api') {
      state.reads++;
      if (state.peerBefore && state.reads === 2) fs.writeFileSync('body', state.peerBefore);
      if (state.readFailures?.includes(state.reads)) status = 1;
      else output = fs.readFileSync('body', 'utf8').replaceAll('\\n', '\\r\\n');
    } else if (args[0] === 'issue' && args[1] === 'edit') {
      state.writes++;
      if (state.editFailure) status = 1;
      else if (!state.noop) fs.copyFileSync(args[args.indexOf('--body-file') + 1], 'body');
      if (state.peerAfter) { fs.writeFileSync('body', state.peerAfter); delete state.peerAfter; }
      output = 'https://github.com/a-novel-kit/.github/issues/900';
    } else throw Error('Unexpected gh call: ' + args.join(' '));
    fs.writeFileSync('state.json', JSON.stringify(state));
    process.stdout.write(output); process.exit(status);
  `
  );
  const result = w.bash(script, {
    ORG: "a-novel-kit",
    PLANNING_REPO: ".github",
    EPIC: "900",
    STABILIZE_SECONDS: "120",
    STUCK_WAVE_HOURS: "72",
    MEMBERS: JSON.stringify(options.members ?? members),
    TMPDIR: w.cwd,
    ...options.env,
  });
  const text = w.read("body");
  const region = text.split(`${start}\n`)[1]?.split(`\n${end}`)[0];
  const payload = region?.split("\n").find((line) => line.startsWith("{"));
  return { result, text, payload: payload ? JSON.parse(payload) : null, ...JSON.parse(w.read("state.json")) };
}

test("snapshot transitions preserve the wave boundary and human prose", (t) => {
  for (const [before, expected, values] of [
    [null, "pending", {}],
    [marker("pending"), "frozen", {}],
    [marker("pending", { at: now }), "pending", {}],
    [marker("pending", { at: "broken" }), "pending", {}],
    [marker("pending", { members: members.slice(0, 1) }), "pending", {}],
    [marker("retired", { since: boundary }), "pending", {}],
    [marker("pending", { since: boundary }), "frozen", {}],
    [marker("frozen"), "retired", { members: members.map((m) => ({ ...m, state: "MERGED" })) }],
  ]) {
    const output = fixture(t, { before, ...values });
    succeeds(output.result);
    assert.equal(output.payload.status, expected);
    assert(output.text.startsWith("Human introduction.\n"));
    assert(output.text.includes("Human conclusion."));
    if (before?.since) assert.equal(output.payload.since, boundary);
    if (expected === "retired") assert.deepEqual(output.payload, { status: "retired", since: now });
    else assert.deepEqual(output.payload.members, members);
  }
});

test("only fully merged, nonempty waves retire; held passes and dry runs cannot capture", (t) => {
  for (const state of ["OPEN", "CLOSED", undefined]) {
    const output = fixture(t, { before: marker("frozen"), members: members.map((m) => ({ ...m, state })) });
    succeeds(output.result);
    assert.equal(output.writes, 0, String(state));
    assert.equal(output.payload.status, "frozen");
  }
  for (const env of [{ RETIRE_ONLY: "true" }, { SNAPSHOT_DRY_RUN: "TrUe" }]) {
    const output = fixture(t, { before: marker("pending"), env });
    succeeds(output.result);
    assert.equal(output.writes, 0);
  }
  const retired = fixture(t, {
    before: marker("frozen"),
    members: members.map((m) => ({ ...m, state: "MERGED" })),
    env: { RETIRE_ONLY: "true" },
  });
  succeeds(retired.result);
  assert.equal(retired.payload.status, "retired");
});

test("member normalization matches reader constraints", (t) => {
  const normalized = fixture(t, { members: [members[1], { repo: "A-NOVEL-KIT/A", number: 5 }, members[0]] });
  succeeds(normalized.result);
  assert.deepEqual(normalized.payload.members, members);
  for (const invalid of [
    [],
    [{ repo: "owner/repo\n", number: 1 }],
    [{ repo: "owner/repo", number: "1" }],
    [{ repo: "owner/repo", number: 0 }],
    [{ repo: "owner/repo", number: 1.5 }],
    [{ repo: "owner/repo", number: 2147483648 }],
    Array.from({ length: 51 }, (_, i) => ({ repo: "owner/repo", number: i + 1 })),
  ])
    assert.equal(fixture(t, { members: invalid }).writes, 0);
});

test("snapshot writer yields to a peer's changed set, clock, freeze or boundary", (t) => {
  for (const peer of [
    marker("pending", { members: members.slice(0, 1) }),
    marker("pending", { at: now }),
    marker("pending", { members: [members[0], { repo: "a-novel-kit/c", number: 2 }] }),
    marker("frozen", { members: members.slice(0, 1) }),
    marker("retired", { since: boundary }),
  ]) {
    const peerBody = body(peer);
    const output = fixture(t, { before: marker("pending"), server: { peerBefore: peerBody } });
    succeeds(output.result);
    assert.equal(output.writes, 0);
    assert.equal(output.text, peerBody);
  }
  const nextWave = body(marker("pending", { members: members.slice(0, 1) }));
  const output = fixture(t, {
    before: marker("frozen"),
    members: members.map((m) => ({ ...m, state: "MERGED" })),
    server: { peerBefore: nextWave },
  });
  assert.equal(output.writes, 0);
  assert.equal(output.text, nextWave);
});

test("snapshot writer verifies writes, retries lost updates and preserves the peer's prose", (t) => {
  const output = fixture(t, { server: { peerAfter: `${body(null)}Peer status.\n` } });
  succeeds(output.result);
  assert.equal(output.writes, 2);
  assert(output.text.includes("Peer status."));
  assert.equal(output.payload.status, "pending");
  for (const server of [{ noop: true }, { editFailure: true }, { readFailures: [2, 3, 4] }]) {
    const failed = fixture(t, { server });
    succeeds(failed.result);
    assert.equal(failed.text, body(null));
    assert.match(failed.result.stdout, /could not write/);
    assert(failed.writes <= 3);
  }
  const recovered = fixture(t, { server: { readFailures: [2, 3] } });
  succeeds(recovered.result);
  assert.equal(recovered.payload.status, "pending");
  const initialFailure = fixture(t, { server: { readFailures: [1] } });
  assert.notEqual(initialFailure.result.status, 0);
  assert.equal(initialFailure.writes, 0);

  const equivalent = fixture(t, { server: { peerAfter: body(marker("pending")) } });
  succeeds(equivalent.result);
  assert.equal(equivalent.writes, 1, "a peer's valid clock does not cause a write loop");
  const orphan = `${JSON.stringify(marker("pending", { at: now }))}\n${body(null)}`;
  const repaired = fixture(t, { body: orphan, server: { noop: true } });
  assert.match(repaired.result.stdout, /could not write/, "loose prose cannot satisfy marker verification");
});

test("corrupt wave boundaries are dropped and rehearsal credentials remain read-only", (t) => {
  for (const since of ["garbage", "2026-07-20", "2026-07-20T08:00:00+02:00", 1234]) {
    const output = fixture(t, { before: marker("pending", { since }) });
    succeeds(output.result);
    assert.equal(output.payload.status, "frozen");
    assert.equal(output.payload.since, undefined);
  }
  const steps = manifest("generic-actions/merge-gate/action.yaml").runs.steps;
  const token = steps.find((s) => s.name === "Mint snapshot-write token");
  assert.match(token.with["permission-issues"], /snapshot_dry_run.*'read'.*'write'/);
  const capture = steps.find((s) => s.name === "Capture activation snapshot");
  assert.match(capture.if, /retire_only/);
});

test("malformed fences are repaired without discarding human prose", (t) => {
  for (const malformed of [
    `Human introduction.\n${start}\nHuman conclusion.\n`,
    `Human introduction.\n${end}\nHuman conclusion.\n`,
    `${end}\nHuman introduction.\n${start}\nHuman conclusion.\n`,
    `${start}\n${start}\nHuman introduction.\nHuman conclusion.\n${end}\n`,
    `${body(null)}<!-- example ${start} -->\n`,
  ]) {
    const output = fixture(t, { body: malformed });
    succeeds(output.result);
    assert.equal(output.payload.status, "pending");
    assert(output.text.includes("Human introduction."));
    assert(output.text.includes("Human conclusion."));
    assert.equal(output.text.split("\n").filter((line) => line === start).length, 1);
    assert.equal(output.text.split("\n").filter((line) => line === end).length, 1);
  }
});

test("a fully merged wave retires after a member repository is renamed", (t) => {
  // The frozen marker keeps the old name, while epic-membership reports the live one.
  const renamed = members.map((m, i) => ({ ...m, repo: i ? m.repo : "a-novel-kit/a-renamed", state: "MERGED" }));
  const output = fixture(t, { before: marker("frozen"), members: renamed });
  succeeds(output.result);
  assert.equal(output.payload.status, "retired");
});
