// Exercise the real HTTP client with deterministic Drive responses and buffered request bodies.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { mock, test } from "node:test";
import { Failure } from "../node-actions/test-playwright/drive/common.mjs";
import { CHUNK, Drive, PROTOCOL, digest } from "../node-actions/test-playwright/drive/storage.mjs";
const repository = "a-novel/platform-studio";
const session = "https://www.googleapis.com/upload/drive/v3/files?upload_id=private-session";
const props = { run_id: "10", run_number: "2", attempt: "1", sha: "a".repeat(40) };

function client(responses) {
  const calls = [];
  // Each client replaces the previous stub, so a test sees only its own responses.
  mock.restoreAll();
  mock.method(globalThis, "fetch", async (url, init) => {
    const response = responses.shift();
    assert.ok(response, `Unexpected ${init.method ?? "GET"} ${url.pathname}`);
    const call = { ...init, url, headers: new Headers(init.headers) };
    calls.push(call);
    await response.check?.(call);
    if (response.error) throw response.error;
    return new Response(response.body ?? JSON.stringify(response.data ?? {}), {
      status: response.status ?? 200,
      headers: response.headers,
    });
  });
  return { drive: new Drive("private-token", repository), calls, responses };
}
function folders(maintenance = false) {
  return ["references", "results"].map((id) => ({
    id,
    mimeType: "application/vnd.google-apps.folder",
    driveId: "shared-drive",
    parents: ["platform-studio"],
    trashed: false,
    capabilities: {
      canListChildren: true,
      canAddChildren: maintenance || id === "results",
      canDeleteChildren: maintenance,
    },
  }));
}
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), "drive-client-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function sparse(path, size) {
  const file = await open(path, "w");
  try {
    await file.truncate(size);
  } finally {
    await file.close();
  }
}
async function result(archive) {
  return {
    id: "batch-id",
    parents: ["results"],
    size: String((await stat(archive)).size),
    md5Checksum: await digest(archive),
    properties: { ...props, state: "pending", protocol: PROTOCOL, repository },
  };
}
function sent(call, expectedRange, expectedLength) {
  assert.equal(call.headers.get("content-range"), expectedRange);
  // fetch derives Content-Length from a Buffer, and a probe sends no body.
  assert.ok(expectedLength ? Buffer.isBuffer(call.body) && call.body.length <= CHUNK : call.body === undefined);
  assert.equal(call.body?.length ?? 0, expectedLength);
}

test("folder-only candidate and maintenance access is accepted", async () => {
  for (const maintenance of [false, true]) {
    const { drive } = client(folders(maintenance).map((data) => ({ data })));
    await drive.validateFolders("references", "results", maintenance);
  }
});
test("candidate folder shares work when Drive hides their parents", async () => {
  for (const hidden of [[0], [1], [0, 1]]) {
    const values = folders();
    for (const index of hidden) delete values[index].parents;
    await client(values.map((data) => ({ data }))).drive.validateFolders("references", "results");
  }
});
test("maintenance requires visible sibling parents even with deletion access", async () => {
  for (const hidden of [[0], [1], [0, 1]]) {
    const values = folders(true);
    for (const index of hidden) delete values[index].parents;
    await assert.rejects(
      client(values.map((data) => ({ data }))).drive.validateFolders("references", "results", true),
      Failure
    );
  }
});
test("hidden parents do not weaken candidate storage or reference access checks", async () => {
  for (const invalid of [
    { id: "shared-drive" },
    { driveId: "other-drive" },
    { capabilities: { canListChildren: true, canAddChildren: true } },
    { capabilities: { canListChildren: true, canDeleteChildren: true } },
  ]) {
    const values = folders();
    for (const folder of values) delete folder.parents;
    Object.assign(values[0], invalid);
    await assert.rejects(
      client(values.map((data) => ({ data }))).drive.validateFolders("references", "results"),
      Failure
    );
  }
});
test("wrong storage and reference write access are rejected", async () => {
  for (const invalid of [
    { driveId: null },
    { parents: ["other-platform"] },
    { parents: ["shared-drive"] },
    { parents: [] },
    { parents: null },
    { mimeType: "application/x-tar" },
    { trashed: true },
    { capabilities: { canListChildren: true, canAddChildren: true } },
  ]) {
    const values = folders();
    Object.assign(values[0], invalid);
    await assert.rejects(
      client(values.map((data) => ({ data }))).drive.validateFolders("references", "results"),
      Failure
    );
  }
  await assert.rejects(client([]).drive.validateFolders("same", "same"), Failure);
  await assert.rejects(
    client(folders().map((data) => ({ data }))).drive.validateFolders("references", "results", true),
    Failure
  );
});
test("listing is scoped to platform, protocol and repository, including every page", async () => {
  const { drive, calls } = client([
    { data: { nextPageToken: "next", files: [{ id: "one" }] } },
    { data: { files: [{ id: "two" }] } },
  ]);
  assert.deepEqual(
    (await drive.batches("studio-results")).map((batch) => batch.id),
    ["one", "two"]
  );
  const query = new URL(calls[0].url).searchParams;
  assert.equal(query.get("corpora"), "user");
  assert.equal(query.has("driveId"), false);
  assert.ok(query.get("q").includes("'studio-results' in parents"));
  assert.ok(query.get("q").includes("key='repository' and value='a-novel/platform-studio'"));
  assert.ok(query.get("q").includes("key='protocol'"));
  assert.equal(new URL(calls[1].url).searchParams.get("pageToken"), "next");
  await assert.rejects(client([{ data: { incompleteSearch: true, files: [] } }]).drive.batches("results"), Failure);
});
test("transient failures retry within a bounded budget while others fail at once", async () => {
  const recovered = client([{ status: 503 }, { status: 429 }, { data: { ids: ["batch-id"] } }]);
  assert.deepEqual(await recovered.drive.files("/generateIds"), { ids: ["batch-id"] });
  // Failures without a response share the attempt count and stop after two retries.
  const network = new TypeError("fetch failed");
  const offline = client([{ error: network }, { status: 503 }, { error: network }]);
  await assert.rejects(offline.drive.files(""), network);
  assert.equal(offline.responses.length, 0);
  const denied = client([{ status: 403 }, { data: {} }]);
  await assert.rejects(denied.drive.files(""), (error) => error.status === 403);
  assert.equal(denied.responses.length, 1);
});
test("resumes at the server-confirmed offset after an ambiguous chunk failure", async (t) => {
  const dir = await directory(t),
    archive = join(dir, "batch.tar"),
    size = CHUNK + 1024;
  await sparse(archive, size);
  const metadata = await result(archive);
  const { drive, responses } = client([
    { data: { ids: ["batch-id"] } },
    { headers: { location: session } },
    { status: 503, check: (call) => sent(call, `bytes 0-${CHUNK - 1}/${size}`, CHUNK) },
    {
      status: 308,
      headers: { range: `bytes=0-${CHUNK / 2 - 1}` },
      check: (call) => sent(call, `bytes */${size}`, 0),
    },
    {
      data: metadata,
      check: (call) => sent(call, `bytes ${CHUNK / 2}-${size - 1}/${size}`, size - CHUNK / 2),
    },
  ]);
  assert.equal((await drive.upload("results", archive, props, join(dir, "id"))).md5Checksum, metadata.md5Checksum);
  assert.equal(await readFile(join(dir, "id"), "utf8"), "batch-id");
  assert.equal(responses.length, 0);
});
test("unknown creation outcomes recover the preallocated file and verify provenance", async (t) => {
  const dir = await directory(t),
    archive = join(dir, "batch.tar"),
    identity = join(dir, "id");
  await writeFile(archive, "complete archive");
  await writeFile(identity, "batch-id");
  const metadata = await result(archive);
  assert.equal(
    (await client([{ status: 409 }, { data: metadata }]).drive.upload("results", archive, props, identity)).id,
    "batch-id"
  );
  for (const invalid of [{ parents: ["another-platform-results"] }, { md5Checksum: "0".repeat(32) }, { size: "1" }]) {
    await assert.rejects(
      client([{ status: 409 }, { data: { ...metadata, ...invalid } }]).drive.upload(
        "results",
        archive,
        props,
        identity
      ),
      Failure
    );
  }
});
test("expired upload sessions and untrusted session URLs cannot publish", async (t) => {
  const dir = await directory(t),
    archive = join(dir, "batch.tar"),
    identity = join(dir, "id");
  await writeFile(archive, "archive");
  await writeFile(identity, "batch-id");
  await assert.rejects(
    client([{ headers: { location: "https://attacker.test/upload" } }]).drive.upload(
      "results",
      archive,
      props,
      identity
    ),
    Failure
  );
  await assert.rejects(
    client([{ headers: { location: session } }, { status: 404 }]).drive.upload("results", archive, props, identity),
    (error) => error.status === 404
  );
});
test("uploads a 4 GiB batch in bounded chunks with offsets beyond 32 bits", async (t) => {
  const dir = await directory(t),
    archive = join(dir, "large.tar"),
    size = 4 * 1024 ** 3 + 1024;
  await sparse(archive, size);
  const responses = [];
  for (let offset = 0; offset < size; offset += CHUNK) {
    const start = offset,
      end = Math.min(offset + CHUNK, size);
    responses.push({
      status: end === size ? 200 : 308,
      data: { id: "large" },
      headers: { range: `bytes=0-${end - 1}` },
      check: (call) => sent(call, `bytes ${start}-${end - 1}/${size}`, end - start),
    });
  }
  const { drive } = client(responses);
  assert.equal((await drive.sendArchive(session, archive, size)).id, "large");
  assert.equal(responses.length, 0);
});
test("native fetch exposes resumable progress and sends exact chunk lengths", async (t) => {
  mock.restoreAll();
  const dir = await directory(t),
    archive = join(dir, "batch.tar");
  await writeFile(archive, "0123456789");
  const received = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push([request.headers["content-length"], request.headers["content-range"], body]);
    // Drive answers an incomplete upload with 308 and no Location header.
    if (received.length === 1) response.writeHead(308, { range: "bytes=0-4" }).end();
    else response.writeHead(200, { "content-type": "application/json" }).end('{"id":"batch-id"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/upload`;
  assert.deepEqual(await new Drive("private-token", repository).sendArchive(url, archive, 10), { id: "batch-id" });
  assert.deepEqual(received, [
    ["10", "bytes 0-9/10", "0123456789"],
    ["5", "bytes 5-9/10", "56789"],
  ]);
});
test("downloads resume after interrupted bodies and verify checksum", async (t) => {
  const dir = await directory(t),
    target = join(dir, "reference.tar");
  const broken = ReadableStream.from(
    (async function* () {
      yield Buffer.from("p");
      throw new Error("connection reset");
    })()
  );
  const checksum = createHash("md5").update("png").digest("hex");
  const { drive } = client([
    { status: 206, headers: { "content-range": "bytes 0-2/3" }, body: broken },
    { status: 206, headers: { "content-range": "bytes 0-2/3" }, body: "png" },
  ]);
  await drive.download({ id: "reference", size: "3", md5Checksum: checksum }, target);
  assert.equal(await readFile(target, "utf8"), "png");
  await assert.rejects(
    client([{ status: 206, headers: { "content-range": "bytes 0-2/3" }, body: "bad" }]).drive.download(
      { id: "reference", size: "3", md5Checksum: checksum },
      target
    ),
    /checksum/
  );
});

test("whole-file responses are accepted only within the requested chunk", async (t) => {
  const dir = await directory(t),
    target = join(dir, "reference.tar");
  const checksum = createHash("md5").update("png").digest("hex");
  await client([{ headers: { "content-length": "3" }, body: "png" }]).drive.download(
    { id: "reference", size: "3", md5Checksum: checksum },
    target
  );
  const body = Readable.from([Buffer.from("unrequested data")]);
  await assert.rejects(
    client([{ headers: { "content-length": String(CHUNK + 1) }, body: Readable.toWeb(body) }]).drive.download(
      { id: "reference", size: String(CHUNK + 1), md5Checksum: checksum },
      target
    ),
    /range/
  );
  assert.equal(body.destroyed, true);
});
