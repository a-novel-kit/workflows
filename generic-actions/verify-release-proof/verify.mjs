// Check that every first-party version a dependency bot's pull request adds was built by a release.
// Any workflow run of a repository can publish its packages, so a version proves its origin only
// through what a branch cannot make: an attestation over its exact bytes, signed by the producer's
// release workflow at the version's tag, and an immutable Release of that tag from the release App.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The release App of each first-party org, the only author of a Release that proves a version. */
export const RELEASE_APPS = { "a-novel": "anovelbot-release[bot]", "a-novel-kit": "anovelkitbot-release[bot]" };

const org = "(a-novel|a-novel-kit)";
const lockfile = /(^|\/)pnpm-lock\.yaml$/;
// Checksum files, whose diffs can be too large to read and never name an image.
const checksums = /(^|\/)([^/]+\.sum|\.terraform\.lock\.hcl)$/;
// A package key in a pnpm lockfile, and the resolution pnpm writes on the line after it. The tarball
// must come from GitHub Packages, which is the only host the job's token is sent to.
const packageKey = new RegExp(String.raw`^  '?@${org}\/([^@'\s]+)@([^'\s]+?)'?:$`);
const resolution =
  /^    resolution: \{integrity: (sha512-[A-Za-z0-9+/]+=*), tarball: (https:\/\/npm\.pkg\.github\.com\/\S+)\}$/;
// An image the bots move by release tag, with the digest that pins it when there is one.
const imageRef = new RegExp(
  String.raw`ghcr\.io\/${org}\/([\w.-]+)((?:\/[\w.-]+)*):(v\d[\w.+-]*)(@sha256:[0-9a-f]{64})?`,
  "g"
);
const repository = /^(?:git\+)?https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/;

/** The first-party packages a pnpm lockfile resolves, keyed by name@version. */
export function lockfilePackages(text) {
  const packages = new Map();
  const lines = text.split("\n");
  let section = "";
  lines.forEach((line, index) => {
    if (/^\S/.test(line)) section = line;
    const key = section === "packages:" && line.match(packageKey);
    if (!key) return;
    const [, owner, name, version] = key;
    const [, integrity, tarball] = lines[index + 1]?.match(resolution) ?? [];
    const label = `@${owner}/${name}@${version}`;
    packages.set(label, { kind: "npm", label, org: owner, tag: `v${version}`, integrity, tarball });
  });
  return packages;
}

/** The first-party images the added lines of a diff reference. */
export function addedImages(files) {
  const images = new Map();
  for (const { patch = "" } of files) {
    for (const line of patch.split("\n").filter((text) => text.startsWith("+"))) {
      for (const [label, owner, repo, path, tag, digest] of line.matchAll(imageRef)) {
        const name = `ghcr.io/${owner}/${repo}${path}`;
        images.set(label, { kind: "image", label, org: owner, producer: `${owner}/${repo}`, name, tag, digest });
      }
    }
  }
  return [...images.values()];
}

/**
 * The first-party versions a pull request adds, and the reasons it cannot be read. files is the
 * comparison of the checked commit with its base. lockfiles maps each changed lockfile's name to its
 * text at the merge base and at the commit.
 */
export function addedVersions(files, lockfiles) {
  if (files.length >= 300) return { versions: [], problems: ["its comparison may stop at 300 files"] };
  const unread = (file) => file.status !== "removed" && file.patch === undefined;
  const problems = files
    .filter((file) => !lockfile.test(file.filename) && !checksums.test(file.filename) && unread(file))
    .map((file) => `${file.filename} has no diff to read`);
  const versions = addedImages(files);
  for (const { base, head } of lockfiles.values()) {
    const before = lockfilePackages(base);
    for (const [label, entry] of lockfilePackages(head)) if (!before.has(label)) versions.push(entry);
  }
  return { versions, problems };
}

/**
 * Why a version lacks a release proof, or "" when it carries one. io performs the reads: download(url)
 * returns a tarball's bytes or throws, save(bytes) writes them to a file, manifest(file) returns the
 * tarball's package.json or throws, attest(subject, producer, tag) throws without a matching
 * attestation, and release(producer, tag) returns the Release's author and whether it is immutable.
 */
export async function missingProof(version, io) {
  let { producer, subject } = version;
  if (version.kind === "npm") {
    if (!version.tarball) return "its lockfile entry names no GitHub Packages tarball";
    let bytes, manifest;
    try {
      bytes = await io.download(version.tarball);
      subject = io.save(bytes);
      manifest = io.manifest(subject);
    } catch {
      return "its tarball cannot be downloaded and read";
    }
    if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== version.integrity) {
      return "the registry serves other bytes than the lockfile's integrity";
    }
    const [, owner, repo] = manifest.repository?.url?.match(repository) ?? [];
    if (owner !== version.org) return "its package names no repository of its own org";
    producer = `${owner}/${repo}`;
  } else {
    if (!version.digest) return "it is pinned without a digest";
    subject = `oci://${version.name}${version.digest}`;
  }
  try {
    io.attest(subject, producer, version.tag);
  } catch {
    return `no attestation from ${producer}'s release workflow at ${version.tag} covers it`;
  }
  const app = RELEASE_APPS[version.org];
  const { author, immutable } = io.release(producer, version.tag) ?? {};
  if (author !== app || immutable !== true) return `${producer} ${version.tag} is not an immutable Release by ${app}`;
  return "";
}

function gh(...args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** The network reads of missingProof, with the job token. */
function network(token) {
  const dir = mkdtempSync(join(tmpdir(), "release-proof-"));
  let saved = 0;
  return {
    async download(url) {
      const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`${url} answered ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
    manifest(file) {
      return JSON.parse(execFileSync("tar", ["-xzOf", file, "package/package.json"], { encoding: "utf8" }));
    },
    save(bytes) {
      const file = join(dir, `${saved++}.tgz`);
      writeFileSync(file, bytes);
      return file;
    },
    attest(subject, producer, tag) {
      const workflow = `${producer}/.github/workflows/release.yaml`;
      const ref = `refs/tags/${tag}`;
      gh(
        "attestation",
        "verify",
        subject,
        "--repo",
        producer,
        "--signer-workflow",
        workflow,
        "--source-ref",
        ref,
        "--deny-self-hosted-runners"
      );
    },
    release(producer, tag) {
      try {
        return JSON.parse(
          gh("api", `repos/${producer}/releases/tags/${tag}`, "--jq", "{author: .author.login, immutable}")
        );
      } catch {
        return undefined;
      }
    },
  };
}

/** A changed lockfile's text at the merge base and at the checked commit. */
function lockfileTexts(repo, file, baseSha, headSha) {
  const read = (path, ref) =>
    gh("api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${path}?ref=${ref}`);
  const base = file.status === "added" ? "" : read(file.previous_filename ?? file.filename, baseSha);
  return { base, head: read(file.filename, headSha) };
}

async function main() {
  const { REPOSITORY, PULL_REQUEST, HEAD_SHA, GH_TOKEN, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY } = process.env;
  const number = PULL_REQUEST.split("/").at(-1);
  const base = gh("api", `repos/${REPOSITORY}/pulls/${number}`, "--jq", ".base.ref").trim();
  // The diff of the exact commit the caller approves, whatever the branch does meanwhile.
  const { files, mergeBase } = JSON.parse(
    gh("api", `repos/${REPOSITORY}/compare/${base}...${HEAD_SHA}`, "--jq", "{files, mergeBase: .merge_base_commit.sha}")
  );
  const lockfiles = new Map(
    files
      .filter((file) => lockfile.test(file.filename) && file.status !== "removed")
      .map((file) => [file.filename, lockfileTexts(REPOSITORY, file, mergeBase, HEAD_SHA)])
  );
  const { versions, problems } = addedVersions(files, lockfiles);
  const io = network(GH_TOKEN);
  const rows = problems.map((problem) => ["the diff", problem]);
  for (const version of versions) rows.push([version.label, await missingProof(version, io)]);
  // A version and a filename are the pull request's text, so neither reaches the output as a new line.
  const line = (text) => text.replace(/[\u0000-\u001f\u007f]/g, " ");
  const unproved = rows.filter(([, reason]) => reason);
  for (const [label, reason] of unproved) console.log(`::notice::Not auto-approving: ${line(label)}: ${line(reason)}.`);
  if (rows.length === 0) console.log("The pull request adds no first-party version.");
  else {
    const cell = (text) => line(text).replaceAll("|", "\\|");
    const table = rows.map(([label, reason]) => `| ${cell(label)} | ${reason ? cell(reason) : "proved"} |`);
    appendFileSync(
      GITHUB_STEP_SUMMARY,
      ["## Release proofs", "", "| Version | Proof |", "| --- | --- |", ...table, ""].join("\n")
    );
  }
  appendFileSync(GITHUB_OUTPUT, `verified=${unproved.length === 0}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
