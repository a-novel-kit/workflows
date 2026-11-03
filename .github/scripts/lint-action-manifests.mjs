import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

/** Find unavailable contexts, including bracket access and multiline expressions. */
export function violations(source) {
  if (parse(source)?.runs?.using !== "composite") return [];
  const hits = [];
  const unavailable = new Set(["vars", "secrets", "needs", "matrix", "strategy"]);
  const openings = /\$\{\{/g;
  // Consume quoted strings as single tokens; nested repetition can backtrack exponentially.
  const tokens = /'(?:[^']|'')*'|[A-Za-z_][\w-]*|\}\}|[^\s]/g;
  let line = 1,
    counted = 0;
  while (openings.exec(source)) {
    tokens.lastIndex = openings.lastIndex;
    let previous, token;
    while ((token = tokens.exec(source)) && token[0] !== "}}") {
      if (previous !== "." && unavailable.has(token[0].toLowerCase())) {
        line += source.slice(counted, token.index).split("\n").length - 1;
        counted = token.index;
        hits.push({ line, context: token[0] });
      }
      previous = token[0];
    }
    openings.lastIndex = token ? tokens.lastIndex : source.length;
  }
  return hits;
}

/** A `uses:` line's reference and the text after it, the version comment of a pinned action. */
const USES = /^\s*(?:-\s+)?uses:\s*["']?([^\s"']+)["']?(.*)$/;
/** References that resolve inside A-Novel or to a container image, which pinning leaves alone. */
const FIRST_PARTY = /^(\.\/|\$\/|docker:\/\/|a-novel-kit\/)/;
const COMMIT = /@[0-9a-f]{40}$/;
const VERSION_COMMENT = /^\s+#\s*v\d+\.\d+\.\d+\s*$/;

/** Find third-party actions not pinned as `owner/repo@<commit> # vX.Y.Z`, the form Renovate keeps current. */
export function unpinned(source) {
  const hits = [];
  for (const [index, text] of source.split("\n").entries()) {
    const [, uses, rest] = USES.exec(text) ?? [];
    if (!uses || FIRST_PARTY.test(uses) || (COMMIT.test(uses) && VERSION_COMMENT.test(rest))) continue;
    hits.push({ line: index + 1, uses });
  }
  return hits;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(process.argv[2] ?? ".");
  for (const file of globSync("**/action.{yaml,yml}", { cwd: root, exclude: ["**/node_modules/**", "**/.git/**"] })) {
    try {
      const source = readFileSync(resolve(root, file), "utf8");
      for (const { line, context } of violations(source)) {
        console.error(
          `::error file=${file},line=${line}::${context} is unavailable in composite actions; pass it as an input.`
        );
        process.exitCode = 1;
      }
      for (const { line, uses } of unpinned(source)) {
        console.error(`::error file=${file},line=${line}::pin ${uses} to its release commit, as @<sha> # vX.Y.Z.`);
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`::error file=${file}::${error.message}`);
      process.exitCode = 1;
    }
  }
}
