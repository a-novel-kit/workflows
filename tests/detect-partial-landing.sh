#!/usr/bin/env bash
# Regression tests for detect-partial-landing's membership sourcing.
#
# These actions are bash inside a composite manifest, so there is nothing to import: the harness
# EXTRACTS the functions under test verbatim from the manifest and sources them, which keeps the
# shipped code the code that runs here — a paraphrase would drift the moment the action changed.
# Only the network leaves are stubbed (gh, and the three read helpers evaluate_epic calls), so every
# decision below is the real predicate running on fixture truth. Offline and deterministic.
#
# The case that matters: a member de-labeled and closed mid-landing. Live label truth has forgotten
# it — GitHub indexes no "ever carried label X" — so the detector reads the survivors as a clean
# landing and clears. The frozen activation snapshot is what keeps it a member, and the first two
# assertions are that exact counterfactual on identical fixtures.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ACTION="${1:-$ROOT/generic-actions/detect-partial-landing/action.yaml}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

extract() { # $1 = function name — lift it out of the run: block and de-indent
  awk -v n="$1" '
    $0 ~ "^        "n"\\(\\) \\{" {f=1}
    f {print}
    f && /^        \}$/ {exit}
  ' "$ACTION" | sed 's/^        //'
}

for fn in snapshot_buckets evaluate_epic; do
  out=$(extract "$fn")
  if [ -z "$out" ]; then
    echo "::error::could not extract $fn from $ACTION — did its definition move or change indent?"
    exit 1
  fi
  printf '%s\n' "$out" >> "$WORK/lib.sh"
done

export ORG=a-novel-kit PLANNING_REPO=.github GRACE_MINUTES=30
export GITHUB_STEP_SUMMARY="$WORK/summary.md"
now_epoch=$(date -u +%s)
grace_seconds=1800

# ---- stubbed leaves ---------------------------------------------------------------------
# gh serves only the two calls snapshot_buckets makes; everything else is a harness bug.
gh() {
  case "$*" in
    *graphql*)
      [ "$FX_REHYDRATE" = "FAIL" ] && { echo "gh: Bad credentials" >&2; return 1; }
      printf '%s' "$FX_REHYDRATE" ;;
    *issues*)
      case "$FX_BODY" in
        FAIL404) echo "gh: Not Found (HTTP 404)" >&2; return 1 ;;
        FAIL500) echo "gh: HTTP 502" >&2; return 1 ;;
      esac
      printf '%s' "$FX_BODY" ;;
    *) echo "unexpected gh call: $*" >&2; return 1 ;;
  esac
}
search_prs() {
  case "$1" in
    *is:merged*) printf '%s' "$FX_LIVE_MERGED" ;;
    *is:unmerged*) printf '%s' "$FX_LIVE_CLOSED" ;;
    *is:open*) printf '%s' "$FX_LIVE_OPEN" ;;
  esac
}
merge_queue_entries() { printf '%s' "$FX_QUEUE"; }
rest_pr_state() { printf '%s' "$FX_REST" | jq -r --arg k "$1#$2" '.[$k] // "open false"'; }

# shellcheck disable=SC1091
. "$WORK/lib.sh"

# ---- fixtures ---------------------------------------------------------------------------
node() { # repo number state [mergedAt]
  jq -cn --arg r "$1" --argjson n "$2" --arg s "$3" --arg m "${4:-}" \
    '{number:$n, headRefOid:("sha"+($n|tostring)), mergedAt:(if $m=="" then null else $m end),
      baseRefName:"master", isDraft:false, state:$s, repository:{nameWithOwner:$r}}'
}
rehydrate() { # the aliased re-read response, one alias per member
  jq -s -c '{data: ([.[] | {pullRequest: .}] | to_entries
    | map({key:("m"+(.key|tostring)), value:.value}) | from_entries)}' <<<"$*"
}
marker() { # status members-json
  printf '<!-- epic-membership:snapshot:start -->\n%s\n<!-- epic-membership:snapshot:end -->\n' \
    "$(jq -cn --arg s "$1" --argjson m "$2" '{status:$s, at:"2026-07-20T10:00:00Z", members:$m}')"
}

A=$(node a-novel-kit/repo-a 1 MERGED "$(date -u -d '-40 minutes' +%Y-%m-%dT%H:%M:%SZ)")
B=$(node a-novel-kit/repo-b 2 CLOSED)   # the abandoned member: closed unmerged, label removed
C=$(node a-novel-kit/repo-c 3 OPEN)
ABC='[{"repo":"a-novel-kit/repo-a","number":1},{"repo":"a-novel-kit/repo-b","number":2},{"repo":"a-novel-kit/repo-c","number":3}]'
AC='[{"repo":"a-novel-kit/repo-a","number":1},{"repo":"a-novel-kit/repo-c","number":3}]'
FX_REST='{"a-novel-kit/repo-a#1":"closed true","a-novel-kit/repo-b#2":"closed false","a-novel-kit/repo-c#3":"open false"}'
FX_QUEUE='[{"number":3,"state":"QUEUED","headOid":"sha3"}]'  # repo-c sits in its queue → not a stray

# ---- assertions -------------------------------------------------------------------------
pass=0
fail=0
check() { # name expected-decision [expected-membership-source]
  local name="$1" want="$2" wantsrc="${3:-}" src
  evaluate_epic 900 >/dev/null 2>&1
  src=$(grep -o 'membership=[a-z]*' "$GITHUB_STEP_SUMMARY" | tail -1 | cut -d= -f2)
  : > "$GITHUB_STEP_SUMMARY"
  if [ "$EV_DECISION" = "$want" ] && { [ -z "$wantsrc" ] || [ "$src" = "$wantsrc" ]; }; then
    printf '  ✓ %-56s decision=%-7s membership=%s\n' "$name" "$EV_DECISION" "${src:-n/a}"
    pass=$((pass + 1))
  else
    printf '  ✗ %-56s decision=%-7s (want %s) membership=%s (want %s)\n' \
      "$name" "$EV_DECISION" "$want" "${src:-n/a}" "${wantsrc:-any}"
    fail=$((fail + 1))
  fi
}

echo "the regression: a member de-labeled and closed mid-landing"
FX_LIVE_MERGED="[$A]"; FX_LIVE_CLOSED='[]'; FX_LIVE_OPEN="[$C]"   # live truth has forgotten B
FX_BODY=""; FX_REHYDRATE=""
check "without a snapshot, the abandonment is invisible" clear live
FX_BODY=$(marker frozen "$ABC"); FX_REHYDRATE=$(rehydrate "$A" "$B" "$C")
check "the frozen set catches it" frozen snapshot

echo
echo "unchanged behaviour"
FX_BODY=$(marker frozen "$AC"); FX_REHYDRATE=$(rehydrate "$A" "$C")
check "a healthy set under a snapshot still clears" clear snapshot
FX_BODY=""; FX_LIVE_CLOSED="[$B]"
check "the live path still trips on a closed member" frozen live
FX_LIVE_CLOSED='[]'
check "the live path still clears a healthy set" clear live

echo
echo "a degraded marker falls back to live — never a crash, never a freeze on garbage"
FX_BODY=$(marker pending "$ABC")
check "a pending marker (the set has not settled)" clear live
FX_BODY='<!-- epic-membership:snapshot:start -->
{"status":"frozen","members":"nope"}
<!-- epic-membership:snapshot:end -->'
check "members of the wrong type" clear live
FX_BODY='<!-- epic-membership:snapshot:start -->
{{{ not json
<!-- epic-membership:snapshot:end -->'
check "hand-edited garbage" clear live
FX_BODY=FAIL404
check "the Epic issue is absent" clear live
FX_BODY=FAIL500
check "the body read fails outright" clear live
FX_BODY=$(marker frozen '[]')
check "an empty frozen set" clear snapshot

echo
echo "a frozen set that cannot be re-read fails closed, rather than downgrading to live"
FX_BODY=$(marker frozen "$ABC"); FX_REHYDRATE=FAIL
check "re-hydration fails outright" error
# evaluate_epic returns before it logs anything on this path, so stderr is the only diagnosis.
if evaluate_epic 900 2>&1 >/dev/null | grep -q 'could not re-read frozen member state'; then
  printf '  ✓ %s\n' "the reason reaches the run log"
  pass=$((pass + 1))
else
  printf '  ✗ %s\n' "the fail-closed pass is silent"
  fail=$((fail + 1))
fi
: > "$GITHUB_STEP_SUMMARY"

echo
echo "one unreadable member repo must not empty the set"
FX_REHYDRATE=$(jq -cn --argjson a "$A" --argjson b "$B" \
  '{data:{m0:{pullRequest:$a}, m1:{pullRequest:$b}, m2:{pullRequest:null}}, errors:[{message:"repo gone"}]}')
check "the survivors still trip the freeze" frozen snapshot

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
