// Decide whether a dependency bot's pull request may merge without a person, for a repository whose
// merges reach production. Only two shapes qualify: a release pin, and a version update that
// Renovate itself put on auto-merge.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tfvars = /(^|\/)terraform\.tfvars$/;
const releasePin = /"ghcr\.io\/a-novel\/[^"\s]+:[^"@\s]+@sha256:[0-9a-f]{64}"/;
// Checksums the toolchain verifies on its own, so their churn cannot change what runs.
const integrity = /(^|\/)([^/]+\.sum|\.terraform\.lock\.hcl)$/;
const modfile = /(^|\/)[^/]+\.mod$/;
const indirectRequirement = /^\s*(require\s+)?[^\s()]+\s+v\S+\s*\/\/\s*indirect\s*$/;
const renovateAnnotation = /#\s*renovate:\s*datasource=/;
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

/** The removed and added lines of each hunk, each with the line before it on its own side. */
function hunks(patch) {
  const out = [];
  let before = "";
  let after = "";
  for (const line of patch.split("\n")) {
    const text = line.slice(1);
    if (line.startsWith("@@")) {
      out.push({ removed: [], added: [] });
      before = after = "";
    } else if (!out.length) continue;
    else if (line.startsWith("-")) {
      out.at(-1).removed.push({ text, context: before });
      before = text;
    } else if (line.startsWith("+")) {
      out.at(-1).added.push({ text, context: after });
      after = text;
    } else before = after = text;
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

/** Every hunk pairs its removed and added lines one to one, each pair version-only. */
const pairsUp = (filename, { removed, added }) =>
  removed.length === added.length && removed.every((line, index) => versionOnly(filename, line, added[index]));

const review = (reason) => ({ decision: "review", reason });

/**
 * Classify a pull request's changed files: "pin" for a release pin, "renovate" for a version
 * update Renovate put on auto-merge, "review" for anything a person must approve. headSha is the
 * head after the files were listed, which must still be the expected commit the approval binds
 * to. changedFiles is the pull request's own count, since the files listing stops at 3000.
 * autoMergeEnabledBy is whoever first enabled auto-merge and autoMergeArmed whether it is on now,
 * so a maintainer's hold stands. resolveTag(repository, tag) returns the commit a tag names, so a
 * moved action pin must be the commit of its new version.
 */
export async function classify({
  files,
  changedFiles,
  headSha,
  expectedSha,
  bot,
  autoMergeEnabledBy,
  autoMergeArmed,
  resolveTag,
}) {
  if (headSha !== expectedSha) return review(`its head moved from ${expectedSha} to ${headSha}`);
  if (files.length === 0) return review("it changes no file");
  if (files.length !== changedFiles) return review(`GitHub listed ${files.length} of its ${changedFiles} files`);

  const pinOnly = files.every(
    (file) =>
      tfvars.test(file.filename) &&
      file.status === "modified" &&
      file.patch !== undefined &&
      hunks(file.patch).every(
        (hunk) =>
          [...hunk.removed, ...hunk.added].every(({ text }) => releasePin.test(text)) && pairsUp(file.filename, hunk)
      )
  );
  if (pinOnly) return { decision: "pin", reason: "it changes nothing but release pins" };

  const login = (name) => (name ?? "").replace(/\[bot\]$/, "");
  if (login(autoMergeEnabledBy) !== login(bot)) return review("Renovate did not put it on auto-merge");
  if (!autoMergeArmed) return review("its auto-merge is off");

  const movedPins = [];
  for (const file of files) {
    if (integrity.test(file.filename) && file.status === "modified") continue;
    if (file.status !== "modified" || file.patch === undefined) return review(`${file.filename} is ${file.status}`);
    for (const hunk of hunks(file.patch)) {
      // A module update adds and drops indirect requirements, which build nothing until imported.
      const keep = ({ text }) => !modfile.test(file.filename) || !indirectRequirement.test(text);
      const removed = hunk.removed.filter(keep);
      const added = hunk.added.filter(keep);
      if (!pairsUp(file.filename, { removed, added })) return review(`${file.filename} changes more than versions`);
      for (const [index, { text }] of added.entries()) {
        const commits = (line) => line.match(/@[0-9a-f]{40}\b/g)?.join();
        if (commits(text) === commits(removed[index].text)) continue;
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

async function main() {
  const { REPOSITORY, PULL_REQUEST, HEAD_SHA, BOT, GITHUB_OUTPUT } = process.env;
  const [owner, name] = REPOSITORY.split("/");
  const number = Number(PULL_REQUEST.split("/").at(-1));
  const files = JSON.parse(gh("api", "--paginate", "--slurp", `repos/${REPOSITORY}/pulls/${number}/files`)).flat();
  // Read after the listing, so a push in between shows as a moved head.
  const pull = JSON.parse(gh("api", `repos/${REPOSITORY}/pulls/${number}`, "--jq", "{changed_files, sha: .head.sha}"));
  // The first to enable auto-merge decided it; recover-prs re-arms a dropped pull request as the agent.
  const { autoMergeRequest, timelineItems } = JSON.parse(
    gh(
      "api",
      "graphql",
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `number=${number}`,
      "-f",
      "query=query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) " +
        "{ pullRequest(number: $number) { autoMergeRequest { enabledAt } " +
        "timelineItems(itemTypes: [AUTO_MERGE_ENABLED_EVENT], first: 1) " +
        "{ nodes { ... on AutoMergeEnabledEvent { actor { login } } } } } } }"
    )
  ).data.repository.pullRequest;
  const resolveTag = (repository, tag) => {
    try {
      return gh("api", `repos/${repository}/commits/${tag}`, "--jq", ".sha").trim();
    } catch {
      return "";
    }
  };
  const { decision, reason } = await classify({
    files,
    changedFiles: pull.changed_files,
    headSha: pull.sha,
    expectedSha: HEAD_SHA,
    bot: BOT,
    autoMergeEnabledBy: timelineItems.nodes[0]?.actor?.login,
    autoMergeArmed: Boolean(autoMergeRequest?.enabledAt),
    resolveTag,
  });
  // A filename is the pull request author's choice, so it never reaches the output as a new line.
  const line = reason.replace(/[\u0000-\u001f\u007f]/g, " ");
  console.log(
    decision === "review" ? `::notice::Not auto-approving: ${line}; a person approves it.` : `${decision}: ${line}.`
  );
  appendFileSync(GITHUB_OUTPUT, `reason=${line}\ndecision=${decision}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
