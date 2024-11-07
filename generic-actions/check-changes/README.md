# Check changes

Check if the current workflow introduced uncommited changes.

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
          fetch-depth: "1"
      - name: Check generated files are up-to-date
        run: |
          make generated-files
      - uses: a-novel-kit/workflows/generic-actions/check-changes@master
        id: generated
      - name: Verify generated files
        if: steps.generated.outputs.diff == '1'
        run: echo "generated definitions are not up-to-date, please run 'xxxxx' and commit the changes" && exit 1
```
