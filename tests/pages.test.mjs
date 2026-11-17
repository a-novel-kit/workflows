import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { step, succeeds, workspace } from "./helpers.mjs";

const assemble = step("github-pages-actions/publish-api-docs/action.yaml", "Assemble the site");

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
