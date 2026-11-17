# shellcheck shell=bash
# Shell helpers shared by the landing actions. A run step sources the file as
#   source "$GITHUB_ACTION_PATH/../landing.sh"
# The runner downloads the whole repository for an action, so the file sits beside the action folders,
# at the same release tag.

# Succeeds when the org-wide halt is engaged. Only an explicit off value runs: empty, 0, off, false, no
# or disabled, compared lowercased with whitespace removed. Any other value halts, so a mistyped value
# fails safe.
kill_switch_engaged() { # $1 = the AGENT_KILL_SWITCH value
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
    "" | 0 | off | false | no | disabled) return 1 ;;
  esac
}

# Prints the pull requests a GitHub search finds, every page, as one JSON array. The caller sets
# SEARCH_Q, a GraphQL document taking $q and $cursor that selects search.pageInfo and search.nodes.
# Each page is tried 3 times; a response carrying errors counts as a failure, since GitHub answers a
# partial page with data and errors both.
search_prs() { # $1 = search query string
  local search="$1" cursor="" agg='[]' data page ok args
  while :; do
    ok=false
    for attempt in 1 2 3; do
      args=(-f query="$SEARCH_Q" -f q="$search")
      [ -n "$cursor" ] && args+=(-f cursor="$cursor")
      # stderr joins stdout so a transport, auth or rate-limit error reaches the log. On success gh
      # prints only the response JSON, which jq validates.
      if data=$(gh api graphql "${args[@]}" 2>&1) \
        && printf '%s' "$data" | jq -e 'has("data") and (has("errors") | not)' >/dev/null 2>&1; then
        ok=true
        break
      fi
      [ "$attempt" -lt 3 ] && sleep 2
    done
    if [ "$ok" != true ]; then
      printf 'search_prs failed for query "%s": %s\n' "$search" "$data" >&2
      return 1
    fi
    page=$(printf '%s' "$data" | jq '[(.data.search.nodes // [])[] | select(.number != null)]')
    agg=$(jq -s '.[0] + .[1]' <(printf '%s' "$agg") <(printf '%s' "$page"))
    [ "$(printf '%s' "$data" | jq -r '.data.search.pageInfo.hasNextPage')" = "true" ] || break
    cursor=$(printf '%s' "$data" | jq -r '.data.search.pageInfo.endCursor')
  done
  printf '%s' "$agg"
}

# Prints "<merged> <merge commit sha>" for a pull request, trying the REST read 3 times.
rest_pr_merge() { # $1 = owner/repo, $2 = number
  local data
  for attempt in 1 2 3; do
    if data=$(gh api "repos/$1/pulls/$2" 2>/dev/null); then
      printf '%s' "$data" | jq -r '"\(.merged) \(.merge_commit_sha // "")"'
      return 0
    fi
    [ "$attempt" -lt 3 ] && sleep 2
  done
  printf 'rest_pr_merge failed for %s#%s\n' "$1" "$2" >&2
  return 1
}
