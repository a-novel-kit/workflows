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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(process.argv[2] ?? ".");
  for (const file of globSync("**/action.{yaml,yml}", { cwd: root, exclude: ["**/node_modules/**", "**/.git/**"] })) {
    try {
      for (const { line, context } of violations(readFileSync(resolve(root, file), "utf8"))) {
        console.error(
          `::error file=${file},line=${line}::${context} is unavailable in composite actions; pass it as an input.`
        );
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`::error file=${file}::${error.message}`);
      process.exitCode = 1;
    }
  }
}
