# Build Docker Job

- Builds the provided docker imaghe
- Ensure the image can run and terminates without error
- Publish the image to the GitHub Container Registry

```yaml
name: main

on: [ push ]

jobs:
  build-job:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      attestations: write
      id-token: write
    steps:
      - uses: a-novel-kit/workflows/build/docker-job@master
        with:
          # Will make the image available as [repository_name]/job:[ref_name]
          image_name: ${{ github.repository }}/job
          # Get the branch name or tag. Works for pull requests events.
          image_tags: ${{ github.head_ref || github.ref_name }}
```

# Options

Custom Dockerfile path.

```yaml
name: main

on: [ push ]

jobs:
  build-job:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      attestations: write
      id-token: write
    steps:
      - uses: a-novel-kit/workflows/build/docker-job@master
        with:
          # Build the Dockerfile specified.
          file: path/to/Dockerfile
          # Will make the image available as [repository_name]/job:[ref_name]
          image_name: ${{ github.repository }}/job
          # Get the branch name or tag. Works for pull requests events.
          image_tags: ${{ github.head_ref || github.ref_name }}
```

Pass custom arguments when running the image for testing.

```yaml
name: main

on: [ push ]

jobs:
  build-job:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      attestations: write
      id-token: write
    steps:
      - uses: a-novel-kit/workflows/build/docker-job@master
        with:
          # Pass an environment variable to the image when running.
          run_args: -e DSN="${DSN}"
          # Will make the image available as [repository_name]/job:[ref_name]
          image_name: ${{ github.repository }}/job
          # Get the branch name or tag. Works for pull requests events.
          image_tags: ${{ github.head_ref || github.ref_name }}
```

Disable healthcheck (just build and publish).

```yaml
name: main

on: [ push ]

jobs:
  build-job:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      attestations: write
      id-token: write
    steps:
      - uses: a-novel-kit/workflows/build/docker-job@master
        with:
          # 'true' is the only recognized value. Any other value will result in
          # the healthcheck being enabled.
          skip_healthcheck: true
          # Will make the image available as [repository_name]/job:[ref_name]
          image_name: ${{ github.repository }}/job
          # Get the branch name or tag. Works for pull requests events.
          image_tags: ${{ github.head_ref || github.ref_name }}
```
