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
# The subtle half is not the write, it is what the write DOES WITH a decision made earlier. `$do` and
# `$payload` are computed from a body read before the loop; a writer that re-reads but does not
# re-derive will freeze a member set the world has already moved past, and a retry loop makes it win.
# Several cases below exist only to pin that.
#
# Scope: this drives `write_marker` and its helpers. The decision step that PRODUCES `$do`/`$payload`
# (the `do=` jq, and the MEMBERS normalization above it) is not extracted and is not covered here —
# the fixtures set those as inputs. Their reachable range was checked by hand against that jq; adding
# a decision-step suite is the obvious next increment.
set -euo pipefail

TOP_PID=$$
die() { echo "::error::$1" >&2; kill -s TERM "$TOP_PID"; exit 1; }

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
for fn in splice current_marker same_marker marker_settled write_marker; do
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
# The re-derive guard re-checks AGE, so the harness must supply the same clock the step does.
export STABILIZE_SECONDS=120
now=2026-07-22T10:00:00Z
export GITHUB_STEP_SUMMARY="$WORK/summary.md"
# Fences and region layout, read OUT OF THE MANIFEST. The fence literal is shared by merge-gate,
# epic-membership and detect-partial-landing, so a restated copy here could not see the writer drift
# away from both readers; and the ORDER inside the region matters — put the payload above the note
# and `current_marker` reads every marker as absent.
START=$(sed -n "s/^ *START='\(.*\)'\$/\1/p" "$ACTION" | head -1)
END=$(sed -n "s/^ *END='\(.*\)'\$/\1/p" "$ACTION" | head -1)
[ -n "$START" ] && [ -n "$END" ] || die "could not read the fence literals from $ACTION"
REGION_BLOCK=$(awk '
  /^        \{$/ { buf=""; inb=1; next }
  inb && /^        \} > "\$regionf"$/ { printf "%s", buf; exit }
  inb { buf = buf $0 "\n" }
' "$ACTION")
[ -n "$REGION_BLOCK" ] || die "could not read the region block from $ACTION"
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
      printf 'r' >> "$WORK/reads"
      if [ "$(< "$WORK/read_fails")" -gt 0 ]; then
        printf '%s' "$(($(< "$WORK/read_fails") - 1))" > "$WORK/read_fails"
        return 1
      fi
      # Fail every read from the Nth onward — lets a read failure follow an edit failure, which is
      # the only order in which the per-attempt `err` reset is observable.
      if [ -s "$WORK/read_fail_from" ] && [ "$(wc -c < "$WORK/reads")" -ge "$(< "$WORK/read_fail_from")" ]; then
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
      # Real `gh issue edit` prints the issue URL on success. Without it, capturing the command's
      # stdout into the error variable is invisible.
      echo "https://github.com/${ORG}/${PLANNING_REPO}/issues/${EPIC}"
      # File-backed for the same reason as read_fails: the write runs inside $( ), so clearing a
      # shell variable here would never reach the parent and the peer would strike on every attempt.
      if [ -s "$WORK/steal" ]; then cp "$WORK/steal" "$WORK/body"; : > "$WORK/steal"; fi
      ;;
    *) echo "unexpected gh call: $*" >&2; return 1 ;;
  esac
}

# repo-a carries the HIGHER number on purpose: sorting by repo and sorting by number then give
# different answers, so a guard using the wrong key is observable.
M1='[{"repo":"a-novel-kit/repo-a","number":5}]'
M2='[{"repo":"a-novel-kit/repo-a","number":5},{"repo":"a-novel-kit/repo-b","number":2}]'
# Same size as M2, different members: without this, every "members differ" case also differs in
# COUNT, and comparing lengths would be indistinguishable from comparing sets.
M2B='[{"repo":"a-novel-kit/repo-a","number":5},{"repo":"a-novel-kit/repo-c","number":3}]'
# Two members in ONE repo, numbers out of input order: sorting by repo alone is stable and leaves them
# as given, so only the composite (repo, number) key produces the canonical order.
M2S='[{"repo":"a-novel-kit/repo-a","number":2},{"repo":"a-novel-kit/repo-a","number":9}]'

pending_json() { jq -cn --arg at "${2:-2026-07-22T10:00:00Z}" --argjson m "$1" '{status:"pending", at:$at, members:$m}'; }
frozen_json() { jq -cn --argjson m "$1" '{status:"frozen", members:$m}'; }

# The note the action actually writes, read OUT OF THE MANIFEST. Restating it here is how a fixture
# comes to encode a belief instead of the format: a note that ever began with `[` or `{` would make
# current_marker latch onto it and read every marker as absent, and a paraphrase could never show it.
note_of() { # frozen|pending
  local key=FROZEN
  [ "$1" = frozen ] || key=PENDING
  sed -n "s/^ *note=\"\(_Epic membership, $key.*\)\"$/\1/p" "$ACTION" | head -1
}
region_file() { # $1 = payload json, $2 = frozen|pending -> the region the action itself would build
  local f note payload regionf
  note=$(note_of "${2:-pending}")
  [ -n "$note" ] || die "could not read the note text from $ACTION"
  payload="$1"
  f=$(mktemp -p "$WORK"); regionf="$f"
  # Run the manifest's own assembly rather than a copy of it.
  # `$( )` strips the trailing newline, so the closing brace needs its own separator or bash
  # reads it as an argument to the last command.
  eval "{ $REGION_BLOCK
} > \"\$regionf\""
  printf '%s' "$f"
}
server_body() { # $1 = marker json, or empty for a body with no marker
  if [ -z "${1:-}" ]; then
    printf 'Some prose.\n\nMore prose.\n' > "$WORK/body"
  else
    printf 'Some prose.\n\n%s\n%s\n%s\n%s\n\nMore prose.\n' "$START" "$(note_of pending)" "$1" "$END" > "$WORK/body"
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
  : > "$WORK/edit_fails"; : > "$WORK/read_fail_from"; : > "$WORK/reads"
  : > "$GITHUB_STEP_SUMMARY"; server_body ""
}
# Capture the function's own output so it cannot be mistaken for the exit code, and so both tee'd
# and plain log lines can be asserted from one place.
run() { write_marker "$(region_file "$payload" "$do")" > "$WORK/out" 2>&1 && echo 0 || echo $?; }
said() { grep -q "$1" "$WORK/out"; }

echo "the marker contract is shared by three actions"
# A derived fixture follows merge-gate's fences rather than catching a change in them; what it cannot
# see is the writer drifting away from the two READERS. Assert the contract across all three.
for d in epic-membership detect-partial-landing; do
  f="$ROOT/generic-actions/$d/action.yaml"
  if [ ! -f "$f" ]; then ko "$d/action.yaml is missing"; continue; fi
  if grep -qF -- "$START" "$f" && grep -qF -- "$END" "$f"; then
    ok "$d uses the same fences as the writer"
  else
    ko "$d has drifted from merge-gate's fences — the snapshot would be invisible to it"
  fi
done

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
printf 'Some prose.\n%s\n\n%s\n%s\n%s\n%s\n' "$orphan" "$START" "$(note_of pending)" \
  "$(pending_json "$M2" 2026-07-22T09:00:00Z)" "$END" > "$WORK/body"
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
echo "the sort key is the pair, not either half"
reset
server_body "$(jq -cn --argjson m "$M2S" '{status:"pending", at:"2026-07-22T09:00:00Z", members:($m | reverse)}')"
do=frozen; cur="$M2S"; payload=$(frozen_json "$M2S")
eq "two members in one repo, reordered, still freeze" "$(run)" 0
eq "and the marker is frozen" "$(marker_now | jq -r .status)" frozen

echo
echo "a freeze must not skip the stabilization window"
# The decision step only says `frozen` once the marker has held still past STABILIZE_SECONDS. If the
# guard does not re-check age, a peer's clock reset can be overtaken seconds later — freezing before
# the lagging label index has had its window to surface a missing member.
reset
server_body "$(pending_json "$M2" 2026-07-22T09:59:30Z)"   # 30s old, threshold is 120s
do=frozen; cur="$M2"; payload=$(frozen_json "$M2")
eq "a freeze against a freshly reset clock abandons" "$(run)" 2
eq "writing nothing" "$(writes)" 0
eq "and the marker stays pending" "$(marker_now | jq -r .status)" pending

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
  b=$(mktemp -p "$WORK"); r=$(region_file "$2" frozen)
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

out=$(sp "$(printf 'HUMAN-A\n%s\nA\n%s\ntext\n%s\nB\n%s\nHUMAN-B\n' "$START" "$END" "$START" "$END")" "$P")
one_region "$out" && ok "duplicate fences are healed to one region" || ko "duplicate fences survived"
grep -q '^HUMAN-A$' <<< "$out" && grep -q '^HUMAN-B$' <<< "$out" \
  && ok "without dropping the prose around them" || ko "prose was destroyed healing duplicate fences"

# Prose BETWEEN a stray fence and the end is the shape that discriminates: an in-place replace spans
# from the first START to the END and discards everything inside, while the recovery path strips the
# fence lines and keeps it. A malformed region must take the recovery path.
out=$(sp "$(printf '%s\nHUMAN-A\n%s\nHUMAN-B\n%s\n' "$START" "$START" "$END")" "$P")
one_region "$out" && ok "an unbalanced fence pair is healed to one region" || ko "unbalanced fences survived"
grep -q '^HUMAN-A$' <<< "$out" && grep -q '^HUMAN-B$' <<< "$out" \
  && ok "keeping prose that was trapped inside it" || ko "prose between stray fences was destroyed"
out=$(sp "$(printf 'HUMAN-A\n%s\nstray end first\n%s\nHUMAN-B\n' "$END" "$START")" "$P")
one_region "$out" && ok "inverted fences are healed to one region" || ko "inverted fences survived"
grep -q '^HUMAN-A$' <<< "$out" && grep -q '^HUMAN-B$' <<< "$out" \
  && ok "keeping the prose around those too" || ko "prose was destroyed healing inverted fences"

echo
echo "same status, different members of the same size"
# Without this, every members-differ case also differs in COUNT, so comparing lengths would pass for
# comparing sets — in both the equivalence check and the re-derive guard.
reset
server_body "$(pending_json "$M2B" 2026-07-22T09:00:00Z)"
do=pending; cur="$M2"; payload=$(pending_json "$M2")
eq "an equal-size but different set is corrected" "$(run)" 0
eq "which takes a write" "$(writes)" 1
eq "and our members are what stand" "$(marker_now | jq -c '.members')" "$M2"
reset
server_body "$(pending_json "$M2B" 2026-07-22T09:00:00Z)"
do=frozen; cur="$M2"; payload=$(frozen_json "$M2")
eq "and a freeze against an equal-size peer set abandons" "$(run)" 2
eq "writing nothing" "$(writes)" 0

echo
echo "a shorter peer set is a difference, not a match"
# The index-lag shape: a peer wrote a strict subset. If the comparison is a subset test rather than
# equality, no writer ever corrects it.
reset
server_body "$(pending_json "$M1" 2026-07-22T09:00:00Z)"
do=pending; cur="$M2"; payload=$(pending_json "$M2")
eq "a subset marker is corrected, not accepted" "$(run)" 0
eq "and our full set is what stands" "$(marker_now | jq -r '.members | length')" 2

echo
echo "a region holding more than one value"
# jq -s '.[0]' takes the first. If a hand-edit leaves two, the first wins — including an empty frozen
# set, which would pin the Epic to no members at all.
reset
# BOTH values sit inside the fences — that is what makes "first" meaningful.
printf 'prose\n%s\n%s\n%s\n%s\n%s\n' "$START" "$(note_of pending)" \
  "$(pending_json "$M1")" "$(jq -cn '{status:"frozen",members:[]}')" "$END" > "$WORK/body"
eq "the first value in the region is the one read" "$(marker_now | jq -r '.status')" pending
eq "not the last" "$(marker_now | jq -r '.members | length')" 1

echo

echo "a clobbered repair is retried, not reported as done"
# The entry check knows an unreadable `at` is not equivalent; the VERIFY must know it too. If it
# falls back to a plain equivalence test, a repair that a peer immediately undid reads as landed —
# the marker never ages, and the log says success.
reset
bad=$(jq -cn --argjson m "$M2" '{status:"pending", at:"not-a-date", members:$m}')
server_body "$bad"
printf 'Some prose.\n\n%s\n%s\n%s\n%s\n\nMore prose.\n' "$START" "$(note_of pending)" "$bad" "$END" > "$WORK/steal"
do=pending; cur="$M2"; payload=$(pending_json "$M2")
eq "the repair is retried until it sticks" "$(run)" 0
eq "which takes two writes" "$(writes)" 2
marker_now | jq -e '.at | try (fromdateiso8601 | true) catch false' >/dev/null \
  && ok "and the marker can age at the end of it" || ko "the marker still cannot age"

echo
echo "a give-up message carries the error, not the success output"
reset
do=pending; cur="$M2"; payload=$(pending_json "$M2")
printf 'x' > "$WORK/noop"          # every edit returns success but changes nothing
eq "an unlandable write gives up" "$(run)" 1
said 'https://' && ko "the edit's success output was captured as an error" \
  || ok "the success URL is not mistaken for an error"

echo
echo "a failing edit"
reset
do=pending; cur="$M2"; payload=$(pending_json "$M2")
printf 'x' > "$WORK/edit_fails"
eq "an edit that errors is retried, then given up on" "$(run)" 1
eq "after three attempts" "$(writes)" 3
said 'HTTP 422' && ok "and the API's own error text is surfaced, not swallowed" || ko "the edit error was discarded"

echo
echo "a give-up after mixed failures names a real cause"
# err is cleared each attempt so a give-up cannot quote an earlier attempt's error. That reset is
# only observable when the LAST attempts fail somewhere that sets no error of its own.
reset
do=pending; cur="$M2"; payload=$(pending_json "$M2")
printf 'x' > "$WORK/edit_fails"
printf 2 > "$WORK/read_fail_from"   # attempt 1 reads, edits, fails; every later read fails too
eq "the pass gives up" "$(run)" 1
said 'could not read' && ok "and names the failure that actually ended it" \
  || ko "the give-up quotes a stale error from an earlier attempt"

echo
echo "read failures"
reset
do=pending; cur="$M2"; payload=$(pending_json "$M2")
printf 2 > "$WORK/read_fails"
eq "two failed reads still converge on the third attempt" "$(run)" 0
reset
do=pending; cur="$M2"; payload=$(pending_json "$M2")
printf 'Important human prose.\n\nA hand-written plan.\n' > "$WORK/body"
printf 99 > "$WORK/read_fails"
eq "a total read failure gives up rather than claiming success" "$(run)" 1
eq "and writes nothing at all" "$(writes)" 0
grep -q 'A hand-written plan' "$WORK/body" \
  && ok "leaving the Epic body untouched" || ko "the body was written blind after a failed read"

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
ran=$((pass + fail))
if [ "$fail" -gt 0 ]; then
  echo "::error::$fail assertion(s) failed"
  exit 1
fi
if [ "$ran" -ne 72 ]; then
  echo "::error::$ran assertion(s) ran, expected exactly 72 — the suite did not execute fully (or an assertion was added without raising this)"
  exit 1
fi
