# Create commit

Create and push a new commit to the repository. It pushes on the head branch by default.

If no uncommitted changes are detected, the action will not create a commit. You can check if a commit was created using
the `diff` output.

> The Personal Access Token used MUST have at least the `repo` scope. If your commit changes the workflow file, you MUST
> also ass the `workflow` scope.

```yaml
name: main

jobs:
  generated:
    needs: []
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          # Retrieve the git history to be able to push changes.
          fetch-depth: 0s
          # IMPORTANT: you MUST check the repository out using the
          # PAT token to be able to push changes.
          token: ${{ secrets.PAT }}
      - name: do something
        run: |
          # Do anything on previous steps.
      - uses: a-novel-kit/workflows/generic-actions/create-commit@master
        id: commit
        with:
          commit_message: "commit message"
          pat: ${{ secrets.PAT }}
      - name: Post commit
        if: steps.commit.outputs.diff == '1'
        run: |
          # Do anything after the commit.
```

# Options

| option           | Required | Default | Description                                                            |
| :--------------- | :------- | :------ | :--------------------------------------------------------------------- |
| `commit_message` | Yes      |         | The commit message to use when committing changes.                     |
| `pat`            | Yes      |         | The personal access token to use for the action.                       |
| `branch`         |          |         | The new branch to push the commit to. Uses the HEAD branch by default. |
