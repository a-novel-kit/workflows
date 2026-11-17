# Upgrading to NEXT

The governance gates run from one reusable `gates-run.yaml`, the Dependabot path from
`dependabot-run.yaml`, board ids and privileged labels default inside the actions, and the
`go-tools` preset matches tool modfiles in any directory. Every caller keeps working unchanged.

## Do I need to act?

**Recommended.** Nothing breaks: every caller of the previous release keeps working. Each change
below deletes lines from a repository's governance copies. Make them once the repository's pins name
this release or a later one, after Renovate's bump has merged. A deprecated path logs a warning that
names its successor, and the daily CI digest collects them.

## Call `gates-run.yaml` from `gates.yaml`

`gates.yaml` keeps its triggers and calls the engine. The relay and every gate step move into the
engine:

```yaml
permissions: {}

jobs:
  evaluate:
    permissions:
      contents: read
      pull-requests: read
      issues: read
    uses: a-novel-kit/workflows/.github/workflows/gates-run.yaml@<tag>
    with:
      client_id: ${{ vars.AGENT_BOT_CLIENT_ID }}
      dependabot_security_login: ${{ vars.DEPENDABOT_SECURITY_LOGIN }}
    secrets:
      app_private_key: ${{ secrets.AGENT_BOT_PRIVATE_KEY }}
```

The engine reads the org's `AGENT_KILL_SWITCH` itself. The `notify-review` job stays as it is. The
checks keep their names, since the [Agent] App posts them, so no required check changes.

## Call `dependabot-run.yaml` from the `dependabot` job

The `dependabot` job of `auto-approve-dependabot.yaml` runs its resolve, gate and approve steps
through `dependabot-run.yaml`, which takes the job's conditions and reads the halt itself. The
`auto-approve` job stays as it is:

```yaml
dependabot:
  if: github.event_name == 'workflow_run'
  permissions:
    contents: read
    pull-requests: read
    issues: read
  uses: a-novel-kit/workflows/.github/workflows/dependabot-run.yaml@<tag>
  with:
    client_id: ${{ vars.AGENT_BOT_CLIENT_ID }}
    dependabot_security_login: ${{ vars.DEPENDABOT_SECURITY_LOGIN }}
  secrets:
    app_private_key: ${{ secrets.AGENT_BOT_PRIVATE_KEY }}
```

In strict mode `auto-approve-dependabot-run.yaml` reads the pull request's live labels and holds one
labeled `breaking-release`, so a-novel/infra may drop its own hold.

## Drop the board id and the privileged labels

The board actions (`archive-board-items`, `board-write`, `derive-status`, `epic-rollback`,
`escalate`, `rollup-board`) and the reusable workflows that take `project_id` default it to the
calling org's Tasks board. Delete every `project_id: ${{ github.repository_owner == 'a-novel' && ...
}}` line.

`review-gate` reads the fleet's privileged labels from `generic-actions/privileged-labels.txt` when
`privileged_labels` is empty. Delete the list from every caller.

## Revoke head-bound labels with `revoke-labels`

`generic-actions/revoke-labels` removes every privileged label a pull request carried when a push
landed. It replaces `check-dependencies.yaml`'s `revoke-feature-env` job:

```yaml
revoke-labels:
  if: github.event.action == 'synchronize' && github.event.pull_request.labels[0] != null
  runs-on: ubuntu-latest
  permissions:
    pull-requests: write
  steps:
    - uses: a-novel-kit/workflows/generic-actions/revoke-labels@<tag>
```

## Call the renamed workflows and action

| Before                                   | After                                        |
| ---------------------------------------- | -------------------------------------------- |
| `.github/workflows/reconcile-board.yaml` | `.github/workflows/reconcile-board-run.yaml` |
| `.github/workflows/token-expiry.yaml`    | `.github/workflows/token-expiry-run.yaml`    |
| `generic-actions/assign-bot`             | `generic-actions/assign-author`              |

Every input keeps its name. The old paths run their successors until the next major.

## Call `bot-comment-run.yaml` from the bot-comment dispatchers

The dispatcher engine moves into `bot-comment-run.yaml`. Each org's `bot-comment.yaml` keeps its
dispatch inputs, its `run-name` (the CLI finds its run by it) and its concurrency, and calls the
engine with `client_id: ${{ vars.AGENT_BOT_CLIENT_ID }}`, the six inputs and `app_private_key: ${{
secrets.AGENT_BOT_PRIVATE_KEY }}`.

## Drop `repository_config` from `renovate.yaml`

The renovate action no longer extends the base preset globally: each repository's `renovate.json`,
which extends its class preset, is its only policy. The input is ignored with a warning. Delete it.

## Notes

- `merge-gate-run.yaml`, which no repository called, is removed. `gates-run.yaml` replaces it.
- The `go-tools` preset matches `golangci-lint.mod`, `gotestsum.mod`, `govulncheck.mod` and `go.mod`
  in any directory and runs their post-upgrade commands in the modfile's directory. A repository
  that copied those rules for a module in a subdirectory, such as the stack's `cli/`, deletes its
  copies; its `allowed_commands` must then allow the preset's commands as they run in that
  directory.
- `verify-release-proof` also accepts an attestation from the producer's `main.yaml` at the release
  tag, for repositories whose `main.yaml` builds the release images.
- `classify-bot-change` also recognizes release pins in
  `environments/production/cluster/releases/<service>.tfvars`.
