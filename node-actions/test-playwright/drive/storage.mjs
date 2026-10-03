// Store immutable Playwright batches in Shared Drive folders with short-lived CI credentials.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { appendFile, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { Gaxios } from "gaxios";
import * as tar from "tar";
import { Failure, GitHub, runCli } from "./common.mjs";

export const PROTOCOL = "playwright-v1";
export const CHUNK = 16 * 1024 * 1024;
const FIELDS = "id,name,size,md5Checksum,properties,createdTime,parents";
const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

/** Hash archives without buffering their contents. */
export async function digest(path) {
  const hash = createHash("md5");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

function rank(a, b) {
  return (
    Number(a.properties.run_number) - Number(b.properties.run_number) ||
    Number(a.properties.attempt) - Number(b.properties.attempt)
  );
}

/** Keep all requests scoped to the configured platform and repository. */
export class Drive {
  constructor(token, repository, client = new Gaxios()) {
    this.repository = repository;
    this.client = client;
    this.token = token;
  }

  request(url, options = {}) {
    return this.client.request({
      url,
      timeout: 60_000,
      maxRedirects: 0,
      retry: true,
      retryConfig: { retry: 5, httpMethodsToRetry: ["GET", "POST", "PATCH", "DELETE"] },
      ...options,
      headers: { Authorization: `Bearer ${this.token}`, ...options.headers },
    });
  }

  async files(path = "", params = {}, options = {}) {
    return (await this.request(`${API}${path}`, { params: { supportsAllDrives: true, ...params }, ...options })).data;
  }

  async validateFolders(references, results, maintenance = false) {
    if (references === results || [references, results].some((id) => !/^[\w-]+$/.test(id))) {
      throw new Failure("Two distinct platform folder IDs are required");
    }
    const folders = await Promise.all(
      [references, results].map((id) =>
        this.files(`/${id}`, { fields: "id,mimeType,driveId,parents,trashed,capabilities" })
      )
    );
    // Drive hides parents from folder-only shares; maintenance must verify the full hierarchy.
    const parentsVisible = folders.every((folder) => folder.parents !== undefined);
    if (
      folders.some(
        (folder) =>
          folder.mimeType !== "application/vnd.google-apps.folder" ||
          folder.trashed ||
          !folder.driveId ||
          folder.id === folder.driveId ||
          (folder.parents !== undefined &&
            (!Array.isArray(folder.parents) || folder.parents.length !== 1 || folder.parents[0] === folder.driveId)) ||
          !folder.capabilities?.canListChildren
      ) ||
      folders[0].driveId !== folders[1].driveId ||
      (maintenance && !parentsVisible) ||
      (parentsVisible && !isDeepStrictEqual(folders[0].parents, folders[1].parents))
    ) {
      throw new Failure("Use accessible references/results folders under one platform folder in a Shared Drive");
    }
    const [referenceAccess, resultAccess] = folders.map((folder) => folder.capabilities);
    if (!resultAccess.canAddChildren) throw new Failure("The identity cannot upload platform results");
    if (maintenance) {
      if (![referenceAccess, resultAccess].every((access) => access.canAddChildren && access.canDeleteChildren)) {
        throw new Failure("Maintenance must publish and permanently delete platform batches");
      }
    } else if (referenceAccess.canAddChildren || referenceAccess.canDeleteChildren) {
      throw new Failure("Candidate CI must have read-only access to the reference folder");
    }
  }

  async batches(folderId) {
    const batches = [];
    let pageToken;
    do {
      const result = await this.files("", {
        // Folder-only shares do not make CI a Shared Drive member.
        corpora: "user",
        includeItemsFromAllDrives: true,
        pageSize: 1000,
        pageToken,
        q: `'${folderId}' in parents and trashed = false and properties has { key='protocol' and value='${PROTOCOL}' } and properties has { key='repository' and value='${this.repository}' }`,
        fields: `nextPageToken,incompleteSearch,files(${FIELDS})`,
      });
      if (result.incompleteSearch) throw new Failure("Drive returned an incomplete batch list");
      batches.push(...(result.files ?? []));
      pageToken = result.nextPageToken;
    } while (pageToken);
    return batches;
  }

  async remove(batch) {
    try {
      await this.files(`/${batch.id}`, {}, { method: "DELETE" });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }

  async markCurrent(batch) {
    const properties = { ...batch.properties, state: "current" };
    await this.files(`/${batch.id}`, {}, { method: "PATCH", data: { properties } });
    batch.properties = properties;
  }

  async upload(folderId, archive, props, identityFile) {
    let fileId;
    if (existsSync(identityFile)) fileId = (await readFile(identityFile, "utf8")).trim();
    else {
      fileId = (await this.files("/generateIds", { count: 1, space: "drive", type: "files" })).ids[0];
      await writeFile(identityFile, fileId);
    }
    const metadata = {
      id: fileId,
      name: `playwright-${props.run_number}-${props.attempt}.tar`,
      parents: [folderId],
      properties: { ...props, protocol: PROTOCOL, repository: this.repository, state: "pending" },
    };
    const size = (await stat(archive)).size;
    if (!Number.isSafeInteger(size) || size <= 0) throw new Failure("Invalid archive size");
    let batch;
    try {
      const response = await this.request(UPLOAD, {
        method: "POST",
        params: { uploadType: "resumable", supportsAllDrives: true, fields: FIELDS },
        data: metadata,
        headers: { "X-Upload-Content-Type": "application/x-tar", "X-Upload-Content-Length": String(size) },
      });
      const session = new URL(response.headers.get("location"));
      if (session.origin !== "https://www.googleapis.com" || !session.pathname.startsWith("/upload/drive/")) {
        throw new Failure("Unexpected Drive upload session destination");
      }
      batch = await this.sendArchive(session.href, archive, size);
    } catch (error) {
      if (error.status !== 409) throw error;
      batch = await this.files(`/${fileId}`, { fields: FIELDS });
    }
    if (batch.md5Checksum !== (await digest(archive)) || Number(batch.size ?? -1) !== size) {
      throw new Failure("Uploaded batch checksum or size does not match");
    }
    if (
      !isDeepStrictEqual({ ...batch.properties, state: "pending" }, metadata.properties) ||
      !isDeepStrictEqual(batch.parents, [folderId])
    ) {
      throw new Failure("Uploaded batch provenance does not match");
    }
    return batch;
  }

  async sendArchive(session, archive, size) {
    let offset = 0,
      failures = 0,
      probe = false;
    for (;;) {
      const end = Math.min(offset + CHUNK, size);
      const data = probe ? undefined : createReadStream(archive, { start: offset, end: end - 1 });
      let response;
      try {
        response = await this.request(session, {
          method: "PUT",
          retry: false,
          data,
          headers: {
            "Content-Type": "application/x-tar",
            "Content-Length": String(probe ? 0 : end - offset),
            "Content-Range": probe ? `bytes */${size}` : `bytes ${offset}-${end - 1}/${size}`,
          },
          validateStatus: (status) => status === 200 || status === 201 || status === 308,
        });
      } catch (error) {
        if ((error.status && error.status !== 429 && error.status < 500) || failures++ >= 5) throw error;
        await setTimeout(Math.min(2 ** failures * 1000, 32_000));
        // A failed request may already have persisted bytes; ask Drive for the committed offset.
        probe = true;
        continue;
      } finally {
        data?.destroy();
      }
      if (response.status !== 308) return response.data;
      const range = response.headers.get("range");
      const match = range?.match(/^bytes=0-(\d+)$/);
      const next = range === null ? 0 : match ? Number(match[1]) + 1 : NaN;
      if (!Number.isSafeInteger(next) || next < offset || next > (probe ? size : end) || next >= size) {
        throw new Failure("Invalid Drive upload progress");
      }
      if (next === offset && !probe && ++failures > 5) throw new Failure("Drive upload made no progress");
      if (next > offset) failures = 0;
      offset = next;
      probe = false;
    }
  }

  async download(batch, target) {
    let offset = 0;
    const size = Number(batch.size);
    if (!Number.isSafeInteger(size) || size <= 0) throw new Failure("Invalid reference size");
    while (offset < size) {
      const end = Math.min(offset + CHUNK, size) - 1;
      for (let attempt = 0; attempt <= 5; attempt++) {
        try {
          const response = await this.request(`${API}/${batch.id}`, {
            params: { alt: "media", supportsAllDrives: true },
            responseType: "stream",
            headers: { Range: `bytes=${offset}-${end}` },
          });
          const partial =
            response.status === 206 && response.headers.get("content-range") === `bytes ${offset}-${end}/${size}`;
          const whole =
            response.status === 200 &&
            offset === 0 &&
            end === size - 1 &&
            Number(response.headers.get("content-length")) === size;
          if (!partial && !whole) {
            response.data.destroy();
            throw new Failure("Invalid Drive download range");
          }
          await pipeline(response.data, createWriteStream(target, { flags: offset ? "r+" : "w", start: offset }));
          if ((await stat(target)).size !== end + 1) throw new Failure("Downloaded reference size does not match");
          break;
        } catch (error) {
          if (error instanceof Failure || (error.status && error.status !== 429 && error.status < 500) || attempt === 5)
            throw error;
        }
      }
      offset = end + 1;
    }
    if ((await digest(target)) !== batch.md5Checksum) throw new Failure("Downloaded reference checksum does not match");
  }
}

/** Select the latest published reference, excluding incomplete uploads. */
export function currentReference(batches) {
  return (
    batches
      .filter((batch) => batch.properties.state === "current")
      .sort(rank)
      .at(-1) ?? null
  );
}

/** Publish a successful current-master upload before deleting the old reference. */
export async function promote(drive, github, referencesId, batch) {
  const props = batch.properties;
  if (!(await github.successfulBrowserRun(batch)) || !(await github.current(props.sha, props.run_id, props.attempt)))
    return false;
  await drive.markCurrent(batch);
  for (const old of await drive.batches(referencesId)) {
    if (old.id !== batch.id && rank(old, batch) <= 0) await drive.remove(old);
  }
  return true;
}

/** Retain the current master reference and one completed batch per live branch. */
export async function cleanup(drive, github, resultsId, referencesId) {
  let references = await drive.batches(referencesId);
  for (const batch of references.sort((a, b) => rank(b, a))) {
    if (batch.properties.state === "pending" && (await promote(drive, github, referencesId, batch))) break;
  }
  references = await drive.batches(referencesId);
  const current = currentReference(references);
  for (const batch of references) {
    if (current && batch.id !== current.id && rank(batch, current) <= 0) await drive.remove(batch);
    else if (batch.properties.state === "pending") {
      const [, completed] = await github.branch(batch);
      if (completed) await drive.remove(batch);
    }
  }
  const byBranch = new Map();
  for (const batch of await drive.batches(resultsId)) {
    const [branch, completed] = await github.branch(batch);
    if (branch === null) await drive.remove(batch);
    else if (completed) byBranch.set(branch, [...(byBranch.get(branch) ?? []), batch]);
  }
  for (const [branchName, batches] of byBranch) {
    const newest = batches.sort(rank).at(-1);
    // Recheck deletion/merge after listing, before publishing the retained batch.
    let [branch, completed] = await github.branch(newest);
    if (branchName === "master" && current && rank(newest, current) <= 0) branch = null;
    if (branch !== null && completed) await drive.markCurrent(newest);
    for (const batch of batches) if (branch === null || batch.id !== newest.id) await drive.remove(batch);
  }
}

/** Extract regular PNGs into a fresh destination, rejecting links and path traversal. */
export async function extractSnapshots(archive, destination) {
  await mkdir(destination, { recursive: true });
  let count = 0;
  let unsafe = false;
  await tar.x({
    file: archive,
    cwd: destination,
    strip: 1,
    strict: true,
    filter(name, entry) {
      const parts = name.split("/");
      if (parts[0] !== "snapshots" || entry.type === "Directory") return false;
      if (
        entry.type !== "File" ||
        parts.includes("..") ||
        posix.isAbsolute(name) ||
        name.includes("\\") ||
        posix.extname(name) !== ".png"
      ) {
        unsafe = true;
        return false;
      }
      count++;
      return true;
    },
  });
  if (unsafe) throw new Failure("Unsafe snapshot archive entry");
  if (!count) throw new Failure("Reference batch contains no screenshots");
}

async function main() {
  const env = process.env;
  const mode = process.argv[2];
  const github = new GitHub(env.GITHUB_REPOSITORY, env.GH_TOKEN);
  const drive = new Drive(env.DRIVE_TOKEN, env.GITHUB_REPOSITORY);
  const references = env.REFERENCES_FOLDER,
    results = env.RESULTS_FOLDER;
  await drive.validateFolders(references, results, ["stage", "cleanup"].includes(mode));
  const workspace = join(env.RUNNER_TEMP, "playwright-drive");
  await mkdir(workspace, { recursive: true });
  if (mode === "download") {
    const snapshots = ".visual/snapshots";
    if (existsSync(snapshots)) throw new Failure("Reference download requires a fresh snapshot directory");
    await mkdir(snapshots, { recursive: true });
    let seed = false,
      baseline = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const batch = currentReference(await drive.batches(references));
      if (!batch) {
        seed =
          env.SEED_SHA === env.GITHUB_SHA &&
          env.GITHUB_REF === "refs/heads/master" &&
          env.GITHUB_EVENT_NAME === "push" &&
          (await github.current(env.GITHUB_SHA, env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT));
        if (!seed) throw new Failure("No reference exists; explicit master seeding is required");
        break;
      }
      try {
        const archive = join(workspace, "reference.tar");
        await drive.download(batch, archive);
        await extractSnapshots(archive, snapshots);
        await unlink(archive);
        baseline = batch.properties.sha;
        break;
      } catch (error) {
        if (error.status !== 404 || attempt === 2) throw error;
      }
    }
    await writeFile(".visual/context.json", JSON.stringify({ baseline, seed }));
    await appendFile(
      env.GITHUB_ENV,
      `VISUAL_SEED=${seed}\nPLAYWRIGHT_SNAPSHOT_DIR=.visual/snapshots\nPLAYWRIGHT_VISUAL_REPORT=.visual/results.json\n`
    );
  } else if (["upload", "stage"].includes(mode)) {
    const props = {
      sha: env.GITHUB_SHA,
      run_id: env.GITHUB_RUN_ID,
      run_number: env.GITHUB_RUN_NUMBER,
      attempt: env.GITHUB_RUN_ATTEMPT,
    };
    if (mode === "stage" && !(await github.current(props.sha, props.run_id, props.attempt))) {
      // Master moving on mid-run is routine: the newer run stages its own reference.
      if ((await github.request("git/ref/heads/master")).object.sha === props.sha)
        throw new Failure("Only the latest main.yaml push run on master can stage references");
      await appendFile(
        env.GITHUB_STEP_SUMMARY,
        "\nMaster moved on during this run; the newer run stages the reference.\n"
      );
      return;
    }
    const batch = await drive.upload(
      mode === "stage" ? references : results,
      env.BATCH_ARCHIVE,
      props,
      join(workspace, mode === "stage" ? "reference-id" : "result-id")
    );
    await appendFile(
      env.GITHUB_STEP_SUMMARY,
      `\n[Private Playwright batch](https://drive.google.com/file/d/${batch.id}/view)\n`
    );
  } else if (mode === "cleanup") await cleanup(drive, github, results, references);
  else throw new Failure("Unknown storage operation");
}

runCli(import.meta.url, main, "Drive operation failed; check API access and quota in the private consoles");
