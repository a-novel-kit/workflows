# Contributing to workflows

This guide covers what is specific to `workflows`. Read the [README](./README.md) first: it says what
the repository ships and how callers pin it. The [developer guide](https://a-novel-kit.github.io/stack/)
sets up the platform, and the
[libraries, tooling and platform concepts](https://github.com/a-novel-kit/.github/blob/master/CONTRIBUTING.md)
place this repository in the tooling layer.

## Where things live

| Path                                                                        | Holds                                                                       |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `<group>/<name>/action.yaml`                                                | One composite action, with its scripts beside it or in its group directory. |
| `.github/workflows/*-run.yaml`, `reconcile-board.yaml`, `token-expiry.yaml` | The reusable workflows other repositories call.                             |
| `.github/workflows/`, other files                                           | This repository's own CI and release, and its governance callers.           |
| `renovate/`                                                                 | The Renovate presets, one per repository class plus shared parts.           |
| `docs/migrations/`                                                          | One guide per release that asks callers to change something.                |
| `tests/`                                                                    | The regression suites for the actions, workflows and presets.               |

GitHub shows each action's `name` and `description` to its callers, and the README catalog copies them
by hand. Update the README in the same change.

The workflows with a "Managed by `a-novel repo update`" banner, and `.github/CODEOWNERS`, are rendered
from the stack's repocfg templates. Change them there.

## Versioning

One `v*` tag releases every action, workflow and preset together. A maintainer cuts a release from
**Actions** → **release** → **Run workflow** with a bump type. The run executes
`publish-actions/release-core` in the protected `release` environment.

An action that calls a sibling references it by tag, as `a-novel-kit/workflows/<group>/<name>@<tag>`,
so a release always runs its own siblings. The release rewrites those pins to its new tag, together with
the versions in the README and the presets guide. A script
that several actions share loads through `$GITHUB_ACTION_PATH`, as the security actions load
`security-actions/run-scan.mjs`.

A change that callers must act on ships with a guide in `docs/migrations/`, added to its index.

## Scripts and tests

Write scripts outside YAML as JavaScript modules (`.mjs`) for Node.js 24. A run block may use Bash.
Pass every input to it through `env:`, so a caller's value stays data.

The suites run on Node's built-in test runner. The Drive suites also need GNU `tar`, and the browser
suite needs Chromium:

```bash
pnpm install
pnpm exec playwright install chromium
a-novel test --type=pnpm -y
```

On a host without Chromium's system libraries, run the browser suite in the Playwright image of the
pinned version. The runner under test calls pnpm, so the container installs the pinned one first:

```bash
playwright="$(node -p "require('./package.json').devDependencies.playwright")"
pnpm="$(node -p "require('./package.json').packageManager")"
podman run --rm -v "$PWD:$PWD:z" -w "$PWD" -e PNPM="$pnpm" \
  "mcr.microsoft.com/playwright:v$playwright-noble" \
  sh -c 'npm install --global "$PNPM" && node --test tests/drive-browser.test.mjs'
```

`pnpm lint` checks formatting and that no composite manifest names a context it cannot read. CI also
audits the workflows with zizmor (`lint-workflows`) and shellchecks the Bash every run block ships
(`lint-shell`), which extracts each block into its own file first:

```bash
shell_dir="$(mktemp -d)"
node .github/scripts/extract-shell.mjs "$shell_dir"
shellcheck "$shell_dir"/*.sh
```

`tests/helpers.mjs` reads run blocks from the parsed YAML and gives each test an isolated workspace and
command stubs. Prefer tests of a complete step's behavior, and extract a function only when the full
step would add unrelated setup. Keep a case for each distinct failure and security boundary, and leave
out assertions that restate configuration or repeat another test's outcome.

## Questions?

[Open an issue](https://github.com/a-novel-kit/workflows/issues) with the logs and the environment
details.
