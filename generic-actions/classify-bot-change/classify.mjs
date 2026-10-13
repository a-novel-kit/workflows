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
const requireEntry = /^\s*(require\s+)?[^\s()]+\s+v\S+(\s*\/\/\s*indirect)?\s*$/;
const digest = /\b(?:sha256:)?[0-9a-f]{40,64}\b/g;
const version = /\bv?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?\b/g;

/** The removed and added lines of each hunk of a unified diff. */
function hunks(patch) {
  const out = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) out.push({ removed: [], added: [] });
    else if (out.length && line.startsWith("-")) out.at(-1).removed.push(line.slice(1));
    else if (out.length && line.startsWith("+")) out.at(-1).added.push(line.slice(1));
  }
  return out;
}

const mask = (line) => line.replace(digest, "<digest>").replace(version, "<version>");
const tokens = (line, pattern) => (line.match(pattern) ?? []).join(" ");

/**
 * A line change is version-only when nothing but versions and digests differ, and no digest moves
 * without its version: the same version on another commit means its tag was moved.
 */
function versionOnly(before, after) {
  if (mask(before) !== mask(after)) return false;
  return tokens(before, digest) === tokens(after, digest) || tokens(before, version) !== tokens(after, version);
}

/** Every hunk pairs its removed and added lines one to one, each pair version-only. */
const pairsUp = ({ removed, added }) =>
  removed.length === added.length && removed.every((line, index) => versionOnly(line, added[index]));

const review = (reason) => ({ decision: "review", reason });

/**
 * Classify a pull request's changed files: "pin" for a release pin, "renovate" for a version
 * update Renovate put on auto-merge, "review" for anything a person must approve.
 */
export function classify({ files, bot, autoMergeEnabledBy }) {
  if (files.length === 0) return review("it changes no file");

  const pinOnly = files.every(
    (file) =>
      tfvars.test(file.filename) &&
      file.status === "modified" &&
      file.patch !== undefined &&
      hunks(file.patch).every(
        (hunk) => [...hunk.removed, ...hunk.added].every((line) => releasePin.test(line)) && pairsUp(hunk)
      )
  );
  if (pinOnly) return { decision: "pin", reason: "it changes nothing but release pins" };

  const login = (name) => (name ?? "").replace(/\[bot\]$/, "");
  if (login(autoMergeEnabledBy) !== login(bot)) return review("Renovate did not put it on auto-merge");

  for (const file of files) {
    if (integrity.test(file.filename)) continue;
    if (file.status !== "modified" || file.patch === undefined) return review(`${file.filename} is ${file.status}`);
    for (const hunk of hunks(file.patch)) {
      // A module update adds and drops indirect requirements, which build nothing until imported.
      const keep = (line) => !modfile.test(file.filename) || !requireEntry.test(line);
      if (!pairsUp({ removed: hunk.removed.filter(keep), added: hunk.added.filter(keep) })) {
        return review(`${file.filename} changes more than versions`);
      }
    }
  }
  return { decision: "renovate", reason: "Renovate put it on auto-merge and it changes nothing but versions" };
}

function gh(...args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function main() {
  const { REPOSITORY, PULL_REQUEST, BOT, GITHUB_OUTPUT } = process.env;
  const [owner, name] = REPOSITORY.split("/");
  const number = Number(PULL_REQUEST.split("/").at(-1));
  const files = JSON.parse(gh("api", "--paginate", "--slurp", `repos/${REPOSITORY}/pulls/${number}/files`)).flat();
  const autoMerge = JSON.parse(
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
        "{ pullRequest(number: $number) { autoMergeRequest { enabledBy { login } } } } }"
    )
  ).data.repository.pullRequest.autoMergeRequest;
  const { decision, reason } = classify({ files, bot: BOT, autoMergeEnabledBy: autoMerge?.enabledBy?.login });
  // A filename is the pull request author's choice, so it never reaches the output as a new line.
  const line = reason.replace(/[\u0000-\u001f\u007f]/g, " ");
  console.log(
    decision === "review" ? `::notice::Not auto-approving: ${line}; a person approves it.` : `${decision}: ${line}.`
  );
  appendFileSync(GITHUB_OUTPUT, `reason=${line}\ndecision=${decision}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
