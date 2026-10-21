import assert from "node:assert/strict";
import { test } from "node:test";
import { step, succeeds, workspace } from "./helpers.mjs";

const manifest = "publish-actions/npm/action.yaml";
const pack = step(manifest, "pack");
const publish = step(manifest, "Publish the attested tarballs");

const packages = [
  { name: "root", version: "1.2.3", path: "/repo", private: true },
  { name: "@a-novel-kit/uikit", version: "1.2.3", path: "/repo/packages/uikit", private: false },
  { name: "@a-novel-kit/uikit-tokens", version: "1.2.3", path: "/repo/packages/tokens", private: false },
  { name: "@a-novel-kit/uikit-workbench", version: "1.2.3", path: "/repo/packages/workbench", private: true },
];

test("publish npm packs and publishes only the public versions the registry lacks", (t) => {
  const w = workspace(t);
  w.write("output", "");
  w.stub(
    "pnpm",
    `const args = process.argv.slice(2);
    const fs = require("fs");
    if (args[1] === "ls") console.log(process.env.PACKAGES);
    else {
      const name = args[1].split("/").at(-1);
      fs.writeFileSync(args.at(-1) + "/" + name + ".tgz", name);
    }`
  );
  w.stub(
    "npm",
    `const args = process.argv.slice(2);
    require("fs").appendFileSync(process.env.NPM_LOG, args.join(" ") + "\\n");
    // A re-run finds the version an earlier attempt published.
    if (args[0] === "view") process.exit(args[1] === "@a-novel-kit/uikit-tokens@1.2.3" ? 0 : 1);`
  );
  const env = { RUNNER_TEMP: w.cwd, PACKAGES: JSON.stringify(packages), NPM_LOG: `${w.cwd}/npm.log` };
  const out = succeeds(w.bash(pack, env));
  assert.match(out, /@a-novel-kit\/uikit-tokens@1\.2\.3 is already published\./);
  assert.match(w.read("output"), new RegExp(`^dir=${w.cwd}/npm$`, "m"));
  assert.match(w.read("output"), /^count=1$/m);

  succeeds(w.bash(publish, { ...env, DIR: `${w.cwd}/npm` }));
  const published = w
    .read("npm.log")
    .split("\n")
    .filter((line) => line.startsWith("publish"));
  assert.deepEqual(published, [`publish ${w.cwd}/npm/uikit.tgz --access public`]);
});
