// Decide whether a dependency bot's pull request may merge without a person, for a repository whose
// merges reach production. Only three shapes qualify: a release pin, a version update that
// Renovate itself put on auto-merge, and a refresh of Google's service ranges to exactly what Google
// publishes.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { googleServiceRanges } from "../google-service-ranges/ranges.mjs";

const tfvars = /(^|\/)terraform\.tfvars$/;
const serviceRangesFile = /(^|\/)google-service-ranges\.json$/;
const releasePin = /"ghcr\.io\/a-novel\/[^"\s]+:[^"@\s]+@sha256:[0-9a-f]{64}"/;
const releaseRef = /ghcr\.io\/a-novel\/[^"\s]+:[^"@\s]+@sha256:[0-9a-f]{64}/g;
// A Dockerfile that builds on a release image takes the very digest its terraform.tfvars pins.
const dockerfile = /(^|\/)[^/]*Dockerfile$/;
const releaseBase = /^FROM (ghcr\.io\/a-novel\/[^"\s]+:[^"@\s]+@sha256:[0-9a-f]{64})(\s+AS\s+\S+)?\s*$/i;
// Checksums the toolchain verifies on its own, so their churn cannot change what runs.
const integrity = /(^|\/)([^/]+\.sum|\.terraform\.lock\.hcl)$/;
const modfile = /(^|\/)[^/]+\.mod$/;
const indirectRequirement = /^\s*(require\s+)?[^\s()]+\s+v\S+\s*\/\/\s*indirect\s*$/;
const renovateAnnotation = /#\s*renovate:\s*datasource=/;
const workflow = /(^|\/)(\.github\/(workflows|actions)\/.+|action)\.ya?ml$/;
const opentofu = /\.tf$/;
const actionPin = /uses:\s*([\w.-]+\/[\w.-]+)(?:\/[^@\s]*)?@([0-9a-f]{40})\s*#\s*(v?\d[\w.+-]*)\s*$/;

const semver = String.raw`v?\d+(?:\.\d+)+(?:[-+][\w.-]+)?`;
const digests = [/@sha256:[0-9a-f]{64}/g, /@[0-9a-f]{40}\b/g];
// Where a dependency reference puts its version. Anywhere else a dotted number, such as an IP
// address or a CIDR base, stays literal.
const versions = [
  new RegExp(String.raw`(?<=@)(?!\d+(?:\.\d+){3}\b)v?\d+(?:\.\d+)*(?:[-+][\w.-]+)?\b`, "g"),
  new RegExp(String.raw`(?<=\/[\w.-]+:)${semver}(?=[@"\s]|$)`, "g"),
  new RegExp(String.raw`(?<=#\s*)${semver}(?=["\s]|$)`, "g"),
];
const moduleVersions = [
  /(?<=\s)v\d+\.\d+\.\d+[\w.+-]*/g,
  /(?<=^go )\d+\.\d+(?:\.\d+)?$/g,
  /(?<=^toolchain go)\d[\w.]*/g,
];
const annotatedVersion = new RegExp(semver, "g");
const inputVersion = new RegExp(
  String.raw`(?<=^\s*[\w-]+-version:\s*["']?)(?!\d+(?:\.\d+){3}\b)${semver}(?=["']?\s*$)`,
  "g"
);
// The version argument of a provider requirement, a Helm release or a module, exactly as Renovate pins it.
const argumentVersion = new RegExp(String.raw`(?<=^\s*version\s*=\s*")${semver}(?="\s*$)`, "g");

/**
 * The removed and added lines of each change, a run of them between context lines, each with the
 * line before it on its own side. Pairing within a change keeps a line from moving past context.
 */
function changes(patch) {
  const out = [];
  let before = "";
  let after = "";
  for (const line of patch.split("\n")) {
    const text = line.slice(1);
    if (line.startsWith("@@")) {
      out.push({ removed: [], added: [] });
      before = after = "";
    } else if (!out.length || line.startsWith("\\")) continue;
    else if (line.startsWith("-")) {
      out.at(-1).removed.push({ text, context: before });
      before = text;
    } else if (line.startsWith("+")) {
      out.at(-1).added.push({ text, context: after });
      after = text;
    } else {
      out.push({ removed: [], added: [] });
      before = after = text;
    }
  }
  return out;
}

/** The line with its versions and digests replaced by placeholders, and the values replaced. */
function masked(text, patterns) {
  const found = { versions: [], digests: [] };
  let line = text;
  for (const pattern of digests) line = line.replace(pattern, (value) => (found.digests.push(value), "@<digest>"));
  for (const pattern of patterns) line = line.replace(pattern, (value) => (found.versions.push(value), "<version>"));
  return { line, ...found };
}

/** The version patterns that apply to a changed line of the given file. */
function patternsFor(filename, { context }) {
  if (modfile.test(filename)) return [...versions, ...moduleVersions];
  // Renovate's custom managers write a version on the line after their annotation.
  if (renovateAnnotation.test(context)) return [...versions, annotatedVersion];
  // Its github-actions manager rewrites a step's tool version input, such as node-version.
  if (workflow.test(filename)) return [...versions, inputVersion];
  // Its terraform and helm managers rewrite a block's version argument.
  if (opentofu.test(filename)) return [...versions, argumentVersion];
  return versions;
}

/**
 * A line change is version-only when nothing but versions and digests differ, and no digest moves
 * without its version: the same version on another commit means its tag was moved.
 */
function versionOnly(filename, before, after) {
  const was = masked(before.text, patternsFor(filename, before));
  const now = masked(after.text, patternsFor(filename, after));
  if (was.line !== now.line) return false;
  return was.digests.join() === now.digests.join() || was.versions.join() !== now.versions.join();
}

/** A change pairs its removed and added lines one to one, each pair version-only. */
const pairsUp = (filename, { removed, added }) =>
  removed.length === added.length && removed.every((line, index) => versionOnly(filename, line, added[index]));

/** The commit pins of a line, joined, so two lines compare by the commits they name. */
const commitPins = (text) => text.match(/@[0-9a-f]{40}\b/g)?.join();

/** The release references added to terraform.tfvars, which deploy verifies against each tag's attestation. */
function tfvarsPins(files) {
  const references = files
    .filter((file) => tfvars.test(file.filename) && file.patch !== undefined)
    .flatMap((file) =>
      changes(file.patch).flatMap(({ added }) => added.flatMap(({ text }) => text.match(releaseRef) ?? []))
    );
  return new Set(references);
}

/**
 * A file changes nothing but release pins: terraform.tfvars pins, or a Dockerfile's release base whose
 * digest the same pull request pins in terraform.tfvars.
 */
function pinsOnly(file, pinned) {
  const isTfvars = tfvars.test(file.filename);
  if (!(isTfvars || dockerfile.test(file.filename)) || file.status !== "modified" || file.patch === undefined) {
    return false;
  }
  const pinLine = ({ text }) => (isTfvars ? releasePin.test(text) : releaseBase.test(text));
  const pinnedBase = ({ text }) => pinned.has(text.match(releaseBase)[1]);
  for (const change of changes(file.patch)) {
    if (![...change.removed, ...change.added].every(pinLine)) return false;
    if (!isTfvars && !change.added.every(pinnedBase)) return false;
    if (!pairsUp(file.filename, change)) return false;
  }
  return true;
}

const review = (reason) => ({ decision: "review", reason });

/**
 * Classify a pull request's changed files: "pin" for a release pin, "renovate" for a version
 * update Renovate put on auto-merge, "ranges" for a refresh of Google's service ranges, "review" for
 * anything a person must approve. files is the diff of the exact commit the caller approves, which a
 * comparison caps at 300 files. autoMergeEnabledBy is whoever first enabled auto-merge and
 * autoMergeArmed whether it is on now, so a maintainer's hold stands. resolveTag(repository, tag)
 * returns the commit a tag names, so a moved action pin must be the commit of its new version.
 * readFile(filename) returns a file's content at that commit, and serviceRanges() Google's service
 * ranges as they stand now.
 */
export async function classify({
  files,
  bot,
  autoMergeEnabledBy,
  autoMergeArmed,
  resolveTag,
  readFile,
  serviceRanges,
}) {
  if (files.length === 0) return review("it changes no file");
  if (files.length >= 300) return review("its comparison may stop at 300 files");

  // A bot could write any range into the list, so it passes only as what Google publishes now.
  if (files.length === 1 && serviceRangesFile.test(files[0].filename)) {
    const [{ filename, status }] = files;
    if (status !== "modified") return review(`${filename} is ${status}`);
    try {
      const proposed = JSON.stringify(JSON.parse(await readFile(filename)));
      if (proposed === JSON.stringify(await serviceRanges()))
        return { decision: "ranges", reason: "it sets Google's service ranges to exactly what Google publishes" };
      return review(`${filename} differs from what Google publishes now`);
    } catch {
      return review(`${filename} or Google's lists could not be read`);
    }
  }

  const pinned = tfvarsPins(files);
  if (files.every((file) => pinsOnly(file, pinned)))
    return { decision: "pin", reason: "it changes nothing but release pins" };

  const login = (name) => (name ?? "").replace(/\[bot\]$/, "");
  if (login(autoMergeEnabledBy) !== login(bot)) return review("Renovate did not put it on auto-merge");
  if (!autoMergeArmed) return review("its auto-merge is off");

  const movedPins = [];
  for (const file of files) {
    if (integrity.test(file.filename) && file.status === "modified") continue;
    if (file.status !== "modified" || file.patch === undefined) return review(`${file.filename} is ${file.status}`);
    // A module update adds and drops indirect requirements, which name only a module and its version.
    const kept = ({ text }) => !modfile.test(file.filename) || !indirectRequirement.test(text);
    for (const change of changes(file.patch)) {
      const removed = change.removed.filter(kept);
      const added = change.added.filter(kept);
      if (!pairsUp(file.filename, { removed, added })) return review(`${file.filename} changes more than versions`);
      for (const [index, { text }] of added.entries()) {
        if (commitPins(text) === commitPins(removed[index].text)) continue;
        const pin = text.match(actionPin);
        if (!pin) return review(`${file.filename} moves a commit pin it cannot verify`);
        movedPins.push(pin);
      }
    }
  }

  // GitHub resolves a commit that exists only in a fork through its parent's name.
  for (const [, repository, commit, tag] of movedPins) {
    if ((await resolveTag(repository, tag)) !== commit) return review(`${repository}@${tag} does not name ${commit}`);
  }
  return { decision: "renovate", reason: "Renovate put it on auto-merge and it changes nothing but versions" };
}

function gh(...args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** The commit a tag names in a repository, or "" when GitHub cannot resolve it. */
function tagCommit(repository, tag) {
  try {
    return gh("api", `repos/${repository}/commits/${tag}`, "--jq", ".sha").trim();
  } catch {
    return "";
  }
}

/** The pull request's auto-merge state and the first auto-merge enabling, with its actor. */
const AUTO_MERGE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    autoMergeRequest { enabledAt }
    timelineItems(itemTypes: [AUTO_MERGE_ENABLED_EVENT], first: 1) {
      nodes { ... on AutoMergeEnabledEvent { actor { login } } }
    }
  } }
}`;

async function main() {
  const { REPOSITORY, PULL_REQUEST, HEAD_SHA, BOT, GITHUB_OUTPUT } = process.env;
  const [owner, name] = REPOSITORY.split("/");
  const number = Number(PULL_REQUEST.split("/").at(-1));
  const base = gh("api", `repos/${REPOSITORY}/pulls/${number}`, "--jq", ".base.ref").trim();
  // The diff of the exact commit the caller approves, whatever the branch does meanwhile.
  const { files } = JSON.parse(gh("api", `repos/${REPOSITORY}/compare/${base}...${HEAD_SHA}`, "--jq", "{files}"));
  // The first to enable auto-merge decided it; recover-prs re-arms a dropped pull request as the agent.
  const variables = ["-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`];
  const { autoMergeRequest, timelineItems } = JSON.parse(
    gh("api", "graphql", ...variables, "-f", `query=${AUTO_MERGE_QUERY}`)
  ).data.repository.pullRequest;
  const { decision, reason } = await classify({
    files,
    bot: BOT,
    autoMergeEnabledBy: timelineItems.nodes[0]?.actor?.login,
    autoMergeArmed: Boolean(autoMergeRequest?.enabledAt),
    resolveTag: tagCommit,
    // A filename is the pull request author's choice, so each segment is encoded into the path.
    readFile: async (filename) =>
      gh(
        "api",
        `repos/${REPOSITORY}/contents/${filename.split("/").map(encodeURIComponent).join("/")}?ref=${HEAD_SHA}`,
        "-H",
        "Accept: application/vnd.github.raw+json"
      ),
    serviceRanges: googleServiceRanges,
  });
  // A filename is the pull request author's choice, so it never reaches the output as a new line.
  const line = reason.replace(/[\u0000-\u001f\u007f]/g, " ");
  console.log(
    decision === "review" ? `::notice::Not auto-approving: ${line}; a person approves it.` : `${decision}: ${line}.`
  );
  appendFileSync(GITHUB_OUTPUT, `reason=${line}\ndecision=${decision}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
