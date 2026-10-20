// Decide what a package sweep keeps beyond release tags: the default branch's tag and builds, and the
// tags and builds of open pull requests. A build's version label names its origin; a build pushed
// without a tag has none, so its provenance attestation names the pull request it came from.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MANIFESTS = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(",");
const IMAGE_CONFIGS = ["application/vnd.oci.image.config.v1+json", "application/vnd.docker.container.image.v1+json"];

/** GitHub REST and GHCR registry access for one package, with the caller's token. */
export class Client {
  constructor(token, repository, pkg) {
    this.token = token;
    this.repository = repository;
    this.owner = repository.split("/")[0];
    this.pkg = pkg;
  }

  async fetch(url, { headers, method = "GET", missing = false }) {
    const response = await fetch(url, { method, headers, signal: AbortSignal.timeout(60_000) });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw new Error(`${method} ${url} answered HTTP ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  api(path, options = {}) {
    return this.fetch(`https://api.github.com/${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json" },
    });
  }

  async pages(path, until = () => false) {
    const values = [];
    for (let page = 1; ; page++) {
      const result = await this.api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      values.push(...result);
      if (result.length < 100 || result.some(until)) return values;
    }
  }

  versionsPath() {
    return `orgs/${this.owner}/packages/container/${encodeURIComponent(this.pkg)}/versions`;
  }

  /** The digest's attestations, or null when it has none. */
  async attestations(digest) {
    return (await this.api(`repos/${this.repository}/attestations/${digest}`, { missing: true }))?.attestations ?? null;
  }

  async registry(path, accept, missing = false) {
    this.bearer ??= (
      await this.fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${this.owner}/${this.pkg}:pull`, {
        headers: { Authorization: `Basic ${Buffer.from(`token:${this.token}`).toString("base64")}` },
      })
    ).token;
    return this.fetch(`https://ghcr.io/v2/${this.owner}/${this.pkg}/${path}`, {
      headers: { Authorization: `Bearer ${this.bearer}`, Accept: accept },
      missing,
    });
  }
}

/** The ref a provenance attestation records, as a version label would name it ("pr-12", "master"). */
export function provenanceOrigin(attestations) {
  if (!attestations?.length) return "";
  const payload = attestations[0].bundle?.dsseEnvelope?.payload;
  if (!payload) throw new Error("the attestation carries no inline bundle");
  const { ref } = JSON.parse(Buffer.from(payload, "base64").toString()).predicate.buildDefinition.externalParameters
    .workflow;
  return ref.replace(/^refs\/pull\/(\d+)\/merge$/, "pr-$1").replace(/^refs\/heads\//, "");
}

/** Where an image came from: its version label, else an index's provenance; "" for neither, null if unreadable. */
export async function origin(client, digest) {
  try {
    const manifest = await client.registry(`manifests/${digest}`, MANIFESTS);
    // An index's platform images share its labels; its attestation manifests have platform "unknown".
    const child = manifest.manifests?.find((entry) => entry.platform?.os !== "unknown");
    const image = manifest.manifests
      ? child && (await client.registry(`manifests/${child.digest}`, MANIFESTS))
      : manifest;
    let label = "";
    if (IMAGE_CONFIGS.includes(image?.config?.mediaType)) {
      const config = await client.registry(`blobs/${image.config.digest}`, image.config.mediaType);
      label = config.config?.Labels?.["org.opencontainers.image.version"] ?? "";
    }
    // Only an index is attested; its children follow it, so they need no origin of their own.
    if (label || !manifest.manifests) return label;
    return provenanceOrigin(await client.attestations(digest));
  } catch (error) {
    console.log(`::warning::Kept ${digest}: ${error.message}`);
    return null;
  }
}

/** A digest's origin from the cache, else read and cached. An unreadable origin is null and stays uncached. */
async function cachedOrigin(digest, read, cache) {
  const found = cache[digest] ?? (await read(digest));
  if (found !== null) cache[digest] = found;
  return found;
}

/**
 * Untagged versions past the minimum age that a sweep must keep: builds of the default branch or of an
 * open pull request, and builds whose origin cannot be read. Origins never change, so readable ones are
 * cached by digest.
 */
export async function protectedDigests(versions, cutoff, kept, read, cache) {
  const candidates = versions
    .filter((v) => v.metadata.container.tags.length === 0 && new Date(v.updated_at) < cutoff)
    .map((v) => v.name);
  const protect = [];
  // A few concurrent reads keep a first run on thousands of versions within minutes.
  for (let next = 0; next < candidates.length; next += 8) {
    const batch = candidates.slice(next, next + 8);
    const origins = await Promise.all(batch.map((digest) => cachedOrigin(digest, read, cache)));
    protect.push(...batch.filter((_, i) => origins[i] === null || kept(origins[i])));
  }
  return protect.sort();
}

/** The exclusion pattern beyond release tags; digests match by a 16-hex prefix to stay short. */
export function keepPattern(tags, digests) {
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = `^(${tags.map(escape).join("|")})$`;
  return digests.length ? `${pattern}|^sha256:(${digests.map((d) => d.slice(7, 23)).join("|")})` : pattern;
}

async function sweep(env) {
  const client = new Client(env.GH_TOKEN, env.GITHUB_REPOSITORY, env.PACKAGE);
  const { default_branch: defaultBranch } = await client.api(`repos/${env.GITHUB_REPOSITORY}`);
  const pulls = (await client.pages(`repos/${env.GITHUB_REPOSITORY}/pulls?state=open`)).map((pr) => `pr-${pr.number}`);
  const kept = new Set([defaultBranch, ...pulls]);
  const cache = JSON.parse(await readFile(env.CACHE_FILE, "utf8").catch(() => "{}"));
  const cutoff = new Date(Date.now() - Number(env.MIN_AGE_DAYS) * 86_400_000);
  const versions = await client.pages(client.versionsPath());
  const digests = await protectedDigests(
    versions,
    cutoff,
    (o) => kept.has(o),
    (d) => origin(client, d),
    cache
  );
  const present = new Set(versions.map((v) => v.name));
  await writeFile(
    env.CACHE_FILE,
    JSON.stringify(Object.fromEntries(Object.entries(cache).filter(([d]) => present.has(d))))
  );
  await appendFile(env.GITHUB_OUTPUT, `pattern=${keepPattern([...kept], digests)}\n`);
  await appendFile(
    env.GITHUB_STEP_SUMMARY,
    `\`${env.PACKAGE}\`: ${versions.length} versions; keeps ${digests.length} untagged builds of ${defaultBranch}, of ${pulls.length} open pull requests, or of unreadable origin.\n`
  );
}

/** Delete a closed pull request's `pr-<N>` image from each package that has one; a sweep takes the rest. */
async function close(env) {
  const tag = `pr-${Number(env.PULL_REQUEST)}`;
  const tagged = (version) => version.metadata.container.tags.includes(tag);
  const dryRun = env.DRY_RUN === "true";
  for (const pkg of JSON.parse(env.PACKAGES)) {
    const client = new Client(env.GH_TOKEN, env.GITHUB_REPOSITORY, pkg);
    if (!(await client.registry(`manifests/${tag}`, MANIFESTS, true))) continue;
    const version = (await client.pages(client.versionsPath(), tagged)).find(tagged);
    // Another tag on the same image names it for something else, so the image stays.
    if (!version || version.metadata.container.tags.length > 1) {
      console.log(`::notice::Kept ${pkg}:${tag}, which ${version ? "carries other tags" : "no version lists"}.`);
      continue;
    }
    if (!dryRun) await client.api(`${client.versionsPath()}/${version.id}`, { method: "DELETE" });
    await appendFile(env.GITHUB_STEP_SUMMARY, `${dryRun ? "Would delete" : "Deleted"} \`${pkg}:${tag}\`.\n`);
  }
}

function fail(error) {
  console.log(`::error::${error.message}`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (process.argv[2] === "close" ? close : sweep)(process.env).catch(fail);
}
