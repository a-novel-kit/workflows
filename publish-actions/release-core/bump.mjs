// Updating versions directly avoids pnpm's dependency verification during a release.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tracked, version } from "./common.mjs";

const index = ["major", "minor", "patch"].indexOf(process.env.RELEASE_TYPE);
if (index < 0) throw new Error("release_type must be patch, minor, or major");
const parts = version().split(".").map(BigInt);
// A hotfix of the default branch's own minor takes its next patch on the release line, so a patch
// moves past every tag already cut in its minor rather than reusing one.
if (index === 2) {
  const tags = execFileSync("git", ["tag", "--list", `v${parts[0]}.${parts[1]}.*`], { encoding: "utf8" });
  for (const [, patch] of tags.matchAll(/^v\d+\.\d+\.(\d+)$/gm)) if (BigInt(patch) > parts[2]) parts[2] = BigInt(patch);
}
const next = parts.map((part, i) => (i < index ? part : i === index ? part + 1n : 0n)).join(".");
// Parse every member before writing so a malformed manifest cannot leave a partial bump.
const packages = tracked()
  .filter((file) => /(^|\/)package\.json$/.test(file))
  .map((file) => [file, JSON.parse(readFileSync(file, "utf8"))]);
for (const [file, pkg] of packages) {
  if (pkg.version == null) continue;
  pkg.version = next;
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}
process.stdout.write(next);
