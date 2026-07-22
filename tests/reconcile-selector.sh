#!/usr/bin/env bash
# Regression tests for the reconcile sweep's membership selectors.
#
# Same discipline as the other suites: the jq programs are extracted verbatim from the workflow and
# run against fixture nodes, so what is asserted here is what ships. There is nothing to stub, since
# the selectors are pure functions of the GraphQL result.
#
# The central case is a PR carrying the `epic:<N>` label with no `Closes` line — the shape of a
# cross-repo re-pin or an infra PR pulled into a wave. merge-gate holds every member of an unready
# set at `failure`, and this sweep is the only thing that releases one, so a member it cannot see
# keeps the whole wave behind a permanently-red required check.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORKFLOW="${1:-$ROOT/.github/workflows/reconcile-board.yaml}"

extract_jq() { # $1 = the shell variable the filter is assigned to
  sed -n "/^          $1=\$(echo/,/\]')\$/p" "$WORKFLOW" | sed -e "1s/^[^']*'//" -e "\$s/')\$//"
}

TASKS_FILTER=$(extract_jq tasks)
EPIC_FILTER=$(extract_jq epic_prs)

for name in TASKS_FILTER EPIC_FILTER; do
  if [ -z "${!name}" ]; then
    echo "::error::could not extract the $name from $WORKFLOW — did the assignment move or change indent?"
    exit 1
  fi
done

# Four PRs covering every combination that matters.
NODES=$(
  cat <<'EOF'
[
  { "number": 1, "headRefOid": "sha1", "repository": {"name": "repo-a"},
    "labels": {"nodes": [{"name": "epic:417"}]},
    "closingIssuesReferences": {"nodes": [{"parent": {"number": 417}}]} },

  { "number": 2, "headRefOid": "sha2", "repository": {"name": "repo-b"},
    "labels": {"nodes": [{"name": "epic:417"}]},
    "closingIssuesReferences": {"nodes": []} },

  { "number": 3, "headRefOid": "sha3", "repository": {"name": "repo-c"},
    "labels": {"nodes": [{"name": "dependencies"}]},
    "closingIssuesReferences": {"nodes": [{"parent": {"number": 417}}]} },

  { "number": 4, "headRefOid": "sha4", "repository": {"name": "repo-d"},
    "labels": {"nodes": []},
    "closingIssuesReferences": {"nodes": [{"parent": null}]} }
]
EOF
)

fails=0
check() { # $1=label $2=expected $3=actual
  if [ "$2" = "$3" ]; then
    echo "  ok   $1"
  else
    echo "  FAIL $1: expected [$2], got [$3]"
    fails=$((fails + 1))
  fi
}

selected() { printf '%s' "$NODES" | jq -c "$1" | jq -c '[.[].number]'; }

echo "== epic_prs: membership is the label, not the Closes walk =="

got=$(selected "$EPIC_FILTER")

# PR 2 is the regression: labelled, no Closes. Under the previous Closes-walk selector it was invisible
# to the sweep, so merge-gate never got re-posted and it stayed held forever.
check "a labelled PR with no Closes is selected" "[1,2]" "$got"

case "$got" in
  *3*) echo "  FAIL an unlabelled PR was selected"; fails=$((fails + 1)) ;;
  *) echo "  ok   an unlabelled PR with a parented Closes is not selected" ;;
esac

echo "== tasks: status re-derivation still follows the Closes walk =="

# derive-status reads the closing reference, so this half is correctly Closes-driven and must not have
# been changed along with the other.
check "every PR closing an issue is re-derived" "[1,3,4]" "$(selected "$TASKS_FILTER")"

echo "== the previous selector, for contrast =="

OLD_FILTER='[.[]
  | select(.number and (([.closingIssuesReferences.nodes[].parent] | map(select(. != null)) | length) > 0))
  | {repo: .repository.name, number, sha: .headRefOid}]'

old=$(selected "$OLD_FILTER")
check "it missed the labelled PR and swept an unlabelled one" "[1,3]" "$old"

echo
if [ "$fails" -ne 0 ]; then
  echo "::error::$fails assertion(s) failed"
  exit 1
fi
echo "all assertions passed"
