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
# NOTE: the action computes these outside any extracted function, so the harness necessarily
# REIMPLEMENTS them rather than deriving them. A change to the action's own arithmetic would not be
# caught here — keep the two in sync by hand.
grace_seconds=$((GRACE_MINUTES * 60))
sleep() { :; } # retries are driven by the rehydrate_fails countdown; wall-clock delay is not useful here

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
  # Record the query. The stub dispatches on the `is:` token alone, so without this the rest of the
  # search grammar — the label qualifier and the org scope that BOUND membership — is unasserted, and
  # dropping either would silently make every open pull request in the org a member of every Epic.
  printf '%s\n' "$1" >> "$WORK/searches"
  [ "$FX_SEARCH_FAIL" = true ] && return 1
  # Fail exactly one of the three searches, so each fail-closed guard is pinned separately.
  case "$FX_SEARCH_FAIL_ON" in
    merged) case "$1" in *is:merged*) return 1 ;; esac ;;
    closed) case "$1" in *is:unmerged*) return 1 ;; esac ;;
    open) case "$1" in *is:open*) return 1 ;; esac ;;
  esac
  case "$1" in
    *is:merged*) printf '%s' "$FX_LIVE_MERGED" ;;
    *is:unmerged*) printf '%s' "$FX_LIVE_CLOSED" ;;
    *is:open*) printf '%s' "$FX_LIVE_OPEN" ;;
    *) echo "unexpected search: $1" >&2; return 1 ;;
  esac
}
merge_queue_entries() { # $1=owner $2=repo $3=base
  [ "$FX_QUEUE_FAIL" = true ] && return 1
  # Honour all three arguments the real helper takes. A fixture that ignores them cannot catch an
  # owner/repo split swapped the wrong way round or a hard-coded base, both of which would read the
  # wrong queue for every member.
  printf '%s' "$FX_QUEUE" | jq -c --arg repo "$1/$2" --arg base "$3" \
    '[.[] | select((.repo // $repo) == $repo and (.base // $base) == $base)]'
}
rest_pr_state() {
  [ "$FX_REST_FAIL" = true ] && return 1
  [ "$FX_REST_FAIL_ON" = "$1#$2" ] && return 1
  printf '%s' "$FX_REST" | jq -er --arg k "$1#$2" '.[$k]' 2>/dev/null || {
    echo "harness gap: no REST fixture for $1#$2" >&2
    return 1
  }
}

# shellcheck disable=SC1091
. "$WORK/lib.sh"

# ---- fixtures ---------------------------------------------------------------------------
# A member node as the re-read returns it. `prov` is how the node proves it belongs to the Epic:
#   timeline = de-labeled now, but its timeline records having been labeled (the regression case)
#   label    = still carries the label
#   none     = neither — a pull request named by the marker that was never a member
node() { # repo number state [mergedAt] [prov: timeline|label|none]
  jq -cn --arg r "$1" --argjson n "$2" --arg s "$3" --arg m "${4:-}" --arg p "${5:-timeline}" --arg e "epic:900" \
    '{number:$n, headRefOid:("sha"+($n|tostring)), mergedAt:(if $m=="" then null else $m end),
      baseRefName:"master", isDraft:false, state:$s, repository:{nameWithOwner:$r},
      labels:{nodes:(if $p=="label" then [{name:$e}] else [] end)},
      timelineItems:{nodes:(if $p=="timeline" then [{label:{name:$e}}] else [] end)}}'
}
rehydrate() { # the aliased re-read response, one alias per member
  jq -s -c '{data: ([.[] | {pullRequest: .}] | to_entries
    | map({key:("m"+(.key|tostring)), value:.value}) | from_entries)}' <<<"$*"
}
# Builds the region EXACTLY as merge-gate writes it: fence, a human-readable note line, the compact
# payload, fence. The note is the part that matters — it lives INSIDE the fence, and a reader that
# parses the whole region as JSON chokes on it. A fixture that omits the note agrees with whatever the
# reader happens to do and can never catch that, which is how a parser change once made the feature
# silently inert end to end. Frozen payloads carry no `at`; only pending does.
marker() { # status members-json
  local payload note
  if [ "$1" = frozen ]; then
    payload=$(jq -cn --argjson m "$2" '{status:"frozen", members:$m}')
    note='_Epic membership, FROZEN at activation by the merge-gate. The authoritative set for this landing — a later de-label, close, or relabel does not change it. Do not edit._'
  else
    payload=$(jq -cn --arg s "$1" --argjson m "$2" '{status:$s, at:"2026-07-20T10:00:00Z", members:$m}')
    note='_Epic membership, PENDING — stabilizing before it freezes (the label index is eventually consistent). Do not edit._'
  fi
  printf '<!-- epic-membership:snapshot:start -->\n%s\n%s\n<!-- epic-membership:snapshot:end -->\n' "$note" "$payload"
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
  : > "$WORK/searches"
  FX_QUEUE='[{"number":3,"state":"QUEUED","headOid":"sha3"}]' # repo-c is queued → not a stray
  FX_SEARCH_FAIL=false
  FX_SEARCH_FAIL_ON=none
  FX_REST_FAIL=false
  FX_REST_FAIL_ON=none
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
  && ok "EV_OPEN offers exactly one roll-forward candidate" || ko "EV_OPEN would offer a de-labeled member to roll-forward"
reset_fixtures

echo
echo "the marker only widens membership to pull requests that were really members"
# The marker lives in an issue body, so its author is whoever can edit that issue, and every member it
# names becomes a freeze target posted with an org-wide checks:write token. Membership has to be
# corroborated against the permission-gated label, or one issue edit blocks merges across the org.
# In-org, so it clears the owner check and really reaches corroboration.
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo-b","number":2},{"repo":"a-novel-kit/VICTIM","number":4242}]')
FX_REHYDRATE=$(rehydrate "$B" "$(node a-novel-kit/VICTIM 4242 OPEN '' none)")
# `error`, not `clear`: falling back to the live floor would POST success and lift a standing freeze,
# so an untrustworthy marker must decide nothing rather than decide optimistically.
check "a named pull request that was never a member decides nothing" error
# A labeled intruder: corroboration must match THIS Epic's label, not merely "has some label", and
# not a different Epic's.
FX_REHYDRATE=$(rehydrate "$B" "$(jq -cn --argjson v "$(node a-novel-kit/VICTIM 4242 OPEN '' none)" \
  '$v | .labels.nodes = [{name:"bug"}]')")
check "an intruder carrying an unrelated label is still rejected" error
FX_REHYDRATE=$(rehydrate "$B" "$(jq -cn --argjson v "$(node a-novel-kit/VICTIM 4242 OPEN '' none)" \
  '$v | .timelineItems.nodes = [{label:{name:"epic:901"}}]')")
check "an intruder labeled for a DIFFERENT Epic is rejected" error
printf '%s' "$EV_OPEN" | jq -e 'any(.repository.nameWithOwner == "a-novel-kit/VICTIM")' >/dev/null \
  && ko "the planted pull request reached the freeze target set" \
  || ok "and it never reaches the freeze target set"
# A repository outside the org can never be a member: the live label search is org-scoped, so a marker
# naming one would let its author corroborate in a repository they control.
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo-b","number":2},{"repo":"attacker/anything","number":1}]')
FX_REHYDRATE=$(rehydrate "$B" "$(node attacker/anything 1 OPEN)")
check "a member outside the org is rejected outright" clear live 1/0/1
FX_BODY=$(marker frozen "$BC")
FX_REHYDRATE=$(rehydrate "$B" "$(node a-novel-kit/repo-c 3 OPEN '' label)")
check "a member still carrying the label is corroborated" frozen live+snapshot 1/1/1
FX_REHYDRATE=$(rehydrate "$B" "$C") # B is de-labeled: only its timeline proves membership
check "a de-labeled member is corroborated by its timeline" frozen live+snapshot 1/1/1
# GraphQL follows a rename and answers with the NEW name. A frozen marker is never rewritten, so
# matching identity on the name would strand a renamed member's Epic at `error` forever.
FX_REST=$(printf '%s' "$FX_REST" | jq -c '. + {"a-novel-kit/repo-b-renamed#2":"closed false"}')
FX_REHYDRATE=$(rehydrate "$(node a-novel-kit/repo-b-renamed 2 CLOSED)" "$C")
check "a member whose repository was renamed still resolves" frozen live+snapshot 1/1/1
reset_fixtures

echo
echo "the roll-forward target set, on BOTH membership paths"
# Every node must carry liveMember whichever path built it. jq reads a missing key as null, so an
# untagged node silently drops out of the roll-forward filter and into its skip-warning — disabling
# recovery for exactly the Epics that have no snapshot yet, which is all of them before activation.
reset_fixtures
FX_QUEUE='[]' # repo-c left its queue: a stray, still labeled, within grace
FX_LIVE_MERGED="[$(node a-novel-kit/repo-a 1 MERGED "$AGO5")]"
evaluate_epic 900 >/dev/null 2>&1
: > "$GITHUB_STEP_SUMMARY"
[ "$(printf '%s' "$EV_STRAYS" | jq '[.[] | select((.isDraft | not) and .liveMember)] | length')" = 1 ] \
  && ok "no snapshot: EV_STRAYS still offers a roll-forward candidate" \
  || ko "no snapshot: the roll-forward selected nothing (untagged nodes)"
[ "$(printf '%s' "$EV_STRAYS" | jq '[.[] | select((.isDraft | not) and (.liveMember | not))] | length')" = 0 ] \
  && ok "no snapshot: EV_STRAYS reports nothing as de-labeled" \
  || ko "no snapshot: a labeled stray was warned about as de-labeled"
reset_fixtures

echo
echo "the GraphQL document it builds"
FX_BODY=$(marker frozen "$BC")
FX_REHYDRATE=$(rehydrate "$B" "$C")
evaluate_epic 900 >/dev/null 2>&1
: > "$GITHUB_STEP_SUMMARY"
q=$(cat "$WORK/gh_calls")
for want in 'owner:"a-novel-kit", name:"repo-b"' 'number:2' 'owner:"a-novel-kit", name:"repo-c"' 'number:3' \
            'm0:' 'm1:' 'state' 'headRefOid' 'mergedAt' 'baseRefName' 'isDraft' 'nameWithOwner' \
            'labels(first:100)' 'LABELED_EVENT'; do
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
FX_LIVE_CLOSED="[$B]" # a closed member, but nothing has landed: there is no partial landing to protect
check "a closed member with nothing merged is not a partial landing" clear live 0/1/1

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
echo "the snapshot is the fresher read, so it wins a collision"
# Both sources describe repo-c#3. The freeze is posted on headRefOid, and the live search index lags a
# direct read, so a stale head here is the "stranded on Expected" failure the action exists to avoid.
reset_fixtures
FX_LIVE_OPEN="[$(node a-novel-kit/repo-c 3 OPEN)]" # index still reports the old head
FX_BODY=$(marker frozen "$BC")
FX_REHYDRATE=$(rehydrate "$B" "$(jq -cn --argjson c "$C" '$c | .headRefOid = "sha3-FRESH"')")
evaluate_epic 900 >/dev/null 2>&1
: > "$GITHUB_STEP_SUMMARY"
printf '%s' "$EV_OPEN" | jq -e 'any(.number == 3 and .headRefOid == "sha3-FRESH")' >/dev/null \
  && ok "EV_OPEN carries the snapshot's head, not the index's" \
  || ko "the freeze would be posted on the stale head"
[ "$(printf '%s' "$EV_OPEN" | jq '[.[] | select(.number == 3)] | length')" = 1 ] \
  && ok "and the member appears exactly once" || ko "the member was double-counted across sources"

echo
echo "membership is bounded by the label and the org"
reset_fixtures
evaluate_epic 900 >/dev/null 2>&1
: > "$GITHUB_STEP_SUMMARY"
for want in 'label:"epic:900"' 'org:a-novel-kit'; do
  # All THREE searches, not merely one: a grep over the file would pass while two of them ran unscoped.
  [ "$(grep -cF -- "$want" "$WORK/searches")" = 3 ] \
    && ok "all three member searches are scoped by $want" \
    || ko "a member search is missing $want — the set would be every open pull request"
done
: > "$WORK/searches"
evaluate_epic 901 >/dev/null 2>&1
: > "$GITHUB_STEP_SUMMARY"
[ "$(grep -cF 'label:"epic:901"' "$WORK/searches")" = 3 ] \
  && ok "and the label follows the Epic being evaluated" || ko "the Epic label is not interpolated"

echo
echo "the merge queue is read per (repo, base), and only members are dequeued"
reset_fixtures
# An unrelated pull request sits in the same queue: it must not become an Epic member.
FX_QUEUE='[{"number":3,"state":"QUEUED","headOid":"sha3"},{"number":999,"state":"QUEUED","headOid":"sha999"}]'
evaluate_epic 900 >/dev/null 2>&1
: > "$GITHUB_STEP_SUMMARY"
[ "$(printf '%s' "$EV_QUEUE" | jq 'length')" = 1 ] \
  && ok "an unrelated queue entry is not treated as a member" \
  || ko "a non-member queue entry leaked into EV_QUEUE (it would be dequeued)"
reset_fixtures
FX_QUEUE='[{"number":3,"state":"QUEUED","headOid":"sha3","repo":"a-novel-kit/repo-c","base":"master"}]'
check "the queue is read with the member's own repo and base" clear live 1/0/1
reset_fixtures

echo
echo "a freeze is confirmed against REST before it blocks anyone"
# Each guard gets its own fixture: a single failure that trips all three at once proves only that at
# least one survives, and any one of them could then be deleted unnoticed.
FX_LIVE_CLOSED="[$B]"
FX_REST='{"a-novel-kit/repo-a#1":"open false","a-novel-kit/repo-b#2":"closed false","a-novel-kit/repo-c#3":"open false"}'
check "a 'merged' member REST says is open blocks the freeze" error live 1/1/1
FX_REST='{"a-novel-kit/repo-a#1":"closed false","a-novel-kit/repo-b#2":"closed false","a-novel-kit/repo-c#3":"open false"}'
check "a 'merged' member REST says is closed-unmerged blocks it too" error live 1/1/1
FX_REST='{"a-novel-kit/repo-a#1":"closed true","a-novel-kit/repo-b#2":"open false","a-novel-kit/repo-c#3":"open false"}'
check "a 'closed' member REST says is open blocks the freeze" error live 1/1/1
reset_fixtures
FX_QUEUE='[]' # repo-c looks like a stray to the index...
FX_REST='{"a-novel-kit/repo-a#1":"closed true","a-novel-kit/repo-b#2":"closed false","a-novel-kit/repo-c#3":"closed true"}'
check "a candidate stray REST says is merged is not a stray" clear live 1/0/1
reset_fixtures

echo
echo "the grace clock"
FX_QUEUE='[]'
FX_LIVE_MERGED="[$(node a-novel-kit/repo-a 1 MERGED "$AGO40"),$(node a-novel-kit/repo-d 4 MERGED "$AGO5")]"
FX_REST=$(printf '%s' "$FX_REST" | jq -c '. + {"a-novel-kit/repo-d#4":"closed true"}')
check "grace runs from the FIRST merge, not the most recent" frozen live 2/0/1
FX_LIVE_MERGED="[$(node a-novel-kit/repo-a 1 MERGED 'not-a-date')]"
check "an unparseable merge time never elapses grace" clear live 1/0/1
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
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo-b","number":0}]')
check "member number zero" clear live 1/0/1
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo-b","number":2147483648}]')
check "a member number past Int range" clear live 1/0/1
FX_BODY=$(marker frozen "$(jq -cn '[range(51) | {repo:"a-novel-kit/repo-b", number:(.+1)}]')")
check "a frozen set over the member cap" clear live 1/0/1
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/x\"){pullRequest(number:1){number}}} evil: rateLimit{cost","number":1}]')
check "a member repo carrying a GraphQL injection" clear live 1/0/1
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo\nEVIL: rateLimit{cost}","number":1}]')
check "a member repo carrying a newline" clear live 1/0/1
# The case the whole-string anchors exist for: jq's `$` matches BEFORE a final newline, so a bare
# trailing one passes `^…$`. It emits a raw line break inside a GraphQL string literal — a
# document-level error that no retry clears, wedging the Epic forever.
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo-b\n","number":2}]')
check "a member repo with a bare trailing newline" clear live 1/0/1
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
echo "a pseudo-fence cannot shadow the real marker"
# Readers once matched the fence as a SUBSTRING while merge-gate's splice matches whole lines, so a
# decoy fence inside an HTML comment was read as the marker yet was invisible to the writer — a tamper
# that survived every self-heal pass.
FX_BODY=$(printf '%s\n%s\n%s\n\n%s' \
  '<!--- <!-- epic-membership:snapshot:start --> --->' \
  '{"status":"frozen","members":[{"repo":"a-novel-kit/DECOY","number":4242}]}' \
  '<!--- <!-- epic-membership:snapshot:end --> --->' \
  "$(marker frozen "$BC")")
FX_REHYDRATE=$(rehydrate "$B" "$C")
check "a decoy fence in an HTML comment is ignored" frozen live+snapshot 1/1/1
printf '%s' "$EV_OPEN" | jq -e 'any(.repository.nameWithOwner == "a-novel-kit/DECOY")' >/dev/null \
  && ko "the decoy marker was used" || ok "and the real marker is the one that was read"
reset_fixtures

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
# GitHub answers a pullRequest(number:) that does not exist with a null and NO errors array, so the
# member count is the only thing standing between a short answer and a silent clear.
FX_REHYDRATE=$(jq -cn --argjson b "$B" '{data:{m0:{pullRequest:$b}, m1:{pullRequest:null}}}')
check "a short answer carrying no errors array" error
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
for which in merged closed open; do
  reset_fixtures
  FX_SEARCH_FAIL_ON="$which"
  check "a failed '$which' member search fails closed" error
done
FX_SEARCH_FAIL=true
check "all searches failing fails closed" error
reset_fixtures
FX_LIVE_CLOSED="[$B]"
FX_REST_FAIL_ON='a-novel-kit/repo-a#1'
check "a failed REST read of the merged member fails closed" error
reset_fixtures
FX_LIVE_CLOSED="[$B]"
FX_REST_FAIL_ON='a-novel-kit/repo-b#2'
check "a failed REST read of the closed member fails closed" error
reset_fixtures
FX_QUEUE='[]'
FX_REST_FAIL_ON='a-novel-kit/repo-c#3'
check "a failed REST read of a candidate stray fails closed" error
reset_fixtures
FX_REST_FAIL=true
FX_LIVE_CLOSED="[$B]"
check "every REST read failing fails closed" error
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
# A floor on the count, not just on failures: a suite that runs no assertions at all exits 0 and reads
# as green, which is the one way a test file can protect nothing while looking like it protects
# everything. Raise this when assertions are added; never lower it to make a run pass.
# Report failures first: they are the useful diagnosis. The floor below is about assertions that never
# RAN, so it counts executions (pass + fail) — counting passes alone would make any ordinary failure
# masquerade as a truncated suite.
ran=$((pass + fail))
if [ "$fail" -gt 0 ]; then
  echo "::error::$fail assertion(s) failed"
  exit 1
fi
if [ "$ran" -lt 95 ]; then
  echo "::error::only $ran assertion(s) ran (expected at least 95) — the suite did not execute fully"
  exit 1
fi
