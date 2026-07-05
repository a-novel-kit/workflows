// Release planner: rewrite in-repo version references (stamps) and print the
// tags to cut, one per line.
//
// package.json is the source of truth for the version (bump.cjs already bumped
// it). On top of that, each ecosystem in LANGUAGES declares:
//   • stamps  — {files, pattern, replace}: point in-repo version refs at the new version
//   • subtags — dirs that get their own <dir>/vX.Y.Z tag (independently-resolved sub-modules)
// A root vX.Y.Z tag is ALWAYS emitted, so a repo can never end up with only
// sub-tags. Support a new ecosystem by appending one entry — no shell changes.

const fs = require("fs");
const cp = require("child_process");
const path = require("path");

const tracked = cp.execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const goMod = /(^|\/)go\.mod$/;
const goMods = () => tracked.filter((f) => goMod.test(f));
// This repo's own module root, e.g. github.com/a-novel-kit/stack.
const goModulePath = `github.com/${process.env.GITHUB_REPOSITORY || ""}`;

const LANGUAGES = [
  {
    name: "go",
    // Each nested go.mod is resolved independently as <dir>/vX.Y.Z; a root go.mod
    // (dir ".") shares the root tag.
    subtags: () =>
      goMods()
        .map((f) => path.dirname(f))
        .filter((d) => d !== "."),
    stamps: [
      {
        // In-repo inter-module requires → the freshly-cut version. The (?![-.\d])
        // guard leaves pseudo-versions (v0.0.0-<ts>-<sha>) and pre-releases alone.
        files: goMods,
        pattern: new RegExp(`(${esc(goModulePath)}\\S*\\s+)v\\d+\\.\\d+\\.\\d+(?![-.\\d])`, "g"),
        replace: `$1v${version}`,
      },
    ],
  },
  {
    // JS packages share the root tag; bump.cjs already stamped every package.json
    // and prepublish:doc handles docs — nothing extra here.
    name: "node",
    subtags: () => [],
    stamps: [],
  },
];

for (const lang of LANGUAGES) {
  for (const s of lang.stamps) {
    for (const f of s.files()) {
      const before = fs.readFileSync(f, "utf8");
      const after = before.replace(s.pattern, s.replace);
      if (after !== before) fs.writeFileSync(f, after);
    }
  }
}

const tags = new Set([`v${version}`]);
for (const lang of LANGUAGES) {
  for (const dir of lang.subtags()) tags.add(`${dir}/v${version}`);
}
process.stdout.write([...tags].join("\n"));
