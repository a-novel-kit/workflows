"""Store Playwright batches in platform folders in a Shared Drive using short-lived CI credentials."""

import hashlib
import json
import logging
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import tarfile
import urllib.error
import urllib.parse
import urllib.request

PROTOCOL = "playwright-v1"
FIELDS = "id,name,size,md5Checksum,properties,createdTime,parents"
CHUNK = 16 * 1024 * 1024


class Failure(RuntimeError):
    """A safe, operator-facing failure without credential or response payloads."""


def digest(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "md5").hexdigest()


def rank(batch):
    props = batch["properties"]
    return int(props["run_number"]), int(props["attempt"])


class GitHub:
    def __init__(self, repository, token):
        if not re.fullmatch(r"[\w.-]+/[\w.-]+", repository):
            raise Failure("Invalid repository coordinate")
        self.repository = repository
        self.token = token

    def request(self, path, *, missing=False):
        request = urllib.request.Request(
            f"https://api.github.com/repos/{self.repository}/{path}",
            headers={
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/vnd.github+json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if missing and error.code == 404:
                return None
            raise Failure(f"GitHub request failed (HTTP {error.code})") from None

    def pages(self, path):
        for page in range(1, 101):
            separator = "&" if "?" in path else "?"
            result = self.request(f"{path}{separator}per_page=100&page={page}")
            if not isinstance(result, list):
                raise Failure("Unexpected GitHub list response")
            yield from result
            if len(result) < 100:
                return
        raise Failure("GitHub pagination limit exceeded")

    def current(self, sha, run_id, attempt):
        ref = self.request("git/ref/heads/master")
        run = self.request(f"actions/runs/{run_id}")
        return (
            ref["object"]["sha"] == sha
            and run["head_sha"] == sha
            and run["head_branch"] == "master"
            and run["event"] == "push"
            and run["path"] == ".github/workflows/main.yaml"
            and run["run_attempt"] == int(attempt)
        )

    def successful_job(self, run_id, attempt, name):
        jobs = self.request(
            f"actions/runs/{int(run_id)}/attempts/{int(attempt)}/jobs?per_page=100"
        )
        if jobs["total_count"] > 100:
            raise Failure("Too many jobs to verify test completion")
        selected = [job for job in jobs["jobs"] if job["name"] == name]
        return (
            len(selected) == 1
            and selected[0]["status"] == "completed"
            and selected[0]["conclusion"] == "success"
        )

    def successful_browser_run(self, batch):
        props = batch["properties"]
        run = self.request(
            f"actions/runs/{int(props['run_id'])}/attempts/{int(props['attempt'])}"
        )
        return run["status"] == "completed" and self.successful_job(
            props["run_id"], props["attempt"], "test-browser"
        )

    def branch(self, batch):
        props = batch["properties"]
        run_id, attempt = int(props["run_id"]), int(props["attempt"])
        run = self.request(f"actions/runs/{run_id}/attempts/{attempt}", missing=True)
        if run is None:
            return None, True
        if (
            run["path"] != ".github/workflows/main.yaml"
            or run["head_repository"]["full_name"] != self.repository
            or run["head_sha"] != props["sha"]
            or run["run_number"] != int(props["run_number"])
            or run["event"] not in ("push", "merge_group")
        ):
            raise Failure("Batch provenance does not match its GitHub run")
        branch = run["head_branch"]
        ref = self.request(
            f"git/ref/heads/{urllib.parse.quote(branch, safe='')}", missing=True
        )
        if ref is None:
            return None, True
        if run["event"] == "merge_group":
            return (None, True) if run["status"] == "completed" else (branch, False)
        pulls = self.pages(
            f"pulls?state=closed&head={self.repository.split('/')[0]}:{urllib.parse.quote(branch, safe='')}"
        )
        if any(
            pr.get("merged_at") and pr["head"]["sha"] == run["head_sha"] for pr in pulls
        ):
            return None, True
        return branch, run["status"] == "completed"


class Drive:
    def __init__(self, token, repository):
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build

        logging.getLogger("googleapiclient").setLevel(logging.CRITICAL)
        self.files = build(
            "drive", "v3", credentials=Credentials(token), cache_discovery=False
        ).files()
        self.repository = repository

    def validate_folders(self, references, results, *, maintenance=False):
        """Require sibling Shared Drive folders with a read-only candidate reference boundary."""
        if references == results or any(
            not re.fullmatch(r"[\w-]+", value) for value in (references, results)
        ):
            raise Failure("Two distinct platform folder IDs are required")
        folders = [
            self.files.get(
                fileId=folder_id,
                supportsAllDrives=True,
                fields="id,mimeType,driveId,parents,trashed,capabilities",
            ).execute(num_retries=5)
            for folder_id in (references, results)
        ]
        if any(
            folder.get("mimeType") != "application/vnd.google-apps.folder"
            or folder.get("trashed")
            or not folder.get("driveId")
            or len(folder.get("parents", [])) != 1
            or folder["parents"] == [folder["driveId"]]
            or not folder.get("capabilities", {}).get("canListChildren")
            for folder in folders
        ) or any(
            folders[0].get(field) != folders[1].get(field)
            for field in ("driveId", "parents")
        ):
            raise Failure(
                "Use accessible references/results folders under one platform folder in a Shared Drive"
            )
        reference_access, result_access = [folder["capabilities"] for folder in folders]
        if not result_access.get("canAddChildren"):
            raise Failure("The identity cannot upload platform results")
        if maintenance:
            if not all(
                access.get("canAddChildren") and access.get("canDeleteChildren")
                for access in (reference_access, result_access)
            ):
                raise Failure(
                    "Maintenance must publish and permanently delete platform batches"
                )
        elif reference_access.get("canAddChildren") or reference_access.get(
            "canDeleteChildren"
        ):
            raise Failure(
                "Candidate CI must have read-only access to the reference folder"
            )

    def batches(self, folder_id):
        page = None
        batches = []
        while True:
            result = self.files.list(
                # Folder-only shares do not make CI a Shared Drive member.
                corpora="user",
                supportsAllDrives=True,
                includeItemsFromAllDrives=True,
                pageSize=1000,
                pageToken=page,
                q=f"'{folder_id}' in parents and trashed = false and properties has {{ key='protocol' and value='{PROTOCOL}' }} and properties has {{ key='repository' and value='{self.repository}' }}",
                fields=f"nextPageToken,incompleteSearch,files({FIELDS})",
            ).execute(num_retries=5)
            if result.get("incompleteSearch"):
                raise Failure("Drive returned an incomplete batch list")
            batches.extend(result.get("files", []))
            page = result.get("nextPageToken")
            if not page:
                return batches

    def remove(self, batch):
        from googleapiclient.errors import HttpError

        try:
            self.files.delete(fileId=batch["id"], supportsAllDrives=True).execute(
                num_retries=5
            )
        except HttpError as error:
            if error.resp.status != 404:
                raise

    def mark_current(self, batch):
        props = dict(batch["properties"], state="current")
        self.files.update(
            fileId=batch["id"], supportsAllDrives=True, body={"properties": props}
        ).execute(num_retries=5)
        batch["properties"] = props

    def upload(self, folder_id, archive, props, identity_file):
        from googleapiclient.errors import HttpError
        from googleapiclient.http import MediaFileUpload

        identity_file = Path(identity_file)
        if identity_file.exists():
            file_id = identity_file.read_text().strip()
        else:
            file_id = self.files.generateIds(
                count=1, space="drive", type="files"
            ).execute(num_retries=5)["ids"][0]
            identity_file.write_text(file_id)
        metadata = {
            "id": file_id,
            "name": f"playwright-{props['run_number']}-{props['attempt']}.tar",
            "parents": [folder_id],
            "properties": dict(
                props, protocol=PROTOCOL, repository=self.repository, state="pending"
            ),
        }
        request = self.files.create(
            supportsAllDrives=True,
            body=metadata,
            fields=FIELDS,
            media_body=MediaFileUpload(
                str(archive),
                mimetype="application/x-tar",
                chunksize=CHUNK,
                resumable=True,
            ),
        )
        try:
            batch = request.execute(num_retries=5)
        except HttpError as error:
            if error.resp.status != 409:
                raise
            batch = self.files.get(
                fileId=file_id, supportsAllDrives=True, fields=FIELDS
            ).execute(num_retries=5)
        if (
            batch.get("md5Checksum") != digest(archive)
            or int(batch.get("size", -1)) != Path(archive).stat().st_size
        ):
            raise Failure("Uploaded batch checksum or size does not match")
        if dict(batch.get("properties", {}), state="pending") != metadata[
            "properties"
        ] or batch.get("parents") != [folder_id]:
            raise Failure("Uploaded batch provenance does not match")
        return batch

    def download(self, batch, target):
        from googleapiclient.http import MediaIoBaseDownload

        with Path(target).open("wb") as destination:
            downloader = MediaIoBaseDownload(
                destination,
                self.files.get_media(fileId=batch["id"], supportsAllDrives=True),
                chunksize=CHUNK,
            )
            done = False
            while not done:
                _, done = downloader.next_chunk(num_retries=5)
        if digest(target) != batch.get("md5Checksum"):
            raise Failure("Downloaded reference checksum does not match")


def current_reference(batches):
    current = [
        batch for batch in batches if batch["properties"].get("state") == "current"
    ]
    return max(current, key=rank) if current else None


def promote(drive, github, references_id, batch):
    """Promote only a complete successful master upload from the protected references folder."""
    props = batch["properties"]
    if not github.successful_browser_run(batch) or not github.current(
        props["sha"], props["run_id"], props["attempt"]
    ):
        return False
    drive.mark_current(batch)
    for old in drive.batches(references_id):
        if old["id"] != batch["id"] and rank(old) <= rank(batch):
            drive.remove(old)
    return True


def cleanup(drive, github, results_id, references_id):
    """Keep one completed batch per live branch and the current master reference."""
    references = drive.batches(references_id)
    for batch in sorted(references, key=rank, reverse=True):
        if batch["properties"].get("state") == "pending" and promote(
            drive, github, references_id, batch
        ):
            break
    references = drive.batches(references_id)
    current = current_reference(references)
    for batch in references:
        if current and batch["id"] != current["id"] and rank(batch) <= rank(current):
            drive.remove(batch)
        elif batch["properties"].get("state") == "pending":
            _, completed = github.branch(batch)
            if completed:
                drive.remove(batch)

    by_branch = {}
    for batch in drive.batches(results_id):
        branch, completed = github.branch(batch)
        if branch is None:
            drive.remove(batch)
        elif completed:
            by_branch.setdefault(branch, []).append(batch)
    for branch_name, batches in by_branch.items():
        newest = max(batches, key=rank)
        # Recheck deletion/merge after listing, before publishing the retained batch.
        branch, completed = github.branch(newest)
        if branch_name == "master" and current and rank(newest) <= rank(current):
            branch = None
        if branch is not None and completed:
            drive.mark_current(newest)
        for batch in batches:
            if branch is None or batch["id"] != newest["id"]:
                drive.remove(batch)


def extract_snapshots(archive, destination):
    """Read only regular PNG snapshots; no archive path can escape the destination."""
    destination = Path(destination)
    count = 0
    with tarfile.open(archive) as source:
        for member in source:
            path = PurePosixPath(member.name)
            if path.parts[:1] != ("snapshots",):
                continue
            if member.isdir():
                continue
            if (
                not member.isfile()
                or ".." in path.parts
                or path.is_absolute()
                or path.suffix != ".png"
            ):
                raise Failure("Unsafe snapshot archive entry")
            target = destination.joinpath(*path.parts[1:])
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as data, target.open("wb") as output:
                shutil.copyfileobj(data, output, length=CHUNK)
            count += 1
    if not count:
        raise Failure("Reference batch contains no screenshots")


def main():
    mode = sys.argv[1]
    repository = os.environ["GITHUB_REPOSITORY"]
    github = GitHub(repository, os.environ["GH_TOKEN"])
    drive = Drive(os.environ["DRIVE_TOKEN"], repository)
    references = os.environ["REFERENCES_FOLDER"]
    results = os.environ["RESULTS_FOLDER"]
    drive.validate_folders(
        references, results, maintenance=mode in ("stage", "cleanup")
    )
    workspace = Path(os.environ["RUNNER_TEMP"]) / "playwright-drive"
    workspace.mkdir(exist_ok=True)
    if mode == "download":
        from googleapiclient.errors import HttpError

        snapshots = Path(".visual/snapshots")
        if snapshots.exists():
            raise Failure("Reference download requires a fresh snapshot directory")
        snapshots.mkdir(parents=True)
        seed = False
        baseline = None
        for attempt in range(3):
            batch = current_reference(drive.batches(references))
            if batch is None:
                seed = (
                    os.environ.get("SEED_SHA") == os.environ["GITHUB_SHA"]
                    and os.environ.get("GITHUB_REF") == "refs/heads/master"
                    and os.environ.get("GITHUB_EVENT_NAME") == "push"
                    and github.current(
                        os.environ["GITHUB_SHA"],
                        os.environ["GITHUB_RUN_ID"],
                        os.environ["GITHUB_RUN_ATTEMPT"],
                    )
                )
                if not seed:
                    raise Failure(
                        "No reference exists; explicit master seeding is required"
                    )
                break
            try:
                drive.download(batch, workspace / "reference.tar")
                extract_snapshots(workspace / "reference.tar", snapshots)
                (workspace / "reference.tar").unlink()
                baseline = batch["properties"]["sha"]
                break
            except HttpError as error:
                if error.resp.status != 404 or attempt == 2:
                    raise
        Path(".visual/context.json").write_text(
            json.dumps({"baseline": baseline, "seed": seed})
        )
        with open(os.environ["GITHUB_ENV"], "a") as env:
            env.write(
                f"VISUAL_SEED={str(seed).lower()}\nPLAYWRIGHT_SNAPSHOT_DIR=.visual/snapshots\nPLAYWRIGHT_VISUAL_REPORT=.visual/results.json\n"
            )
    elif mode in ("upload", "stage"):
        props = {
            "sha": os.environ["GITHUB_SHA"],
            "run_id": os.environ["GITHUB_RUN_ID"],
            "run_number": os.environ["GITHUB_RUN_NUMBER"],
            "attempt": os.environ["GITHUB_RUN_ATTEMPT"],
        }
        archive = Path(os.environ["BATCH_ARCHIVE"])
        if mode == "stage":
            if not github.current(props["sha"], props["run_id"], props["attempt"]):
                raise Failure("Superseded master run cannot stage references")
            batch = drive.upload(references, archive, props, workspace / "reference-id")
        else:
            batch = drive.upload(results, archive, props, workspace / "result-id")
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
            summary.write(
                f"\n[Private Playwright batch](https://drive.google.com/file/d/{batch['id']}/view)\n"
            )
    elif mode == "cleanup":
        cleanup(drive, github, results, references)
    else:
        raise Failure("Unknown storage operation")


if __name__ == "__main__":
    try:
        main()
    except Failure as error:
        print(f"::error::{error}", file=sys.stderr)
        sys.exit(1)
    except Exception:
        # Client errors can contain resumable session URLs; keep those out of public logs.
        print(
            "::error::Drive operation failed; check API access and quota in the private consoles",
            file=sys.stderr,
        )
        sys.exit(1)
