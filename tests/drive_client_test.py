"""Exercise the Google SDK's real resumable protocol against a fake HTTP boundary."""

import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from googleapiclient.discovery import build
from googleapiclient.http import HttpMockSequence

sys.path.insert(
    0, str(Path(__file__).resolve().parents[1] / "node-actions/test-playwright/drive")
)
from storage import CHUNK, Drive, Failure, PROTOCOL


class ClientTest(unittest.TestCase):
    def drive(self, responses):
        drive = Drive.__new__(Drive)
        drive.repository = "a-novel/platform-studio"
        drive.files = build(
            "drive", "v3", http=HttpMockSequence(responses), cache_discovery=False
        ).files()
        return drive

    def test_resumes_multiple_chunks_after_retryable_http_failure(self):
        props = {"run_id": "10", "run_number": "2", "attempt": "1", "sha": "a" * 40}
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "batch.tar"
            with archive.open("wb") as target:
                target.truncate(CHUNK + 1024)
            with archive.open("rb") as source:
                checksum = hashlib.file_digest(source, "md5").hexdigest()
            result = {
                "id": "batch-id",
                "size": str(archive.stat().st_size),
                "md5Checksum": checksum,
                "properties": dict(
                    props,
                    state="pending",
                    protocol=PROTOCOL,
                    repository="a-novel/platform-studio",
                ),
            }
            drive = self.drive(
                [
                    ({"status": "200"}, b'{"ids":["batch-id"]}'),
                    (
                        {
                            "status": "200",
                            "location": "https://upload.example.test/session",
                        },
                        b"",
                    ),
                    ({"status": "503"}, b"{}"),
                    ({"status": "308", "range": f"bytes=0-{CHUNK - 1}"}, b""),
                    ({"status": "200"}, json.dumps(result).encode()),
                ]
            )
            with patch("time.sleep"):
                uploaded = drive.upload(
                    "results", archive, props, Path(directory) / "id"
                )
            self.assertEqual(uploaded["md5Checksum"], checksum)
            self.assertEqual((Path(directory) / "id").read_text(), "batch-id")

    def test_unknown_create_outcome_recovers_the_preallocated_file(self):
        props = {"run_id": "10", "run_number": "2", "attempt": "1", "sha": "a" * 40}
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "batch.tar"
            archive.write_bytes(b"complete archive")
            identity = Path(directory) / "id"
            identity.write_text("batch-id")
            result = {
                "id": "batch-id",
                "size": str(archive.stat().st_size),
                "md5Checksum": hashlib.md5(archive.read_bytes()).hexdigest(),
                "properties": dict(
                    props,
                    state="pending",
                    protocol=PROTOCOL,
                    repository="a-novel/platform-studio",
                ),
            }
            drive = self.drive(
                [
                    ({"status": "409"}, b"{}"),
                    ({"status": "200"}, json.dumps(result).encode()),
                ]
            )
            self.assertEqual(
                drive.upload("results", archive, props, identity)["id"], "batch-id"
            )

    def test_paginated_listing_and_incomplete_results(self):
        drive = self.drive(
            [
                ({"status": "200"}, b'{"nextPageToken":"next","files":[{"id":"one"}]}'),
                ({"status": "200"}, b'{"files":[{"id":"two"}]}'),
            ]
        )
        self.assertEqual(
            [batch["id"] for batch in drive.batches("results")], ["one", "two"]
        )
        drive = self.drive(
            [({"status": "200"}, b'{"incompleteSearch":true,"files":[]}')]
        )
        with self.assertRaises(Failure):
            drive.batches("results")

    def test_download_checksum_failure_is_visible(self):
        drive = self.drive([({"status": "200", "content-length": "3"}, b"bad")])
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(Failure):
            drive.download(
                {"id": "reference", "md5Checksum": "0" * 32},
                Path(directory) / "reference.tar",
            )


if __name__ == "__main__":
    unittest.main()
