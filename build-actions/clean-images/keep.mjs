// Decide what a package cleanup keeps beyond release tags: the default branch tag, open pull
// request tags, and every untagged build of the default branch, which its version label names.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MANIFESTS = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(",");
const IMAGE_CONFIGS = ["application/vnd.oci.image.config.v1+json", "application/vnd.docker.container.image.v1+json"];

/** GitHub REST and GHCR registry reads for one package, with the caller's token. */
export class Client {
  constructor(token, repository, pkg) {
    this.token = token;
    this.repository = repository;
    this.image = `${repository.split("/")[0]}/${pkg}`;
    this.pkg = pkg;
  }

  async fetch(url, headers) {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
    return response.json();
  }

  api(path) {
    return this.fetch(`https://api.github.com/${path}`, {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
    });
  }

  async pages(path) {
    const values = [];
    for (let page = 1; ; page++) {
      const result = await this.api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      values.push(...result);
      if (result.length < 100) return values;
    }
  }

  versions() {
    return this.pages(
      `orgs/${this.repository.split("/")[0]}/packages/container/${encodeURIComponent(this.pkg)}/versions`
    );
  }

  async registry(path, accept) {
    this.bearer ??= (
      await this.fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${this.image}:pull`, {
        Authorization: `Basic ${Buffer.from(`token:${this.token}`).toString("base64")}`,
      })
    ).token;
    return this.fetch(`https://ghcr.io/v2/${this.image}/${path}`, {
      Authorization: `Bearer ${this.bearer}`,
      Accept: accept,
    });
  }
}

/** The image's version label, "" when it has none, or null when it cannot be read. */
export async function versionLabel(client, digest) {
  try {
    const manifest = await client.registry(`manifests/${digest}`, MANIFESTS);
    // An index's platform images share its labels; its attestation manifests have platform "unknown".
    const child = manifest.manifests?.find((entry) => entry.platform?.os !== "unknown");
    const image = manifest.manifests
      ? child && (await client.registry(`manifests/${child.digest}`, MANIFESTS))
      : manifest;
    if (!IMAGE_CONFIGS.includes(image?.config?.mediaType)) return "";
    const config = await client.registry(`blobs/${image.config.digest}`, image.config.mediaType);
    return config.config?.Labels?.["org.opencontainers.image.version"] ?? "";
  } catch (error) {
    console.log(`::warning::Kept ${digest}: ${error.message}`);
    return null;
  }
}

/**
 * Untagged versions older than the cutoff that a cleanup must keep: default-branch builds, and
 * builds whose label cannot be read. Labels never change, so readable ones are cached by digest.
 */
export async function protectedDigests(versions, cutoff, defaultBranch, label, cache) {
  const kept = [];
  const candidates = versions.filter((v) => v.metadata.container.tags.length === 0 && new Date(v.updated_at) < cutoff);
  for (let next = 0; next < candidates.length;) {
    // A few concurrent reads keep a first run on thousands of versions within minutes.
    await Promise.all(
      candidates.slice(next, (next += 8)).map(async ({ name }) => {
        const version = cache[name] ?? (await label(name));
        if (version !== null) cache[name] = version;
        if (version === null || version === defaultBranch) kept.push(name);
      })
    );
  }
  return kept.sort();
}

/** The exclusion pattern beyond release tags; digests match by a 16-hex prefix to stay short. */
export function keepPattern(defaultBranch, pulls, digests) {
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tags = [escape(defaultBranch), ...pulls.map((number) => `pr-${number}`)];
  const pattern = `^(${tags.join("|")})$`;
  return digests.length ? `${pattern}|^sha256:(${digests.map((d) => d.slice(7, 23)).join("|")})` : pattern;
}

async function main() {
  const env = process.env;
  const client = new Client(env.GH_TOKEN, env.GITHUB_REPOSITORY, env.PACKAGE);
  const { default_branch: defaultBranch } = await client.api(`repos/${env.GITHUB_REPOSITORY}`);
  const pulls = (await client.pages(`repos/${env.GITHUB_REPOSITORY}/pulls?state=open`)).map((pr) => pr.number);
  const cache = JSON.parse(await readFile(env.CACHE_FILE, "utf8").catch(() => "{}"));
  const cutoff = new Date(Date.now() - Number(env.RETENTION_DAYS) * 86_400_000);
  const versions = await client.versions();
  const digests = await protectedDigests(versions, cutoff, defaultBranch, (d) => versionLabel(client, d), cache);
  const present = new Set(versions.map((v) => v.name));
  await writeFile(
    env.CACHE_FILE,
    JSON.stringify(Object.fromEntries(Object.entries(cache).filter(([d]) => present.has(d))))
  );
  await appendFile(env.GITHUB_OUTPUT, `pattern=${keepPattern(defaultBranch, pulls, digests)}\n`);
  await appendFile(
    env.GITHUB_STEP_SUMMARY,
    `\`${env.PACKAGE}\`: ${versions.length} versions; keeps ${digests.length} untagged ${defaultBranch} or unreadable builds older than ${env.RETENTION_DAYS} days, and ${pulls.length} open pull request tags.\n`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
