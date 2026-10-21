import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { addedVersions, lockfilePackages, missingProof } from "../generic-actions/verify-release-proof/verify.mjs";
import { manifest, root, succeeds, workspace } from "./helpers.mjs";

const digest = (char) => `sha256:${char.repeat(64)}`;
const integrity = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const tarball = (name, version) => `https://npm.pkg.github.com/download/${name}/${version}/${"f".repeat(40)}`;

/** A pnpm lockfile resolving the given packages, each with its snapshot entry. */
function lock(entries) {
  const packages = entries.map(
    ([key, resolution]) => `  '${key}':\n    resolution: {${resolution}}\n    engines: {node: '>=24.0.0'}\n`
  );
  const snapshots = entries.map(([key]) => `  '${key}':\n    dependencies:\n      svelte: 5.55.8\n`);
  return ["lockfileVersion: '9.0'", "", "packages:", "", ...packages, "snapshots:", "", ...snapshots].join("\n");
}
const firstParty = (name, version, bytes = "tarball") => [
  `${name}@${version}`,
  `integrity: ${integrity(bytes)}, tarball: ${tarball(name, version)}`,
];

/** A modified file whose patch adds the given lines and removes the others. */
const patch = (filename, added, removed = []) => ({
  filename,
  status: "modified",
  patch: ["@@ -1,1 +1,1 @@", ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join("\n"),
});

test("lockfilePackages reads the first-party packages of the packages section only", () => {
  const text = lock([
    firstParty("@a-novel/service-authentication-rest", "2.14.0"),
    firstParty("@a-novel-kit/uikit", "0.11.0"),
    ["@a-novel-kit/nodelib-config@2.1.0", `integrity: ${integrity("x")}`],
    ["@a-novel/evil@1.0.0", `integrity: ${integrity("x")}, tarball: https://evil.example/evil.tgz`],
    [
      "@a-novelist/lookalike@1.0.0",
      `integrity: ${integrity("x")}, tarball: ${tarball("@a-novelist/lookalike", "1.0.0")}`,
    ],
    ["svelte@5.55.8", `integrity: ${integrity("x")}`],
  ]);
  const packages = lockfilePackages(text);
  assert.deepEqual(
    [...packages.keys()],
    [
      "@a-novel/service-authentication-rest@2.14.0",
      "@a-novel-kit/uikit@0.11.0",
      "@a-novel-kit/nodelib-config@2.1.0",
      "@a-novel/evil@1.0.0",
    ]
  );
  const uikit = packages.get("@a-novel-kit/uikit@0.11.0");
  assert.deepEqual(
    [uikit.org, uikit.tag, uikit.integrity, uikit.tarball],
    ["a-novel-kit", "v0.11.0", integrity("tarball"), tarball("@a-novel-kit/uikit", "0.11.0")]
  );
  // Without a GitHub Packages tarball there is nothing the job's token may download.
  assert.equal(packages.get("@a-novel-kit/nodelib-config@2.1.0").tarball, undefined);
  assert.equal(packages.get("@a-novel/evil@1.0.0").tarball, undefined);
});

test("addedVersions collects the versions a diff adds and refuses what it cannot read", () => {
  const image = "ghcr.io/a-novel/service-json-keys/database";
  const compose = patch(
    "builds/compose.e2e.yaml",
    [
      `    image: ${image}:v2.11.0@${digest("b")}`,
      "    image: ghcr.io/a-novel/service-authentication/rest:v2.14.0",
      "    image: ghcr.io/a-novel/infra/host-credentials:sha-0123@" + digest("c"),
      "    image: docker.io/library/postgres:18.1",
    ],
    [`    image: ${image}:v2.10.4@${digest("a")}`]
  );
  // Only the entry the commit adds counts; uikit-tokens keeps its version.
  const base = lock([firstParty("@a-novel-kit/uikit", "0.10.0"), firstParty("@a-novel-kit/uikit-tokens", "0.10.0")]);
  const head = lock([firstParty("@a-novel-kit/uikit", "0.11.0"), firstParty("@a-novel-kit/uikit-tokens", "0.10.0")]);
  const lockfiles = new Map([["pnpm-lock.yaml", { base, head }]]);
  const files = [
    compose,
    { filename: "pnpm-lock.yaml", status: "modified" },
    { filename: "go.sum", status: "modified" },
    { filename: "removed.yaml", status: "removed" },
  ];
  const { versions, problems } = addedVersions(files, lockfiles);
  assert.deepEqual(
    versions.map(({ kind, label, producer, tag, digest: pinned }) => ({ kind, label, producer, tag, pinned })),
    [
      {
        kind: "image",
        label: `${image}:v2.11.0@${digest("b")}`,
        producer: "a-novel/service-json-keys",
        tag: "v2.11.0",
        pinned: `@${digest("b")}`,
      },
      {
        kind: "image",
        label: "ghcr.io/a-novel/service-authentication/rest:v2.14.0",
        producer: "a-novel/service-authentication",
        tag: "v2.14.0",
        pinned: undefined,
      },
      { kind: "npm", label: "@a-novel-kit/uikit@0.11.0", producer: undefined, tag: "v0.11.0", pinned: undefined },
    ]
  );
  assert.deepEqual(problems, []);

  // A diff GitHub does not show could add a version nobody checks.
  assert.deepEqual(addedVersions([{ filename: "builds/compose.yaml", status: "modified" }], new Map()).problems, [
    "builds/compose.yaml has no diff to read",
  ]);
  const many = Array.from({ length: 300 }, (_, i) => patch(`f${i}`, []));
  assert.deepEqual(addedVersions(many, new Map()).problems, ["its comparison may stop at 300 files"]);
});

/** Reads that prove every version, unless a case overrides one. */
function reads(overrides = {}) {
  const calls = [];
  const io = {
    download: async () => Buffer.from("tarball"),
    save: () => "/tmp/package.tgz",
    manifest: () => ({ repository: { url: "git+https://github.com/a-novel-kit/uikit.git" } }),
    attest: (...args) => calls.push(args),
    release: () => ({ author: "anovelkitbot-release[bot]", immutable: true }),
    ...overrides,
  };
  return { io, calls };
}

test("missingProof accepts only a release's attested bytes", async () => {
  const [, npm] = [...lockfilePackages(lock([firstParty("@a-novel-kit/uikit", "0.11.0")]))][0];
  const image = {
    kind: "image",
    label: "image",
    org: "a-novel",
    producer: "a-novel/service-json-keys",
    name: "ghcr.io/a-novel/service-json-keys/database",
    tag: "v2.11.0",
    digest: `@${digest("b")}`,
  };
  const released = { author: "anovelbot-release[bot]", immutable: true };
  const fail = () => {
    throw new Error("no attestation");
  };
  const cases = [
    ["a released package", npm, {}, ""],
    ["a released image", image, { release: () => released }, ""],
    [
      "bytes other than the lockfile's",
      npm,
      { download: async () => Buffer.from("other") },
      "the registry serves other bytes than the lockfile's integrity",
    ],
    ["a tarball that cannot be read", npm, { manifest: fail }, "its tarball cannot be downloaded and read"],
    [
      "a package naming another org's repository",
      npm,
      { manifest: () => ({ repository: { url: "git+https://github.com/someone/uikit.git" } }) },
      "its package names no repository of its own org",
    ],
    // A branch can publish a version and attest it, but its attestation names the branch.
    [
      "a version a branch published",
      npm,
      { attest: fail },
      "no attestation from a-novel-kit/uikit's release workflow at v0.11.0 covers it",
    ],
    [
      "a Release a person published",
      npm,
      { release: () => ({ author: "kushuh", immutable: true }) },
      "a-novel-kit/uikit v0.11.0 is not an immutable Release by anovelkitbot-release[bot]",
    ],
    [
      "a mutable Release",
      npm,
      { release: () => ({ author: "anovelkitbot-release[bot]", immutable: false }) },
      "a-novel-kit/uikit v0.11.0 is not an immutable Release by anovelkitbot-release[bot]",
    ],
    [
      "a missing Release",
      npm,
      { release: () => undefined },
      "a-novel-kit/uikit v0.11.0 is not an immutable Release by anovelkitbot-release[bot]",
    ],
    ["an image pinned by tag alone", { ...image, digest: undefined }, {}, "it is pinned without a digest"],
    [
      "an entry without a tarball",
      { ...npm, tarball: undefined },
      {},
      "its lockfile entry names no GitHub Packages tarball",
    ],
  ];
  for (const [name, version, overrides, expected] of cases) {
    assert.equal(await missingProof(version, reads(overrides).io), expected, name);
  }
  // The attestation is checked on the downloaded file and the pinned digest, at the version's tag.
  const npmReads = reads();
  await missingProof(npm, npmReads.io);
  assert.deepEqual(npmReads.calls, [["/tmp/package.tgz", "a-novel-kit/uikit", "v0.11.0"]]);
  const imageReads = reads({ release: () => released });
  await missingProof(image, imageReads.io);
  assert.deepEqual(imageReads.calls, [
    [`oci://ghcr.io/a-novel/service-json-keys/database@${digest("b")}`, "a-novel/service-json-keys", "v2.11.0"],
  ]);
});

test("verify-release-proof withholds an image no release attested and passes a diff without one", (t) => {
  const cases = [
    [
      [patch("builds/compose.yaml", [`image: ghcr.io/a-novel/service-json-keys/database:v2.11.0@${digest("b")}`])],
      "false",
    ],
    [[patch("go.mod", ["\tgithub.com/a-novel-kit/golib v0.21.0"])], "true"],
  ];
  for (const [files, verified] of cases) {
    const w = workspace(t);
    w.write("output", "");
    w.write("summary", "");
    w.stub(
      "gh",
      `const args = process.argv.slice(2);
      require("fs").appendFileSync(process.env.GH_LOG, JSON.stringify(args) + "\\n");
      if (args.includes(".base.ref")) console.log("master");
      else if (args[1]?.includes("/compare/")) console.log(JSON.stringify({ files: ${JSON.stringify(files)}, mergeBase: "${"a".repeat(40)}" }));
      else if (args[0] === "attestation") process.exit(1);`
    );
    const env = {
      REPOSITORY: "a-novel/platform-studio",
      PULL_REQUEST: "https://github.com/a-novel/platform-studio/pull/7",
      HEAD_SHA: "e".repeat(40),
      GH_TOKEN: "token",
      GH_LOG: `${w.cwd}/gh.log`,
    };
    const out = succeeds(w.run("node", [`${root}generic-actions/verify-release-proof/verify.mjs`], env));
    assert.match(w.read("output"), new RegExp(`^verified=${verified}$`, "m"));
    if (verified === "false") {
      assert.match(out, /::notice::Not auto-approving: .*no attestation from a-novel\/service-json-keys/);
      assert.match(
        w.read("summary"),
        /\| ghcr\.io\/a-novel\/service-json-keys\/database:v2\.11\.0@sha256:b+ \| no attestation/
      );
      const verify = w
        .read("gh.log")
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
        .find((args) => args[0] === "attestation");
      assert.deepEqual(verify.slice(3), [
        "--repo",
        "a-novel/service-json-keys",
        "--signer-workflow",
        "a-novel/service-json-keys/.github/workflows/release.yaml",
        "--source-ref",
        "refs/tags/v2.11.0",
        "--deny-self-hosted-runners",
      ]);
    } else assert.match(out, /adds no first-party version/);
    // The checked diff is the given commit's, so the approval names the commit that was read.
    assert.match(w.read("gh.log"), new RegExp(`compare/master\\.\\.\\.${"e".repeat(40)}`));
  }
});

test("the approver approves and queues only the checked commit, after its release proofs", () => {
  const engine = manifest(".github/workflows/auto-approve-dependabot-run.yaml");
  const job = engine.jobs["auto-approve"];
  for (const permission of ["statuses", "contents", "attestations", "packages"])
    assert.equal(job.permissions[permission], "read", permission);
  const steps = Object.fromEntries(job.steps.map((s) => [s.name, s]));
  assert.match(steps["Verify first-party release proofs"].uses, /generic-actions\/verify-release-proof@/);
  for (const name of ["Approve", "Enable auto-merge"])
    assert.match(steps[name].if, /steps\.proof\.outputs\.verified == 'true'/, name);
  assert.equal(steps.Approve.with.head_sha, "${{ steps.pr.outputs.sha }}");
  assert.match(steps["Enable auto-merge"].run, /--match-head-commit "\$SHA"/);
});
