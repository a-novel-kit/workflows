// Materialize YAML's Bash steps for ShellCheck; production scripts remain in their manifests.
import { globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const destination = process.argv[2];
if (!destination) throw new Error("Provide an output directory for the extracted shell steps");
mkdirSync(destination, { recursive: true });
let count = 0;
for (const file of globSync(["*-actions/*/action.yaml", ".github/workflows/*.{yaml,yml}"])) {
  const data = parse(readFileSync(file, "utf8"));
  const steps = data.runs?.steps ?? Object.values(data.jobs ?? {}).flatMap((job) => job.steps ?? []);
  for (const [index, step] of steps.entries()) {
    if (!step.run || (step.shell && step.shell !== "bash")) continue;
    const environment = new Set(Object.keys(step.env ?? {}));
    let expressionIndex = 0;
    const source = step.run.replace(/\$\{\{\s*([^]*?)\s*\}\}/g, (_, expression) => {
      const input = expression.match(/^inputs\.(filter_patterns|filter_extra_patterns)$/)?.[1];
      if (input) return data.inputs[input].default;
      const name = `GITHUB_EXPRESSION_${expressionIndex++}`;
      environment.add(name);
      return `\${${name}}`;
    });
    // jq and GraphQL deliberately contain literal $variables in single-quoted strings.
    const header = [
      "#!/usr/bin/env bash",
      "# shellcheck disable=SC2016",
      ...[...environment].map((name) => `export ${name}=1`),
    ];
    writeFileSync(join(destination, `${file.replaceAll("/", "_")}-${index}.sh`), `${header.join("\n")}\n${source}\n`);
    count++;
  }
}
if (!count) throw new Error("No Bash steps found");
console.log(`Extracted ${count} Bash steps for ShellCheck`);
