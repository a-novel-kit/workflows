# Migration guides

One immutable guide per release that asks consumers to change something. Newest first.

| Version                 | Summary                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [v1.60.0](./v1.60.0.md) | No bot write bypasses the release rulesets: audit opens a pull request; `notify-pr-run` drops `pull_requests_webhook`.    |
| [v1.59.0](./v1.59.0.md) | Renames the `lint-semgrep` rule IDs from `agora-` to `a-novel-`; update `nosemgrep:` comments.                            |
| [v1.57.0](./v1.57.0.md) | Releases split into `plan`, `cut` and a publishing tag; the release App cuts behind one approval.                         |
| [v1.55.0](./v1.55.0.md) | Node actions stop minting an App token; drop `app_private_key` and `client_id` from all but `audit`.                      |
| [v1.54.0](./v1.54.0.md) | Removes the reusable `watchdog.yaml`; delete its callers before moving their pins.                                        |
| [v1.53.0](./v1.53.0.md) | Screenshot and translation gates support `main` running on pull requests; platforms can switch.                           |
| [v1.52.0](./v1.52.0.md) | Docker builds are tagged only on `master`, releases and `with-feature-env` pull requests; others push by digest.          |
| [v1.46.0](./v1.46.0.md) | A push to a PR removes `append-only-override`; pass `github_token` and grant `pull-requests: write`.                      |
| [v1.45.3](./v1.45.3.md) | A push removes the screenshot and translation approval labels; `approve-playwright` needs `pull-requests: write`.         |
| [v1.45.0](./v1.45.0.md) | Removes the reconcile hotfix path (`hotfix-run`, `hotfix-reconcile`) that backports replaced.                             |
| [v1.44.0](./v1.44.0.md) | `approve-playwright` records the approval without waiting on main CI.                                                     |
| [v1.43.0](./v1.43.0.md) | Hotfixes become backport pull requests into `release/vX.Y` lines; merging one cuts the patch.                             |
| [v1.40.0](./v1.40.0.md) | Shared translation gate for platforms with translation catalogs.                                                          |
| [v1.38.0](./v1.38.0.md) | Protobuf regeneration becomes an opt-in Renovate preset for `buf.mod` repositories.                                       |
| [v1.37.0](./v1.37.0.md) | Removes four uncalled actions; per-action caches seed once after adopting.                                                |
| [v1.33.0](./v1.33.0.md) | Optional private Drive storage, native screenshot comparisons and reviewed visual updates.                                |
| [v1.32.0](./v1.32.0.md) | Shared Playwright pipeline for platform browser tests, coverage and failure diagnostics.                                  |
| [v1.31.0](./v1.31.0.md) | Composable Renovate presets by repository class and JSON runner configuration.                                            |
| [v1.30.1](./v1.30.1.md) | Centralizes Renovate defaults and lockfile-sensitive groups; consumers remove duplicated local policy.                    |
| [v1.30.0](./v1.30.0.md) | Docker build actions publish signed GitHub provenance and require four narrow job permissions.                            |
| [v1.26.0](./v1.26.0.md) | Tool versions become required inputs on `lint-shell`, `lint-dockerfile` and the `release-core` actions.                   |
| [v1.24.0](./v1.24.0.md) | Removes the `go-actions/go-report-card` action (dead service); activation-snapshot membership resolves without the label. |
| [v1.21.0](./v1.21.0.md) | Activation-snapshot wave boundary — converge every repo, planning repos included.                                         |
| [v1.1.0](./v1.1.0.md)   | `client_id` bot-token input (deprecates `app_id`); UI-dispatched releases added.                                          |
