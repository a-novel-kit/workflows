"""Run native comparisons and regenerate only after a reviewed visual-only failure."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

from storage import Failure


def inspect_report(report):
    """Return screenshot paths and whether every failure came from a screenshot assertion."""
    cases = report.get("tests", [])
    if not cases or len(cases) != report.get("expected") or report.get("errors"):
        raise Failure("Playwright did not complete the selected test suite")
    if len({case["id"] for case in cases}) != len(cases):
        raise Failure("Retried tests cannot publish a reference")
    paths = set()
    visual_only = True
    for test in cases:
        if test.get("expectedStatus") != "passed":
            raise Failure("Expected-failure tests cannot publish a reference")
        if len(test.get("snapshots", [])) != test.get("screenshotCount"):
            raise Failure("Screenshot inventory does not match executed assertions")
        errors = test.get("errors", [])
        if test.get("status") not in ("passed", "failed"):
            visual_only = False
        if test.get("status") == "failed" and not errors:
            visual_only = False
        if any(error not in test.get("visualErrors", []) for error in errors):
            visual_only = False
        for name in test.get("snapshots", []):
            path = Path(name)
            if path.is_absolute() or ".." in path.parts or path.suffix != ".png":
                raise Failure("Invalid screenshot inventory path")
            if path.as_posix() in paths:
                raise Failure("Duplicate screenshot inventory path")
            paths.add(path.as_posix())
    if not paths:
        raise Failure("No screenshot assertions were recorded")
    return paths, visual_only


def run_tests(script, mode):
    result = subprocess.run(
        [
            "pnpm",
            "run",
            script,
            f"--update-snapshots={mode}",
            f"--add-reporter={Path(__file__).with_name('reporter.mjs')}",
        ],
        check=False,
    )
    report_path = Path(os.environ["PLAYWRIGHT_VISUAL_REPORT"])
    if not report_path.exists():
        raise Failure("Playwright visual report is missing")
    return result.returncode, json.loads(report_path.read_text())


def archive_batch(paths, target):
    """Package only declared evidence, excluding credentials and arbitrary workspace files."""
    with tarfile.open(target, "w") as archive:
        sources = [
            (Path(".visual/snapshots") / path, f"snapshots/{path}")
            for path in sorted(paths)
        ]
        for folder in (
            "playwright-report",
            "test-results",
            ".visual/comparison-report",
            ".visual/comparison-results",
        ):
            root = Path(folder)
            if root.exists():
                sources.extend(
                    (path, path.as_posix())
                    for path in root.rglob("*")
                    if path.is_file()
                )
        for name in (
            "integration-services.log",
            ".visual/results.json",
            ".visual/comparison.json",
        ):
            path = Path(name)
            if path.exists():
                sources.append((path, path.as_posix()))
        workspace = Path.cwd().resolve()
        for path, name in sources:
            if path.is_symlink() or not path.resolve().is_relative_to(workspace):
                raise Failure("Evidence contains an unsafe file path")
            if not path.is_file():
                raise Failure("Screenshot inventory contains a missing file")
            archive.add(path, arcname=name, recursive=False)


def compare(script, approved=False, seed=False):
    root = Path(".visual")
    root.mkdir(exist_ok=True)
    snapshots = root / "snapshots"
    previous = {
        path.relative_to(snapshots).as_posix() for path in snapshots.rglob("*.png")
    }
    code, report = run_tests(script, "all" if seed else "none")
    paths, visual_only = inspect_report(report)
    changed = code != 0 or previous != paths
    if not visual_only or (
        code and all(test["status"] == "passed" for test in report["tests"])
    ):
        raise Failure(
            "Test execution or screenshot capture failed; approval cannot waive it"
        )
    if seed:
        if code:
            raise Failure("Initial screenshot capture failed")
    elif changed:
        if not approved:
            raise Failure("Screenshot changes require approval for the current PR head")
        for source, target in (
            ("playwright-report", ".visual/comparison-report"),
            ("test-results", ".visual/comparison-results"),
            (".visual/results.json", ".visual/comparison.json"),
        ):
            if Path(source).exists():
                shutil.move(source, target)
        shutil.rmtree(snapshots)
        code, report = run_tests(script, "all")
        updated, _ = inspect_report(report)
        if code or updated != paths:
            raise Failure(
                "Approved screenshot regeneration did not complete the same test inventory"
            )
    for path in paths:
        if not (snapshots / path).is_file():
            raise Failure("A screenshot capture is missing")
    return changed


if __name__ == "__main__":
    try:
        if sys.argv[1] in ("--diagnostics", "--archive"):
            paths = (
                inspect_report(json.loads(Path(".visual/results.json").read_text()))[0]
                if sys.argv[1] == "--archive"
                else set()
            )
            archive_batch(paths, Path(".visual/batch.tar"))
            sys.exit(0)
        changed = compare(
            sys.argv[1],
            approved=os.environ.get("VISUAL_APPROVED") == "true",
            seed=os.environ.get("VISUAL_SEED") == "true",
        )
        Path(".visual/verdict.json").write_text(
            json.dumps({"changed": changed, "sha": os.environ["GITHUB_SHA"]})
        )
    except Failure as error:
        print(f"::error::{error}", file=sys.stderr)
        sys.exit(1)
