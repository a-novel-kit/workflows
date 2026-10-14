// What a package cleanup keeps: the composed exclusion pattern, the default-branch classifier, and the CLI.
import assert from "node:assert/strict";
import { test } from "node:test";
import { keepPattern, protectedDigests, versionLabel } from "../build-actions/clean-images/keep.mjs";
import { manifest, root, succeeds, workspace } from "./helpers.mjs";

const cleanup = manifest("build-actions/clean-images/action.yaml").runs.steps.find((s) =>
  s.uses?.startsWith("dataaxiom/ghcr-cleanup-action@")
);
const digest = (c) => `sha256:${c.repeat(64)}`;

/** The exclusion regex the cleanup receives once the keep step's output is substituted. */
const exclusion = (pattern) =>
  new RegExp(cleanup.with["exclude-tags"].replace("${{ steps.keep.outputs.pattern }}", pattern));

test("the cleanup keeps releases, the default branch, open pull requests and protected builds", () => {
  const keep = exclusion(keepPattern("master", [12], [digest("a")]));
  for (const kept of ["v1.2.3", "v1", "latest", "nightly", "master", "pr-12", digest("a")])
    assert(keep.test(kept), kept);
  for (const dropped of ["pr-1", "pr-120", "gh-readonly-queue-master-pr-12-abc", "feat-x", "renovate-go", digest("b")])
    assert(!keep.test(dropped), dropped);
  // An empty computed part matches everything, so a broken keep step deletes nothing.
  assert(exclusion("").test("feat-x") && exclusion("").test(digest("b")));
  assert.equal(new RegExp(keepPattern("re.lease", [], [])).test("reXlease"), false);
});

test("every tag but an attestation referrer is a deletion candidate, once old enough", () => {
  const candidates = new RegExp(cleanup.with["delete-tags"]);
  for (const tag of ["pr-1", "gh-readonly-queue-master-pr-1-abc", "feat-x"]) assert(candidates.test(tag), tag);
  assert(!candidates.test(`sha256-${"a".repeat(64)}`));
  assert.equal(cleanup.with["older-than"], "${{ inputs.retention_days }} days");
  assert.equal(cleanup.with["delete-untagged"], true);
  assert.equal(cleanup.with["delete-orphaned-images"], true);
});

test("untagged builds of the default branch, or with unreadable labels, are kept", async () => {
  const old = "2026-01-01T00:00:00Z";
  const versions = [
    { name: digest("a"), updated_at: old, metadata: { container: { tags: [] } } },
    { name: digest("b"), updated_at: old, metadata: { container: { tags: [] } } },
    { name: digest("c"), updated_at: old, metadata: { container: { tags: [] } } },
    { name: digest("d"), updated_at: old, metadata: { container: { tags: ["pr-3"] } } },
    { name: digest("e"), updated_at: "2026-06-01T00:00:00Z", metadata: { container: { tags: [] } } },
    { name: digest("f"), updated_at: old, metadata: { container: { tags: [] } } },
  ];
  const labels = { [digest("a")]: "master", [digest("b")]: "pr-7", [digest("c")]: null, [digest("f")]: "" };
  const read = [];
  const cache = { [digest("f")]: "master" };
  const kept = await protectedDigests(
    versions,
    new Date("2026-05-01T00:00:00Z"),
    "master",
    async (d) => {
      read.push(d);
      return labels[d];
    },
    cache
  );
  assert.deepEqual(kept, [digest("a"), digest("c"), digest("f")]);
  // Tagged and recent versions are never read, a cached label is reused, and an unreadable one is retried.
  assert.deepEqual(read.sort(), [digest("a"), digest("b"), digest("c")]);
  assert.deepEqual(cache, { [digest("a")]: "master", [digest("b")]: "pr-7", [digest("f")]: "master" });
});

test("an image's version label comes from its first platform image", async () => {
  const config = { mediaType: "application/vnd.oci.image.config.v1+json", digest: "config" };
  const documents = {
    "manifests/index": {
      manifests: [
        { digest: "attestation", platform: { os: "unknown" } },
        { digest: "image", platform: { os: "linux" } },
      ],
    },
    "manifests/image": { config },
    "manifests/attestation": { config: { mediaType: "application/vnd.in-toto+json", digest: "statement" } },
    "blobs/config": { config: { Labels: { "org.opencontainers.image.version": "master" } } },
  };
  const client = {
    registry: async (path) => {
      if (!documents[path]) throw new Error(`${path} answered HTTP 404`);
      return documents[path];
    },
  };
  assert.equal(await versionLabel(client, "index"), "master");
  assert.equal(await versionLabel(client, "image"), "master");
  assert.equal(await versionLabel(client, "attestation"), "");
  assert.equal(await versionLabel(client, "missing"), null);
});

test("the keep step pages every version and prunes the cache to them", (t) => {
  const w = workspace(t);
  const versions = Array.from({ length: 101 }, (_, i) => ({
    name: `sha256:${String(i).padStart(64, "0")}`,
    updated_at: "2026-01-01T00:00:00Z",
    metadata: { container: { tags: i === 0 ? ["master"] : [] } },
  }));
  const master = versions[1].name;
  w.write("cache.json", JSON.stringify({ [master]: "master", "sha256:gone": "master" }));
  const stub = w.write(
    "fetch.mjs",
    `
    const versions = ${JSON.stringify(versions)};
    globalThis.fetch = async (url) => {
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      const body = url.includes("/token?") ? { token: "bearer" }
        : url.includes("/versions") ? versions.slice((page - 1) * 100, page * 100)
        : url.includes("/pulls") ? (page === 1 ? [{ number: 5 }] : [])
        : url.endsWith("/repos/a-novel/service") ? { default_branch: "master" }
        : url.includes("/manifests/") ? { config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: "c" } }
        : { config: { Labels: { "org.opencontainers.image.version": "pr-5" } } };
      return new Response(JSON.stringify(body));
    };
  `
  );
  succeeds(
    w.run(process.execPath, ["--import", stub, `${root}build-actions/clean-images/keep.mjs`], {
      GH_TOKEN: "token",
      GITHUB_REPOSITORY: "a-novel/service",
      PACKAGE: "service/rest",
      RETENTION_DAYS: "7",
      CACHE_FILE: `${w.cwd}/cache.json`,
    })
  );
  assert.equal(w.read("output"), `pattern=^(master|pr-5)$|^sha256:(${master.slice(7, 23)})\n`);
  const cache = JSON.parse(w.read("cache.json"));
  assert.equal(Object.keys(cache).length, 100);
  assert.equal(cache[master], "master");
  assert.equal(cache["sha256:gone"], undefined);
  assert.match(w.read("summary"), /101 versions; keeps 1 untagged master/);
});
