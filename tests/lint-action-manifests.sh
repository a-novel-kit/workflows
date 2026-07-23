#!/usr/bin/env bash
# shellcheck disable=SC2016
# ^ fixtures carry literal `${{ … }}` GitHub expressions that must not expand.
#
# Regression tests for the composite-manifest context lint: each case is a manifest the linter runs
# against for real. Both halves matter — the violations must fail, and the plain-text prose that
# documents caller syntax must pass.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
LINTER="$ROOT/.github/scripts/lint-action-manifests.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

fails=0

# writes a composite manifest whose run: step is $2, into its own directory
fixture() { # $1=name $2=run body
  mkdir -p "$WORK/$1"
  cat >"$WORK/$1/action.yaml" <<EOF
name: $1
description: fixture
runs:
  using: composite
  steps:
    - shell: bash
      run: |
        $2
EOF
  printf '%s' "$WORK/$1"
}

check() { # $1=label $2=expected(pass|fail) $3=dir
  if bash "$LINTER" "$3" >/dev/null 2>&1; then
    got=pass
  else
    got=fail
  fi

  if [ "$got" = "$2" ]; then
    echo "  ok   $1"
  else
    echo "  FAIL $1: expected the linter to $2, it did $got"
    fails=$((fails + 1))
  fi
}

echo "== violations the linter must catch =="

check "context as the first token" fail \
  "$(fixture first-token 'echo "${{ vars.AGENT_KILL_SWITCH }}"')"

# The case the anchored version missed. This is what a contributor writes when making an input
# self-defaulting, and it is indistinguishable to GitHub from the one above.
check "context after an operator" fail \
  "$(fixture after-operator 'echo "${{ inputs.kill_switch || vars.AGENT_KILL_SWITCH }}"')"

# A widened ${{[^}]*}} pattern stops at the } inside '{0}' and lets this through.
check "context inside a function call with braces" fail \
  "$(fixture inside-format "echo \"\${{ format('{0}', secrets.TOKEN) }}\"")"

check "needs context" fail \
  "$(fixture needs-ctx 'echo "${{ toJSON(needs.build.outputs.x) }}"')"

check "matrix context" fail \
  "$(fixture matrix-ctx 'echo "${{ matrix.os }}"')"

check "strategy context" fail \
  "$(fixture strategy-ctx 'echo "${{ strategy.job-index }}"')"

echo "== what the linter must NOT flag =="

# These names appear as prose in ten manifests, documenting the syntax a caller uses. The lint has to
# leave them alone for that documentation to stay in the actions.
check "plain-text prose outside an expression" pass \
  "$(fixture prose '# threaded from the caller as kill_switch: vars.AGENT_KILL_SWITCH')"

check "a legal context in an expression" pass \
  "$(fixture legal-ctx 'echo "${{ inputs.client_id }} ${{ github.repository }} ${{ env.FOO }}"')"

# Here the name is a substring of a longer identifier.
check "a longer identifier ending in a context name" pass \
  "$(fixture substring 'echo "${{ inputs.myvars.thing }}"')"

# A reusable workflow may use these contexts freely; only composite actions cannot.
mkdir -p "$WORK/reusable"
cat >"$WORK/reusable/action.yaml" <<'EOF'
name: reusable
description: not a composite action
runs:
  using: node20
  main: index.js
EOF
check "a non-composite action is out of scope" pass "$WORK/reusable"

echo
if [ "$fails" -ne 0 ]; then
  echo "::error::$fails assertion(s) failed"
  exit 1
fi
echo "all assertions passed"
