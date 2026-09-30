// Stamp in-repository Go requirements and emit the root and nested module tags.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tracked, version } from "./common.mjs";

const next = version();
const repository = process.env.GITHUB_REPOSITORY;
if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository ?? "")) {
  throw new Error("GITHUB_REPOSITORY must name the release repository");
}
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The slash boundary excludes similarly named repositories; the full version boundary
// preserves prereleases and pseudo-versions instead of rewriting their numeric prefix.
const requirement = new RegExp(
  `^(\\s*(?:require\\s+)?${escape(`github.com/${repository}`)}(?:/[^\\s]+)?\\s+)v\\d+\\.\\d+\\.\\d+(?=\\s|$)`,
  "gm"
);
const tags = new Set([`v${next}`]);
const files = tracked();
for (const file of files.filter((file) => /(^|\/)go\.mod$/.test(file))) {
  const before = readFileSync(file, "utf8");
  const after = before.replace(requirement, `$1v${next}`);
  if (after !== before) writeFileSync(file, after);
  if (dirname(file) !== ".") tags.add(`${dirname(file)}/v${next}`);
}
const selfPin = new RegExp(
  `(?<![\\w./-])(${escape(repository)}/[A-Za-z0-9._/-]+)@v\\d+\\.\\d+\\.\\d+(?=[\\s"']|$)`,
  "g"
);
// Hotfixes retain the baseline's workflow pins and do not need workflows:write.
for (const file of files.filter((file) => process.argv.includes("--self-pins") && /\.ya?ml$/.test(file))) {
  const before = readFileSync(file, "utf8");
  const after = before.replace(selfPin, `$1@v${next}`);
  if (after !== before) writeFileSync(file, after);
}
process.stdout.write([...tags].join("\n"));
