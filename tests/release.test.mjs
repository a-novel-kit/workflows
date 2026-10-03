import assert from "node:assert/strict";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { functions, root, step, succeeds, workspace } from "./helpers.mjs";

function repository(t) {
  const w = workspace(t);
  succeeds(w.run("git", ["init", "-q"]));
  w.write("package.json", '{"description":"fixture","version":"1.2.3"}');
  return w;
}
const releaseScript = (name) => join(root, "publish-actions/release-core", `${name}.mjs`);

test("release branch guard treats branch names as data", (t) => {
  const w = workspace(t);
  const guard = step("publish-actions/release-core/action.yaml", "Guard — default branch only");
  for (const ref of ["master", "feature", "$(touch injected)"]) {
    assert.equal(w.bash(guard, { REF_NAME: ref, DEFAULT_BRANCH: "master" }).status, ref === "master" ? 0 : 1);
    assert.equal(existsSync(join(w.cwd, "injected")), false);
  }
});

test("release bump updates all package formats and quoted filenames, leaving versionless packages alone", (t) => {
  for (const [type, next] of [
    ["patch", "1.2.4"],
    ["minor", "1.3.0"],
    ["major", "2.0.0"],
  ]) {
    const w = repository(t);
    const nested = 'packages/quoted "name"\n/package.json';
    w.write(nested, '{"version" : "0.5.0", "config":{"version":"leave-me"}}');
    w.write("tools/package.json", '{"private":true}\n');
    succeeds(w.run("git", ["add", "package.json", "packages", "tools"]));
    assert.equal(succeeds(w.run(process.execPath, [releaseScript("bump")], { RELEASE_TYPE: type })), next);
    assert.equal(JSON.parse(w.read("package.json")).version, next);
    assert.deepEqual(JSON.parse(w.read(nested)), { version: next, config: { version: "leave-me" } });
    assert.equal(w.read("tools/package.json"), '{"private":true}\n');
  }
});

test("invalid release baselines and broken workspace manifests fail before any file changes", (t) => {
  for (const version of ["1.2.3-beta.1", "1.2", "01.2.3", null]) {
    const w = repository(t);
    const original = JSON.stringify({ version });
    w.write("package.json", original);
    succeeds(w.run("git", ["add", "package.json"]));
    assert.notEqual(w.run(process.execPath, [releaseScript("bump")], { RELEASE_TYPE: "patch" }).status, 0);
    assert.equal(w.read("package.json"), original);
  }
  const w = repository(t),
    original = w.read("package.json");
  w.write("broken/package.json", "{");
  succeeds(w.run("git", ["add", "package.json", "broken"]));
  assert.notEqual(w.run(process.execPath, [releaseScript("bump")], { RELEASE_TYPE: "patch" }).status, 0);
  assert.equal(w.read("package.json"), original);
});

test("release plan stamps only this repository's stable Go requirements and emits nested tags", (t) => {
  const w = repository(t);
  const original = `module github.com/a-novel-kit/example
require (
  github.com/a-novel-kit/example/child v1.0.0
  github.com/a-novel-kit/example-other v9.0.0
  github.com/a-novel-kit/example/pre v1.0.0-rc.1
  github.com/a-novel-kit/example/pseudo v0.0.0-20260101000000-abcdef
)
// github.com/a-novel-kit/example/comment v1.0.0
`;
  w.write("go.mod", original);
  w.write(
    "child/go.mod",
    "module github.com/a-novel-kit/example/child\nrequire github.com/a-novel-kit/example v1.0.0\n"
  );
  const pins =
    'uses: "a-novel-kit/example/build/task@v1.0.0"\nuses: a-novel-kit/example-other/task@v1.0.0\nuses: a-novel-kit/example/task@v1.0.0-rc.1\n';
  w.write("action with spaces.yaml", pins);
  succeeds(w.run("git", ["add", "package.json", "go.mod", "child", "action with spaces.yaml"]));
  const tags = succeeds(w.run(process.execPath, [releaseScript("plan")], { GITHUB_REPOSITORY: "a-novel-kit/example" }));
  assert.equal(tags, "v1.2.3\nchild/v1.2.3");
  assert.equal(w.read("go.mod"), original.replace("/child v1.0.0", "/child v1.2.3"));
  assert.match(w.read("child/go.mod"), /require github.com\/a-novel-kit\/example v1\.2\.3/);
  assert.equal(w.read("action with spaces.yaml"), pins);
  succeeds(
    w.run(process.execPath, [releaseScript("plan"), "--self-pins"], { GITHUB_REPOSITORY: "a-novel-kit/example" })
  );
  assert.equal(w.read("action with spaces.yaml"), pins.replace("build/task@v1.0.0", "build/task@v1.2.3"));
  assert.notEqual(w.run(process.execPath, [releaseScript("plan")], { GITHUB_REPOSITORY: "" }).status, 0);
});

test("release pushes are atomic, hotfixes only push tags, and dry runs publish nothing", (t) => {
  for (const action of ["release-core", "release-core-hotfix"]) {
    for (const outcome of ["success", "reject", "dry-run"]) {
      const w = repository(t);
      const git = (...args) => succeeds(w.run("git", args));
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture@example.test");
      git("checkout", "-b", "master");
      w.write("child/go.mod", "module github.com/a-novel-kit/example/child\n");
      git("add", "package.json", "child");
      git("commit", "-qm", "baseline");
      git("tag", "v1.2.3");
      git("init", "--bare", "remote.git");
      git("remote", "add", "origin", "remote.git");
      git("push", "origin", "master", "v1.2.3");
      const baseline = git("rev-parse", "HEAD");
      // Keep the mock remote and diagnostics out of the release commit's git add -A.
      w.write(".git/info/exclude", "remote.git/\nbin/\noutput\nsummary\nreleased\n");
      if (outcome === "reject") {
        const hook = w.write(
          "remote.git/hooks/update",
          `#!${process.execPath}\nprocess.exit(process.argv[2] === 'refs/tags/child/v1.2.4' ? 1 : 0);\n`
        );
        chmodSync(hook, 0o755);
      }
      w.stub(
        "gh",
        "import * as fs from 'node:fs'; fs.writeFileSync('released', JSON.stringify(process.argv.slice(2)))"
      );
      const result = w.bash(step(`publish-actions/${action}/action.yaml`, "cut"), {
        GITHUB_ACTION_PATH: join(root, "publish-actions", action),
        GITHUB_REPOSITORY: "a-novel-kit/example",
        APP_SLUG: "fixture",
        RELEASE_TYPE: "patch",
        STAMP_NEEDED: "false",
        BRANCH: "master",
        DRY_RUN: String(outcome === "dry-run"),
      });
      if (outcome === "reject") assert.notEqual(result.status, 0, result.stdout);
      else succeeds(result);
      const remote = (...args) => git("--git-dir=remote.git", ...args);
      const branch = remote("rev-parse", "refs/heads/master");
      assert.equal(branch === baseline, action.endsWith("hotfix") || outcome !== "success");
      assert.equal(existsSync(join(w.cwd, "released")), outcome === "success");
      if (outcome === "success") {
        for (const tag of ["v1.2.4", "child/v1.2.4"]) assert.equal(remote("rev-parse", tag), git("rev-parse", "HEAD"));
        assert.equal(JSON.parse(w.read("released")).includes("--latest=false"), action.endsWith("hotfix"));
      } else assert.equal(remote("tag", "--list", "*v1.2.4"), "");
      if (outcome === "dry-run") assert.equal(JSON.parse(w.read("package.json")).version, "1.2.3");
    }
  }
});

test("release train distinguishes read failure, empty history and release types", (t) => {
  const w = workspace(t);
  const script = functions(
    step("generic-actions/release-train/action.yaml", "Reconstruct the Epic, derive bumps, drive each release.yaml"),
    ["commit_messages", "derive_bump"]
  );
  w.stub("sleep", "");
  w.stub(
    "gh",
    `
    if (process.env.API_FAIL === 'true') process.exit(1);
    for (const message of JSON.parse(process.env.MESSAGES)) console.log(JSON.stringify(message));
  `
  );
  for (const [messages, tag, failed, expected] of [
    [[], "v1.0.0", false, "none"],
    [[], "", false, "minor"],
    [[], "v1.0.0", true, "__ERR__"],
    [[], "", true, "__ERR__"],
    [["fix: predicate"], "v1.0.0", false, "patch"],
    [["feat: endpoint"], "v1.0.0", false, "minor"],
    [["feat(proto)!: remove field"], "v1.0.0", false, "major"],
    [["fix: change\n\nBREAKING CHANGE: contract"], "v1.0.0", false, "major"],
    [["docs: examples\n\nfeat: quoted example"], "v1.0.0", false, "patch"],
  ])
    assert.equal(
      succeeds(
        w.bash(
          `${script}\nderive_bump "$@"`,
          {
            MESSAGES: JSON.stringify(messages),
            API_FAIL: String(failed),
          },
          ["owner/repo", tag, "master"]
        )
      ),
      expected
    );
});

test("release receipt replacement preserves prose and literal backslashes", (t) => {
  const w = workspace(t);
  const script = functions(
    step("generic-actions/release-train/action.yaml", "Reconstruct the Epic, derive bumps, drive each release.yaml"),
    ["splice_body"]
  );
  const start = "<!-- release-train:receipts:start -->",
    end = "<!-- release-train:receipts:end -->";
  const block = `${start}\nreceipt \\new\n${end}`;
  for (const body of [`Human prose.\n${start}\nstale\n${end}`, "Human prose.", `${end}\nHuman prose.\n${start}`]) {
    const result = succeeds(w.bash(`${script}\nsplice_body "$@"`, {}, [body, block]));
    assert(result.includes("Human prose."));
    assert(result.includes(block));
    assert(!result.includes("stale"));
  }
});
