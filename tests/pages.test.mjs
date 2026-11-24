import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { manifest, step, succeeds, workspace } from "./helpers.mjs";

const assemble = step("github-pages-actions/publish-api-docs/action.yaml", "Assemble the site");

test("deploy uploads the site once and retries only the deployment", () => {
  const action = manifest("github-pages-actions/deploy/action.yaml");
  const steps = action.runs.steps;
  // A second upload leaves two artifacts of one name, which no deployment attempt can tell apart.
  assert.equal(steps.filter((s) => s.uses?.startsWith("actions/upload-pages-artifact@")).length, 1);
  // Each retry repeats the first attempt and runs only when the one before it failed; the last fails the job.
  const attempts = steps.filter((s) => s.uses?.startsWith("actions/deploy-pages@"));
  assert.equal(attempts.length, 3);
  for (const [i, attempt] of attempts.entries()) {
    assert.equal(attempt.uses, attempts[0].uses);
    assert.equal(attempt["continue-on-error"], i < attempts.length - 1 ? true : undefined);
    if (i > 0) assert.equal(attempt.if, `\${{ steps.${attempts[i - 1].id}.outcome == 'failure' }}`);
  }
  // The page URL comes from whichever attempt deployed.
  const urls = attempts.map((attempt) => `steps.${attempt.id}.outputs.page_url`);
  assert.equal(action.outputs.page_url.value, `\${{ ${urls.join(" || ")} }}`);
});

test("publish-api-docs deploys the REST reference, and the gRPC document only when titled", (t) => {
  const w = workspace(t);
  w.stub("buf", "require('fs').writeFileSync('buf-ran', '');");
  w.write("openapi.html", "<html></html>\n");
  succeeds(w.bash(assemble, { GRPC_TITLE: "", RUNNER_TEMP: w.cwd }));
  assert.deepEqual(readdirSync(join(w.cwd, "_site")), ["index.html"]);
  assert.equal(w.read("_site/index.html"), "<html></html>\n");
  assert.equal(existsSync(join(w.cwd, "buf-ran")), false);
});

test("publish-api-docs names the gRPC document and drops what the converter adds", (t) => {
  const w = workspace(t);
  const converted = {
    info: { title: "", version: "" },
    paths: { "/keys.v1.Keys/Get": { post: { parameters: [{ name: "Connect-Protocol-Version" }], summary: "Get" } } },
    components: {
      schemas: {
        "connect-protocol-version": { type: "number" },
        "connect-timeout-header": { type: "number" },
        "keys.v1.Key": { type: "object", properties: { id: { title: "id", type: "string" } } },
      },
    },
  };
  w.stub(
    "buf",
    `const a = process.argv; require('fs').writeFileSync(a[a.indexOf('-o') + 1] + '/grpc.openapi.json', process.env.CONVERTED);`
  );
  w.write("openapi.html", "<html></html>\n");
  w.write("openapi.yaml", "openapi: 3.1.0\n");
  w.write("package.json", '{"version": "2.15.8"}\n');
  succeeds(
    w.bash(assemble, { GRPC_TITLE: "JSON Keys gRPC API", RUNNER_TEMP: w.cwd, CONVERTED: JSON.stringify(converted) })
  );
  assert.deepEqual(readdirSync(join(w.cwd, "_site")).sort(), ["grpc.openapi.json", "index.html", "openapi.yaml"]);
  assert.deepEqual(JSON.parse(w.read("_site/grpc.openapi.json")), {
    info: { title: "JSON Keys gRPC API", version: "v2.15.8" },
    paths: { "/keys.v1.Keys/Get": { post: { summary: "Get" } } },
    components: { schemas: { "keys.v1.Key": { type: "object", properties: { id: { type: "string" } } } } },
  });
});
