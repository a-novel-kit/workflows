// Advisory mode waives only each scanner's findings codes; execution failures still fail.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";

const [name, command, ...args] = process.argv.slice(2);
if (!name || !command) throw new Error("Expected a scanner name and command");
let output = Buffer.alloc(0);
let code;
for (let attempt = 1; attempt <= 3; attempt++) {
  output = Buffer.alloc(0);
  code = await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of ["stdout", "stderr"])
      child[stream].on("data", (chunk) => {
        process[stream].write(chunk);
        output = Buffer.concat([output, chunk]).subarray(-60_000);
      });
    child.on("error", (error) => {
      console.error(error.message);
      resolve(127);
    });
    child.on("close", (status) => resolve(status ?? 2));
  });
  // Docker's 125 means no scanner ran. Findings and scanner errors are never retried.
  if (command !== "docker" || code !== 125 || attempt === 3) break;
  console.warn(`::warning::docker could not run ${name} (attempt ${attempt}/3); retrying`);
  await setTimeout(attempt * Number(process.env.SCAN_RETRY_DELAY_MS ?? 5000));
}

const summary = (text) => appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
if (code === 0) summary(`${name}: clean`);
else {
  const failed = !{ semgrep: [1], gitleaks: [10], zizmor: [11, 12, 13, 14] }[name]?.includes(code);
  const advisory = !failed && process.env.ADVISORY === "true";
  const status = failed ? "did not run" : "findings";
  const note =
    name === "gitleaks" && !failed
      ? "Values are redacted. Scope allowlists to the exact value or path, never a whole rule.\n\n"
      : "";
  summary(`### ${name} ${status}\n\n${note}\`\`\`\n${output.subarray(failed ? -20_000 : -60_000).toString()}\n\`\`\``);
  console.error(
    `::${advisory ? "warning" : "error"}::${name} ${status} (exit ${code})${advisory ? "; advisory mode" : ""}`
  );
  process.exitCode = advisory ? 0 : code;
}
