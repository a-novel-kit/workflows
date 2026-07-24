#!/usr/bin/env bash
# Every lint action must pin its tool at the call site.
#
# An unpinned linter is a gate whose meaning moves without the repo changing: shellcheck used to
# come from the runner image, so a GitHub image rebuild could alter what the check accepted. A
# version defaulted inside the action is pinned but invisible — Renovate runs in the consuming repo
# and never sees it.
#
# The URL assertions cover the prefix disagreement: shellcheck's archive carries the v, gitleaks'
# and hadolint's drop it, and a bump that writes the wrong spelling 404s at install time.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fails=0
check() { # $1=label $2=expected $3=actual
  if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: expected [$2], got [$3]"; fails=$((fails + 1)); fi
}

# Every action that downloads a tool must take a required version with no default.
for a in generic-actions/lint-shell generic-actions/lint-dockerfile \
         security-actions/scan-secrets security-actions/lint-semgrep security-actions/lint-workflows; do
  got=$(python3 -c "
import yaml, sys
v = (yaml.safe_load(open(sys.argv[1]))['inputs'] or {}).get('version', {})
print('required' if v.get('required') and 'default' not in v else 'optional')
" "$ROOT/$a/action.yaml")
  check "${a#*/}: version required, no default" required "$got"
done

# The action must install its own shellcheck, not fall through to the runner's.
installs=$(grep -c 'koalaman/shellcheck/releases/download' "$ROOT/generic-actions/lint-shell/action.yaml")
check "lint-shell: installs a pinned shellcheck" 1 "$installs"

# Prefix normalisation, per tool. shellcheck keeps the v in its archive name; the others drop it.
for spelling in 0.11.0 v0.11.0; do
  got=$(SHELLCHECK_VERSION="$spelling" bash -c 'v="v${SHELLCHECK_VERSION#v}"; echo "shellcheck-${v}.linux.x86_64.tar.xz"')
  check "shellcheck: '$spelling' names the archive" "shellcheck-v0.11.0.linux.x86_64.tar.xz" "$got"
done
for spelling in 2.12.0 v2.12.0; do
  got=$(HADOLINT_VERSION="$spelling" bash -c 'echo "v${HADOLINT_VERSION#v}"')
  check "hadolint: '$spelling' names the tag" "v2.12.0" "$got"
done

# The normalisation must be in the shipped manifests, not only in this test.
check "lint-shell strips/adds the v" 1 "$(grep -c 'SHELLCHECK_VERSION#v' "$ROOT/generic-actions/lint-shell/action.yaml")"
check "lint-dockerfile strips the v" 1 "$(grep -c 'HADOLINT_VERSION#v' "$ROOT/generic-actions/lint-dockerfile/action.yaml")"

# A pin nothing bumps is a pin that rots: the annotation is what the custom manager reads.
missing=0
while IFS= read -r f; do
  grep -q 'renovate: datasource=' "$f" || { echo "    $f has a version: with no renovate annotation"; missing=$((missing + 1)); }
done < <(grep -rl 'version: "' "$ROOT/.github/workflows" 2>/dev/null)
check "in-repo callers annotate their pins" 0 "$missing"

if [ "$fails" -gt 0 ]; then echo "::error::$fails tool-pin assertion(s) failed"; exit 1; fi
echo "lint-tool-pins: all assertions passed"
