import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { functions, step, succeeds, workspace } from "./helpers.mjs";

const dispatch = step(".github/workflows/backport-run.yaml", "Open backport pull requests");
const backport = functions(dispatch, ["release_baseline", "ensure_release_line", "fast_path"]);
const pending = functions(step(".github/workflows/release-line-run.yaml", "pending"), ["line_pending"]);

/** A repository released at v1.4.0 whose default branch is pushed to a bare origin. */
function repository(t) {
  const w = workspace(t);
  const git = (...args) => succeeds(w.run("git", args));
  git("init", "-q", "-b", "master");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  w.write(".git/info/exclude", "remote.git/\nbin/\noutput\nsummary\npulls\ninjected\n");
  const commit = (path, content, message) => {
    w.write(path, content);
    git("add", path);
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  commit("auth.js", "if (user.id === owner) allow();\n", "feat: owner check");
  commit("limits.js", "const max = 10;\n", "feat: request limit");
  git("tag", "v1.4.0");
  git("init", "-q", "--bare", "remote.git");
  git("remote", "add", "origin", "remote.git");
  git("push", "-q", "origin", "master", "v1.4.0");
  // Records every call. The API's commits and ref moves act on the bare origin, committed by GitHub,
  // which is the committer of every commit it creates and signs.
  w.stub(
    "gh",
    `
    const args = process.argv.slice(2), field = (name) => args.find((arg) => arg.startsWith(name + '='))?.slice(name.length + 1);
    require('node:fs').appendFileSync('pulls', JSON.stringify(args) + '\\n');
    const origin = (...command) => require('node:child_process').execFileSync('git', ['--git-dir=remote.git', ...command], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'agent[bot]', GIT_AUTHOR_EMAIL: 'agent[bot]@users.noreply.github.com',
        GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com' },
    }).trim();
    if (args[1]?.endsWith('/git/commits')) console.log(origin('commit-tree', field('tree'), '-p', field('parents[]'), '-m', field('message')));
    else if (args[2] === 'PATCH') origin('update-ref', 'refs/heads/' + args[3].split('/git/refs/heads/')[1], field('sha'));
  `
  );
  const sh = (script, env = {}) =>
    w.bash(`set -euo pipefail\n${backport}\n${pending}\n${script}`, {
      DEFAULT_BRANCH: "master",
      DRY_RUN: "false",
      ...env,
    });
  const backports = (fixRefs, env = {}) =>
    w.bash(dispatch, {
      LINE: "1.4",
      FIX_REFS: fixRefs,
      DEFAULT_BRANCH: "master",
      DRY_RUN: "false",
      APP_SLUG: "agent",
      RUNNER_TEMP: w.cwd,
      GITHUB_REPOSITORY: "a-novel-kit/example",
      ...env,
    });
  const remote = (ref) => w.run("git", ["--git-dir=remote.git", "rev-parse", "--verify", "--quiet", ref]).stdout.trim();
  const calls = () => (existsSync(join(w.cwd, "pulls")) ? w.read("pulls").trim().split("\n").map(JSON.parse) : []);
  const pulls = () => calls().filter((args) => args[0] === "pr");
  return { w, git, commit, sh, backports, remote, calls, pulls };
}

test("the backport baseline is the line's highest stable tag, and a malformed line is data", (t) => {
  const { w, git, sh } = repository(t);
  for (const tag of ["v1.4.2", "v1.4.10", "v1.4.11-rc.1", "child/v1.4.12", "v1.40.0", "v1.5.0"]) git("tag", tag);
  assert.equal(succeeds(sh("release_baseline 1.4")), "v1.4.10");
  assert.notEqual(sh("release_baseline 1.3").status, 0);
  for (const line of ["1.4; touch injected", "1x4", "v1.4"]) {
    assert.notEqual(sh(`release_baseline '${line}'`).status, 0, line);
    assert.equal(existsSync(join(w.cwd, "injected")), false);
  }
});

test("a release line is created from its baseline once, and a line missing that baseline is refused", (t) => {
  const { git, commit, sh, remote } = repository(t);
  const released = git("rev-parse", "v1.4.0");
  succeeds(sh("ensure_release_line 1.4 v1.4.0", { DRY_RUN: "true" }));
  assert.equal(remote("refs/heads/release/v1.4"), "");
  succeeds(sh("ensure_release_line 1.4 v1.4.0"));
  assert.equal(remote("refs/heads/release/v1.4"), released);
  succeeds(sh("ensure_release_line 1.4 v1.4.0"));
  assert.equal(remote("refs/heads/release/v1.4"), released);
  // A v1.4.1 tagged off the default branch is not on the line, so the line was not cut from it.
  commit("limits.js", "const max = 20;\n", "feat: raise the limit");
  git("tag", "v1.4.1");
  assert.match(sh("ensure_release_line 1.4 v1.4.1").stderr, /does not contain v1\.4\.1/);
});

test("the release App creates a missing release line when the caller passes it", (t) => {
  const { w, git, sh, remote } = repository(t);
  // Ref creation through the API lands on the bare origin, recorded with the token it ran with.
  w.stub(
    "gh",
    `
    const args = process.argv.slice(2), field = (name) => args.find((arg) => arg.startsWith(name + '='))?.slice(name.length + 1);
    require('node:fs').appendFileSync('tokens', JSON.stringify([process.env.GH_TOKEN, ...args]) + '\\n');
    if (args[1]?.endsWith('/git/refs')) require('node:child_process').execFileSync('git', ['--git-dir=remote.git', 'update-ref', field('ref'), field('sha')]);
  `
  );
  succeeds(sh("ensure_release_line 1.4 v1.4.0", { GITHUB_REPOSITORY: "a-novel-kit/example", LINE_TOKEN: "release" }));
  assert.equal(remote("refs/heads/release/v1.4"), git("rev-parse", "v1.4.0"));
  const calls = w.read("tokens").trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    calls.map(([token, ...args]) => [token, args[1]]),
    [["release", "repos/a-novel-kit/example/git/refs"]]
  );
});

test("a clean backport opens one pull request carrying the fix alone, never the default branch's unreleased work", (t) => {
  const { git, commit, backports, remote, calls, pulls } = repository(t);
  commit("dashboard.js", "render();\n", "feat: unreleased dashboard");
  const fix = commit("limits.js", "const max = 5;\n", "fix: lower the request limit");
  git("push", "-q", "origin", "master");
  const branch = `backport/v1.4-${fix.slice(0, 12)}`;

  succeeds(backports(fix, { DRY_RUN: "true" }));
  assert.equal(remote("refs/heads/release/v1.4"), "");
  assert.equal(remote(`refs/heads/${branch}`), "");
  assert.deepEqual(calls(), []);

  succeeds(backports(fix));
  const picked = remote(`refs/heads/${branch}`);
  git("fetch", "-q", "origin", branch);
  // The release line requires signed commits, so the branch carries the API's copy of the cherry-pick.
  assert.equal(git("log", "-1", "--format=%cn", picked), "GitHub");
  assert.equal(git("rev-parse", `${picked}^`), git("rev-parse", "v1.4.0"));
  assert.equal(git("show", `${picked}:limits.js`), "const max = 5;");
  assert.equal(git("ls-tree", "--name-only", picked), "auth.js\nlimits.js");
  assert.match(git("log", "-1", "--format=%B", picked), new RegExp(`cherry picked from commit ${fix}`));
  const title = "fix: lower the request limit [v1.4]";
  const opened = ["pr", "create", "--base", "release/v1.4", "--head", branch, "--title", title, "--body"];
  assert.deepEqual(
    pulls().map((args) => args.slice(0, 9)),
    [opened]
  );

  // A second dispatch finds the open backport, and once it merges, finds the fix on the line.
  succeeds(backports(fix));
  git("push", "-q", "origin", `${picked}:refs/heads/release/v1.4`, `:refs/heads/${branch}`);
  succeeds(backports(fix));
  assert.equal(pulls().length, 1);
});

test("a clean backport is opened by the Dependencies App and approved; one fitted to other context waits for a person", (t) => {
  const { w, git, commit, backports } = repository(t);
  // Each call records the token it ran with; a created pull request answers with its URL.
  w.stub(
    "gh",
    `
    const args = process.argv.slice(2), field = (name) => args.find((arg) => arg.startsWith(name + '='))?.slice(name.length + 1);
    require('node:fs').appendFileSync('tokens', JSON.stringify([process.env.GH_TOKEN, ...args]) + '\\n');
    const origin = (...command) => require('node:child_process').execFileSync('git', ['--git-dir=remote.git', ...command], {
      encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'dependencies[bot]', GIT_AUTHOR_EMAIL: 'dependencies[bot]@users.noreply.github.com', GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com' },
    }).trim();
    if (args[1]?.endsWith('/git/commits')) console.log(origin('commit-tree', field('tree'), '-p', field('parents[]'), '-m', field('message')));
    else if (args[2] === 'PATCH') origin('update-ref', 'refs/heads/' + args[3].split('/git/refs/heads/')[1], field('sha'));
    else if (args[0] === 'pr' && args[1] === 'create') console.log('https://github.com/pulls/' + args[args.indexOf('--head') + 1]);
  `
  );
  w.write("routes.js", "a\nb\nc\nd\ne\nf\ng\n");
  git("add", "routes.js");
  git("commit", "-qm", "feat: routes");
  git("tag", "v1.4.1");
  git("push", "-q", "origin", "master", "v1.4.1");
  // The clean fix's context is unchanged since v1.4.1. The other's context holds an unreleased change
  // two lines away: git fits it onto the released code, but its patch is no longer the reviewed one.
  const clean = commit("limits.js", "const max = 5;\n", "fix: lower the request limit");
  commit("routes.js", "a\nb\nC\nd\ne\nf\ng\n", "feat: unreleased route");
  const fitted = commit("routes.js", "a\nb\nC\nd\nE\nf\ng\n", "fix: route e");
  git("push", "-q", "origin", "master");

  succeeds(backports(`${clean} ${fitted}`, { GH_TOKEN: "agent", BACKPORT_TOKEN: "dependencies" }));
  const tokens = w.read("tokens").trim().split("\n").map(JSON.parse);
  const by = (sha) => tokens.filter((call) => call.join(" ").includes(`backport/v1.4-${sha.slice(0, 12)}`));
  const cleanURL = `https://github.com/pulls/backport/v1.4-${clean.slice(0, 12)}`;
  assert.deepEqual(
    by(clean).map(([token, ...args]) => [token, args[0], args[1]]),
    [
      ["dependencies", "api", "-X"],
      ["dependencies", "pr", "create"],
      ["agent", "pr", "review"],
      ["agent", "pr", "merge"],
    ]
  );
  assert.deepEqual(by(clean).at(-1).slice(1), ["pr", "merge", cleanURL, "--auto", "--squash"]);
  assert.deepEqual(
    by(fitted).map(([token, ...args]) => [token, args[0], args[1]]),
    [
      ["agent", "api", "-X"],
      ["agent", "pr", "create"],
    ]
  );
  // Without the Dependencies App's credentials, every backport waits for a person, as before.
  w.write("tokens", "");
  git(
    "push",
    "-q",
    "origin",
    `:refs/heads/backport/v1.4-${clean.slice(0, 12)}`,
    `:refs/heads/backport/v1.4-${fitted.slice(0, 12)}`
  );
  succeeds(backports(clean, { GH_TOKEN: "agent" }));
  assert.equal(w.read("tokens").includes('"review"'), false);
});

test("a fix written against unreleased work opens nothing and hands over the release line's form", (t) => {
  const { w, git, commit, backports, remote, pulls } = repository(t);
  // The default branch renames user to currentUser after v1.4.0, then fixes the renamed line. That
  // fix cannot apply to the released code without the rename, so it conflicts instead of carrying it.
  commit("auth.js", "if (currentUser.id === owner) allow();\n", "refactor: rename user to currentUser");
  const clean = commit("limits.js", "const max = 5;\n", "fix: lower the request limit");
  const fix = commit("auth.js", "if (currentUser.id === owner && !banned) allow();\n", "fix: refuse banned owners");
  git("push", "-q", "origin", "master");

  const result = backports(`${clean} ${fix}`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not apply to release\/v1\.4; conflicting paths: auth\.js/);
  const instructions = w.read("output").match(/^instructions<<(EOF_\w+)\n([^]*)\n\1$/m)?.[2] ?? "";
  assert.match(instructions, new RegExp(`git cherry-pick -S -x ${fix}`));
  assert.match(instructions, /--title fix:\\ refuse\\ banned\\ owners\\ \\\[v1\.4\\\]$/m);
  assert.equal(remote(`refs/heads/backport/v1.4-${fix.slice(0, 12)}`), "");
  assert.equal(remote("refs/heads/release/v1.4"), git("rev-parse", "v1.4.0"));
  assert.deepEqual(
    pulls().map((args) => args[7]),
    ["fix: lower the request limit [v1.4]"]
  );
});

test("a backport refuses refs that are not default-branch commits before creating anything", (t) => {
  const { git, commit, backports, remote, pulls } = repository(t);
  const fix = commit("limits.js", "const max = 5;\n", "fix: lower the request limit");
  git("push", "-q", "origin", "master");
  git("switch", "-q", "-c", "side");
  const side = commit("auth.js", "allow();\n", "fix: unreviewed");
  git("switch", "-q", "master");
  for (const [refs, message] of [
    [`${fix} ${side}`, /is not on master/],
    ["--help", /must not begin with '-'/],
    ["0000000", /is not a commit/],
  ]) {
    const result = backports(refs);
    assert.notEqual(result.status, 0, refs);
    assert.match(result.stderr, message, refs);
  }
  assert.equal(remote("refs/heads/release/v1.4"), "");
  assert.deepEqual(pulls(), []);
});

test("the dispatch names a normal release only when the fixes are all the default branch holds unreleased", (t) => {
  const { git, commit, sh } = repository(t);
  const fix = commit("auth.js", "if (user.id === owner && owner) allow();\n", "fix: owner check");
  git("push", "-q", "origin", "master");
  // The line's baseline is the latest release, and the default branch holds only the fix.
  assert.match(succeeds(sh(`fast_path v1.4.0 ${fix}`)), /a normal patch release ships them/);
  // No fix to ship, a newer release than the line, or other unreleased work: the backport is the path.
  assert.equal(succeeds(sh("fast_path v1.4.0")), "");
  git("tag", "v1.5.0");
  assert.equal(succeeds(sh(`fast_path v1.4.0 ${fix}`)), "");
  git("tag", "-d", "v1.5.0");
  commit("limits.js", "const max = 20;\n", "feat: higher limit");
  git("push", "-q", "origin", "master");
  assert.equal(succeeds(sh(`fast_path v1.4.0 ${fix}`)), "");
});

test("a release line is pending until its head carries one of its own tags", (t) => {
  const { w, git, sh } = repository(t);
  succeeds(sh("ensure_release_line 1.4 v1.4.0"));
  assert.equal(succeeds(sh("line_pending release/v1.4")), "false");
  git("switch", "-q", "-c", "line", "v1.4.0");
  w.write("limits.js", "const max = 5;\n");
  git("commit", "-qam", "fix: lower the request limit");
  git("tag", "v1.5.0");
  git("push", "-q", "origin", "line:release/v1.4", "v1.5.0");
  assert.equal(succeeds(sh("line_pending release/v1.4")), "true");
  git("tag", "v1.4.1");
  git("push", "-q", "origin", "v1.4.1");
  assert.equal(succeeds(sh("line_pending release/v1.4")), "false");
  for (const branch of ["release/1.4", "release/v1.4; touch injected", "master"]) {
    assert.notEqual(sh(`line_pending '${branch}'`).status, 0, branch);
    assert.equal(existsSync(join(w.cwd, "injected")), false);
  }
});
