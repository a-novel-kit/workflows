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
# landing and clears. The frozen activation snapshot is what keeps it a member.
#
# Note the shape of the fixtures for that case. merge-gate captures the set from OPEN pull requests
# and freezes it only after the set holds still, while auto-merge is armed earlier — so a real frozen
# set routinely does NOT contain the members that already merged. The snapshot is therefore added to
# the live set rather than replacing it, and the fixtures model exactly that: `A` merged is visible
# only live, `B` abandoned only in the snapshot, and the freeze depends on both.
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

for fn in snapshot_buckets union_buckets evaluate_epic; do
  out=$(extract "$fn")
  if [ -z "$out" ]; then
    echo "::error::could not extract $fn from $ACTION — did its definition move or change indent?"
    exit 1
  fi
  printf '%s\n' "$out" >> "$WORK/lib.sh"
done
# Extraction stops at the first 8-space `}`. If that ever lands mid-function the result is invalid
# bash, and without this check the suite fails later with a confusing unbound-variable abort.
if ! bash -n "$WORK/lib.sh"; then
  echo "::error::extracted functions do not parse — extraction truncated a definition"
  exit 1
fi

export ORG=a-novel-kit PLANNING_REPO=.github GRACE_MINUTES=30
export GITHUB_STEP_SUMMARY="$WORK/summary.md"
now_epoch=$(date -u +%s)
grace_seconds=$((GRACE_MINUTES * 60)) # derived, so it cannot drift from the action's own arithmetic
sleep() { :; }                        # retry COUNTS are asserted via the gh call log, not by wall clock

# ---- stubbed leaves ---------------------------------------------------------------------
# Every stub can fail on demand: the action's central promise is that it fails CLOSED, and stubs
# that cannot fail leave that promise untested.
gh() {
  # Record every call so the QUERY can be asserted, not just its answer: the document this action
  # builds is the part no fixture would otherwise exercise, and a wrong field or alias in it is a
  # total feature outage.
  printf '%s\n' "$*" >> "$WORK/gh_calls"
  case "$*" in
    *graphql*)
      # The stub runs inside $( ), i.e. a subshell, so a shell-variable countdown would never reach
      # the parent. Keep it in a file to make "fail twice, then succeed" actually observable.
      if [ "$(< "$WORK/rehydrate_fails")" -gt 0 ]; then
        printf '%s' "$(($(< "$WORK/rehydrate_fails") - 1))" > "$WORK/rehydrate_fails"
        echo "gh: API rate limit exceeded" >&2
        return 1
      fi
      [ "$FX_REHYDRATE" = "FAIL" ] && { echo "gh: Bad credentials" >&2; return 1; }
      printf '%s' "$FX_REHYDRATE" ;;
    *issues*)
      case "$FX_BODY" in
        FAIL404) echo "gh: Not Found (HTTP 404)" >&2; return 1 ;;
        FAIL500) echo "gh: HTTP 502" >&2; return 1 ;;
        NOISE) echo "gh: a deprecation notice" >&2; jq -cn --arg b "$FX_MARKER_BODY" '{body: $b}' ;;
        *) jq -cn --arg b "$FX_BODY" '{body: $b}' ;;
      esac ;;
    *) echo "unexpected gh call: $*" >&2; return 1 ;;
  esac
}
search_prs() {
  [ "$FX_SEARCH_FAIL" = true ] && return 1
  case "$1" in
    *is:merged*) printf '%s' "$FX_LIVE_MERGED" ;;
    *is:unmerged*) printf '%s' "$FX_LIVE_CLOSED" ;;
    *is:open*) printf '%s' "$FX_LIVE_OPEN" ;;
    *) echo "unexpected search: $1" >&2; return 1 ;;
  esac
}
merge_queue_entries() {
  [ "$FX_QUEUE_FAIL" = true ] && return 1
  printf '%s' "$FX_QUEUE" | jq -c --arg repo "$1/$2" '[.[] | select(.repo == null or .repo == $repo)]'
}
rest_pr_state() {
  [ "$FX_REST_FAIL" = true ] && return 1
  printf '%s' "$FX_REST" | jq -er --arg k "$1#$2" '.[$k]' 2>/dev/null || {
    echo "harness gap: no REST fixture for $1#$2" >&2
    return 1
  }
}

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
marker() { # status members-json — mirrors merge-gate's payload (frozen carries no `at`)
  local payload
  if [ "$1" = frozen ]; then
    payload=$(jq -cn --argjson m "$2" '{status:"frozen", members:$m}')
  else
    payload=$(jq -cn --arg s "$1" --argjson m "$2" '{status:$s, at:"2026-07-20T10:00:00Z", members:$m}')
  fi
  printf '<!-- epic-membership:snapshot:start -->\n%s\n<!-- epic-membership:snapshot:end -->\n' "$payload"
}

AGO40=$(date -u -d '-40 minutes' +%Y-%m-%dT%H:%M:%SZ)
AGO5=$(date -u -d '-5 minutes' +%Y-%m-%dT%H:%M:%SZ)
A=$(node a-novel-kit/repo-a 1 MERGED "$AGO40")
B=$(node a-novel-kit/repo-b 2 CLOSED) # the abandoned member: closed unmerged, label removed
C=$(node a-novel-kit/repo-c 3 OPEN)
BC='[{"repo":"a-novel-kit/repo-b","number":2},{"repo":"a-novel-kit/repo-c","number":3}]'

reset_fixtures() {
  # Every fixture the assertions read lives here: a section that edits one and forgets to restore it
  # would silently redefine truth for every later assertion.
  FX_REST='{"a-novel-kit/repo-a#1":"closed true","a-novel-kit/repo-b#2":"closed false","a-novel-kit/repo-c#3":"open false"}'
  FX_LIVE_MERGED="[$A]" # A merged and still labeled: visible to the live search
  FX_LIVE_CLOSED='[]'   # B is de-labeled, so live truth has forgotten it entirely
  FX_LIVE_OPEN="[$C]"
  FX_BODY=""
  FX_REHYDRATE=""
  printf 0 > "$WORK/rehydrate_fails"
  : > "$WORK/gh_calls"
  FX_QUEUE='[{"number":3,"state":"QUEUED","headOid":"sha3"}]' # repo-c is queued → not a stray
  FX_SEARCH_FAIL=false
  FX_REST_FAIL=false
  FX_QUEUE_FAIL=false
}
reset_fixtures

# ---- assertions -------------------------------------------------------------------------
pass=0
fail=0
note() { printf '  %s %s\n' "$1" "$2"; }
ok() { note ✓ "$1"; pass=$((pass + 1)); }
ko() { note ✗ "$1"; fail=$((fail + 1)); }

check() { # name expected-decision [expected-membership] [expected merged/closed/open counts]
  local name="$1" want="$2" wantsrc="${3:-}" wantcounts="${4:-}" src counts detail=""
  evaluate_epic 900 >/dev/null 2>&1
  src=$(grep -o 'membership=[a-z+]*' "$GITHUB_STEP_SUMMARY" | tail -1 | cut -d= -f2)
  counts="$EV_MERGED_COUNT/$EV_CLOSED_COUNT/$EV_OPEN_COUNT"
  : > "$GITHUB_STEP_SUMMARY"
  [ "$EV_DECISION" = "$want" ] || detail="decision=$EV_DECISION (want $want)"
  { [ -z "$wantsrc" ] || [ "$src" = "$wantsrc" ]; } || detail="$detail membership=${src:-n/a} (want $wantsrc)"
  { [ -z "$wantcounts" ] || [ "$counts" = "$wantcounts" ]; } || detail="$detail counts=$counts (want $wantcounts)"
  if [ -z "$detail" ]; then
    printf '  ✓ %-54s %-7s %-14s %s\n' "$name" "$EV_DECISION" "${src:-n/a}" "$counts"
    pass=$((pass + 1))
  else
    printf '  ✗ %-54s %s\n' "$name" "$detail"
    fail=$((fail + 1))
  fi
}

echo "the regression: a member de-labeled and closed mid-landing"
check "on the live set alone, the abandonment is invisible" clear live 1/0/1
FX_BODY=$(marker frozen "$BC")
FX_REHYDRATE=$(rehydrate "$B" "$C")
check "the snapshot supplies it, and the Epic freezes" frozen live+snapshot 1/1/1
[ "$EV_REASON" = "a member was closed without merging" ] \
  && ok "and for the right reason" || ko "wrong reason: $EV_REASON"

echo
echo "the snapshot is ADDED to the live set, never swapped for it"
# The real capture shape: merge-gate freezes from open PRs, so an already-merged member is absent
# from the snapshot. Substituting would zero the merged bucket that gates every decision.
check "a merged member absent from the snapshot still counts" frozen live+snapshot 1/1/1
FX_REHYDRATE=$(rehydrate "$(node a-novel-kit/repo-b 2 MERGED "$AGO5")" "$C")
check "a member merged after the freeze is not double-counted" clear live+snapshot 2/0/1

echo
echo "the frozen member reaches the payload the freeze is posted on"
# A decision is worthless if the head it names is missing: EV_OPEN is what sweep_post_freeze targets.
FX_REHYDRATE=$(rehydrate "$(node a-novel-kit/repo-b 2 OPEN)" "$C")
FX_REST='{"a-novel-kit/repo-a#1":"closed true","a-novel-kit/repo-b#2":"open false","a-novel-kit/repo-c#3":"open false"}'
evaluate_epic 900 >/dev/null 2>&1
: > "$GITHUB_STEP_SUMMARY"
printf '%s' "$EV_OPEN" | jq -e 'any(.repository.nameWithOwner == "a-novel-kit/repo-b" and .number == 2)' >/dev/null \
  && ok "a de-labeled open member is in EV_OPEN, so it gets a check" \
  || ko "the de-labeled open member is missing from EV_OPEN"
printf '%s' "$EV_OPEN" | jq -e 'any(.repository.nameWithOwner == "a-novel-kit/repo-b" and (.liveMember | not))' >/dev/null \
  && ok "and is tagged as no longer live-labeled" || ko "liveMember tag missing or wrong"
printf '%s' "$EV_OPEN" | jq -e 'any(.repository.nameWithOwner == "a-novel-kit/repo-c" and .liveMember)' >/dev/null \
  && ok "while a still-labeled member is tagged live" || ko "a live member was mis-tagged"
# The roll-forward reads exactly this filter; a de-labeled member must not be re-armed.
printf '%s' "$EV_OPEN" | jq -e '[.[] | select((.isDraft | not) and .liveMember)] | length == 1' >/dev/null \
  && ok "only the live-labeled member is a roll-forward target" || ko "roll-forward would touch a de-labeled member"
reset_fixtures

echo
echo "the GraphQL document it builds"
FX_BODY=$(marker frozen "$BC")
FX_REHYDRATE=$(rehydrate "$B" "$C")
evaluate_epic 900 >/dev/null 2>&1
: > "$GITHUB_STEP_SUMMARY"
q=$(cat "$WORK/gh_calls")
for want in 'owner:"a-novel-kit", name:"repo-b"' 'number:2' 'owner:"a-novel-kit", name:"repo-c"' 'number:3' \
            'm0:' 'm1:' 'state' 'headRefOid' 'mergedAt' 'baseRefName' 'isDraft' 'nameWithOwner'; do
  case "$q" in
    *"$want"*) ok "queries $want" ;;
    *) ko "the re-read query is missing: $want" ;;
  esac
done
# `2.0` is a valid integer to the guard (it equals its own floor) but jq preserves the literal a body
# was written with, and `number:2.0` is an Int! violation that rejects the WHOLE document — no retry
# clears it, so the Epic would wedge forever. It has to render canonically.
reset_fixtures
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo-b","number":2.0}]')
FX_REHYDRATE=$(rehydrate "$B")
evaluate_epic 900 >/dev/null 2>&1
: > "$GITHUB_STEP_SUMMARY"
q=$(cat "$WORK/gh_calls")
case "$q" in
  *"number:2.0"*) ko "a float-valued member number reaches the query verbatim" ;;
  *"number:2"*) ok "a float-valued member number renders as a canonical integer" ;;
  *) ko "the re-read query never rendered the member number" ;;
esac
reset_fixtures

echo
echo "unchanged behaviour"
reset_fixtures
check "a healthy live set clears" clear live 1/0/1
FX_LIVE_CLOSED="[$B]"
check "a closed member still labeled trips without any snapshot" frozen live 1/1/1
reset_fixtures
FX_LIVE_MERGED='[]'
check "nothing merged yet, so nothing can be partial" clear live 0/0/1

echo
echo "the stray + grace path, under a snapshot"
reset_fixtures
FX_QUEUE='[]' # repo-c left its queue
FX_BODY=$(marker frozen "$BC")
FX_REHYDRATE=$(rehydrate "$(node a-novel-kit/repo-b 2 OPEN)" "$C")
FX_REST='{"a-novel-kit/repo-a#1":"closed true","a-novel-kit/repo-b#2":"open false","a-novel-kit/repo-c#3":"open false"}'
check "a stray past grace freezes" frozen live+snapshot 1/0/2
FX_LIVE_MERGED="[$(node a-novel-kit/repo-a 1 MERGED "$AGO5")]"
check "the same stray within grace does not" clear live+snapshot 1/0/2
reset_fixtures

echo
echo "a degraded marker falls back to the live floor — never a crash, never a freeze on garbage"
FX_BODY=$(marker pending "$BC")
check "a pending marker (the set has not settled)" clear live 1/0/1
FX_BODY='<!-- epic-membership:snapshot:start -->
{"status":"frozen","members":"nope"}
<!-- epic-membership:snapshot:end -->'
check "members of the wrong type" clear live 1/0/1
FX_BODY='<!-- epic-membership:snapshot:start -->
{{{ not json
<!-- epic-membership:snapshot:end -->'
check "hand-edited garbage" clear live 1/0/1
FX_BODY=$(marker frozen '[{"repo":"noslash","number":2}]')
check "a member repo with no owner" clear live 1/0/1
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo-b","number":"2"}]')
check "a member number that is a string" clear live 1/0/1
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo-b","number":1.5}]')
check "a non-integer member number (a whole-document error)" clear live 1/0/1
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/x\"){pullRequest(number:1){number}}} evil: rateLimit{cost","number":1}]')
check "a member repo carrying a GraphQL injection" clear live 1/0/1
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo\nEVIL: rateLimit{cost}","number":1}]')
check "a member repo carrying a newline" clear live 1/0/1
# One bad member must poison the whole set: validating with `any` instead of `all` would let the
# injection through alongside a legitimate member.
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo-b","number":2},{"repo":"a-novel-kit/x\"){evil","number":1}]')
check "one evil member among valid ones" clear live 1/0/1
# The repo pattern must be anchored at BOTH ends: a payload in the prefix still ends in a valid name.
FX_BODY=$(marker frozen '[{"repo":"evil\"){x} a-novel-kit/repo-b","number":2}]')
check "a member repo with an injected prefix" clear live 1/0/1
FX_BODY=$(marker frozen '[]')
check "an empty frozen set" clear live 1/0/1
FX_BODY=FAIL404
check "the Epic issue is absent" clear live 1/0/1
# An unreadable body is IGNORANCE, not an answer: we cannot tell whether a snapshot exists, and a
# `clear` would post success and lift a freeze an earlier pass set. Only a 404 is an answer.
FX_BODY=FAIL500
check "the body read fails outright — decide nothing" error
# A benign notice on stderr must not corrupt the payload — it costs a whole pass now that an
# unreadable body no longer falls back to the live floor.
FX_MARKER_BODY=$(marker frozen "$BC")
FX_REHYDRATE=$(rehydrate "$B" "$C")
FX_BODY=NOISE
check "a gh notice on stderr does not corrupt the body" frozen live+snapshot 1/1/1
FX_REHYDRATE=""

echo
echo "the marker is parsed as JSON, not as a single line of text"
FX_BODY=$(printf '<!-- epic-membership:snapshot:start -->\n%s\n<!-- epic-membership:snapshot:end -->\n' \
  "$(jq -n --argjson m "$BC" '{status:"frozen", members:$m}')") # pretty-printed
FX_REHYDRATE=$(rehydrate "$B" "$C")
check "a pretty-printed marker still freezes" frozen live+snapshot 1/1/1
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo-b","number":2},{"repo":"a-novel-kit/repo-b","number":2},{"repo":"a-novel-kit/repo-c","number":3}]')
check "a duplicated member is de-duplicated, not double-counted" frozen live+snapshot 1/1/1
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo-B","number":2},{"repo":"a-novel-kit/repo-b","number":2},{"repo":"a-novel-kit/repo-c","number":3}]')
check "a case-variant duplicate is one member, not two" frozen live+snapshot 1/1/1
# Two DISTINCT members in one repository: cross-repo Epics reuse numbers, so the dedup key has to be
# the pair. Keyed on repo alone these would collapse and the set would silently lose a member.
FX_REST=$(printf '%s' "$FX_REST" | jq -c '. + {"a-novel-kit/repo-b#4":"open false"}')
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo-b","number":2},{"repo":"a-novel-kit/repo-b","number":4}]')
FX_REHYDRATE=$(rehydrate "$B" "$(node a-novel-kit/repo-b 4 OPEN)")
check "two members in one repository stay two" frozen live+snapshot 1/1/2
reset_fixtures

echo
echo "a frozen set that cannot be resolved fails closed — it never decides on the live floor alone"
FX_BODY=$(marker frozen "$BC")
FX_REHYDRATE=FAIL
check "re-hydration fails outright" error
# evaluate_epic returns before it logs anything on this path, so stderr is the only diagnosis.
evaluate_epic 900 2>&1 >/dev/null | grep -q 'could not re-read all 2 frozen member' \
  && ok "the reason reaches the run log" || ko "the fail-closed pass is silent"
: > "$GITHUB_STEP_SUMMARY"
FX_REHYDRATE=$(jq -cn '{data:{m0:null,m1:null}, errors:[{message:"NOT_FOUND"}]}')
check "every alias nulled (data has keys, but no members)" error
FX_REHYDRATE=$(jq -cn --argjson b "$B" '{data:{m0:{pullRequest:$b}, m1:{pullRequest:null}}, errors:[{message:"timeout"}]}')
check "one alias nulled — a short answer is not a clean set" error
FX_REHYDRATE=$(rehydrate "$B" "$C" | jq -c '. + {errors:[{message:"something went wrong"}]}')
check "a complete answer that still reports errors is not trusted" error
FX_REHYDRATE=$(rehydrate "$B" "$(node a-novel-kit/UNRELATED 4242 OPEN)")
# Give the intruder full REST + queue backing, so `error` can only come from the identity check
# rejecting it — not from the harness running out of fixtures for a PR it never expected.
FX_REST=$(printf '%s' "$FX_REST" | jq -c '. + {"a-novel-kit/UNRELATED#4242":"open false"}')
FX_QUEUE='[{"number":3,"state":"QUEUED","headOid":"sha3"},{"number":4242,"state":"QUEUED","headOid":"sha4242"}]'
check "a node for a pull request nobody asked about" error
FX_QUEUE='[{"number":3,"state":"QUEUED","headOid":"sha3"}]'
FX_REHYDRATE=$(rehydrate "$B" "$(jq -cn --argjson c "$C" '$c | del(.state)')")
check "a member whose state is missing" error

echo
echo "transient failures retry, then the floor's own failures fail closed"
FX_REHYDRATE=$(rehydrate "$B" "$C")
printf 2 > "$WORK/rehydrate_fails"
check "re-hydration recovers on the third attempt" frozen live+snapshot 1/1/1
reset_fixtures
FX_SEARCH_FAIL=true
check "a failed label search" error
reset_fixtures
FX_REST_FAIL=true
FX_LIVE_CLOSED="[$B]"
check "a failed REST confirmation" error
reset_fixtures
FX_QUEUE_FAIL=true
check "a failed merge-queue read" error

echo
echo "state does not leak between Epics in one sweep process"
reset_fixtures
FX_BODY=$(marker frozen "$BC")
FX_REHYDRATE=$(rehydrate "$B" "$C")
evaluate_epic 900 >/dev/null 2>&1
: > "$GITHUB_STEP_SUMMARY"
FX_BODY="" # the next Epic has no snapshot at all
check "an Epic with no snapshot sees none of the previous one's" clear live 1/0/1

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
