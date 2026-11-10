import assert from "node:assert/strict";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { functions, manifest, root, step, succeeds, workspace } from "./helpers.mjs";

function repository(t) {
  const w = workspace(t);
  succeeds(w.run("git", ["init", "-q"]));
  w.write("package.json", '{"description":"fixture","version":"1.2.3"}');
  return w;
}
const releaseScript = (name) => join(root, "publish-actions/release-core", `${name}.mjs`);

/** A repository whose master holds the v1.2.3 release, or the given baseline. */
function released(t, baseline = "1.2.3") {
  const w = repository(t);
  const git = (...args) => succeeds(w.run("git", args));
  w.write("package.json", `{"version":"${baseline}"}`);
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  git("checkout", "-qb", "master");
  git("add", "package.json");
  git("commit", "-qm", `chore(release): ${baseline}`);
  git("tag", `v${baseline}`);
  git("update-ref", "refs/remotes/origin/master", "HEAD");
  return { w, git };
}

test("release guard treats branch names as data and refuses a cut without the release key", (t) => {
  const w = workspace(t);
  const guard = step("publish-actions/release-core/action.yaml", "guard");
  const refs = [
    ["master", 0],
    ["v2", 0],
    ["v12", 0],
    ["feature", 1],
    ["v0", 1],
    ["v02", 1],
    ["v2.1", 1],
    ["release/v1.2", 1],
    ["$(touch injected)", 1],
  ];
  for (const [ref, status] of refs) {
    const env = { REF_NAME: ref, DEFAULT_BRANCH: "master", DRY_RUN: "false", HAS_KEY: "true" };
    assert.equal(w.bash(guard, env).status, status, ref);
    assert.equal(existsSync(join(w.cwd, "injected")), false);
  }
  // A rehearsal needs no key; a cut whose job sits outside the release environment reads none.
  const keyOutcomes = [
    ["true", "false", 0],
    ["yes", "false", 0],
    ["false", "false", 1],
    [" FALSE ", "false", 1],
  ];
  for (const [dryRun, hasKey, status] of keyOutcomes) {
    const env = { REF_NAME: "master", DEFAULT_BRANCH: "master", DRY_RUN: dryRun, HAS_KEY: hasKey };
    assert.equal(w.bash(guard, env).status, status);
  }
  // The guard hands later steps its resolved dry_run.
  w.write("output", "");
  succeeds(w.bash(guard, { REF_NAME: "master", DEFAULT_BRANCH: "master", DRY_RUN: " FALSE ", HAS_KEY: "true" }));
  assert.equal(w.read("output"), "dry_run=false\n");
});

test("release bump updates all package formats and quoted filenames, leaving versionless packages alone", (t) => {
  const bumps = [
    ["patch", "1.2.4"],
    ["minor", "1.3.0"],
    // A major reads its number from its branch, never from the branch's own package.json.
    ["major", "7.0.0"],
  ];
  for (const [type, next] of bumps) {
    const w = repository(t);
    const nested = 'packages/quoted "name"\n/package.json';
    w.write(nested, '{"version" : "0.5.0", "config":{"version":"leave-me"}}');
    w.write("tools/package.json", '{"private":true}\n');
    succeeds(w.run("git", ["add", "package.json", "packages", "tools"]));
    assert.equal(
      succeeds(w.run(process.execPath, [releaseScript("bump")], { RELEASE_TYPE: type, BRANCH: "v7" })),
      next
    );
    assert.equal(JSON.parse(w.read("package.json")).version, next);
    assert.deepEqual(JSON.parse(w.read(nested)), { version: next, config: { version: "leave-me" } });
    assert.equal(w.read("tools/package.json"), '{"private":true}\n');
  }
});

test("a patch moves past the patches its minor already tagged, as a release line's hotfix", (t) => {
  const histories = [
    [["v1.2.3", "v1.2.4", "v1.2.10", "child/v1.2.12", "v1.3.0", "v1.2.11-rc.1"], "1.2.11"],
    [["v1.2.3", "v1.20.4"], "1.2.4"],
  ];
  for (const [tags, next] of histories) {
    const w = repository(t);
    succeeds(w.run("git", ["add", "package.json"]));
    succeeds(
      w.run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "baseline"])
    );
    for (const tag of tags) succeeds(w.run("git", ["tag", tag]));
    assert.equal(succeeds(w.run(process.execPath, [releaseScript("bump")], { RELEASE_TYPE: "patch" })), next);
    assert.equal(JSON.parse(w.read("package.json")).version, next);
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

test("release pushes are atomic, hotfixes push their release line, and dry runs publish nothing", (t) => {
  const releaseLines = [
    ["release-core", "master"],
    ["release-core-hotfix", "release/v1.2"],
  ];
  for (const [action, pushed] of releaseLines) {
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
      git("push", "origin", "master", "master:release/v1.2", "v1.2.3");
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
      const cut = step(`publish-actions/${action}/action.yaml`, "cut");
      const env = {
        GITHUB_ACTION_PATH: join(root, "publish-actions", action),
        GITHUB_REPOSITORY: "a-novel-kit/example",
        GH_TOKEN: "release-token",
        APP_SLUG: "fixture",
        STAMP_NEEDED: "false",
        BRANCH: pushed,
        DEFAULT_BRANCH: "master",
        DRY_RUN: String(outcome === "dry-run"),
      };
      const result = w.bash(cut, env);
      if (outcome === "reject") assert.notEqual(result.status, 0, result.stdout);
      else succeeds(result);
      const remote = (...args) => git("--git-dir=remote.git", ...args);
      for (const branch of ["master", "release/v1.2"])
        assert.equal(
          remote("rev-parse", `refs/heads/${branch}`) === baseline,
          branch !== pushed || outcome !== "success"
        );
      assert.equal(existsSync(join(w.cwd, "released")), outcome === "success");
      if (outcome === "success") {
        for (const tag of ["v1.2.4", "child/v1.2.4"]) assert.equal(remote("rev-parse", tag), git("rev-parse", "HEAD"));
        const released = JSON.parse(w.read("released"));
        assert.equal(released.includes("--latest=false"), action.endsWith("hotfix"));
        if (action.endsWith("hotfix")) assert.equal(released[released.indexOf("--target") + 1], pushed);
      } else assert.equal(remote("tag", "--list", "*v1.2.4"), "");
      if (outcome === "dry-run") assert.equal(JSON.parse(w.read("package.json")).version, "1.2.3");
    }
  }
});

test("the default branch's release takes the largest size among the commits since its last release", (t) => {
  // Conventional Commits 1.0.0 §15: a type matches in any case, and BREAKING CHANGE only in upper case.
  const cases = [
    [[], "patch"],
    [["fix: predicate", "chore(deps): bump"], "patch"],
    [["fix: predicate", "feat(api): endpoint"], "minor"],
    [["Feat(API): endpoint"], "minor"],
    // A breaking change sized by its commit stays a minor: a major only comes from a v<N> branch.
    [["feat(proto)!: remove field"], "minor"],
    [["chore!: drop action"], "minor"],
    [["fix: change\n\nBREAKING CHANGE: contract"], "minor"],
    [["fix: change\n\nbreaking change: prose"], "patch"],
    [["docs: examples\n\nfeat: quoted example\nfix!: quoted example"], "patch"],
  ];
  const env = { BRANCH: "master", DEFAULT_BRANCH: "master" };
  for (const [messages, expected] of cases) {
    const { w, git } = released(t);
    for (const message of messages) git("commit", "-q", "--allow-empty", "-m", message);
    assert.equal(succeeds(w.run(process.execPath, [releaseScript("size")], env)), expected, messages.join());
  }

  // A commit before the last release no longer counts, and a repository without a release is a minor.
  const { w, git } = released(t);
  git("tag", "-d", "v1.2.3");
  git("commit", "-q", "--allow-empty", "-m", "fix: predicate");
  assert.equal(succeeds(w.run(process.execPath, [releaseScript("size")], env)), "minor");
  git("tag", "v1.2.3");
  assert.equal(succeeds(w.run(process.execPath, [releaseScript("size")], env)), "patch");
});

test("a v<N> branch releases only the major right after the default branch's", (t) => {
  const majors = [
    ["1.2.3", "v1", 1],
    ["1.2.3", "v2", 0],
    ["1.2.3", "v3", 1],
    ["0.4.0", "v1", 0],
  ];
  for (const [baseline, branch, status] of majors) {
    const { w } = released(t, baseline);
    const result = w.run(process.execPath, [releaseScript("size")], { BRANCH: branch, DEFAULT_BRANCH: "master" });
    assert.equal(result.status, status, result.stderr);
    if (status === 0) assert.equal(result.stdout, "major");
    else assert.match(result.stderr, /^::error::/);
  }
});

test("a major from v2 needs its Go module paths to end with /v2", (t) => {
  const modules = [
    ["github.com/a-novel-kit/example", "v2", 1],
    ["github.com/a-novel-kit/example/v2", "v2", 0],
  ];
  for (const [module, branch, status] of modules) {
    const { w, git } = released(t);
    w.write("go.mod", `module ${module}\n`);
    git("add", "go.mod");
    assert.equal(
      w.run(process.execPath, [releaseScript("size")], { BRANCH: branch, DEFAULT_BRANCH: "master" }).status,
      status
    );
  }

  // Go only requires the suffix from major 2 on.
  const { w, git } = released(t, "0.4.0");
  w.write("go.mod", "module github.com/a-novel-kit/example\n");
  git("add", "go.mod");
  assert.equal(
    succeeds(w.run(process.execPath, [releaseScript("size")], { BRANCH: "v1", DEFAULT_BRANCH: "master" })),
    "major"
  );
});

test("a major swaps the branches and pushes its tags atomically, with or without shared history", (t) => {
  const scenarios = [
    { history: "shared", outcome: "success" },
    { history: "unrelated", outcome: "success" },
    { history: "unrelated", outcome: "dry-run" },
    { history: "shared", outcome: "line-taken" },
    { history: "shared", outcome: "master-moved" },
  ];
  for (const { history, outcome } of scenarios) {
    const { w, git } = released(t);
    const master = git("rev-parse", "HEAD");
    git("init", "--bare", "-q", "remote.git");
    git("remote", "add", "origin", "remote.git");
    // Keep the mock remote and diagnostics out of the release commit's git add -A.
    w.write(".git/info/exclude", "remote.git/\nbin/\noutput\nsummary\nreleased\n");

    git("checkout", ...(history === "unrelated" ? ["-q", "--orphan", "v2"] : ["-qb", "v2"]));
    w.write("package.json", '{"version":"0.0.1"}');
    w.write("rewrite", "");
    git("add", "package.json", "rewrite");
    git("commit", "-qm", "feat!: rewrite");
    const branchHead = git("rev-parse", "HEAD");
    git("push", "-q", "origin", "master", "v2", "v1.2.3");

    const remote = (...args) => git("--git-dir=remote.git", ...args);
    if (outcome === "line-taken") git("push", "-q", "origin", "v2:refs/heads/v1");
    if (outcome === "master-moved") {
      const racing = git("commit-tree", `${master}^{tree}`, "-p", master, "-m", "fix: racing merge");
      git("push", "-q", "origin", `${racing}:refs/heads/master`);
      git("update-ref", "refs/remotes/origin/master", master);
    }
    const before = remote("for-each-ref", "--format=%(refname) %(objectname)");

    w.stub("gh", "import * as fs from 'node:fs'; fs.writeFileSync('released', JSON.stringify(process.argv.slice(2)))");
    const result = w.bash(step("publish-actions/release-core/action.yaml", "cut"), {
      GITHUB_ACTION_PATH: join(root, "publish-actions/release-core"),
      GITHUB_REPOSITORY: "a-novel-kit/example",
      GH_TOKEN: "release-token",
      APP_SLUG: "fixture",
      STAMP_NEEDED: "false",
      BRANCH: "v2",
      DEFAULT_BRANCH: "master",
      DRY_RUN: String(outcome === "dry-run"),
    });

    if (outcome !== "success") {
      assert.equal(result.status === 0, outcome === "dry-run", result.stdout + result.stderr);
      assert.equal(remote("for-each-ref", "--format=%(refname) %(objectname)"), before);
      assert.equal(existsSync(join(w.cwd, "released")), false);
      assert.equal(remote("rev-parse", "refs/heads/v2"), branchHead);
      continue;
    }

    succeeds(result);
    const head = git("rev-parse", "HEAD");
    assert.equal(git("rev-parse", "HEAD^"), branchHead);
    assert.equal(JSON.parse(w.read("package.json")).version, "2.0.0");
    assert.equal(remote("rev-parse", "refs/heads/master"), head);
    assert.equal(remote("rev-parse", "refs/heads/v1"), master);
    assert.equal(remote("for-each-ref", "refs/heads/v2"), "");
    assert.equal(remote("rev-parse", "refs/tags/v2.0.0"), head);
    assert.equal(remote("rev-parse", "refs/tags/v1.2.3"), master);
    assert.equal(existsSync(join(w.cwd, "released")), true);
  }
});

test("a release names the pending guide after its version and indexes it, newest first", (t) => {
  const entry = "- [v1.2.3](./v1.2.3.md): Moves the thing to the other thing.\n";
  const indexes = [
    [
      "# Migration guides\n\nIntro.\n\n- [v1.0.0](./v1.0.0.md): Older.\n",
      `# Migration guides\n\nIntro.\n\n${entry}- [v1.0.0](./v1.0.0.md): Older.\n`,
    ],
    ["# Migration guides\n\nIntro.\n", `# Migration guides\n\nIntro.\n\n${entry}`],
    [null, `# Migration guides\n\n${entry}`],
  ];
  const guide =
    "# Upgrading to NEXT\n\nMoves the thing to the\nother thing.\n\n## Do I need to act?\n\nNo: `NEXT.md` stays named.\n";
  const plan = (w) => w.run(process.execPath, [releaseScript("plan")], { GITHUB_REPOSITORY: "a-novel-kit/example" });

  for (const [index, expected] of indexes) {
    const w = repository(t);
    w.write("docs/migrations/NEXT.md", guide);
    if (index) w.write("docs/migrations/README.md", index);
    succeeds(w.run("git", ["add", "package.json", "docs"]));
    succeeds(plan(w));
    assert.equal(existsSync(join(w.cwd, "docs/migrations/NEXT.md")), false);
    assert.equal(w.read("docs/migrations/v1.2.3.md"), guide.replace("NEXT\n", "v1.2.3\n"));
    assert.equal(w.read("docs/migrations/README.md"), expected);
  }

  // No pending guide leaves the index alone, and a guide with no summary stops the release.
  const clean = repository(t);
  succeeds(clean.run("git", ["add", "package.json"]));
  succeeds(plan(clean));
  assert.equal(existsSync(join(clean.cwd, "docs")), false);
  const untitled = repository(t);
  untitled.write("docs/migrations/NEXT.md", "# Upgrading to NEXT\n");
  succeeds(untitled.run("git", ["add", "package.json", "docs"]));
  assert.notEqual(plan(untitled).status, 0);
});

test("release train skips an empty range, and fails closed on a read failure", (t) => {
  const w = workspace(t);
  const script = functions(
    step("generic-actions/release-train/action.yaml", "Reconstruct the Epic, drive each release.yaml"),
    ["pending_release"]
  );
  w.stub("sleep", "");
  w.stub("gh", "if (process.env.API_FAIL === 'true') process.exit(1); console.log(process.env.AHEAD);");
  const cases = [
    ["0", "v1.0.0", false, "none"],
    ["3", "v1.0.0", false, "pending"],
    ["0", "", false, "pending"],
    ["", "v1.0.0", true, "__ERR__"],
  ];
  for (const [ahead, tag, failed, expected] of cases) {
    const env = { AHEAD: ahead, API_FAIL: String(failed) };
    assert.equal(succeeds(w.bash(`${script}\npending_release "$@"`, env, ["owner/repo", tag, "master"])), expected);
  }
});

test("release train waits for a cut's approval and never for a rehearsal", (t) => {
  const w = workspace(t);
  const script = functions(
    step("generic-actions/release-train/action.yaml", "Reconstruct the Epic, drive each release.yaml"),
    ["poll_run"]
  );
  w.stub("sleep", "");
  // Each call answers the next status from STATUSES, repeating the last one.
  w.stub(
    "gh",
    `
    const fs = require('node:fs');
    const statuses = process.env.STATUSES.split(',');
    const n = fs.existsSync('calls') ? Number(fs.readFileSync('calls', 'utf8')) : 0;
    fs.writeFileSync('calls', String(n + 1));
    const status = statuses[Math.min(n, statuses.length - 1)];
    console.log(status === 'completed' ? 'completed success' : status + ' ');
  `
  );
  const cases = [
    ["in_progress,waiting,waiting,in_progress,completed", "true", "success", true],
    ["in_progress,waiting,completed", "false", "blocked", false],
  ];
  for (const [statuses, approval, expected, announced] of cases) {
    w.write("calls", "0");
    w.write("summary", "");
    const env = { STATUSES: statuses, GITHUB_SERVER_URL: "https://github.com" };
    const result = w.bash(`${script}\npoll_run "$@"`, env, ["owner/repo", "42", approval]);
    assert.equal(succeeds(result), expected);
    const link = "- ⏳ **owner/repo** — cut awaiting approval: https://github.com/owner/repo/actions/runs/42";
    assert.equal(w.read("summary").trim(), announced ? link : "");
  }
});

test("release receipt replacement preserves prose and literal backslashes", (t) => {
  const w = workspace(t);
  const script = functions(
    step("generic-actions/release-train/action.yaml", "Reconstruct the Epic, drive each release.yaml"),
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

test("release checkouts keep no credential, so only the push sees the release token", () => {
  for (const action of ["release-core", "release-core-hotfix"]) {
    const checkout = manifest(`publish-actions/${action}/action.yaml`).runs.steps.find((s) => s.name === "Checkout");
    assert.equal(checkout.with["persist-credentials"], false, action);
  }
});
