// Size a release from where it is cut: a v<N> branch is the next major, and the default branch takes
// the largest size among the commits since its last release.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tracked, version } from "./common.mjs";

const { BRANCH, DEFAULT_BRANCH } = process.env;
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

function refuse(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

/** A branch can only release the very next major, and Go refuses a v2+ tag outside its module path. */
function assertNextMajor() {
  const next = Number(BRANCH.slice(1));
  const current = Number(version(`origin/${DEFAULT_BRANCH}`).split(".")[0]);
  if (next !== current + 1)
    refuse(`${DEFAULT_BRANCH} is on major ${current}, so only v${current + 1} can release, not ${BRANCH}`);
  if (next < 2) return;

  for (const file of tracked().filter((path) => /(^|\/)go\.mod$/.test(path))) {
    const [, module] = /^module\s+(\S+)/m.exec(readFileSync(file, "utf8"));
    if (!module.endsWith(`/v${next}`))
      refuse(`${file} declares ${module}, which major ${next} must end with /v${next}`);
  }
}

// A type counts on the subject alone, since a squash merge's body repeats its branch's own subjects.
// Per Conventional Commits 1.0.0 §15, a type matches in any case and BREAKING CHANGE only in upper case.
const isMinor = (message) =>
  /^feat(\([^)]*\))?:/i.test(message) ||
  /^[a-z]+(\([^)]*\))?!:/i.test(message) ||
  /^BREAKING[ -]CHANGE:/m.test(message);

/** Nothing since the last tag reads as a patch, so a cut can still replace a tag that lost its Release. */
function sizeFromCommits() {
  const last = `v${version()}`;
  if (!git("tag", "--list", last).trim()) return "minor";

  return git("log", "-z", "--format=%B", `${last}..HEAD`).split("\0").some(isMinor) ? "minor" : "patch";
}

if (BRANCH === DEFAULT_BRANCH) {
  process.stdout.write(sizeFromCommits());
} else {
  assertNextMajor();
  process.stdout.write("major");
}
