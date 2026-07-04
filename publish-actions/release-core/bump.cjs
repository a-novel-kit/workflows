// Bump the release version across this repo's package.json files.
//
// Why Node and not `pnpm version`: in CI (a cold pnpm store) `pnpm version`
// triggers pnpm's supply-chain verification ("Verifying lockfile against
// supply-chain policies"), which fails a release whenever any transitive dep is
// younger than `minimumReleaseAge` — a race that has nothing to do with cutting
// a release. The `--config.*` flags don't reach that verification path. A
// package's own version isn't recorded in pnpm-lock.yaml (the lockfile tracks
// dependencies, not the importer's version), so a release bump only has to
// rewrite the `version` field — no dependency resolution, hence no supply-chain
// pass. This also sidesteps `pnpm version`'s clean-tree requirement.
//
// Reads RELEASE_TYPE (patch|minor|major) from the env; writes the new version
// to stdout. Bumps the root and every workspace member to a single version.
const fs = require("fs");
const cp = require("child_process");

const type = process.env.RELEASE_TYPE;
if (!["patch", "minor", "major"].includes(type)) {
  console.error(`release_type must be patch, minor, or major (got '${type}')`);
  process.exit(1);
}

// Every tracked package.json: the root plus any workspace members. node_modules
// is gitignored so it never appears; the basename filter drops lookalikes such
// as `mypackage.json` that the `*package.json` pathspec would otherwise match.
const files = cp
  .execSync("git ls-files '*package.json'", { encoding: "utf8" })
  .split("\n")
  .filter((f) => f === "package.json" || f.endsWith("/package.json"));

const root = JSON.parse(fs.readFileSync("package.json", "utf8"));
let [major, minor, patch] = root.version.split(".").map(Number);
if (type === "major") {
  major += 1;
  minor = 0;
  patch = 0;
} else if (type === "minor") {
  minor += 1;
  patch = 0;
} else {
  patch += 1;
}
const next = `${major}.${minor}.${patch}`;

for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const current = JSON.parse(text).version;
  if (current == null) continue; // a member package.json may omit a version
  // Swap only the value, so the file's exact formatting (and the key order
  // prettier-plugin-packagejson enforces) survives untouched.
  fs.writeFileSync(file, text.replace(`"version": ${JSON.stringify(current)}`, `"version": ${JSON.stringify(next)}`));
}

process.stdout.write(next);
