# Repository-class Renovate configuration

Choose the same class as `a-novel repo`: `service`, `platform`, `library`, `infra`, `workflows` or
`meta`. Each class inherits `base`, which owns the common update policy.

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["github>a-novel-kit/workflows//renovate/service#v1.80.1"]
}
```

Pin the preset to the same workflows release as the repository's actions. Renovate's config manager
moves the preset reference in the same workflows update group, and relative references inside a preset
inherit its release tag.

The base preset rebases an update branch whenever it falls behind the target branch, merge queue or
not. A failing update then picks up the fixes the target branch already merged, at the cost of extra
CI runs when the target moves.

The base preset also runs lockfile maintenance before 05:00 each day, in Renovate's configured
timezone, UTC by default. It refreshes supported lockfiles within their manifest constraints, so a
transitive fix lands without waiting for a direct dependency bump.

Renovate selects a GitHub release no sooner than one hour after publication, which gives its binary
assets and checksums time to finish uploading. The delay applies to every `github-releases`
dependency and to the release-file datasources below, on top of Renovate's release-age buffer.

A third-party action runs from the commit its release named. Renovate pins each one as
`owner/repo@<sha> # vX.Y.Z` and moves the commit and the version together, three days after the
release. An update that keeps the version and changes the commit means the upstream tag was moved,
so it waits for a reviewer instead of merging on its own. The `a-novel-kit/workflows` references
stay on release tags. The images and runners a workflow names do not wait.

A scanner image pinned in a workflow's `with:` block carries its digest after the tag, so a moved tag
changes nothing the job runs. Renovate moves the digest with the tag. An update that keeps the tag and
changes the digest merges on its own, since publishers rebuild image tags as routine:

```yaml
# renovate: datasource=docker depName=ghcr.io/zizmorcore/zizmor
version: "1.31.1@sha256:42d409dbb851d4c5d35a058cf042b828bea1e3f2884378c526eb0974780e18d9"
```

A workflow pin of a downloaded tool carries the SHA-256 of its release file on the line after
`version`. The `custom.shellcheck`, `custom.hadolint` and `custom.sentry-cli` datasources read that
file's digest from GitHub's release API, so one update moves the version and the hash. An update that
keeps the version and changes the hash means someone replaced the release's files, so it waits for a
reviewer, as do the database preset's pgBackRest and apko hashes.

```yaml
# renovate: datasource=custom.hadolint depName=hadolint/hadolint
version: "2.15.1"
sha256: "c7187db94eeeeca956519a6af171adc31453941a1e777961f6e680f697c8c507"
```

A Go module waits three days after its release. A security fix skips the wait, through GitHub's
vulnerability alerts and OSV.

Docker images do not wait. A release Renovate cannot date never clears a wait, and Docker Hub lists
at most 1,000 tags to an anonymous client, so Renovate has no date for node or golang.

A first-party version skips every release-age gate. Any workflow run of a repository can publish its
packages, so the auto-approver merges a first-party version only with its release proof: an
attestation over its bytes from the producer's `release.yaml` at the version's tag, and an immutable
Release from the org's release App. Compose files and Dockerfiles pin first-party images by digest,
so a moved tag changes nothing a consumer runs. A composite-action input default gets its digest by
hand once, and its manager then moves the digest with the tag.

Each service's Go module, npm client and images update in one PR, because a module must ship with
its matching images. Renovate runs every artifact update in a grouped branch with the configuration
of its first upgrade by name, usually an image, so these groups carry both `go mod tidy` and
`pnpm dedupe` for their members. The same applies to the golang image in the `go toolchain` group
and the Playwright image pin in `playwright runtime`.

The `go` directive in `go.mod` reads its versions from the golang image's alpine tags, not from
go.dev. Docker Hub publishes a Go release a day or more after go.dev does, and the image builds with
`GOTOOLCHAIN=local`, so a directive ahead of the image fails every image build. The directive and
the image therefore move together, once the image exists.

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

The package manager refreshes an npm lockfile, so a cooldown on transitive packages belongs in the
package manager, such as pnpm's `minimumReleaseAge`. Renovate's own `minimumReleaseAge` does not cover
lockfile maintenance.

| Class       | Additional configuration                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `service`   | Podman Compose and isolated Go tool modules; standard service regeneration; database dependency detection.                          |
| `library`   | Isolated Go tool modules, standard linter/test-tool updates, npm deduplication and peer-dependency updates. Includes the stack CLI. |
| `platform`  | npm deduplication and peer-dependency updates.                                                                                      |
| `workflows` | Common base.                                                                                                                        |
| `infra`     | Common base; deployment-specific policy remains in the repository.                                                                  |
| `meta`      | Common base for organization configuration repositories.                                                                            |

## Protobuf regeneration

A repository that generates protobuf code with a `buf.mod` tool module adds the `protobuf` preset
beside its class, pinned to the same release:

```json
{
  "extends": [
    "github>a-novel-kit/workflows//renovate/service#v1.80.1",
    "github>a-novel-kit/workflows//renovate/protobuf#v1.80.1"
  ]
}
```

When a root `go.mod` update moves `google.golang.org/protobuf`, the preset runs
`go tool -modfile=buf.mod buf generate` in the update branch, so the generated code stays in step with
the generator. The repository's `allowed_commands` must permit it. The preset is opt-in, because a
class does not say whether a repository generates protobuf code, and the command fails without
`buf.mod`.

## Runner configuration

The shared action loads its operator settings from `generic-actions/renovate/config.json`. Set
`repository_config` when adopting a class preset:

```yaml
- uses: a-novel-kit/workflows/generic-actions/renovate@v1.80.1
  with:
    repository_config: "true"
    github_token: ${{ secrets.GITHUB_TOKEN }}
    app_private_key: ${{ secrets.DEPENDENCY_BOT_PRIVATE_KEY }}
    client_id: ${{ vars.DEPENDENCY_BOT_CLIENT_ID }}
```

A caller without the input keeps the base policy through the runner's `globalExtends` default.
`repository_config: "true"` drops that default, so the repository's class preset becomes its only
update policy. Adopt the preset and the input together.

The environment supplies credentials, the current repository, logging and the caller's overrides.
The runner JSON holds the install behavior, the credential-forwarding templates and the default
command allowlist. `allowed_commands` replaces that allowlist: an empty input keeps the default, and
`[]` disables post-upgrade commands. Presets request regeneration tasks, and the allowlist decides
which of them run.

## Local configuration

Keep nonstandard architecture or registry choices, compatibility exceptions and repository-specific
generation paths in the consumer. Matching package rules merge in order, repository rules after
presets. Remove local rules and managers that the class preset carries, since they would apply twice.

The service and library classes share `go-tools`, which isolates each Go tool module in its own
branch. The service class includes `database`, which updates apko and pinned APK packages and groups
PostgreSQL runtime packages. Its pgBackRest and apko managers update a version and its
SHA-256 together: pgBackRest's source archive, and apko's `checksums.txt`, which covers the
release binary of every architecture. Both accept only stable releases with a matching asset and
valid digest. The custom datasources use Renovate's experimental custom datasource support.

The database preset points APK lookups in `builds/database.apko.yaml` at
`https://packages.wolfi.dev/os?arch=x86_64`, so a standard Wolfi service needs only the class preset.
The rule stays inactive until a service adopts the Wolfi image, and other APK files keep their own
registries. A consumer on another registry or architecture overrides `registryUrls` for that file and
datasource, with `arch=aarch64` for ARM64.

## Validation

`tests/renovate.test.mjs` covers the shipped managers and policy. The `lint-renovate` CI job runs
Renovate's strict configuration validator on every preset and on the runner configuration, with the
Renovate action version production uses. It resolves each preset's full inheritance from the tested
commit.

Before a release, check the consumer overrides that meet a changed policy: group precedence, local
exceptions, command permissions, duplicate managers and preset-tag updates. The release stamps the
runner's `globalExtends` reference with its own tag.
