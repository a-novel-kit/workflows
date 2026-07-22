#!/usr/bin/env bash
# Regression tests for merge-gate's activation-snapshot write path.
#
# Same approach as tests/detect-partial-landing.sh: the functions under test are EXTRACTED verbatim
# from the action manifest and sourced, so the shipped code is what runs here. Only `gh` is stubbed.
#
# What this covers is the lost-update race. The reconcile sweep runs merge-gate as a matrix over
# every open member pull request with no concurrency bound, and render-epic-status edits the same
# issue body from a job that does not wait for it — so writers overlap by design, against an API with
# no conditional update.
#
# The subtle half is not the write, it is the DECISION. `$do` and `$payload` are computed from a body
# read before the loop; a writer that re-reads but does not re-derive will freeze a member set the
# world has already moved past, and a retry loop makes it win. Several cases below exist only to pin
# that: a writer must abandon rather than make a stale freeze permanent.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ACTION="${1:-$ROOT/generic-actions/merge-gate/action.yaml}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

extract() { # $1 = function name — lift it out of the run: block and de-indent
  awk -v n="$1" '
    $0 ~ "^        "n"\\(\\) \\{" {f=1}
    f {print}
    f && /^        \}$/ {exit}
  ' "$ACTION" | sed 's/^        //'
}
for fn in splice current_marker same_marker write_marker; do
  out=$(extract "$fn")
  if [ -z "$out" ]; then
    echo "::error::could not extract $fn from $ACTION — did its definition move or change indent?"
    exit 1
  fi
  printf '%s\n' "$out" >> "$WORK/lib.sh"
done
if ! bash -n "$WORK/lib.sh"; then
  echo "::error::extracted functions do not parse — extraction truncated a definition"
  exit 1
fi

export ORG=a-novel-kit PLANNING_REPO=.github EPIC=900
export GITHUB_STEP_SUMMARY="$WORK/summary.md"
START='<!-- epic-membership:snapshot:start -->'
END='<!-- epic-membership:snapshot:end -->'
sleep() { :; }

# ---- the stubbed body store ---------------------------------------------------------------
# $WORK/body is the issue body on the server. $WORK/steal, when non-empty, is a peer write that lands
# immediately AFTER ours, once — the case an exit-code check calls a win. It models what the real peer
# (render-epic-status) does: keep what it found and add its own section OUTSIDE our region. A stub
# that replaced the whole body would delete that prose, and then no assertion could observe a lost
# update at all — which is the one thing this suite exists to see.
gh() {
  case "$*" in
    *"issues/${EPIC}"*)
      # File-backed: reads run inside $( ), so a shell-variable countdown would never reach the parent.
      if [ "$(< "$WORK/read_fails")" -gt 0 ]; then
        printf '%s' "$(($(< "$WORK/read_fails") - 1))" > "$WORK/read_fails"
        return 1
      fi
      # GitHub stores bodies with CRLF. Serving LF would leave every `tr -d '\r'` in the action
      # untested while its comments assert the strip is load-bearing.
      sed 's/$/\r/' "$WORK/body"
      ;;
    *"issue edit"*)
      [ -s "$WORK/edit_fails" ] && { printf 'x' >> "$WORK/writes"; echo "gh: HTTP 422" >&2; return 1; }
      # NOTE: ${*##pattern} strips per-positional-parameter and rejoins — join first, then strip.
      local all="$*" f
      f="${all##*--body-file }"; f="${f%% *}"
      printf 'x' >> "$WORK/writes"
      # A write that silently does not land — the API returned success but the body is unchanged.
      [ -s "$WORK/noop" ] || cp "$f" "$WORK/body"
      # File-backed for the same reason as read_fails: the write runs inside $( ), so clearing a
      # shell variable here would never reach the parent and the peer would strike on every attempt.
      if [ -s "$WORK/steal" ]; then cp "$WORK/steal" "$WORK/body"; : > "$WORK/steal"; fi
      ;;
    *) echo "unexpected gh call: $*" >&2; return 1 ;;
  esac
}

M1='[{"repo":"a-novel-kit/repo-a","number":1}]'
M2='[{"repo":"a-novel-kit/repo-a","number":1},{"repo":"a-novel-kit/repo-b","number":2}]'

pending_json() { jq -cn --arg at "${2:-2026-07-22T10:00:00Z}" --argjson m "$1" '{status:"pending", at:$at, members:$m}'; }
frozen_json() { jq -cn --argjson m "$1" '{status:"frozen", members:$m}'; }

region_file() { # $1 = payload json -> a region file built exactly as the action builds it
  local f
  f=$(mktemp -p "$WORK")
  { echo "$START"; echo "_Epic membership. Do not edit._"; printf '%s\n' "$1"; echo "$END"; } > "$f"
  printf '%s' "$f"
}
server_body() { # $1 = marker json, or empty for a body with no marker
  if [ -z "${1:-}" ]; then
    printf 'Some prose.\n\nMore prose.\n' > "$WORK/body"
  else
    printf 'Some prose.\n\n%s\n_note_\n%s\n%s\n\nMore prose.\n' "$START" "$1" "$END" > "$WORK/body"
  fi
}
marker_now() { current_marker "$(cat "$WORK/body")"; }
writes() { wc -c < "$WORK/writes" | tr -d ' '; }

# shellcheck disable=SC1091
. "$WORK/lib.sh"

pass=0
fail=0
ok() { printf '  ✓ %s\n' "$1"; pass=$((pass + 1)); }
ko() { printf '  ✗ %s\n' "$1"; fail=$((fail + 1)); }
eq() { [ "$2" = "$3" ] && ok "$1" || ko "$1 (got '$2', want '$3')"; }

reset() {
  printf 0 > "$WORK/read_fails"; : > "$WORK/writes"; : > "$WORK/steal"; : > "$WORK/noop"
  : > "$WORK/edit_fails"
  : > "$GITHUB_STEP_SUMMARY"; server_body ""
}
# Capture the function's own output so it cannot be mistaken for the exit code, and so both tee'd
# and plain log lines can be asserted from one place.
run() { write_marker "$(region_file "$payload")" > "$WORK/out" 2>&1 && echo 0 || echo $?; }
said() { grep -q "$1" "$WORK/out"; }

echo "the ordinary write"
reset
do=pending; cur="$M2"; payload=$(pending_json "$M2")
eq "a fresh pending marker is written" "$(run)" 0
eq "and the server carries it" "$(marker_now | jq -r .status)" pending
grep -q 'Some prose' "$WORK/body" && ok "human prose either side survives" || ko "prose was dropped"

echo
echo "a peer that writes after us"
reset
do=pending; cur="$M2"; payload=$(pending_json "$M2")
# The peer reverts the body, discarding our write. Nothing about that invalidates a pending decision,
# so we should notice and retry rather than trust the edit's exit code.
{ cat "$WORK/body"; printf '\n<!-- rendered by the peer -->\n'; } > "$WORK/steal"
eq "we retry until our write survives" "$(run)" 0
eq "and our marker is what finally stands" "$(marker_now | jq -r '.members | length')" 2
eq "which took two writes, not one" "$(writes)" 2
grep -q 'rendered by the peer' "$WORK/body" \
  && ok "and the peer's own edit outside our region survives" \
  || ko "LOST UPDATE: we overwrote the peer's edit"

echo
echo "a wiped marker invalidates a freeze in flight"
# A freeze means "the set held still since this pending marker". If the marker is gone, that premise
# cannot be re-established, so the pass abandons rather than freezing on faith.
reset
server_body "$(pending_json "$M2" 2026-07-22T09:00:00Z)"
do=frozen; cur="$M2"; payload=$(frozen_json "$M2")
printf 'Some prose.\n\nMore prose.\n' > "$WORK/steal"   # a peer that removes the marker outright
eq "the freeze is abandoned once its pending basis disappears" "$(run)" 2

echo
echo "frozen is terminal"
reset
server_body "$(frozen_json "$M2")"
do=pending; cur="$M1"; payload=$(pending_json "$M1")
eq "a pending writer yields rather than resetting it" "$(run)" 2
eq "the frozen marker is left intact" "$(marker_now | jq -r .status)" frozen
eq "with its member set untouched" "$(marker_now | jq -r '.members | length')" 2
eq "and nothing was written" "$(writes)" 0
said 'already frozen' && ok "and it says so in the run log" || ko "the yield is silent"

echo
echo "a stale freeze must not become permanent"
# THE case this rewrite exists for. Our pass decided `frozen` against members=M2. A peer has since
# seen the set change to M1 and reset the clock. Freezing M2 now would make a superseded set
# terminal — and the member it drops is then held forever by the gate.
reset
server_body "$(pending_json "$M1" 2026-07-22T10:05:00Z)"
do=frozen; cur="$M2"; payload=$(frozen_json "$M2")
eq "the writer abandons instead of freezing a superseded set" "$(run)" 2
eq "the peer's pending marker stands" "$(marker_now | jq -r .status)" pending
eq "with the peer's member set" "$(marker_now | jq -r '.members | length')" 1
eq "and nothing was written" "$(writes)" 0
said 'member set moved' && ok "and the abandonment is explained" || ko "abandoning is silent"

echo
echo "equivalent writers agree instead of fighting"
# Two writers with the same member set differ only in `at`. Byte-equality would leave neither able to
# satisfy the other: they would ping-pong to exhaustion and both report a failure that never happened.
reset
server_body "$(pending_json "$M2" 2026-07-22T09:59:00Z)"
do=pending; cur="$M2"; payload=$(pending_json "$M2" 2026-07-22T10:00:00Z)
eq "an equivalent marker already present counts as done" "$(run)" 0
eq "and no redundant write is issued" "$(writes)" 0

echo
echo "an orphaned payload line does not satisfy the verify"
# splice's recovery path strips fence lines but leaves old JSON behind as prose. A whole-body grep
# would match that orphan and report success while the region says something else.
reset
orphan=$(frozen_json "$M2")
# The body carries our exact payload as loose prose (what splice's recovery path leaves behind) plus
# a region saying something else. The write does not land, so a correct verify must fail — a
# whole-body grep would match the orphan and report success.
printf 'Some prose.\n%s\n\n%s\n_note_\n%s\n%s\n' "$orphan" "$START" "$(pending_json "$M2")" "$END" > "$WORK/body"
printf 'x' > "$WORK/noop"
do=frozen; cur="$M2"; payload=$(frozen_json "$M2")
eq "a write that never landed is not masked by the orphan" "$(run)" 1
eq "and the region still says what it did" "$(marker_now | jq -r .status)" pending

echo "a marker that cannot age must be repaired, not accepted"
# The decision step routes a corrupt or missing `at` here on purpose: a timestamp that cannot be read
# can never age, so the marker would sit pending forever and the Epic would keep live membership —
# with a success line every sweep. An equivalence test that ignores `at` must not swallow that.
for bad in '"not-a-date"' 'null'; do
  reset
  server_body "$(jq -cn --argjson m "$M2" --argjson at "$bad" '{status:"pending", at:$at, members:$m}')"
  do=pending; cur="$M2"; payload=$(pending_json "$M2")
  eq "an unreadable at ($bad) is rewritten" "$(run)" 0
  eq "which takes exactly one write" "$(writes)" 1
  marker_now | jq -e '.at | try (fromdateiso8601 | true) catch false' >/dev/null \
    && ok "and the marker can age again" || ko "the marker still cannot age"
done

echo
echo "member order is not a reason to abandon"
# The decision step compares members sorted; the re-derive guard must too, or a marker the decision
# calls stable is judged moved and the freeze is refused on every sweep forever.
reset
server_body "$(jq -cn --argjson m "$M2" '{status:"pending", at:"2026-07-22T09:00:00Z", members:($m | reverse)}')"
do=frozen; cur="$M2"; payload=$(frozen_json "$M2")
eq "a reordered member array still freezes" "$(run)" 0
eq "and the marker is frozen" "$(marker_now | jq -r .status)" frozen

echo
echo "splice, on its own"
# Driven directly, because the retry loop hides it: a broken splice writes a body with no fences, the
# next attempt takes the fallback branch, appends a correct region, and the verify passes. Every
# splice defect therefore reads as a green suite unless it is exercised on its own.
sp() { # $1 = body text, $2 = payload -> the spliced result
  local b r
  b=$(mktemp -p "$WORK"); r=$(region_file "$2")
  printf '%s\n' "$1" > "$b"
  splice "$b" "$r"
}
one_region() { [ "$(grep -cxF -- "$START" <<< "$1")" = 1 ] && [ "$(grep -cxF -- "$END" <<< "$1")" = 1 ]; }
inner() { awk -v s="$START" -v e="$END" '$0==s{f=1;next} $0==e{f=0} f' <<< "$1" | sed -n '/^[[:space:]]*[{[]/,$p'; }

P=$(frozen_json "$M2")
out=$(sp "$(printf 'top\n\n%s\n_note_\n%s\n%s\n\nbottom\n' "$START" "$(pending_json "$M1")" "$END")" "$P")
eq "an existing region is replaced in place" "$(inner "$out" | jq -r .status)" frozen
one_region "$out" && ok "leaving exactly one region" || ko "region count wrong"
grep -q '^top$' <<< "$out" && grep -q '^bottom$' <<< "$out" \
  && ok "with the prose either side intact" || ko "prose was dropped by the in-place branch"
# The replaced payload must be GONE, not merely out of the region: a stale copy left loose in the
# body is what lets a whole-body match report a marker that is not there.
grep -qF -- "$(pending_json "$M1")" <<< "$out" \
  && ko "the replaced payload is still in the body" \
  || ok "and the payload it replaced is gone entirely"

out=$(sp "$(printf 'only prose\n')" "$P")
eq "a body with no region gains one" "$(inner "$out" | jq -r .status)" frozen
grep -q '^only prose$' <<< "$out" && ok "and keeps the prose" || ko "prose lost on append"

out=$(sp "$(printf '%s\nA\n%s\ntext\n%s\nB\n%s\n' "$START" "$END" "$START" "$END")" "$P")
one_region "$out" && ok "duplicate fences are healed to one region" || ko "duplicate fences survived"

out=$(sp "$(printf '%s\nstray end first\n%s\n' "$END" "$START")" "$P")
one_region "$out" && ok "inverted fences are healed to one region" || ko "inverted fences survived"

echo
echo
echo "read failures"
reset
do=pending; cur="$M2"; payload=$(pending_json "$M2")
printf 2 > "$WORK/read_fails"
eq "two failed reads still converge on the third attempt" "$(run)" 0
reset
do=pending; cur="$M2"; payload=$(pending_json "$M2")
printf 99 > "$WORK/read_fails"
eq "a total read failure gives up rather than claiming success" "$(run)" 1

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
ran=$((pass + fail))
if [ "$fail" -gt 0 ]; then
  echo "::error::$fail assertion(s) failed"
  exit 1
fi
if [ "$ran" -lt 39 ]; then
  echo "::error::only $ran assertion(s) ran (expected at least 39) — the suite did not execute fully"
  exit 1
fi
