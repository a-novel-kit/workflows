#!/usr/bin/env bash
# Reject expression contexts that do not exist for a composite action.
#
# GitHub expression-evaluates a composite action's entire manifest when it loads it, including input
# descriptions, run: strings and the bash comments inside them. vars, secrets, needs, matrix and
# strategy are unavailable there, so one reference anywhere in the file makes the action fail to load
# for every consumer.
#
# The manifests document caller syntax by writing those names as plain text —
# `vars.AGENT_KILL_SWITCH` with no ${{ }} around it — which is legal. So the check has to know
# whether an occurrence sits inside an expression; a grep for the names alone cannot.
#
# Two shapes a simpler pattern lets through, both of them what a reader reaches for first:
#
#   ${{ inputs.a || vars.X }}            anchoring to the start of the expression skips it
#   ${{ format('{0}', secrets.X) }}      ${{[^}]*}} stops at the } inside '{0}'
#
# The scan walks each line tracking whether it is inside a ${{ … }} region and reports the
# occurrences that are. Expressions are line-local here; a context split across a block scalar sits
# outside its reach.
set -euo pipefail

ROOT="${1:-.}"

fail=0

while IFS= read -r file; do
  # Only composite actions are affected. A reusable workflow may use these contexts freely.
  grep -qE 'using:[[:space:]]*"?composite' "$file" || continue

  hits=$(awk '
    {
      line = $0
      len = length(line)
      inside = 0
      i = 1

      while (i <= len) {
        if (substr(line, i, 3) == "${{") { inside = 1; i += 3; continue }
        if (inside && substr(line, i, 2) == "}}") { inside = 0; i += 2; continue }

        if (inside) {
          rest = substr(line, i)
          prev = (i > 1) ? substr(line, i - 1, 1) : " "

          # A leading word character means this is the tail of a longer name (myvars.x), not the
          # context itself.
          if (prev !~ /[A-Za-z0-9_.]/ && rest ~ /^(vars|secrets|needs|matrix|strategy)\./) {
            match(rest, /^(vars|secrets|needs|matrix|strategy)\.[A-Za-z0-9_.-]*/)
            printf "%d:%s\n", NR, substr(rest, 1, RLENGTH)
          }
        }

        i++
      }
    }
  ' "$file")

  if [ -n "$hits" ]; then
    while IFS= read -r hit; do
      echo "::error file=${file},line=${hit%%:*}::\`${hit#*:}\` is inside a \${{ }} expression, and that context does not exist for a composite action — the action will fail to LOAD for every consumer. Write the context as plain text to document it, or thread the value in as an input. See the v1.12.1 load-failure incident."
    done <<<"$hits"

    fail=1
  fi
done < <(find "$ROOT" -type f \( -name action.yaml -o -name action.yml \) -not -path '*/node_modules/*')

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "✓ no composite-illegal expression contexts in any action manifest."
