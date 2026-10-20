// What image cleanups keep: the composed exclusion pattern, build origins, and both CLI modes.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  keepPattern,
  latestMinor,
  origin,
  protectedDigests,
  provenanceOrigin,
} from "../build-actions/clean-images/keep.mjs";
import { manifest, root, succeeds, workspace } from "./helpers.mjs";

const cleanup = manifest("build-actions/clean-images/action.yaml").runs.steps.find((s) =>
  s.uses?.startsWith("dataaxiom/ghcr-cleanup-action@")
);
const digest = (c) => `sha256:${c.repeat(64)}`;
const provenance = (ref) => [
  {
    bundle: {
      dsseEnvelope: {
        payload: Buffer.from(
          JSON.stringify({ predicate: { buildDefinition: { externalParameters: { workflow: { ref } } } } })
        ).toString("base64"),
      },
    },
  },
];

/** The exclusion regex the cleanup receives once the keep step's output is substituted. */
const exclusion = (pattern) =>
  new RegExp(cleanup.with["exclude-tags"].replace("${{ steps.keep.outputs.pattern }}", pattern));

test("the sweep keeps releases, the default branch, open pull requests and protected builds", () => {
  const keep = exclusion(keepPattern(["master", "pr-12"], [digest("a")]));
  for (const kept of ["v1.2.3", "v1", "latest", "nightly", "master", "pr-12", digest("a")])
    assert(keep.test(kept), kept);
  for (const dropped of ["pr-1", "pr-120", "gh-readonly-queue-master-pr-12-abc", "feat-x", "renovate-go", digest("b")])
    assert(!keep.test(dropped), dropped);
  // An empty computed part matches everything, so a broken keep step deletes nothing.
  assert(exclusion("").test("feat-x") && exclusion("").test(digest("b")));
  assert.equal(new RegExp(keepPattern(["re.lease"], [])).test("reXlease"), false);
});

test("every tag but an attestation referrer is a deletion candidate past the minimum age", () => {
  const candidates = new RegExp(cleanup.with["delete-tags"]);
  for (const tag of ["pr-1", "gh-readonly-queue-master-pr-1-abc", "feat-x"]) assert(candidates.test(tag), tag);
  assert(!candidates.test(`sha256-${"a".repeat(64)}`));
  assert.equal(cleanup.with["older-than"], "${{ inputs.min_age_days }} days");
  assert.equal(manifest("build-actions/clean-images/action.yaml").inputs.min_age_days.default, "1");
  assert.equal(cleanup.with["delete-untagged"], true);
  assert.equal(cleanup.with["delete-orphaned-images"], true);
});

test("a provenance attestation names the pull request or branch that built the image", () => {
  assert.equal(provenanceOrigin(provenance("refs/pull/12/merge")), "pr-12");
  assert.equal(provenanceOrigin(provenance("refs/heads/master")), "master");
  assert.equal(
    provenanceOrigin(provenance("refs/heads/gh-readonly-queue/master/pr-3-abc")),
    "gh-readonly-queue/master/pr-3-abc"
  );
  assert.equal(provenanceOrigin(null), "");
  assert.equal(provenanceOrigin([]), "");
  assert.throws(() => provenanceOrigin([{ bundle_url: "https://example" }]), /no inline bundle/);
});

test("an image's origin is its version label, else its index's provenance", async () => {
  const config = (label) => ({ mediaType: "application/vnd.oci.image.config.v1+json", digest: `config-${label}` });
  const documents = {
    "manifests/labeled": {
      manifests: [
        { digest: "attestation", platform: { os: "unknown" } },
        { digest: "master-image", platform: { os: "linux" } },
      ],
    },
    "manifests/untagged": { manifests: [{ digest: "plain-image", platform: { os: "linux" } }] },
    "manifests/master-image": { config: config("master") },
    "manifests/plain-image": { config: config("") },
    "manifests/attestation": { config: { mediaType: "application/vnd.in-toto+json", digest: "statement" } },
    "blobs/config-master": { config: { Labels: { "org.opencontainers.image.version": "master" } } },
    "blobs/config-": { config: { Labels: { "org.opencontainers.image.version": "" } } },
  };
  const attested = [];
  const client = {
    registry: async (path) => {
      if (!documents[path]) throw new Error(`${path} answered HTTP 404`);
      return documents[path];
    },
    attestations: async (d) => (attested.push(d), d === "untagged" ? provenance("refs/pull/7/merge") : null),
  };
  assert.equal(await origin(client, "labeled"), "master");
  assert.equal(await origin(client, "untagged"), "pr-7");
  // A platform image or attestation manifest follows its index, so it is never looked up.
  assert.equal(await origin(client, "plain-image"), "");
  assert.equal(await origin(client, "attestation"), "");
  assert.equal(await origin(client, "missing"), null);
  assert.deepEqual(attested, ["untagged"]);
});

test("old untagged builds of the default branch, open pull requests or unreadable origin are kept", async () => {
  const old = "2026-01-01T00:00:00Z";
  const version = (c, tags = [], updated = old) => ({
    name: digest(c),
    updated_at: updated,
    metadata: { container: { tags } },
  });
  const versions = [
    version("a"),
    version("b"),
    version("c"),
    version("d", ["pr-3"]),
    version("e", [], "2026-06-01T00:00:00Z"),
    version("f"),
    version("g"),
  ];
  const origins = {
    [digest("a")]: "master",
    [digest("b")]: "pr-7",
    [digest("c")]: null,
    [digest("f")]: "",
    [digest("g")]: "pr-8",
  };
  const read = [];
  const cache = { [digest("f")]: "pr-9" };
  const live = (o) => ["master", "pr-8", "pr-9"].includes(o);
  async function lookup(d) {
    read.push(d);
    return origins[d];
  }
  const kept = await protectedDigests(versions, new Date("2026-05-01T00:00:00Z"), live, lookup, cache);
  assert.deepEqual(kept, [digest("a"), digest("c"), digest("f"), digest("g")]);
  // Tagged and recent versions are never read, a cached origin is reused, and an unreadable one is retried.
  assert.deepEqual(read.sort(), [digest("a"), digest("b"), digest("c"), digest("g")]);
  assert.deepEqual(cache, {
    [digest("a")]: "master",
    [digest("b")]: "pr-7",
    [digest("f")]: "pr-9",
    [digest("g")]: "pr-8",
  });
});

test("the last minor release is the newest vX.Y.0 tag", () => {
  const tagged = (...tags) => tags.map((tag) => ({ metadata: { container: { tags: [tag] } } }));
  assert.equal(latestMinor(tagged("v2.9.0", "v2.10.0", "v2.10.1", "v2.10", "v2", "latest", "v3.0.0-rc.1")), "v2.10.0");
  assert.equal(latestMinor(tagged("v1.9.0", "v2.0.0")), "v2.0.0");
  assert.equal(latestMinor(tagged("v0.1.4", "master")), undefined);
});

/** Answers the GitHub and registry calls both CLI modes make, recording each request. */
function stub(w, { versions, tagged = [] }) {
  return w.write(
    "fetch.mjs",
    `
    import { appendFileSync } from "node:fs";
    const versions = ${JSON.stringify(versions)}, tagged = ${JSON.stringify(tagged)};
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
    globalThis.fetch = async (url, { method = "GET" } = {}) => {
      appendFileSync("requests", method + " " + url + "\\n");
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (url.includes("/token?")) return json({ token: "bearer" });
      if (url.includes("/versions")) return json(versions.slice((page - 1) * 100, page * 100));
      if (url.includes("/pulls")) return json(page === 1 ? [{ number: 5 }] : []);
      if (url.endsWith("/repos/a-novel/service")) return json({ default_branch: "master" });
      if (url.includes("/attestations/")) return json({ message: "Not Found" }, 404);
      if (url.includes("/commits/v1.4.0")) return json({ commit: { committer: { date: "2026-03-01T00:00:00Z" } } });
      const tag = url.match(/manifests\\/(pr-[0-9]+)$/)?.[1];
      if (tag) return tagged.includes(tag) ? json({ manifests: [] }) : json({}, 404);
      if (url.includes("/manifests/")) return json({ config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: "c" } });
      return json({ config: { Labels: { "org.opencontainers.image.version": "pr-6" } } });
    };
  `
  );
}

test("the sweep pages every version, keeps open pull requests' builds and prunes the cache", (t) => {
  const w = workspace(t);
  const versions = Array.from({ length: 101 }, (_, i) => ({
    id: i,
    name: `sha256:${String(i).padStart(64, "0")}`,
    updated_at: "2026-01-01T00:00:00Z",
    metadata: { container: { tags: i === 0 ? ["master"] : [] } },
  }));
  const [master, open] = [versions[1].name, versions[2].name];
  w.write("cache.json", JSON.stringify({ [master]: "master", [open]: "pr-5", "sha256:gone": "master" }));
  const fetchStub = stub(w, { versions });
  succeeds(
    w.run(process.execPath, ["--import", fetchStub, `${root}build-actions/clean-images/keep.mjs`], {
      GH_TOKEN: "token",
      GITHUB_REPOSITORY: "a-novel/service",
      PACKAGE: "service/rest",
      MIN_AGE_DAYS: "1",
      CACHE_FILE: `${w.cwd}/cache.json`,
    })
  );
  const prefixes = [master, open]
    .map((d) => d.slice(7, 23))
    .sort()
    .join("|");
  assert.equal(w.read("output"), `pattern=^(master|pr-5)$|^sha256:(${prefixes})\n`);
  const cache = JSON.parse(w.read("cache.json"));
  assert.equal(Object.keys(cache).length, 100);
  assert.equal(cache["sha256:gone"], undefined);
  assert.match(w.read("summary"), /101 versions; keeps 2 untagged builds of master, of 1 open pull requests/);
  // Without a minor release, no release commit is looked up.
  assert(!w.read("requests").includes("/commits/"));
});

test("the sweep drops the default branch's untagged builds from before the last minor release", (t) => {
  const w = workspace(t);
  const version = (c, created, tags = []) => ({
    id: c,
    name: digest(c),
    created_at: created,
    updated_at: created,
    metadata: { container: { tags } },
  });
  const versions = [
    version("0", "2026-03-01T00:10:00Z", ["v1.4.0", "v1.4", "v1", "latest"]),
    version("1", "2026-01-01T00:00:00Z", ["v1.3.0"]),
    version("a", "2026-02-01T00:00:00Z"),
    version("b", "2026-03-01T00:00:00Z"),
    version("c", "2026-04-01T00:00:00Z"),
    version("d", "2026-02-01T00:00:00Z"),
  ];
  w.write(
    "cache.json",
    JSON.stringify({ [digest("a")]: "master", [digest("b")]: "master", [digest("c")]: "master", [digest("d")]: "pr-5" })
  );
  const fetchStub = stub(w, { versions });
  succeeds(
    w.run(process.execPath, ["--import", fetchStub, `${root}build-actions/clean-images/keep.mjs`], {
      GH_TOKEN: "token",
      GITHUB_REPOSITORY: "a-novel/service",
      PACKAGE: "service/rest",
      MIN_AGE_DAYS: "1",
      CACHE_FILE: `${w.cwd}/cache.json`,
    })
  );
  // The build of the release commit's own instant stays; an open pull request's build stays at any age.
  const prefixes = ["b", "c", "d"].map((c) => digest(c).slice(7, 23)).join("|");
  assert.equal(w.read("output"), `pattern=^(master|pr-5)$|^sha256:(${prefixes})\n`);
  assert.match(w.read("requests"), /GET https:\/\/api\.github\.com\/repos\/a-novel\/service\/commits\/v1\.4\.0\n/);
  assert.match(w.read("summary"), /keeps 3 untagged builds of master since v1\.4\.0/);
});

test("closing a pull request deletes only its single-tagged image, unless rehearsed", (t) => {
  const versions = [
    { id: 41, name: digest("a"), updated_at: "2026-01-01T00:00:00Z", metadata: { container: { tags: ["pr-9"] } } },
    {
      id: 42,
      name: digest("b"),
      updated_at: "2026-01-01T00:00:00Z",
      metadata: { container: { tags: ["pr-10", "v1.0.0"] } },
    },
  ];
  const cases = [
    ["9", "false", ["DELETE https://api.github.com/orgs/a-novel/packages/container/service%2Frest/versions/41"]],
    ["9", "true", []],
    ["10", "false", []],
    ["11", "false", []],
  ];
  for (const [pull, dryRun, deleted] of cases) {
    const w = workspace(t);
    const fetchStub = stub(w, { versions, tagged: ["pr-9", "pr-10"] });
    succeeds(
      w.run(process.execPath, ["--import", fetchStub, `${root}build-actions/clean-images/keep.mjs`, "close"], {
        GH_TOKEN: "token",
        GITHUB_REPOSITORY: "a-novel/service",
        PULL_REQUEST: pull,
        PACKAGES: '["service/rest"]',
        DRY_RUN: dryRun,
      })
    );
    const requests = w.read("requests").trim().split("\n");
    assert.deepEqual(
      requests.filter((r) => r.startsWith("DELETE")),
      deleted,
      `pr-${pull} dry=${dryRun}`
    );
    // A package without the tag is never listed.
    assert.equal(
      requests.some((r) => r.includes("/versions")),
      pull !== "11"
    );
  }
});
