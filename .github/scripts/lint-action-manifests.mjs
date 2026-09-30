import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

/** Find unavailable contexts, including bracket access and multiline expressions. */
export function violations(source) {
  if (parse(source)?.runs?.using !== "composite") return [];
  const hits = [];
  // Quoted expression strings may contain braces or context names as ordinary text.
  for (const expression of source.matchAll(/\$\{\{((?:'(?:[^']|'')*'|[^'])*?)\}\}/g)) {
    const tokens = /'(?:[^']|'')*'|(?<![\w.-])(?:vars|secrets|needs|matrix|strategy)(?![\w-])/gi;
    for (const token of expression[1].matchAll(tokens)) {
      if (token[0].startsWith("'") || expression[1].slice(0, token.index).trimEnd().endsWith(".")) continue;
      const line = source.slice(0, expression.index + 3 + token.index).split("\n").length;
      hits.push({ line, context: token[0].trim() });
    }
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
