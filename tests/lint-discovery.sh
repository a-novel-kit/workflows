#!/usr/bin/env bash
# Regression tests for what the two lint actions decide to lint.
#
# The discovery expressions are extracted verbatim from the manifests and run against a fixture file
# list, so the assertions are on the shipped patterns rather than a copy of them.
#
# Discovery is the whole gate: a path the pattern misses is silently never linted, and a path it
# wrongly claims fails the check on a file that is not a Dockerfile at all. The second is not
# hypothetical — a case-insensitive `dockerfile(\.<x>)?$` claimed `dockerfile.go` in the stack repo,
# which made the "a repo with no Dockerfiles is a clean pass" promise false there.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DOCKER_ACTION="${1:-$ROOT/generic-actions/lint-dockerfile/action.yaml}"
SHELL_ACTION="${2:-$ROOT/generic-actions/lint-shell/action.yaml}"

DOCKER_RE=$(sed -n "s/^ *| grep -E '\(.*\)')\$/\1/p" "$DOCKER_ACTION")
if [ -z "$DOCKER_RE" ]; then
  echo "::error::could not extract the Dockerfile discovery pattern from $DOCKER_ACTION"
  exit 1
fi
# lint-shell discovers with a pathspec rather than a pattern; assert it is still the one documented.
SHELL_GLOB=$(sed -n "s/^ *mapfile -t files < <(git ls-files '\(.*\)')\$/\1/p" "$SHELL_ACTION")

fails=0
check() { # $1=label $2=expected $3=actual
  if [ "$2" = "$3" ]; then
    echo "  ok   $1"
  else
    echo "  FAIL $1: expected [$2], got [$3]"
    fails=$((fails + 1))
  fi
}
matches() { printf '%s\n' "$1" | grep -cE "$DOCKER_RE"; }

echo "== the naming conventions in the fleet are all discovered =="

check "the fleet's <x>.Dockerfile"      1 "$(matches builds/database.Dockerfile)"
check "a dotted variant of it"          1 "$(matches builds/standalone.grpc.Dockerfile)"
check "a bare Dockerfile at the root"   1 "$(matches Dockerfile)"
check "a bare Dockerfile in a subtree"  1 "$(matches builds/Dockerfile)"
check "the canonical Dockerfile.<x>"    1 "$(matches builds/Dockerfile.dev)"
check "an all-lowercase bare one"       1 "$(matches builds/dockerfile)"
check "a lowercase suffix form"         1 "$(matches builds/database.dockerfile)"

echo "== source files are not =="

# The regression. `dockerfile.go` is the daemon's Dockerfile *discovery* code in the stack repo; a
# case-insensitive dotted match reads it as a Dockerfile and hadolint fails on Go syntax.
check "dockerfile.go is source, not a Dockerfile" 0 "$(matches cli/internal/daemon/discovery/dockerfile.go)"
check "and so is dockerfile.ts"                   0 "$(matches src/dockerfile.ts)"
check "and dockerfile_test.go"                    0 "$(matches cli/internal/dockerfile_test.go)"
# A file merely mentioning the word is not one either — the pattern is anchored at both ends.
check "a doc about Dockerfiles"                   0 "$(matches .agents/skills/write-dockerfiles/SKILL.md)"
check "a path segment, not a file name"           0 "$(matches dockerfile/notes.txt)"

echo "== lint-shell still discovers by pathspec =="

check "the documented *.sh pathspec is what ships" "*.sh" "$SHELL_GLOB"

echo
if [ "$fails" -ne 0 ]; then
  echo "::error::$fails assertion(s) failed"
  exit 1
fi
echo "all assertions passed"
