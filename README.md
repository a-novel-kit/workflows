# Workflows

Shared workflows for A-Novel projects.

## Go workflows

### Test

Run tests and coverage.

> Requires a Codecov token to upload coverage.

```yaml
test:
  uses: a-novel-kit/workflows/.github/workflows/test-go.yaml@master
  secrets:
    codecov_token: ${{ secrets.CODECOV_TOKEN }}
```

### Build GRPC

Builds a GRPC app, and generates a package for it.

```yaml
build:
  needs: [ test ]
  uses: a-novel-kit/workflows/.github/workflows/build-grpc-go.yaml@master
  permissions:
    contents: read
    packages: write
    attestations: write
    id-token: write
  with:
    repository: ${{ github.repository }}
    repository_name: ${{ github.event.repository.name }}
    ref: ${{ github.head_ref || github.ref_name }}
    actor: ${{ github.actor }}
```
