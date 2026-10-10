# Workflows

Reusable composite GitHub Actions powering A-Novel CI/CD.

[![X (formerly Twitter) Follow](https://img.shields.io/twitter/follow/agorastoryverse)](https://twitter.com/agorastoryverse)
[![Discord](https://img.shields.io/discord/1315240114691248138?logo=discord)](https://discord.gg/rp4Qr8cA)

<hr />

![GitHub repo file or directory count](https://img.shields.io/github/directory-file-count/a-novel-kit/workflows)
![GitHub code size in bytes](https://img.shields.io/github/languages/code-size/a-novel-kit/workflows)

![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/a-novel-kit/workflows/main.yaml)

## What this is

The shared CI/CD building blocks for every **a-novel** and **a-novel-kit** repo. Each is a **composite action**: rather than copy CI logic between repos, a project pulls these composite actions in with `uses:`, pinned to a release tag.

Each composite action lives at `<group>/<name>/action.yaml`, grouped by the kind of work it does. The [Action catalog](#action-catalog) lists them all.

## Using an action

Reference an action from a job step as `a-novel-kit/workflows/<group>/<action>@<tag>`:

```yaml
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: a-novel-kit/workflows/go-actions/lint-go@v1.0.3
        with:
          working-directory: . # optional; defaults to the repo root
```

Pin to a release tag, never `@master`. The actions ship as one unit, so bump every reference together on upgrade — Renovate groups them under `a-novel-kit workflows` to do this for you.

## Action catalog

### `build-actions`

| Action       | Purpose                                                                         |
| ------------ | ------------------------------------------------------------------------------- |
| `docker`     | Build an image, verify it runs **healthy**, push it, and attest its provenance. |
| `docker-job` | Build an image, verify it **exits 0**, push it, and attest its provenance.      |

Both actions fail the caller after a successful push unless GitHub can sign and publish provenance
for the exact output digest. Every calling job therefore grants only the permissions the official
GitHub attestation flow requires:

```yaml
permissions:
  attestations: write
  contents: read
  id-token: write
  packages: write
```

The actions use GitHub's first-party `actions/attest`, versioned with a full SemVer tag, and publish its
Sigstore-signed SLSA provenance beside the GHCR image. They do not create the optional linked-artifact
storage record, so callers do not need `artifact-metadata: write`. Consumers verify an immutable
digest against the producer repository without registry write access:

```bash
gh attestation verify \
  oci://ghcr.io/a-novel/service-json-keys/grpc@sha256:<64-hex-digest> \
  --repo a-novel/service-json-keys
```

An image is releasable only after this command succeeds for its expected source repository. Do not
backfill a missing build attestation or move an existing tag; fix the build path and publish a fresh
SemVer release.

### `generic-actions`

| Action                   | Purpose                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `approve-bot`            | Record a fresh PR approval on every invocation; trusted users only.                                               |
| `approve-pr`             | Admin-only escape hatch: approve a PR as the [Agent] App (self-approval).                                         |
| `approve-translations`   | Revoke translation approval labels after a catalog change and rerun the translation check on label changes.       |
| `archive-board-items`    | Archive the repo's "Awaiting release" board items on release.                                                     |
| `assign-bot`             | Assign a PR to its author, or to the code owner when the author is a bot.                                         |
| `board-write`            | Set one single-select/date board field as [Agent] — the single write path.                                        |
| `check-append-only`      | Allow additions under a path while freezing every file that already landed.                                       |
| `check-changes`          | Detect uncommitted changes in a pathspec; optionally fail.                                                        |
| `codecov`                | Upload the coverage artifact to Codecov.                                                                          |
| `derive-status`          | Derive a Task's board Status from its PR's current state (single writer).                                         |
| `approve-playwright`     | Bind screenshot approval to the PR head and rerun the browser check that a label change left stale.               |
| `maintain-playwright`    | Promote successful master batches and delete superseded, merged or deleted branch evidence from Drive.            |
| `detect-partial-landing` | Freeze an epic's remaining siblings when a sibling drops out mid-landing (writer behind the `epic-freeze` check). |
| `enable-auto-merge`      | Enable native auto-merge on a PR as the [Agent] App (queue-when-green).                                           |
| `epic-membership`        | Resolve an Epic's authorized member set — open PRs labeled `epic:<N>`.                                            |
| `escalate`               | File/update a deduped escalation ticket (+ drive its board Status); page SEV1 via a push webhook.                 |
| `lint-dockerfile`        | Run hadolint over the repo's Dockerfiles (advisory or gating; a no-Dockerfile repo passes).                       |
| `lint-shell`             | Run shellcheck over the repo's tracked shell scripts (advisory or gating; a no-shell repo passes).                |
| `merge-gate`             | Required "may this PR merge?" check (epic-atomicity + draft/review).                                              |
| `pull-bot`               | Mint a bot App token and check out the repo authenticated as it.                                                  |
| `refresh-apko-locks`     | Re-resolve apko locks on a schedule and open or update one pull request listing the package changes.              |
| `renovate`               | Run self-hosted Renovate as the bot.                                                                              |
| `rollup-board`           | Roll an epic's Status + Start date up from its children.                                                          |

`check-append-only` needs the full base history. It rejects every change except additions under
the configured path; the `append-only-override` PR label is the reviewed escape hatch.

```yaml
- uses: actions/checkout@v6
  with:
    fetch-depth: 0

- uses: a-novel-kit/workflows/generic-actions/check-append-only@v1.27.0
  with:
    path: internal/models/migrations
    base: ${{ github.event.pull_request.base.sha }}
```

### `github-pages-actions`

| Action              | Purpose                                     |
| ------------------- | ------------------------------------------- |
| `publish-storybook` | Build a Storybook site and deploy to Pages. |

### `go-actions`

| Action        | Purpose                                                                    |
| ------------- | -------------------------------------------------------------------------- |
| `lint-go`     | Run `golangci-lint` (supports a non-root module dir).                      |
| `test-go`     | Run the workspace's Go tests with coverage via `gotestsum`.                |
| `generate-go` | Generate Go code with retries and fail when the committed output is stale. |

### `node-actions`

| Action              | Purpose                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `audit`             | Run `pnpm audit --fix` and commit the fixes.                                                                |
| `build-node`        | Run the package's build script (default `build`).                                                           |
| `lint-node`         | Run the package's lint script (default `lint`).                                                             |
| `lint-translations` | Check catalog structure, and the translation gaps and drift a branch introduces, with label approvals.      |
| `setup-node`        | Set up Node + pnpm (GitHub registry) and install.                                                           |
| `test-node`         | Run the package's tests and upload coverage.                                                                |
| `test-playwright`   | Run browser component and Playwright tests with coverage and optional private Drive screenshot comparisons. |

`test-playwright` runs on an Ubuntu host with Docker Compose available. Its default scripts are
`test:browser` and `test:e2e`; the latter owns application and service startup. The action uploads
`coverage/browser/lcov.info` and exposes its `artifact-id` for Codecov. It retains `playwright-report/`,
`test-results/` and `integration-services.log` for seven days, including when tests fail. With Drive
configured, browser evidence instead stays in each platform's private reference and results folders in a
Shared Drive: the latest successful
master reference and one completed batch per live branch. Coverage continues using GitHub artifacts.
Only existing screenshots that change or disappear produce an additional GitHub artifact:
`playwright-drift.html`, a self-contained **Old / New / Diff** review page linked from the run summary.
It uses an [unzipped artifact](https://github.com/actions/upload-artifact#upload-an-individual-file-unzipped) for direct
browser viewing and expires after three days. New screenshots pass without visual approval or a
drift artifact; unchanged runs also produce no drift artifact. Approved regeneration preserves the
original drift evidence. This small artifact still counts toward GitHub storage usage.

The complete Playwright report, including drift, stays in the Drive archive. After extracting it,
open `playwright-report/` with `pnpm exec playwright show-report`; an approved regeneration also keeps
the original failing report under `.visual/comparison-report/`. Drive previews files but does not host
the interactive HTML report. Existing Drive configuration and batch cleanup need no changes.
`generic-actions/approve-playwright` records label approval for the reviewed PR head without waiting
on main. When the label changes after the head's main run started, it reruns that run's
`test-browser` job once the run completes: at once if it already has, otherwise from the caller's
`workflow_run` trigger on main. Reviewers reach the drift review through the `visual-comparison`
check, which links main's run summary. See the [upgrade guide](./docs/migrations/v1.44.0.md).
Use `generic-actions/approve-playwright` for exact-head label approval and
`generic-actions/maintain-playwright` for trusted publication and cleanup; see the
[Drive adoption guide](./docs/migrations/v1.33.0.md).

Pass `compose_file` for disposable integration services and set a unique `COMPOSE_PROJECT_NAME` in
the calling job. The action preserves logs already collected by the runner and always removes that
Compose project's services and volumes. See the [adoption guide](./docs/migrations/v1.32.0.md).

`lint-translations` runs a platform's `i18n:structure`, `i18n:gaps` and `i18n:drift` scripts, the
last two against the merge base with the default branch. The `allow-incomplete-translations` and
`allow-translation-drift` labels accept gaps and drift; a merge group checks structure only. Skip the
job on the default branch. A trusted `pull_request_target` caller runs
`generic-actions/approve-translations`, which reruns the check when a label changes and removes both
labels when a push changes a catalog. See the [adoption guide](./docs/migrations/v1.40.0.md).

### `security-actions`

Each ships its own config, so a consuming repo carries none. All three run offline: nothing
off-repo can stall them, which is the property a required check needs.

| Action           | Purpose                                                                |
| ---------------- | ---------------------------------------------------------------------- |
| `lint-semgrep`   | Enforce the Agora structural conventions golangci-lint cannot express. |
| `scan-secrets`   | Scan the working tree for committed credentials (gitleaks).            |
| `lint-workflows` | Audit GitHub Actions workflows for security defects (zizmor).          |

Each takes `advisory: "true"` to report without failing, for a repo adopting the check over an
existing backlog.

`version` is **required** on all three, and on `generic-actions/lint-shell` and
`generic-actions/lint-dockerfile`. The pin lives in the calling repo so Renovate sees it there
and bumps each repo on its own cadence, instead of every tool upgrade waiting on a workflows
release. Annotate it so Renovate can resolve the datasource:

```yaml
- uses: a-novel-kit/workflows/security-actions/scan-secrets@v1.25.1
  with:
    # renovate: datasource=github-releases depName=gitleaks/gitleaks
    version: "8.30.1"
```

A repo needing its own gitleaks allowlist passes `config`, which **replaces** the shipped baseline:
gitleaks replaces a base config's allowlists when another config extends it, so the repo copies
`security-actions/scan-secrets/gitleaks.toml` and adds its entries.

Call the three as separate jobs, not through one reusable workflow. A reusable-workflow caller's
checks are named `<caller-job>/<inner-job>`, but required-check discovery reads the caller's job id
verbatim — so the required context would be one GitHub never posts, and the PR could never merge.

### `publish-actions`

| Action                | Purpose                                                                         |
| --------------------- | ------------------------------------------------------------------------------- |
| `npm`                 | Publish the workspace packages to the GitHub registry.                          |
| `release-core`        | Cut a release in CI: bump the version, tag, push, release.                      |
| `release-core-hotfix` | Cut a patch from a release line or a ref off a release tag (patch, not-latest). |

### Reusable workflows

Called from another repo's workflow with `uses: a-novel-kit/workflows/.github/workflows/<file>@<tag>` (not `<group>/<action>` — these are whole workflows, in `.github/workflows/`).

| Workflow           | Purpose                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `reconcile-board`  | Per-org board fail-safe sweep: epic rollup + Status drift re-derive + merge-gate re-post.               |
| `backport-run`     | Hotfix entry point: open one backport pull request per default-branch fix into its `release/vX.Y` line. |
| `release-line-run` | Cut the next patch when a backport merges into a `release/vX.Y` line, behind the `release` environment. |

## Contributing

Setup and day-to-day commands are in the [developer onboarding guide](https://github.com/a-novel-kit/.github/blob/master/README.md); workflows-specific notes are in [CONTRIBUTING.md](./CONTRIBUTING.md).
