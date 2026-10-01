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

The service class includes `database`, which updates apko and pinned APK packages and
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

Run `node --test tests/renovate.test.mjs` for the shipped manager and policy fixtures. Before
releasing a preset change, validate the files with Renovate's strict configuration validator
and resolve representative consumer configurations with the supported Renovate version.
Check group precedence, local exceptions, command permissions, duplicate managers and preset-tag
updates. The runner's compatibility base reference is stamped by the release workflow.
