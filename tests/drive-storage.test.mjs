// Retention, publication and evidence contracts for the shipped Drive implementation.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { Failure } from "../node-actions/test-playwright/drive/common.mjs";
import {
  cleanup,
  currentReference,
  extractSnapshots,
  promote,
} from "../node-actions/test-playwright/drive/storage.mjs";
import { archiveBatch, inspectReport } from "../node-actions/test-playwright/drive/runner.mjs";
const require = createRequire(new URL("../node-actions/test-playwright/drive/package.json", import.meta.url));
const tar = require("tar");

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
  await assert.rejects(
    cleanup(
      store,
      {
        branch: async () => {
          throw new Failure("rate limited");
        },
      },
      "results",
      "references"
    ),
    Failure
  );
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
  await writeFile("secret.env", "private");
  await archiveBatch(new Set(["desktop/home.png"]), "batch.tar");
  const names = [];
  await tar.t({
    file: "batch.tar",
    onReadEntry(entry) {
      names.push(entry.path);
    },
  });
  assert.deepEqual(names, ["snapshots/desktop/home.png"]);
  await extractSnapshots("batch.tar", "out");
  assert.equal(await readFile("out/desktop/home.png", "utf8"), "png");
  await symlink(join(directory, "secret.env"), ".visual/snapshots/desktop/leak.png");
  await assert.rejects(archiveBatch(new Set(["desktop/leak.png"]), "unsafe.tar"), Failure);
});
test("archive extraction rejects traversal and links", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "drive-malicious-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "image"), "png");
  for (const [name, type] of [
    ["snapshots/../escape.png", "File"],
    ["snapshots/link.png", "SymbolicLink"],
  ]) {
    const archive = join(directory, "batch.tar");
    await tar.c(
      {
        cwd: directory,
        file: archive,
        onWriteEntry(entry) {
          entry.path = name;
          entry.type = type;
          entry.linkpath = "../escape";
        },
      },
      ["image"]
    );
    await assert.rejects(extractSnapshots(archive, join(directory, "out")), /Unsafe|TAR_ENTRY/);
  }
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
