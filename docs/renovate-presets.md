# Repository-class Renovate configuration

Choose the same class as `a-novel repo`: `service`, `platform`, `library`, `infra`,
`workflows` or `meta`. Each class inherits `base`, which owns the common update policy.

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["github>a-novel-kit/workflows//renovate/service#v1.31.0"]
}
```

Pin the preset to the same workflows release as the repository's actions. Renovate's
native config manager updates the preset reference in the existing workflows update group.
Relative references inside presets inherit that release tag.

The base preset rebases branches whenever they fall behind the target branch. This brings
fixes already merged into the target into failing update PRs, including repositories with a
merge queue, where Renovate otherwise defaults to rebasing only conflicts. It may trigger
additional CI runs when the target branch changes.

The base preset enables native lockfile maintenance before 05:00 each day in Renovate's
configured timezone (UTC by default). Supported lockfiles are refreshed within their
manifest constraints, so transitive fixes do not have to wait for a direct dependency bump.
Existing CI checks and repository-specific review rules still apply. This uses the existing
Renovate schedule; it does not add a workflow or dependency-specific overrides.

Updates from GitHub releases wait at least one hour after publication before Renovate selects
them. This gives binary assets and checksums time to finish uploading; the default strict
release-age filter keeps premature versions out of update branches. The delay applies to all
`github-releases` dependencies and inherits Renovate's release-age buffer.

Each service's Go module, npm client and images update in one PR, because a module must ship with
its matching images. Renovate runs every artifact update in a grouped branch with the configuration
of its first upgrade by name, usually an image, so these groups carry both `go mod tidy` and
`pnpm dedupe` for their members. The same applies to the golang image in the `go toolchain` group
and the Playwright image pin in `playwright runtime`.

A workflow that runs in the Playwright container annotates the image, so its tag follows npm's
`playwright` releases:

```yaml
container:
  # renovate: datasource=npm depName=playwright
  image: mcr.microsoft.com/playwright:v1.63.0-noble
```

The registry publishes no release dates, so the preset disables Renovate's docker lookup for this
image, and an unannotated tag never updates. An annotated tag clears the same npm release-age gate
as the package and lands in the same commit.

For npm lockfiles, the package manager performs the refresh. Enforce transitive-package
release cooldowns in the package manager (for example, pnpm's `minimumReleaseAge`);
Renovate's `minimumReleaseAge` alone does not cover lockfile maintenance.

| Class       | Additional configuration                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `service`   | Podman Compose and isolated Go tool modules; standard service regeneration; database dependency detection.                          |
| `library`   | Isolated Go tool modules, standard linter/test-tool updates, npm deduplication and peer-dependency updates. Includes the stack CLI. |
| `platform`  | npm deduplication and peer-dependency updates.                                                                                      |
| `workflows` | Complete GitHub Actions release tags.                                                                                               |
| `infra`     | Common base; deployment-specific policy remains in the repository.                                                                  |
| `meta`      | Common base for organization configuration repositories.                                                                            |

## Protobuf regeneration

A repository that generates protobuf code with a `buf.mod` tool module adds the `protobuf` preset
beside its class, pinned to the same release:

```json
{
  "extends": [
    "github>a-novel-kit/workflows//renovate/service#v1.38.0",
    "github>a-novel-kit/workflows//renovate/protobuf#v1.38.0"
  ]
}
```

When a root `go.mod` update moves `google.golang.org/protobuf`, the preset runs
`go tool -modfile=buf.mod buf generate` in the update branch, so generated headers and code stay in
step with the generator. The repository's `allowed_commands` must permit it. The preset is opt-in
because a class does not say whether a repository generates protobuf code, and the command fails
in one without `buf.mod`.

## Runner configuration

The shared action loads its operator settings from `generic-actions/renovate/config.json`.
Set `repository_config` when adopting a class preset:

```yaml
- uses: a-novel-kit/workflows/generic-actions/renovate@v1.31.0
  with:
    repository_config: "true"
    github_token: ${{ secrets.GITHUB_TOKEN }}
    app_private_key: ${{ secrets.DEPENDENCY_BOT_PRIVATE_KEY }}
    client_id: ${{ vars.DEPENDENCY_BOT_CLIENT_ID }}
```

Existing callers retain the base policy through the runner's `globalExtends` default.
`repository_config: "true"` disables that compatibility default: the repository's class
preset becomes the single source of update policy. Adopt the preset and input together.

The environment supplies credentials, the current repository, logging and explicit caller
overrides. Static install behavior, credential-forwarding templates and default command
permissions live in the runner JSON. `allowed_commands` still overrides the default
allowlist; an empty input preserves the default and `[]` disables post-upgrade commands.

## Local configuration

Keep nonstandard architecture or registry choices, compatibility exceptions and repository-specific
generation paths in the consumer. Matching package rules merge in order, with repository
rules applied after presets. Remove the rules and managers transferred to the class preset;
retaining them would apply the same configuration twice.

The service and library classes share `go-tools`, which isolates each Go tool module in its own branch. The service class includes `database`, which updates apko and pinned APK packages and
groups PostgreSQL runtime packages. Its pgBackRest manager updates source version and
SHA-256 together, accepting only stable releases with a matching asset and valid digest.
The custom datasource uses Renovate's experimental custom datasource support.

The database preset defaults APK lookups in `builds/database.apko.yaml` to
`https://packages.wolfi.dev/os?arch=x86_64`. Standard Wolfi services need only the class
preset. Services adopt the Wolfi image separately; the rule is inactive without matching
dependencies. Other APK files and Debian registry rules are unaffected. A consumer using
another registry or architecture overrides `registryUrls` for that file and datasource;
use `arch=aarch64` for ARM64.

Presets request regeneration tasks; the runner's allowlist grants permission to execute them.

## Validation

Run `node --test tests/renovate.test.mjs` for the shipped manager and policy fixtures.
The `test-actions` CI job also runs Renovate's strict configuration validator on every preset
and the runner configuration, using the same Renovate action version as production. It resolves
each preset's full inheritance from the exact tested commit, including all six repository classes.
Before release, also check consumer-specific overrides when they interact with the changed policy.
Check group precedence, local exceptions, command permissions, duplicate managers and preset-tag
updates. The runner's compatibility base reference is stamped by the release workflow.
