// Stamp in-repository Go requirements, name a pending migration guide, and emit the root and nested
// module tags.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tracked, version } from "./common.mjs";

/** Rewrite a file in place where the pattern matches. */
function rewrite(file, pattern, replacement) {
  const before = readFileSync(file, "utf8");
  const after = before.replace(pattern, replacement);
  if (after !== before) writeFileSync(file, after);
}

/**
 * Only the release knows its version, so branches write the guide as NEXT.md and the release names it.
 * The index is a list rather than a table, whose alignment an added row would break for prettier.
 */
function publishGuide(release) {
  const guides = "docs/migrations";
  const draft = `${guides}/NEXT.md`;
  if (!existsSync(draft)) return;

  // Only the title takes the version, since the body may name the NEXT.md file itself. The paragraph
  // under the title is the guide's one-line summary, however it wraps.
  const text = readFileSync(draft, "utf8").replace(/^(#.*)\bNEXT\b/, `$1${release}`);
  const [, summary] = text.split("\n\n");
  if (!summary) throw new Error(`${draft} needs a one-line summary under its title`);

  writeFileSync(`${guides}/${release}.md`, text);
  rmSync(draft);

  const entry = `- [${release}](./${release}.md): ${summary.replaceAll("\n", " ")}\n`;
  const indexFile = `${guides}/README.md`;
  const index = existsSync(indexFile) ? readFileSync(indexFile, "utf8") : "# Migration guides\n";
  const newest = index.search(/^- \[/m);
  writeFileSync(
    indexFile,
    newest < 0 ? `${index.trimEnd()}\n\n${entry}` : index.slice(0, newest) + entry + index.slice(newest)
  );
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
publishGuide(`v${next}`);
process.stdout.write([...tags].join("\n"));
