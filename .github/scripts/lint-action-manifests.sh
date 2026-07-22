#!/usr/bin/env bash
# Reject expression contexts that do not exist for a composite action.
#
# GitHub expression-evaluates a composite action's WHOLE manifest when it loads it — input
# descriptions, run: strings, bash comments inside them. vars, secrets, needs, matrix and strategy
# are not available there, so one such reference anywhere in the file makes the action fail to LOAD
# for every consumer. That took merge-gate offline across both orgs until v1.12.1.
#
# The manifests document caller syntax by writing those names as PLAIN TEXT (`vars.AGENT_KILL_SWITCH`
# with no ${{ }} around it), which is legal and deliberate. So the check cannot simply grep for the
# names: it has to know whether an occurrence sits inside an expression.
#
# That distinction is the whole difficulty, and why two simpler versions of this check were wrong:
#
#   ${{ vars.X }}                        caught by anchoring to the start of the expression
#   ${{ inputs.a || vars.X }}            NOT caught — the context is not the first token
#   ${{ format('{0}', secrets.X) }}      NOT caught by ${{[^}]*}} either — [^}]* stops at the } in '{0}'
#
# So the scan walks each line tracking whether it is inside a ${{ … }} region, and reports only the
# occurrences that are. Expressions are treated as line-local, which is what they are in these
# manifests; a context split across a block scalar would be missed.
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
