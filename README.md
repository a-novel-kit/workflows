# Workflows

Reusable composite GitHub Actions powering A-Novel CI/CD.

[![X (formerly Twitter) Follow](https://img.shields.io/twitter/follow/agorastoryverse)](https://twitter.com/agorastoryverse)
[![Discord](https://img.shields.io/discord/1315240114691248138?logo=discord)](https://discord.gg/rp4Qr8cA)

<hr />

![GitHub repo file or directory count](https://img.shields.io/github/directory-file-count/a-novel-kit/workflows)
![GitHub code size in bytes](https://img.shields.io/github/languages/code-size/a-novel-kit/workflows)

![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/a-novel-kit/workflows/main.yaml)

## What this is

`workflows` is the shared catalog of reusable composite GitHub Actions that standardize lint, test, build, publish, and security tasks across every repo in the **a-novel** and **a-novel-kit** organizations. Instead of copying CI logic from one repo to the next, each project pulls these actions in with `uses:` and pins them to a release tag — currently `v1.0.3`.

Each action lives at `<group>/<name>/action.yaml` and is a self-contained composite step. The groups (`build-actions`, `generic-actions`, `github-pages-actions`, `go-actions`, `node-actions`, `publish-actions`) map to the kind of work the action does; the full list is in the [Action catalog](#action-catalog) below.

## Using an action

Reference an action from a `.github/workflows/*.yaml` job step. The path is `a-novel-kit/workflows/<group>/<action>@<tag>`:

```yaml
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: a-novel-kit/workflows/go-actions/lint-go@v1.0.3
        with:
          working-directory: . # optional; defaults to the repo root
```

Always pin to a release tag (`@v1.0.3`), never to `@master`. The composite actions are released as a single unit, so bump every pinned ref together when you upgrade — Renovate groups them under `a-novel-kit workflows` to do exactly that.

## Action catalog

### `build-actions`

| Action       | Purpose                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `docker`     | Build a Docker image from a Dockerfile and verify it reports **healthy** when run (long-lived service).          |
| `docker-job` | Build a Docker image from a Dockerfile and verify it **exits 0** when run (one-shot job); healthcheck skippable. |

### `generic-actions`

| Action           | Purpose                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `approve-bot`    | Auto-approve a pull request (skips if already approved). Restrict to a trusted set of users. |
| `assign-bot`     | Assign the PR author as the assignee on their own pull request.                              |
| `auto-merge-bot` | Enable GitHub auto-merge (merge strategy) on a pull request.                                 |
| `check-changes`  | Detect uncommitted changes in a pathspec; optionally fail the job when any are found.        |
| `codecov`        | Download the coverage artifact and upload the report to Codecov.                             |
| `pull-bot`       | Mint a GitHub App token and check out the repo authenticated as the bot.                     |
| `renovate`       | Run self-hosted Renovate against the repo using the bot App token.                           |

### `github-pages-actions`

| Action             | Purpose                                              |
| ------------------ | ---------------------------------------------------- |
| `publish-vuepress` | Build a VuePress site and deploy it to GitHub Pages. |

### `go-actions`

| Action           | Purpose                                                                          |
| ---------------- | -------------------------------------------------------------------------------- |
| `go-report-card` | Trigger a [Go Report Card](https://goreportcard.com) refresh for the repo.       |
| `lint-go`        | Run `golangci-lint` (checkstyle output), supporting a non-root module directory. |
| `test-go`        | Run the Go test suite with race + coverage via `gotestsum`; upload the reports.  |

### `node-actions`

| Action            | Purpose                                                                             |
| ----------------- | ----------------------------------------------------------------------------------- |
| `audit`           | Run `pnpm audit --fix`, reformat, and commit the resulting lockfile/override fixes. |
| `build-node`      | Run the package's build script (default `build`) after a Node/pnpm setup.           |
| `lint-node`       | Run the package's lint script (default `lint`) after a Node/pnpm setup.             |
| `security-update` | Publish a patch release for accumulated security fixes, gated on release age.       |
| `setup-node`      | Set up Node + pnpm wired to the GitHub package registry and install dependencies.   |
| `test-node`       | Run the package's test script (default `test`) and upload the coverage artifact.    |

### `publish-actions`

| Action         | Purpose                                                                |
| -------------- | ---------------------------------------------------------------------- |
| `auto-release` | Create a GitHub release from the pushed tag with auto-generated notes. |
| `npm`          | Build and publish the workspace packages to the npm (GitHub) registry. |

## Contributing

Platform setup and the day-to-day commands live in the [developer onboarding guide](https://github.com/a-novel-kit/.github/blob/master/README.md); `workflows`-specific notes are in [CONTRIBUTING.md](./CONTRIBUTING.md).
