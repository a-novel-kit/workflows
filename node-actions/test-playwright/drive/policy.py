"""Bind screenshot-change approval to a human label action and an exact PR head."""

import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.parse
import urllib.request

from storage import Failure, GitHub

LABEL = "allow-screenshot-change"
APPROVAL = "visual-change-approval"
COMPARISON = "visual-comparison"


class Policy:
    def __init__(self, github):
        self.github = github

    def post(self, path, payload=None):
        body = json.dumps(payload or {}).encode()
        request = urllib.request.Request(
            f"https://api.github.com/repos/{self.github.repository}/{path}",
            data=body,
            headers={
                "Authorization": f"Bearer {self.github.token}",
                "Accept": "application/vnd.github+json",
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            response.read()

    def status(self, sha, context, state, description, target):
        self.post(
            f"statuses/{sha}",
            {
                "context": context,
                "state": state,
                "description": description,
                "target_url": target,
            },
        )

    def latest_status(self, sha, context, before=None):
        for status in self.github.pages(f"commits/{sha}/statuses"):
            if status["context"] == context and (
                before is None or status["created_at"] <= before
            ):
                if status["creator"]["login"] != "github-actions[bot]":
                    return None
                return status
        return None

    def approved(self, pr, before=None):
        latest = None
        for event in self.github.pages(f"issues/{pr['number']}/events"):
            if (
                event["event"] in ("labeled", "unlabeled")
                and event.get("label", {}).get("name") == LABEL
                and (before is None or event["created_at"] <= before)
            ):
                if latest is None or (event["created_at"], event["id"]) > (
                    latest["created_at"],
                    latest["id"],
                ):
                    latest = event
        if not latest or latest["event"] != "labeled":
            return False
        actor = latest.get("actor", {})
        if actor.get("type") != "User" or latest.get("performed_via_github_app"):
            return False
        permission = self.github.request(
            f"collaborators/{urllib.parse.quote(actor['login'], safe='')}/permission"
        )
        if permission["permission"] not in ("admin", "maintain", "write"):
            return False
        receipt = self.latest_status(pr["head"]["sha"], APPROVAL, before)
        return bool(
            receipt
            and receipt["state"] == "success"
            and receipt["created_at"] >= latest["created_at"]
            and receipt["target_url"] == pr["html_url"]
        )

    def proof(self, pr, baseline, before=None):
        status = self.latest_status(pr["head"]["sha"], COMPARISON, before)
        if not status or status["state"] != "success":
            return None
        match = re.fullmatch(
            rf"https://github.com/{re.escape(self.github.repository)}/actions/runs/(\d+)/attempts/(\d+)",
            status.get("target_url", ""),
        )
        if not match:
            return None
        run = self.github.request(f"actions/runs/{match[1]}/attempts/{match[2]}")
        if (
            run["head_sha"] != pr["head"]["sha"]
            or run["path"] != ".github/workflows/main.yaml"
            or run["event"] != "push"
        ):
            return None
        if not self.github.successful_browser_run(
            {"properties": {"run_id": match[1], "attempt": match[2]}}
        ):
            return None
        if status["description"] == "approved" and self.approved(pr, before):
            return "approved"
        if status["description"] == f"matched:{baseline}":
            return "matched"
        return None

    def associated(self, base, head, merged):
        commits = []
        for page in range(1, 101):
            data = self.github.request(
                f"compare/{base}...{head}?per_page=100&page={page}"
            )
            commits.extend(data["commits"])
            if len(data["commits"]) < 100:
                break
        else:
            raise Failure("Comparison history exceeds the approval review limit")
        commit_ids = {commit["sha"] for commit in commits}
        pulls = {}
        covered = set()
        for commit in commits:
            for pr in self.github.pages(f"commits/{commit['sha']}/pulls"):
                if (
                    pr["base"]["ref"] != "master"
                    or (pr["head"].get("repo") or {}).get("full_name")
                    != self.github.repository
                ):
                    continue
                if (
                    merged
                    and pr.get("merged_at")
                    and pr.get("merge_commit_sha") in commit_ids
                ):
                    pulls[pr["number"]] = pr
                    covered.add(commit["sha"])
                elif (
                    not merged
                    and pr["state"] == "open"
                    and pr["head"]["sha"] in commit_ids
                ):
                    pulls[pr["number"]] = pr
                    covered.add(commit["sha"])
        for commit in commits:
            if commit["sha"] not in covered:
                parents = {parent["sha"] for parent in commit.get("parents", [])}
                if len(parents) < 2 or not parents <= (covered | {base}):
                    return []
                covered.add(commit["sha"])
        return list(pulls.values())

    def allows(self, event, event_name, sha, ref, baseline):
        if event_name == "merge_group":
            group = event["merge_group"]
            if group["head_sha"] != sha:
                return False
            pulls = self.associated(group["base_sha"], sha, False)
            proofs = [self.proof(pr, baseline) for pr in pulls]
            return bool(proofs and all(proofs) and "approved" in proofs)
        if event_name != "push":
            return False
        if ref == "refs/heads/master":
            pulls = self.associated(baseline, sha, True)
            proofs = [self.proof(pr, baseline, pr["merged_at"]) for pr in pulls]
            return bool(proofs and all(proofs) and "approved" in proofs)
        branch = ref.removeprefix("refs/heads/")
        pulls = self.github.pages(
            f"pulls?state=open&head={self.github.repository.split('/')[0]}:{urllib.parse.quote(branch, safe='')}"
        )
        return any(
            pr["head"]["sha"] == sha
            and pr["base"]["ref"] == "master"
            and self.approved(pr)
            for pr in pulls
        )

    def label_event(self, event):
        action = event.get("action")
        if action not in ("labeled", "unlabeled", "synchronize", "opened", "reopened"):
            return
        if (
            action in ("labeled", "unlabeled")
            and event.get("label", {}).get("name") != LABEL
        ):
            return
        pr = self.github.request(f"pulls/{int(event['number'])}")
        if (pr["head"].get("repo") or {}).get(
            "full_name"
        ) != self.github.repository or pr["head"]["sha"] != event["pull_request"][
            "head"
        ][
            "sha"
        ]:
            return
        approved = False
        if action == "labeled" and event["sender"]["type"] == "User":
            permission = self.github.request(
                f"collaborators/{urllib.parse.quote(event['sender']['login'], safe='')}/permission"
            )
            approved = permission["permission"] in ("admin", "maintain", "write")
        self.status(
            pr["head"]["sha"],
            APPROVAL,
            "success" if approved else "failure",
            (
                "Approved current PR head"
                if approved
                else "Apply the label after reviewing this head"
            ),
            pr["html_url"],
        )
        if action not in ("labeled", "unlabeled"):
            return
        runs = self.github.request(
            f"actions/workflows/main.yaml/runs?head_sha={pr['head']['sha']}&event=push&per_page=100"
        )["workflow_runs"]
        if not runs:
            raise Failure("No main run exists for the labeled PR head")
        run = max(runs, key=lambda value: value["run_number"])
        for _ in range(240):
            current = self.github.request(f"pulls/{pr['number']}")
            if (
                current["state"] != "open"
                or current["head"]["sha"] != pr["head"]["sha"]
            ):
                return
            run = self.github.request(f"actions/runs/{run['id']}")
            if run["status"] == "completed":
                self.post(f"actions/runs/{run['id']}/rerun")
                return
            time.sleep(5)
        raise Failure(
            "Label approval recorded; main is still running and needs a rerun"
        )


def main():
    github = GitHub(os.environ["GITHUB_REPOSITORY"], os.environ["GH_TOKEN"])
    policy = Policy(github)
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    if sys.argv[1] == "label":
        policy.label_event(event)
    elif sys.argv[1] == "allow":
        baseline = json.loads(Path(".visual/context.json").read_text())["baseline"]
        allowed = bool(baseline) and policy.allows(
            event,
            os.environ["GITHUB_EVENT_NAME"],
            os.environ["GITHUB_SHA"],
            os.environ["GITHUB_REF"],
            baseline,
        )
        with open(os.environ["GITHUB_ENV"], "a") as env:
            env.write(f"VISUAL_APPROVED={str(allowed).lower()}\n")
    elif sys.argv[1] == "record":
        success = os.environ["VISUAL_OUTCOME"] == "success"
        baseline = json.loads(Path(".visual/context.json").read_text())["baseline"]
        verdict = (
            json.loads(Path(".visual/verdict.json").read_text()) if success else {}
        )
        description = (
            ("approved" if verdict.get("changed") else f"matched:{baseline}")
            if success
            else "Visual tests or evidence upload failed"
        )
        target = f"https://github.com/{github.repository}/actions/runs/{os.environ['GITHUB_RUN_ID']}/attempts/{os.environ['GITHUB_RUN_ATTEMPT']}"
        policy.status(
            os.environ["GITHUB_SHA"],
            COMPARISON,
            "success" if success else "failure",
            description,
            target,
        )
    else:
        raise Failure("Unknown approval operation")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("::error::Screenshot approval verification failed", file=sys.stderr)
        sys.exit(1)
