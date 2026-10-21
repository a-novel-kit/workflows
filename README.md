# Workflows

Shared GitHub Actions building blocks for every A-Novel repository.

[![X (formerly Twitter) Follow](https://img.shields.io/twitter/follow/agorastoryverse)](https://twitter.com/agorastoryverse)
[![Discord](https://img.shields.io/discord/1315240114691248138?logo=discord)](https://discord.gg/rp4Qr8cA)

<hr />

![GitHub repo file or directory count](https://img.shields.io/github/directory-file-count/a-novel-kit/workflows)
![GitHub code size in bytes](https://img.shields.io/github/languages/code-size/a-novel-kit/workflows)

![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/a-novel-kit/workflows/main.yaml)

## What this is

Every repository of the `a-novel` and `a-novel-kit` organizations builds its CI from this one.
Composite actions package the steps of a job, reusable workflows package whole jobs, and
[Renovate presets](./docs/renovate-presets.md) carry the shared dependency policy. A repository
references them by path, pinned to a release tag, instead of copying CI logic.

The governance workflows that the stack's `a-novel repo update` renders into each repository, such as
`merge-gate.yaml` and `review-gate.yaml`, are thin callers of the reusable workflows and actions here.

## Using an action

Reference an action from a job step as `a-novel-kit/workflows/<group>/<action>@<tag>`, and a reusable
workflow from a job as `a-novel-kit/workflows/.github/workflows/<file>@<tag>`:

```yaml
jobs:
  lint-go:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: a-novel-kit/workflows/go-actions/lint-go@v1.71.0
```

Pin every reference to a release tag. The repository ships as one unit, so every reference in a
repository sits at the same tag, and Renovate moves them together in one `a-novel-kit workflows`
update. A release that asks callers to change something comes with a
[migration guide](./docs/migrations/README.md).

## Action catalog

### `build-actions`

| Action            | Purpose                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `clean-images`    | Delete images once their branch or PR is gone; keep releases, open PRs, and `master` builds since the last minor. |
| `clean-pr-images` | Delete a closed pull request's `pr-<N>` image from each package that has one.                                     |
| `docker`          | Build an image, verify that it runs **healthy**, push it and attest its provenance.                               |
| `docker-job`      | Build an image, verify that its run **exits 0**, push it and attest its provenance.                               |

`docker` and `docker-job` tag only the builds a deployment can name: pushes to the default branch,
releases, and a pull request while it carries the `with-feature-env` label. The label tags the head it
was added on, so the next push builds untagged until someone adds the label again. Every other build is
pushed by digest alone, for the jobs of the same run that pull it, and its attestation stays out of the
registry.

Both actions fail the job after a push unless GitHub signs and publishes SLSA provenance for the exact
output digest. Each calling job grants the permissions of GitHub's attestation flow, and no
`artifact-metadata: write`, since the actions create no linked-artifact record:

```yaml
permissions:
  attestations: write
  contents: read
  id-token: write
  packages: write
```

Anyone can verify an image digest against its producer repository, without registry write access:

```bash
gh attestation verify \
  oci://ghcr.io/a-novel/service-json-keys/grpc@sha256:<64-hex-digest> \
  --repo a-novel/service-json-keys
```

An image is releasable only once this command succeeds for its source repository. When an attestation
is missing, fix the build path and publish a fresh SemVer release. Never backfill an attestation or
move a tag.

### `generic-actions`

| Action                   | Purpose                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `approve-bot`            | Approve a PR as the token's identity, optionally bound to one head commit; it applies no policy of its own.      |
| `approve-playwright`     | Bind screenshot approval to the PR head and rerun the browser check that a label change left stale.              |
| `approve-pr`             | Admin escape hatch: approve the dispatching admin's own PR as the [Agent] App.                                   |
| `approve-translations`   | Revoke translation approval labels after a push and rerun the translation check on label changes.                |
| `archive-board-items`    | Archive the board items in a terminal Status, or whose issue is closed, and close their issues.                  |
| `assign-bot`             | Assign a PR to its author; a bot's PR stays unassigned.                                                          |
| `board-write`            | Set one single-select or date board field on issues or PRs, writing only on a change.                            |
| `check-append-only`      | Allow additions under a path while freezing every file that already landed.                                      |
| `check-changes`          | Detect uncommitted changes in a pathspec, and optionally fail.                                                   |
| `check-dependencies`     | Hold a person's dependency manifest change until a reviewer adds `allow-dependency-change`; bots pass.           |
| `classify-bot-change`    | Strict auto-approval: pass a bot PR only as a release pin or as a version update Renovate put on auto-merge.     |
| `codecov`                | Upload the coverage artifact to Codecov.                                                                         |
| `collect-audit-alerts`   | Collect the audit-log entries that grant access or push past a rule, minus ignore rules and posted alerts.       |
| `collect-warnings`       | Merge the warnings an org's default-branch runs raised in a window into one entry each, minus ignore rules.      |
| `derive-status`          | Derive the board Status of the issues a PR closes from the PR's current state.                                   |
| `detect-partial-landing` | Freeze an Epic's remaining siblings when one drops out mid-landing; the writer behind the `epic-freeze` check.   |
| `discord-post`           | Post one state-colored Discord embed to its repository's channel; pings only the ids given.                      |
| `discord-users`          | Resolve GitHub user ids to Discord ids through the Bitwarden map; masked and fail-soft.                          |
| `enable-auto-merge`      | Enable native auto-merge on a PR as the [Agent] App, so it queues once green.                                    |
| `epic-membership`        | Resolve an Epic's member set: its frozen activation snapshot, else the open PRs labeled `epic:<N>`.              |
| `epic-rollback`          | Revert a landed Epic's merged PRs through a new rollback Epic that lands the reverts together.                   |
| `escalate`               | File or update a deduplicated escalation ticket, drive its board Status, and page a SEV1 through a webhook.      |
| `lint-dockerfile`        | Run hadolint over the repository's Dockerfiles, advisory or gating; a repository without one passes.             |
| `lint-shell`             | Run shellcheck over the repository's tracked shell scripts, advisory or gating; a repository without one passes. |
| `maintain-playwright`    | Promote successful master batches and delete superseded, merged or deleted branch evidence from Drive.           |
| `merge-gate`             | Required "may this PR merge?" check: Epic atomicity, draft state and review.                                     |
| `pull-bot`               | Mint a bot App token and check out the repository authenticated as it.                                           |
| `refresh-apko-locks`     | Re-resolve apko locks on a schedule and open or update one pull request listing the package changes.             |
| `relay-context`          | Resolve a relayed review or merge group for a privileged `workflow_run` gate; any other run wakes nothing.       |
| `release-train`          | Release every repository a landed Epic merged into, by dispatching each one's own `release.yaml`.                |
| `renovate`               | Run self-hosted Renovate as the bot.                                                                             |
| `require-role`           | Fail unless whoever started this run attempt holds one of the listed repository roles.                           |
| `review-gate`            | Required check: a maintainer or admin approved the head and applied every privileged label last.                 |
| `rollup-board`           | Roll an Epic's Status and Start date up from its children.                                                       |
| `verify-release-proof`   | Pass a bot PR only when a release built every first-party package and image version it adds.                     |

`check-append-only` needs the full base history. It rejects every change except additions under the
configured path, and the `append-only-override` PR label is the reviewed exception. The label approves
the head it was added on. A push is checked without it, and removes it when the step gets a token, so
a reviewer adds it again for the new head.

```yaml
check-migration-snapshots:
  permissions:
    contents: read
    pull-requests: write
  steps:
    - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      with:
        fetch-depth: 0
        persist-credentials: false

    - uses: a-novel-kit/workflows/generic-actions/check-append-only@v1.71.0
      with:
        path: internal/models/migrations
        base: ${{ github.event.pull_request.base.sha }}
        github_token: ${{ github.token }}
```

### `github-pages-actions`

| Action              | Purpose                                     |
| ------------------- | ------------------------------------------- |
| `publish-storybook` | Build a Storybook site and deploy to Pages. |

### `go-actions`

| Action        | Purpose                                                                    |
| ------------- | -------------------------------------------------------------------------- |
| `generate-go` | Generate Go code with retries and fail when the committed output is stale. |
| `lint-go`     | Run `golangci-lint`, from a non-root module directory if needed.           |
| `test-go`     | Run the workspace's Go tests with coverage through `gotestsum`.            |

### `node-actions`

| Action              | Purpose                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `audit`             | Run `pnpm audit --fix` and open a pull request with the fixes.                                              |
| `build-node`        | Run the package's build script (default `build`).                                                           |
| `lint-node`         | Run the package's lint script (default `lint`).                                                             |
| `lint-translations` | Check catalog structure, and the translation gaps and drift a branch introduces, with label approvals.      |
| `setup-node`        | Set up Node and pnpm against the GitHub registry, and install.                                              |
| `test-node`         | Run the package's tests and upload coverage.                                                                |
| `test-playwright`   | Run browser component and screenshot tests with coverage and optional private Drive screenshot comparisons. |

#### `test-playwright`

`test-playwright` runs the package scripts `test:browser`, for component tests, and `test:e2e`, for
journeys that start the application and its services themselves. With `runner: vitest`, `test_action`
names a Vitest browser project instead, such as Storybook stories, set up through the
[Vitest guide](./docs/migrations/v1.64.0.md). It uploads
`coverage/browser/lcov.info` and exposes the artifact's `artifact-id` for Codecov. Pass `compose_file`
for disposable integration services, with a unique `COMPOSE_PROJECT_NAME` set in the calling job. The
action collects their logs and always removes the Compose project's services and volumes. The
[adoption guide](./docs/migrations/v1.32.0.md) covers the caller's job.

Without Drive, the action keeps `playwright-report/`, `test-results/` and `integration-services.log`
for seven days, failed runs included. With Drive, set up through the
[Drive adoption guide](./docs/migrations/v1.33.0.md), the evidence lives in each platform's private
references and results folders of a Shared Drive: the latest successful master reference and one
completed batch per live branch. Coverage stays a GitHub artifact.

A screenshot comparison passes new screenshots without approval. An existing screenshot that changes
or disappears adds one small GitHub artifact, `playwright-drift.html`: a self-contained **Old / New /
Diff** page, [unzipped](https://github.com/actions/upload-artifact#upload-an-individual-file-unzipped)
for direct viewing, linked from the run summary and kept three days. The failing `visual-comparison`
check names the `allow-screenshot-change` label and links that page. Rerun `test-browser` once the
page expires. Any other failure links the run of `main`.

The label approves the head it was added on. `generic-actions/approve-playwright` records that
approval without waiting on `main`, removes the label on a push, and reruns the head's `test-browser`
job when it began before the approval. `generic-actions/maintain-playwright` publishes master
references and cleans up branch evidence from a trusted workflow.

The Drive archive holds the complete Playwright report. Extract it and open `playwright-report/` with
`pnpm exec playwright show-report`. An approved regeneration also keeps the original failing report
under `.visual/comparison-report/`.

#### `lint-translations`

`lint-translations` runs a platform's `i18n:structure`, `i18n:gaps` and `i18n:drift` scripts, the last
two against the merge base with the default branch. The `allow-incomplete-translations` and
`allow-translation-drift` labels accept gaps and drift, except on the run for a pull request push. A
merge group checks structure only. Skip the job on the default branch. A trusted
`pull_request_target` caller runs `generic-actions/approve-translations`, which removes both labels
when a push reaches the PR and reruns the check when a label changes. The
[adoption guide](./docs/migrations/v1.40.0.md) covers the caller's jobs.

### `security-actions`

| Action           | Purpose                                                                             |
| ---------------- | ----------------------------------------------------------------------------------- |
| `lint-semgrep`   | Enforce the A-Novel structural conventions golangci-lint cannot express.            |
| `lint-workflows` | Audit GitHub Actions workflows and composite actions for security defects (zizmor). |
| `scan-secrets`   | Scan the working tree for committed credentials (gitleaks).                         |

Each ships its own config, so a calling repository carries none. All three run offline, so nothing
outside the repository can stall them, which a required check needs. Each takes `advisory: "true"` to
report without failing, for a repository adopting the check over an existing backlog.

`version` is required on all three, and on `generic-actions/lint-shell` and
`generic-actions/lint-dockerfile`. The pin lives in the calling repository, so Renovate bumps each
repository on its own cadence without waiting on a workflows release. Annotate it so Renovate can
resolve the datasource:

```yaml
- uses: a-novel-kit/workflows/security-actions/scan-secrets@v1.71.0
  with:
    # renovate: datasource=github-releases depName=gitleaks/gitleaks
    version: "8.30.1"
```

A tool never trusts a checksum published beside its own release, since whoever can replace the
release's files can replace that checksum too. `scan-secrets` builds gitleaks with the runner's Go,
which checks the source against Go's checksum database, and `refresh-apko-locks` builds apko the same
way. `lint-shell` and `lint-dockerfile` download a release binary, so the caller pins its SHA-256 on
the line after `version`, and the base Renovate preset moves both together:

```yaml
- uses: a-novel-kit/workflows/generic-actions/lint-shell@v1.71.0
  with:
    # renovate: datasource=custom.shellcheck depName=koalaman/shellcheck
    version: "0.11.0"
    sha256: "8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198"
```

`lint-dockerfile` takes `datasource=custom.hadolint depName=hadolint/hadolint` and the SHA-256 of
`hadolint-linux-x86_64`. A download that does not match its pin fails the step. A release whose files
change under an unchanged version gets a Renovate pull request that waits for a reviewer.

A repository that needs its own gitleaks allowlist passes `config`, which replaces the shipped
baseline. gitleaks drops a base config's allowlists when another config extends it, so the repository
copies `security-actions/scan-secrets/gitleaks.toml` and adds its entries.

Call the three as separate jobs. A reusable workflow's checks are named `<caller-job>/<inner-job>`,
while required-check discovery reads the caller's job id, so a required check behind a reusable
workflow never reports and the PR never merges.

### `publish-actions`

| Action                | Purpose                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `deploy-release`      | Ask infra to deploy a release once all its images are published. |
| `npm`                 | Attest the workspace packages' tarballs and publish them.        |
| `release-core`        | Cut a release in CI: bump the version, tag, push, release.       |
| `release-core-hotfix` | Cut the next patch of a `release/vX.Y` line, not marked latest.  |

### Reusable workflows

A job calls these with `uses: a-novel-kit/workflows/.github/workflows/<file>@<tag>`.

| Workflow                      | Purpose                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `auto-approve-dependabot-run` | Approve and queue a repository's trusted dependency-bot PRs once their update has aged.                           |
| `backport-run`                | Hotfix entry point: open one backport pull request per default-branch fix into its `release/vX.Y` line.           |
| `epic-rollback-run`           | Admin-gated dispatch of `epic-rollback`, behind a typed confirmation.                                             |
| `merge-gate-run`              | Post the required `merge-gate` check, and arm auto-merge on ready Epic members so they land together.             |
| `notify-audit-run`            | Alert the org's Discord security channel minutes after an audit-log entry grants access or skips a rule.          |
| `notify-ci-run`               | Post a failed default-branch `main` or `release` run to Discord, pinging the repo role, and the run that ends it. |
| `notify-issues-run`           | Post board issues' Status and assignee changes to Discord by stage color, pinging on Triage, Ready and assignees. |
| `notify-pr-run`               | Post people's pull request reviews, merges and merge-queue drops to Discord, and bots' failing pull requests.     |
| `notify-release-run`          | Announce a published release in Discord with its notes, colored by its bump, gold for a hotfix.                   |
| `notify-stuck-run`            | Post bots' pull requests that stay green but out of the merge queue to Discord, pinging the repo role.            |
| `notify-warnings-run`         | Post a daily digest of the org's default-branch CI warnings to Discord, one line per warning.                     |
| `reconcile-board`             | Per-org fail-safe sweep that repairs the board and the `merge-gate` and `epic-freeze` checks.                     |
| `release-line-run`            | Cut the next patch when a backport merges into a `release/vX.Y` line, behind the `release` environment.           |
| `release-train-run`           | Admin-gated dispatch of `release-train` for one landed Epic.                                                      |
| `token-expiry`                | Post an organization's fine-grained personal access tokens to Discord as they near expiry.                        |

## Contributing

Setup and day-to-day commands are in the [developer guide](https://a-novel-kit.github.io/stack/);
workflows-specific notes are in [CONTRIBUTING.md](./CONTRIBUTING.md).
