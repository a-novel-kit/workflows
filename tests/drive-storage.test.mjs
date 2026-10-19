// Retention, publication and evidence contracts for the shipped Drive implementation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { link, mkdtemp, readdir, readFile, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Failure, GitHub, testedHead } from "../node-actions/test-playwright/drive/common.mjs";
import {
  cleanup,
  currentReference,
  extractSnapshots,
  promote,
} from "../node-actions/test-playwright/drive/storage.mjs";
import { archiveBatch, inspectReport } from "../node-actions/test-playwright/drive/runner.mjs";

function batch(id, number, state = "current", attempt = 1) {
  return {
    id,
    properties: { state, run_number: String(number), run_id: String(number), attempt: String(attempt), sha: id },
  };
}
class Store {
  constructor(references = [], results = []) {
    this.records = { references, results };
    this.removed = [];
  }
  async batches(id) {
    return [...this.records[id]];
  }
  async remove(batch) {
    this.removed.push(batch.id);
    for (const [key, values] of Object.entries(this.records))
      this.records[key] = values.filter((value) => value !== batch);
  }
  async markCurrent(batch) {
    batch.properties.state = "current";
  }
}
function publication() {
  const old = batch("old", 1),
    pending = batch("new", 2, "pending");
  return {
    old,
    pending,
    store: new Store([old, pending]),
    github: { current: async () => true, successfulBrowserRun: async () => true },
  };
}

test("a pull request run tests its head, since GITHUB_SHA is then GitHub's merge commit", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "drive-head-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "event.json");
  await writeFile(path, JSON.stringify({ pull_request: { head: { sha: "head" } } }));
  const cases = [
    ["pull_request", "head"],
    ["push", "merge"],
    ["merge_group", "merge"],
  ];
  for (const [name, expected] of cases)
    assert.equal(testedHead({ GITHUB_EVENT_NAME: name, GITHUB_SHA: "merge", GITHUB_EVENT_PATH: path }), expected);
});

test("pull request batches keep their provenance, and only master pushes stage references", async () => {
  const run = {
    path: ".github/workflows/main.yaml",
    head_repository: { full_name: "example/studio" },
    head_sha: "head",
    head_branch: "feature",
    run_number: 4,
    run_attempt: 1,
    status: "completed",
  };
  const github = new GitHub("example/studio", "token");
  function answer(event, overrides = {}) {
    github.request = async (path) =>
      path.startsWith("git/ref/") ? { object: { sha: "head" } } : { ...run, event, ...overrides };
  }
  github.pages = async () => [];
  const props = { properties: { run_id: "40", attempt: "1", run_number: "4", sha: "head" } };
  for (const event of ["push", "pull_request"]) {
    answer(event);
    assert.deepEqual(await github.branch(props), ["feature", true]);
  }
  answer("workflow_dispatch");
  await assert.rejects(github.branch(props), Failure);
  answer("pull_request", { head_sha: "merge" });
  await assert.rejects(github.branch(props), Failure);
  const cases = [
    ["push", true],
    ["pull_request", false],
  ];
  for (const [event, expected] of cases) {
    answer(event, { head_branch: "master" });
    assert.equal(await github.current("head", "40", "1"), expected);
  }
});

test("failed or incomplete runs keep the current reference", async () => {
  const { old, pending, store, github } = publication();
  github.successfulBrowserRun = async () => false;
  assert.equal(await promote(store, github, "references", pending), false);
  assert.equal(currentReference(await store.batches("references")), old);
  assert.deepEqual(store.removed, []);
});
test("stale master runs cannot promote", async () => {
  const { old, pending, store, github } = publication();
  github.current = async () => false;
  assert.equal(await promote(store, github, "references", pending), false);
  assert.equal(currentReference(await store.batches("references")), old);
});
test("replacement is current before deleting the old reference", async () => {
  const { pending, store, github } = publication();
  const remove = store.remove.bind(store);
  store.remove = async (value) => {
    assert.equal(currentReference(await store.batches("references")).id, "new");
    await remove(value);
  };
  assert.equal(await promote(store, github, "references", pending), true);
  assert.deepEqual(
    (await store.batches("references")).map((batch) => batch.id),
    ["new"]
  );
});
test("partial cleanup still selects the newest completed reference", async () => {
  const { pending, store, github } = publication();
  store.remove = async () => {
    throw new Failure("delete failed");
  };
  await assert.rejects(promote(store, github, "references", pending), Failure);
  assert.equal(currentReference(await store.batches("references")).id, "new");
});
test("quiet master and one completed batch per live branch remain", async () => {
  const store = new Store(
    [batch("master", 1)],
    [batch("old", 2), batch("new", 3), batch("other", 4), batch("running", 5, "pending")]
  );
  const github = { branch: async (value) => [value.id === "other" ? "other" : "branch", value.id !== "running"] };
  await cleanup(store, github, "results", "references");
  assert.deepEqual(
    (await store.batches("results")).map((batch) => batch.id),
    ["new", "other", "running"]
  );
  assert.equal((await store.batches("references"))[0].id, "master");
});
test("branch deletion between listing and publication cannot revive it", async () => {
  const store = new Store([batch("master", 1)], [batch("branch", 2, "pending")]);
  const states = [
    ["branch", true],
    [null, true],
  ];
  await cleanup(store, { branch: async () => states.shift() }, "results", "references");
  assert.deepEqual(await store.batches("results"), []);
  assert.equal((await store.batches("references"))[0].id, "master");
});
test("API failure never means branch deletion", async () => {
  const store = new Store([], [batch("branch", 2)]);
  const github = {
    branch: async () => {
      throw new Failure("rate limited");
    },
  };
  await assert.rejects(cleanup(store, github, "results", "references"), Failure);
  assert.deepEqual(store.removed, []);
});
test("master results deduplicate while newer failures remain", async () => {
  const store = new Store([batch("master", 5)], [batch("duplicate", 5)]);
  const github = { branch: async () => ["master", true] };
  await cleanup(store, github, "results", "references");
  assert.deepEqual(await store.batches("results"), []);
  store.records.results = [batch("failed-new-master", 6)];
  await cleanup(store, github, "results", "references");
  assert.equal((await store.batches("results"))[0].id, "failed-new-master");
  assert.equal((await store.batches("references"))[0].id, "master");
});
test("pending references are never selected", () =>
  assert.equal(currentReference([batch("unfinished", 5, "pending")]), null));

test("archive round-trip includes declared PNGs and rejects symlink evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "drive-archive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.cwd();
  process.chdir(directory);
  t.after(() => process.chdir(previous));
  await mkdir(".visual/snapshots/desktop", { recursive: true });
  await writeFile(".visual/snapshots/desktop/home.png", "png");
  await mkdir("playwright-report");
  await writeFile("playwright-report/index.html", "report");
  await writeFile("secret.env", "private");
  await archiveBatch(new Set(["desktop/home.png"]), "batch.tar");
  const listed = execFileSync("tar", ["--list", "--file=batch.tar"], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(listed, ["snapshots/desktop/home.png", "playwright-report/index.html"]);
  await extractSnapshots("batch.tar", "out");
  assert.equal(await readFile("out/desktop/home.png", "utf8"), "png");
  assert.deepEqual((await readdir("out", { recursive: true })).sort(), ["desktop", "desktop/home.png"]);
  await symlink(join(directory, "secret.env"), ".visual/snapshots/desktop/leak.png");
  await assert.rejects(archiveBatch(new Set(["desktop/leak.png"]), "unsafe.tar"), Failure);
});
test("archive extraction rejects traversal and links", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "drive-malicious-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "snapshots"));
  await writeFile(join(directory, "snapshots/image.png"), "png");
  await symlink("../escape", join(directory, "snapshots/link.png"));
  await link(join(directory, "snapshots/image.png"), join(directory, "snapshots/hard.png"));
  const unsafeMembers = [
    ["--transform=s,image,../escape,", "snapshots/image.png"],
    ["snapshots/link.png"],
    ["snapshots/image.png", "snapshots/hard.png"],
  ];
  for (const [index, members] of unsafeMembers.entries()) {
    const archive = join(directory, `batch-${index}.tar`);
    execFileSync("tar", ["--create", "--absolute-names", `--file=${archive}`, `--directory=${directory}`, ...members]);
    await assert.rejects(extractSnapshots(archive, join(directory, `out-${index}`)), /Unsafe/);
  }
  assert.equal(existsSync(join(directory, "escape.png")), false);
});
function report(errors, visualErrors, status = "failed") {
  return {
    expected: 1,
    tests: [
      {
        id: "one",
        expectedStatus: "passed",
        status,
        snapshots: ["desktop/home.png"],
        screenshotCount: 1,
        errors,
        visualErrors,
      },
    ],
  };
}
test("only screenshot failures qualify for reviewed regeneration", () => {
  assert.equal(inspectReport(report(["different pixels"], ["different pixels"])).visualOnly, true);
  assert.equal(inspectReport(report(["different pixels", "login failed"], ["different pixels"])).visualOnly, false);
});
test("timeout, empty suite and incomplete inventories cannot publish", () => {
  assert.equal(inspectReport(report([], [], "timedOut")).visualOnly, false);
  assert.throws(() => inspectReport({ suites: [] }), Failure);
  const value = report([], [], "passed");
  value.tests[0].screenshotCount = 2;
  assert.throws(() => inspectReport(value), Failure);
});
