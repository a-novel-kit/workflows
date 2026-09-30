"""Exercise exact-head approval and merge-queue provenance with GitHub boundary responses."""

from copy import deepcopy
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(
    0, str(Path(__file__).resolve().parents[1] / "node-actions/test-playwright/drive")
)
from policy import APPROVAL, COMPARISON, LABEL, Policy


class PolicyTest(unittest.TestCase):
    def setUp(self):
        self.pr = {
            "number": 1,
            "html_url": "https://github.com/example/studio/pull/1",
            "state": "open",
            "head": {"sha": "head", "repo": {"full_name": "example/studio"}},
            "base": {"ref": "master"},
        }
        self.event = {
            "event": "labeled",
            "label": {"name": LABEL},
            "created_at": "2026-09-01T10:00:00Z",
            "id": 1,
            "actor": {"type": "User", "login": "reviewer"},
        }
        self.receipt = {
            "context": APPROVAL,
            "creator": {"login": "github-actions[bot]"},
            "state": "success",
            "created_at": "2026-09-01T10:00:01Z",
            "target_url": "https://github.com/example/studio/actions/runs/41/attempts/1",
        }
        self.comparison = {
            "context": COMPARISON,
            "creator": {"login": "github-actions[bot]"},
            "state": "success",
            "created_at": "2026-09-01T10:01:00Z",
            "description": "approved",
            "target_url": "https://github.com/example/studio/actions/runs/42/attempts/2",
        }
        self.events = [self.event]
        self.statuses = [self.comparison, self.receipt]
        self.github = Mock(repository="example/studio")
        self.github.pages.side_effect = lambda path: (
            self.events if path.startswith("issues/") else self.statuses
        )

        def request(path):
            if path.startswith("collaborators/"):
                return {"permission": "write"}
            if "/41/" in path:
                return {
                    "event": "pull_request_target",
                    "path": ".github/workflows/visual-tests.yaml",
                    "display_title": "Visual approval 1 head master labeled",
                }
            return {
                "head_sha": "head",
                "path": ".github/workflows/main.yaml",
                "event": "push",
            }

        self.github.request.side_effect = request
        self.github.successful_job.return_value = True
        os.environ.update(GITHUB_RUN_ID="41", GITHUB_RUN_ATTEMPT="1")
        self.github.successful_browser_run.return_value = True
        self.policy = Policy(self.github)

    def test_label_requires_human_write_access_and_current_head_receipt(self):
        self.assertTrue(self.policy.approved(self.pr))
        for mutation in (
            lambda: self.event["actor"].update(type="Bot"),
            lambda: self.receipt.update(state="failure"),
            lambda: self.receipt.update(target_url="another-pr"),
            lambda: self.receipt.update(created_at="2026-09-01T09:00:00Z"),
        ):
            with self.subTest(mutation=mutation):
                self.setUp()
                mutation()
                self.assertFalse(self.policy.approved(self.pr))
        self.setUp()
        self.github.request.return_value = {"permission": "read"}
        self.github.request.side_effect = None
        self.assertFalse(self.policy.approved(self.pr))

    def test_candidate_status_cannot_forge_a_trusted_approval_receipt(self):
        self.receipt["target_url"] = self.comparison["target_url"]
        self.assertFalse(self.policy.approved(self.pr))
        self.setUp()
        original = self.github.request.side_effect
        self.github.request.side_effect = lambda path: (
            dict(
                original(path),
                display_title="Visual approval 1 previous-head master labeled",
            )
            if "/41/" in path
            else original(path)
        )
        self.assertFalse(self.policy.approved(self.pr))

    def test_latest_label_removal_revokes_but_post_merge_removal_preserves_history(
        self,
    ):
        self.events.append(
            dict(self.event, event="unlabeled", id=2, created_at="2026-09-01T12:00:00Z")
        )
        self.assertFalse(self.policy.approved(self.pr))
        self.assertTrue(self.policy.approved(self.pr, "2026-09-01T11:00:00Z"))

    def test_proof_requires_successful_browser_job_and_same_baseline(self):
        self.assertEqual(self.policy.proof(self.pr, "base"), "approved")
        self.github.successful_browser_run.return_value = False
        self.assertIsNone(self.policy.proof(self.pr, "base"))
        self.github.successful_browser_run.return_value = True
        self.comparison["description"] = "matched:base"
        self.assertEqual(self.policy.proof(self.pr, "base"), "matched")
        self.assertIsNone(self.policy.proof(self.pr, "new-base"))
        self.comparison["target_url"] = (
            "https://github.com/other/repo/actions/runs/42/attempts/2"
        )
        self.assertIsNone(self.policy.proof(self.pr, "base"))

    def test_queue_requires_proof_for_every_pr(self):
        second = deepcopy(self.pr)
        second["number"] = 2
        group = {"merge_group": {"base_sha": "base", "head_sha": "group"}}
        self.policy.associated = Mock(return_value=[self.pr, second])
        for proofs, expected in [
            (["approved", "matched"], True),
            (["approved", None], False),
            (["matched", "matched"], False),
        ]:
            self.policy.proof = Mock(side_effect=proofs)
            self.assertEqual(
                self.policy.allows(group, "merge_group", "group", "queue", "base"),
                expected,
            )
        self.assertFalse(
            self.policy.allows(group, "merge_group", "different", "queue", "base")
        )

    def test_unassociated_direct_commit_cannot_borrow_another_pr_approval(self):
        commits = [
            {"sha": "head", "parents": [{"sha": "base"}]},
            {"sha": "unreviewed", "parents": [{"sha": "head"}]},
        ]
        self.github.request.side_effect = lambda path: {"commits": commits}
        self.github.pages.side_effect = lambda path: (
            [self.pr] if "/head/" in path else []
        )
        self.assertEqual(self.policy.associated("base", "unreviewed", False), [])
        commits[1] = {
            "sha": "queue-merge",
            "parents": [{"sha": "base"}, {"sha": "head"}],
        }
        self.assertEqual(
            self.policy.associated("base", "queue-merge", False), [self.pr]
        )

    def test_label_reruns_completed_head_and_synchronize_invalidates_approval(self):
        event = {
            "action": "labeled",
            "label": {"name": LABEL},
            "number": 1,
            "pull_request": self.pr,
            "sender": {"type": "User", "login": "reviewer"},
        }

        def request(path):
            if path.startswith("pulls/"):
                return self.pr
            if path.startswith("collaborators/"):
                return {"permission": "write"}
            if "workflows/" in path:
                return {"workflow_runs": [{"id": 42, "run_number": 4}]}
            return {"id": 42, "status": "completed"}

        self.github.request.side_effect = request
        self.policy.post = Mock()
        self.policy.label_event(event)
        self.assertEqual(self.policy.post.call_args_list[0].args[1]["state"], "success")
        self.assertEqual(
            self.policy.post.call_args_list[1].args[0], "actions/runs/42/rerun"
        )
        self.policy.post.reset_mock()
        self.policy.label_event(dict(event, action="synchronize"))
        self.assertEqual(self.policy.post.call_args.args[1]["state"], "failure")
        self.assertEqual(self.policy.post.call_count, 1)


if __name__ == "__main__":
    unittest.main()
