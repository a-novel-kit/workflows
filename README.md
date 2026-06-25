# Workflows

Reusable composite GitHub Actions powering A-Novel CI/CD.

[![X (formerly Twitter) Follow](https://img.shields.io/twitter/follow/agorastoryverse)](https://twitter.com/agorastoryverse)
[![Discord](https://img.shields.io/discord/1315240114691248138?logo=discord)](https://discord.gg/rp4Qr8cA)

<hr />

![GitHub repo file or directory count](https://img.shields.io/github/directory-file-count/a-novel-kit/workflows)
![GitHub code size in bytes](https://img.shields.io/github/languages/code-size/a-novel-kit/workflows)

![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/a-novel-kit/workflows/main.yaml)

## What this is

The shared CI/CD building blocks for every **a-novel** and **a-novel-kit** repo. Rather than copy CI logic between repos, each project pulls these actions in with `uses:`, pinned to a release tag (currently `v1.0.3`).

Each action lives at `<group>/<name>/action.yaml`, grouped by the kind of work it does. The [Action catalog](#action-catalog) lists them all.

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

| Action       | Purpose                                                       |
| ------------ | ------------------------------------------------------------- |
| `docker`     | Build an image and verify it runs **healthy** (long service). |
| `docker-job` | Build an image and verify it **exits 0** (one-shot job).      |

### `generic-actions`

| Action           | Purpose                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `approve-bot`    | Auto-approve a PR (skips if already approved); trusted users only. |
| `assign-bot`     | Assign the PR author to their own PR.                              |
| `auto-merge-bot` | Enable auto-merge on a PR.                                         |
| `check-changes`  | Detect uncommitted changes in a pathspec; optionally fail.         |
| `codecov`        | Upload the coverage artifact to Codecov.                           |
| `pull-bot`       | Check out the repo authenticated as the bot.                       |
| `renovate`       | Run self-hosted Renovate as the bot.                               |

### `github-pages-actions`

| Action             | Purpose                                    |
| ------------------ | ------------------------------------------ |
| `publish-vuepress` | Build a VuePress site and deploy to Pages. |

### `go-actions`

| Action           | Purpose                                                        |
| ---------------- | -------------------------------------------------------------- |
| `go-report-card` | Refresh the repo's [Go Report Card](https://goreportcard.com). |
| `lint-go`        | Run `golangci-lint` (supports a non-root module dir).          |
| `test-go`        | Run Go tests (race + coverage) via `gotestsum`.                |

### `node-actions`

| Action            | Purpose                                                |
| ----------------- | ------------------------------------------------------ |
| `audit`           | Run `pnpm audit --fix` and commit the fixes.           |
| `build-node`      | Run the package's build script (default `build`).      |
| `lint-node`       | Run the package's lint script (default `lint`).        |
| `security-update` | Publish a patch release for security fixes, age-gated. |
| `setup-node`      | Set up Node + pnpm (GitHub registry) and install.      |
| `test-node`       | Run the package's tests and upload coverage.           |

### `publish-actions`

| Action         | Purpose                                                |
| -------------- | ------------------------------------------------------ |
| `auto-release` | Turn a pushed tag into a GitHub release with notes.    |
| `npm`          | Publish the workspace packages to the GitHub registry. |

## Contributing

Setup and day-to-day commands are in the [developer onboarding guide](https://github.com/a-novel-kit/.github/blob/master/README.md); workflows-specific notes are in [CONTRIBUTING.md](./CONTRIBUTING.md).
