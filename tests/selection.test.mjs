import assert from "node:assert/strict";
import { test } from "node:test";
import { command, manifest, read, step, succeeds, workspace } from "./helpers.mjs";

function filter(source, variable) {
  const match = source.match(new RegExp(`${variable}=\\$\\([^\n]*?jq -[cr] '([^]*?)'\\)`, "m"));
  assert(match, `Missing jq selector ${variable}`);
  return (data) => succeeds(command("jq", ["-c", match[1]], { input: JSON.stringify(data) }));
}

test("status and reconcile selectors include every closing issue and label-only Epic member", () => {
  const derive = step("generic-actions/derive-status/action.yaml", "Compute Status + resolve the Task");
  const ids = filter(derive, "issue_ids");
  assert.equal(
    ids([
      { number: 11, id: "I11" },
      { number: 10, id: "I10" },
    ]),
    '"I10"\n"I11"'
  );
  assert.equal(ids([]), "");
  const nodes = [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ].map(([label, closes], i) => ({
    number: i + 1,
    headRefOid: `sha${i}`,
    repository: { name: "repo" },
    labels: { nodes: label ? [{ name: "epic:417" }] : [] },
    closingIssuesReferences: { nodes: closes ? [{ parent: { number: 417 } }] : [] },
  }));
  const workflow = read(".github/workflows/reconcile-board.yaml");
  assert.deepEqual(
    JSON.parse(filter(workflow, "tasks")(nodes)).map((pr) => pr.number),
    [1, 3]
  );
  assert.deepEqual(
    JSON.parse(filter(workflow, "epic_prs")(nodes)).map((pr) => pr.number),
    [1, 2]
  );
});

test("Go package discovery propagates failed reads and rejects an empty filtered set", (t) => {
  const path = "go-actions/test-go/action.yaml",
    action = manifest(path);
  const script = step(path, "discover").replace(/\$\{\{ inputs\.(\w+) \}\}/g, (_, key) => action.inputs[key].default);
  assert(!script.includes("${{"));
  const w = workspace(t);
  w.stub(
    "go",
    `
    const key = process.argv[3] === '.' ? 'root' : process.argv[3] === '-m' ? 'modules' : 'packages';
    const f = JSON.parse(process.env.GO_FIXTURE);
    if (f.fail === key) process.exit(1);
    console.log(f[key]);
  `
  );
  const fixture = { root: "example.org/repo", modules: "example.org/repo", packages: "example.org/repo/internal/dao" };
  for (const changes of [
    { fail: "root" },
    { fail: "modules" },
    { fail: "packages" },
    { packages: "" },
    { packages: "example.org/repo/mocks\nexample.org/repo/test\nexample.org/repo/proto" },
  ]) {
    assert.notEqual(
      w.bash(script, { PACKAGES: "packages.txt", GO_FIXTURE: JSON.stringify({ ...fixture, ...changes }) }).status,
      0
    );
  }
  const packages =
    "example.org/repo\nexample.org/repo/internal/dao\nexample.org/repo/mocks\nexample.org/repo/test\nexample.org/repo/proto";
  succeeds(w.bash(script, { PACKAGES: "packages.txt", GO_FIXTURE: JSON.stringify({ ...fixture, packages }) }));
  assert.equal(w.read("packages.txt"), "example.org/repo\nexample.org/repo/internal/dao\n");
});

test("Dockerfile discovery accepts fleet naming conventions without claiming source files", () => {
  const source = read("generic-actions/lint-dockerfile/action.yaml");
  const pattern = source.match(/\| grep -E '(.*)'\)/)[1];
  for (const [name, expected] of [
    ["builds/database.Dockerfile", true],
    ["builds/standalone.grpc.Dockerfile", true],
    ["Dockerfile", true],
    ["builds/Dockerfile", true],
    ["builds/Dockerfile.dev", true],
    ["builds/dockerfile", true],
    ["builds/database.dockerfile", true],
    ["cli/discovery/dockerfile.go", false],
    ["src/dockerfile.ts", false],
    ["dockerfile/notes.txt", false],
    [".agents/skills/write-dockerfiles/SKILL.md", false],
  ])
    assert.equal(command("grep", ["-Eq", pattern], { input: `${name}\n` }).status === 0, expected, name);
});

test("Docker provenance uses the published digest and security tools require caller-owned pins", () => {
  const steps = manifest("build-actions/docker/action.yaml").runs.steps;
  const index = steps.findIndex((s) => s.uses?.startsWith("actions/attest@"));
  assert(index > steps.findIndex((s) => s.id === "build"));
  assert.equal(steps[index].with["subject-digest"], "${{ steps.build.outputs.digest }}");
  assert.equal(steps[index].with["push-to-registry"], "${{ steps.meta.outputs.tags != '' }}");
  // docker-job publishes through docker, so it inherits the same attestation.
  const job = manifest("build-actions/docker-job/action.yaml");
  assert.deepEqual(
    job.runs.steps.map((s) => [s.uses?.replace(/@.*/, ""), s.with?.mode]),
    [["a-novel-kit/workflows/build-actions/docker", "job"]]
  );
  assert.equal(job.outputs.digest.value, "${{ steps.build.outputs.digest }}");
  for (const action of [
    "generic-actions/lint-shell",
    "generic-actions/lint-dockerfile",
    "security-actions/scan-secrets",
    "security-actions/lint-semgrep",
    "security-actions/lint-workflows",
    "publish-actions/release-core",
    "publish-actions/release-core-hotfix",
  ]) {
    const input = manifest(`${action}/action.yaml`).inputs[action.startsWith("publish-") ? "cli_version" : "version"];
    assert.equal(input.required, true, action);
    assert.equal(input.default, undefined, action);
  }
});

test("docker tags a branch build only on the default branch or a with-feature-env pull request", () => {
  const steps = manifest("build-actions/docker/action.yaml").runs.steps;
  const rules = steps.find((s) => s.id === "meta").with.tags.split("\n");
  // The label approves the head it was added on, and a push's payload still carries it.
  assert(
    rules.includes(
      "type=ref,event=pr,enable=${{ github.event.action != 'synchronize' && contains(github.event.pull_request.labels.*.name, 'with-feature-env') }}"
    )
  );
  assert(
    rules.includes(
      "type=ref,event=branch,enable=${{ github.event_name == 'push' && github.ref_name == github.event.repository.default_branch }}"
    )
  );
  // Without a tag, the push needs the bare image name to push by digest.
  const push = steps.find((s) => s.id === "build");
  assert.equal(push.with.tags, "${{ steps.meta.outputs.tags || format('ghcr.io/{0}', inputs.image_name) }}");
});

test("a reproducible docker build is content-addressed and drops build-time metadata", (t) => {
  const steps = manifest("build-actions/docker/action.yaml").runs.steps;
  const push = steps.find((s) => s.id === "build");
  assert.equal(
    push.with.outputs,
    "type=image,push=true,push-by-digest=${{ steps.meta.outputs.tags == '' }}${{ inputs.reproducible == 'true' && ',rewrite-timestamp=true' || '' }}"
  );
  assert.equal(push.with.provenance, "${{ inputs.reproducible == 'true' && 'false' || '' }}");
  assert.equal(push.with.labels, "${{ steps.labels.outputs.labels }}");
  // A fixed epoch: a commit date would move the digest with every build-file change.
  const epoch = steps.find((s) => s.run?.includes("SOURCE_DATE_EPOCH"));
  assert.equal(epoch.if, "${{ inputs.reproducible == 'true' }}");
  assert.equal(epoch.run.trim(), 'echo "SOURCE_DATE_EPOCH=0" >>"$GITHUB_ENV"');
  assert(steps.indexOf(epoch) < steps.indexOf(push));

  const w = workspace(t);
  const labels = step("build-actions/docker/action.yaml", "labels");
  const all = [
    "org.opencontainers.image.created=2026-10-08T00:00:00Z",
    "org.opencontainers.image.source=https://github.com/a-novel/service",
    "org.opencontainers.image.version=v1.2.3",
    "org.opencontainers.image.revision=0123abc",
  ].join("\n");
  for (const [reproducible, kept] of [
    ["true", "org.opencontainers.image.source=https://github.com/a-novel/service"],
    ["false", all],
  ]) {
    w.write("output", "");
    succeeds(w.bash(labels, { LABELS: all, REPRODUCIBLE: reproducible }));
    assert.equal(w.read("output"), `labels<<LABELS_END\n${kept}\nLABELS_END\n`);
  }
});

test("self-approval stays in the checked repository", () => {
  const action = manifest("generic-actions/approve-pr/action.yaml");
  const token = action.runs.steps.find((s) => s.id === "token");
  assert.equal(token.with.repositories, "${{ github.event.repository.name }}");
  assert.equal(token.with["permission-pull-requests"], "write");
  const approve = manifest("generic-actions/approve-bot/action.yaml").runs.steps[0];
  assert.equal(approve.env.GH_TOKEN, "${{ inputs.github_token }}");
  // A bare PR number resolves only through GH_REPO: the job has no checkout.
  assert.equal(approve.env.GH_REPO, "${{ github.repository }}");
});
