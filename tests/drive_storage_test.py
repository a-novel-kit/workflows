"""Offline failure and retention contracts for the shipped Drive implementation."""

import io
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import Mock

sys.path.insert(
    0, str(Path(__file__).resolve().parents[1] / "node-actions/test-playwright/drive")
)
from storage import Failure, cleanup, current_reference, extract_snapshots, promote
from runner import inspect_report


def batch(name, number, *, state="current", attempt=1):
    return {
        "id": name,
        "properties": {
            "state": state,
            "run_number": str(number),
            "run_id": str(number),
            "attempt": str(attempt),
            "sha": name,
        },
    }


class Store:
    def __init__(self, references=(), results=()):
        self.records = {"references": list(references), "results": list(results)}
        self.removed = []

    def batches(self, drive_id):
        return list(self.records[drive_id])

    def remove(self, value):
        self.removed.append(value["id"])
        for values in self.records.values():
            if value in values:
                values.remove(value)

    def mark_current(self, value):
        value["properties"]["state"] = "current"


class PublicationTest(unittest.TestCase):
    def setUp(self):
        self.old = batch("old", 1)
        self.pending = batch("new", 2, state="pending")
        self.store = Store([self.old, self.pending])
        self.github = Mock()
        self.github.current.return_value = True
        self.github.successful_browser_run.return_value = True

    def promote(self):
        return promote(self.store, self.github, "references", self.pending)

    def test_failed_or_incomplete_run_keeps_current_reference(self):
        self.github.successful_browser_run.return_value = False
        self.assertFalse(self.promote())
        self.assertEqual(current_reference(self.store.batches("references")), self.old)
        self.assertEqual(self.store.removed, [])

    def test_stale_master_run_cannot_promote(self):
        self.github.current.return_value = False
        self.assertFalse(self.promote())
        self.assertEqual(current_reference(self.store.batches("references")), self.old)

    def test_replacement_becomes_current_before_old_reference_is_deleted(self):
        original_remove = self.store.remove

        def remove(value):
            self.assertEqual(
                current_reference(self.store.batches("references"))["id"], "new"
            )
            original_remove(value)

        self.store.remove = remove
        self.assertTrue(self.promote())
        self.assertEqual(
            [value["id"] for value in self.store.batches("references")], ["new"]
        )

    def test_partial_cleanup_still_selects_newest_completed_reference(self):
        self.store.remove = Mock(side_effect=Failure("delete failed"))
        with self.assertRaises(Failure):
            self.promote()
        self.assertEqual(
            current_reference(self.store.batches("references"))["id"], "new"
        )


class RetentionTest(unittest.TestCase):
    def test_keeps_quiet_master_and_one_completed_batch_per_branch(self):
        store = Store(
            [batch("master", 1)],
            [
                batch("old", 2),
                batch("new", 3),
                batch("other", 4),
                batch("running", 5, state="pending"),
            ],
        )
        github = Mock()
        github.branch.side_effect = lambda value: (
            "other" if value["id"] == "other" else "branch",
            value["id"] != "running",
        )
        cleanup(store, github, "results", "references")
        self.assertEqual(
            set(value["id"] for value in store.batches("results")),
            {"new", "other", "running"},
        )
        self.assertEqual(store.batches("references")[0]["id"], "master")

    def test_deletion_between_listing_and_publication_cannot_revive_branch(self):
        store = Store([batch("master", 1)], [batch("branch", 2, state="pending")])
        github = Mock()
        github.branch.side_effect = [("branch", True), (None, True)]
        cleanup(store, github, "results", "references")
        self.assertEqual(store.batches("results"), [])
        self.assertEqual(store.batches("references")[0]["id"], "master")

    def test_api_failure_does_not_mean_branch_deleted(self):
        store = Store([], [batch("branch", 2)])
        github = Mock()
        github.branch.side_effect = Failure("rate limited")
        with self.assertRaises(Failure):
            cleanup(store, github, "results", "references")
        self.assertEqual(store.removed, [])

    def test_successful_master_result_is_deduplicated_but_newer_failure_is_kept(self):
        store = Store([batch("master", 5)], [batch("duplicate", 5)])
        github = Mock()
        github.branch.return_value = ("master", True)
        cleanup(store, github, "results", "references")
        self.assertEqual(store.batches("results"), [])
        store.records["results"] = [batch("failed-new-master", 6)]
        cleanup(store, github, "results", "references")
        self.assertEqual(store.batches("results")[0]["id"], "failed-new-master")
        self.assertEqual(store.batches("references")[0]["id"], "master")

    def test_pending_reference_is_never_selected(self):
        self.assertIsNone(current_reference([batch("unfinished", 5, state="pending")]))


class ArchiveTest(unittest.TestCase):
    def test_extracts_only_images_and_rejects_traversal_and_links(self):
        for name, kind in [
            ("snapshots/desktop/home.png", tarfile.REGTYPE),
            ("snapshots/../escape.png", tarfile.REGTYPE),
            ("snapshots/link.png", tarfile.SYMTYPE),
        ]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                archive = Path(directory) / "batch.tar"
                with tarfile.open(archive, "w") as target:
                    member = tarfile.TarInfo(name)
                    member.type = kind
                    member.size = 3 if kind == tarfile.REGTYPE else 0
                    target.addfile(member, io.BytesIO(b"png") if member.size else None)
                if name == "snapshots/desktop/home.png":
                    extract_snapshots(archive, Path(directory) / "out")
                    self.assertEqual(
                        (Path(directory) / "out/desktop/home.png").read_bytes(), b"png"
                    )
                else:
                    with self.assertRaises(Failure):
                        extract_snapshots(archive, Path(directory) / "out")


class ReportTest(unittest.TestCase):
    def report(self, errors, steps, status="failed"):
        return {
            "expected": 1,
            "tests": [
                {
                    "id": "one",
                    "expectedStatus": "passed",
                    "status": status,
                    "snapshots": ["desktop/home.png"],
                    "screenshotCount": 1,
                    "errors": errors,
                    "visualErrors": [step["error"]["message"] for step in steps],
                }
            ],
        }

    def test_only_screenshot_failures_are_eligible_for_reviewed_regeneration(self):
        steps = [
            {
                "title": "expect.soft.toHaveScreenshot",
                "error": {"message": "different pixels"},
            }
        ]
        _, only_visual = inspect_report(self.report(["different pixels"], steps))
        self.assertTrue(only_visual)
        _, only_visual = inspect_report(
            self.report(["different pixels", "login failed"], steps)
        )
        self.assertFalse(only_visual)

    def test_timeout_and_empty_suite_cannot_publish(self):
        _, only_visual = inspect_report(self.report([], [], "timedOut"))
        self.assertFalse(only_visual)
        with self.assertRaises(Failure):
            inspect_report({"suites": []})


if __name__ == "__main__":
    unittest.main()
