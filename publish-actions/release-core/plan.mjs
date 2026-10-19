// Stamp in-repository Go requirements and emit the root and nested module tags.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tracked, version } from "./common.mjs";

/** Rewrite a file in place where the pattern matches. */
function rewrite(file, pattern, replacement) {
  const before = readFileSync(file, "utf8");
  const after = before.replace(pattern, replacement);
  if (after !== before) writeFileSync(file, after);
}

const next = version();
const repository = process.env.GITHUB_REPOSITORY;
if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository ?? "")) {
  throw new Error("GITHUB_REPOSITORY must name the release repository");
}
// The slash boundary excludes similarly named repositories; the full version boundary
// preserves prereleases and pseudo-versions instead of rewriting their numeric prefix.
const requirement = new RegExp(
  `^(\\s*(?:require\\s+)?${RegExp.escape(`github.com/${repository}`)}(?:/[^\\s]+)?\\s+)v\\d+\\.\\d+\\.\\d+(?=\\s|$)`,
  "gm"
);
const tags = new Set([`v${next}`]);
const files = tracked();
for (const file of files.filter((file) => /(^|\/)go\.mod$/.test(file))) {
  rewrite(file, requirement, `$1v${next}`);
  if (dirname(file) !== ".") tags.add(`${dirname(file)}/v${next}`);
}
// Hotfixes retain the baseline's workflow pins and do not need workflows:write.
if (process.argv.includes("--self-pins")) {
  const selfPin = new RegExp(
    `(?<![\\w./-])(${RegExp.escape(repository)}/[A-Za-z0-9._/-]+)@v\\d+\\.\\d+\\.\\d+(?=[\\s"']|$)`,
    "g"
  );
  for (const file of files.filter((file) => /\.ya?ml$/.test(file))) rewrite(file, selfPin, `$1@v${next}`);
}
process.stdout.write([...tags].join("\n"));
