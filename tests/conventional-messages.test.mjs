import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { read, root } from "./helpers.mjs";

// The commit-messages ruleset rejects any pushed commit whose subject is not a
// Conventional Commits subject, and a squash merge lands with the PR title as its
// subject. Every commit and pull request title the actions write must pass it.
const conventional = /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([^)]+\))?!?: \S/;

function manifests(dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".git") return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return manifests(path);
    return /\.ya?ml$/.test(entry.name) ? [relative(root, path)] : [];
  });
}

// A command may continue over lines ending in a backslash; the first -m is the subject.
const commitSubjects = /\bgit\b(?:[^\n]|\\\n)*?\bcommit\b(?:[^\n]|\\\n)*?-m\s+"((?:[^"\\]|\\.)*)"/g;
const prTitles = /\bgh pr create\b(?:[^\n]|\\\n)*?--title\s+"((?:[^"\\]|\\.)*)"/g;

test("automation writes Conventional commit subjects and pull request titles", () => {
  const found = [];
  for (const path of manifests()) {
    const source = read(path);
    for (const [, subject] of source.matchAll(commitSubjects)) found.push({ path, kind: "commit", subject });
    for (const [, title] of source.matchAll(prTitles)) found.push({ path, kind: "PR title", subject: title });
  }
  assert(found.length >= 8, `expected the known writers, found ${found.length}`);
  // A backport title reuses its fix's subject, which reached the default branch through this rule.
  const offenders = found.filter(({ subject }) => !conventional.test(subject.replace(/^\$subject\b/, "fix: reused")));
  assert.deepEqual(offenders, [], "non-Conventional automation subjects");
});
