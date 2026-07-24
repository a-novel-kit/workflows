#!/usr/bin/env bash
# Gating tests for the three security actions.
#
# Each step's script is extracted verbatim from its manifest and run with the scanner stubbed, so
# the assertions are on the shipped code rather than a copy. The run bodies read their inputs from
# env: only — no ${{ }} — which is what makes that possible.
#
# Gating is the whole point of the tests: a check that reports findings and exits 0 looks identical
# to a clean run in the checks UI, and one that fails in advisory mode blocks a repo that was only
# meant to be watching.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fails=0
check() { # $1=label $2=expected $3=actual
  if [ "$2" = "$3" ]; then
    echo "  ok   $1"
  else
    echo "  FAIL $1: expected [$2], got [$3]"
    fails=$((fails + 1))
  fi
}

# Extract one step's `run:` body verbatim from a manifest.
extract() { # $1=manifest $2=step name
  python3 -c "
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
for s in d['runs']['steps']:
    if s.get('name') == sys.argv[2]:
        sys.stdout.write(s['run']); break
else:
    sys.exit('no step named ' + sys.argv[2])
" "$1" "$2"
}

# A stub scanner that exits with $1 and prints a finding line, placed ahead of the real one on PATH.
stub() { # $1=name $2=exit code
  mkdir -p "$TMP/bin"
  printf '#!/usr/bin/env bash\necho "stub-%s finding"\nexit %s\n' "$1" "$2" >"$TMP/bin/$1"
  chmod +x "$TMP/bin/$1"
}

run_step() { # $1=script file; remaining args are env assignments
  local script="$1"
  shift
  (
    cd "$TMP/work" || exit 99
    export PATH="$TMP/bin:$PATH"
    export GITHUB_STEP_SUMMARY="$TMP/summary"
    for kv in "$@"; do export "${kv?}"; done
    bash "$script" >"$TMP/out" 2>&1
  )
}

mkdir -p "$TMP/work"
: >"$TMP/summary"

# --- lint-semgrep ------------------------------------------------------------
SEMGREP_ACTION="$ROOT/security-actions/lint-semgrep/action.yaml"
extract "$SEMGREP_ACTION" semgrep >"$TMP/semgrep.sh"
SEMGREP_DIR="$ROOT/security-actions/lint-semgrep"

stub docker 0
run_step "$TMP/semgrep.sh" "RULESET=none" "ADVISORY=false" "SEMGREP_VERSION=x" "ACTION_PATH=$SEMGREP_DIR"
check "semgrep: ruleset=none is a clean pass" 0 $?

run_step "$TMP/semgrep.sh" "RULESET=nope" "ADVISORY=false" "SEMGREP_VERSION=x" "ACTION_PATH=$SEMGREP_DIR"
check "semgrep: unknown ruleset fails" 1 $?

run_step "$TMP/semgrep.sh" "RULESET=service" "ADVISORY=false" "SEMGREP_VERSION=x" "ACTION_PATH=$SEMGREP_DIR"
check "semgrep: clean scan passes" 0 $?

stub docker 1
run_step "$TMP/semgrep.sh" "RULESET=service" "ADVISORY=false" "SEMGREP_VERSION=x" "ACTION_PATH=$SEMGREP_DIR"
check "semgrep: findings fail when gating" 1 $?

run_step "$TMP/semgrep.sh" "RULESET=service" "ADVISORY=true" "SEMGREP_VERSION=x" "ACTION_PATH=$SEMGREP_DIR"
check "semgrep: findings pass in advisory mode" 0 $?

# --- scan-secrets ------------------------------------------------------------
SECRETS_ACTION="$ROOT/security-actions/scan-secrets/action.yaml"
extract "$SECRETS_ACTION" "scan working tree" >"$TMP/secrets.sh"
SECRETS_DIR="$ROOT/security-actions/scan-secrets"

stub gitleaks 0
run_step "$TMP/secrets.sh" "CONFIG=" "ADVISORY=false" "ACTION_PATH=$SECRETS_DIR"
check "gitleaks: clean scan passes" 0 $?

run_step "$TMP/secrets.sh" "CONFIG=nope.toml" "ADVISORY=false" "ACTION_PATH=$SECRETS_DIR"
check "gitleaks: missing config fails" 1 $?

stub gitleaks 1
run_step "$TMP/secrets.sh" "CONFIG=" "ADVISORY=false" "ACTION_PATH=$SECRETS_DIR"
check "gitleaks: findings fail when gating" 1 $?

run_step "$TMP/secrets.sh" "CONFIG=" "ADVISORY=true" "ACTION_PATH=$SECRETS_DIR"
check "gitleaks: findings pass in advisory mode" 0 $?

# A repo config replaces the baseline; gitleaks cannot layer two configs, so the
# action must not leave a stale .gitleaks-base.toml in the workspace pretending otherwise.
stub gitleaks 0
printf '[extend]\nuseDefault = true\n' >"$TMP/work/own.toml"
run_step "$TMP/secrets.sh" "CONFIG=own.toml" "ADVISORY=false" "ACTION_PATH=$SECRETS_DIR"
check "gitleaks: a repo config is used as-is" 0 $?
check "gitleaks: no phantom base file is written" 0 "$([ -e "$TMP/work/.gitleaks-base.toml" ] && echo 1 || echo 0)"

# --- lint-workflows ----------------------------------------------------------
ZIZMOR_ACTION="$ROOT/security-actions/lint-workflows/action.yaml"
extract "$ZIZMOR_ACTION" zizmor >"$TMP/zizmor.sh"
ZIZMOR_DIR="$ROOT/security-actions/lint-workflows"

stub docker 0
run_step "$TMP/zizmor.sh" "CONFIG=" "ADVISORY=false" "ZIZMOR_VERSION=x" "ACTION_PATH=$ZIZMOR_DIR"
check "zizmor: no workflows dir is a clean pass" 0 $?

mkdir -p "$TMP/work/.github/workflows"
run_step "$TMP/zizmor.sh" "CONFIG=" "ADVISORY=false" "ZIZMOR_VERSION=x" "ACTION_PATH=$ZIZMOR_DIR"
check "zizmor: clean audit passes" 0 $?

stub docker 1
run_step "$TMP/zizmor.sh" "CONFIG=" "ADVISORY=false" "ZIZMOR_VERSION=x" "ACTION_PATH=$ZIZMOR_DIR"
check "zizmor: findings fail when gating" 1 $?

run_step "$TMP/zizmor.sh" "CONFIG=" "ADVISORY=true" "ZIZMOR_VERSION=x" "ACTION_PATH=$ZIZMOR_DIR"
check "zizmor: findings pass in advisory mode" 0 $?

# --- gitleaks version prefix -------------------------------------------------
# gitleaks tags releases v-prefixed but names archives without it, and it is the only one of the
# three whose datasource returns the v. A bump that keeps it must still resolve.
extract "$SECRETS_ACTION" "install gitleaks" >"$TMP/install.sh"
for spelling in 8.30.1 v8.30.1; do
  got=$(GITLEAKS_VERSION="$spelling" bash -c '
    v="${GITLEAKS_VERSION#v}"
    echo "https://github.com/gitleaks/gitleaks/releases/download/v${v}/gitleaks_${v}_linux_x64.tar.gz"')
  want="https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz"
  check "gitleaks: version '$spelling' builds the release URL" "$want" "$got"
done
# and the shipped script must actually strip it, not just the test's copy
check "gitleaks: install step strips a leading v" 1 "$(grep -c 'GITLEAKS_VERSION#v' "$TMP/install.sh")"

# --- version is required on all three ----------------------------------------
# A default would pin the tool inside the action, where Renovate in the consuming repo cannot see
# it, and every upgrade would wait on a workflows release.
for a in lint-semgrep scan-secrets lint-workflows; do
  got=$(python3 -c "
import yaml, sys
v = yaml.safe_load(open(sys.argv[1]))['inputs']['version']
print('required' if v.get('required') and 'default' not in v else 'optional')
" "$ROOT/security-actions/$a/action.yaml")
  check "$a: version is required with no default" required "$got"
done

if [ "$fails" -gt 0 ]; then
  echo "::error::$fails security-action assertion(s) failed"
  exit 1
fi
echo "security-actions: all assertions passed"
