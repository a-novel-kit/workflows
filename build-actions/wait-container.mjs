import { execFileSync, spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";

const [mode, limit] = process.argv.slice(2);
if (!["service", "job"].includes(mode) || !/^[1-9]\d*$/.test(limit) || !Number.isSafeInteger(Number(limit))) {
  throw new Error("Expected service|job and a positive timeout in deciseconds");
}

// xargs handles quoted flags without evaluating shell substitutions or operators.
const parsed = execFileSync("xargs", ["-r", "printf", "%s\\0"], {
  input: process.env.RUN_ARGS ?? "",
  encoding: "utf8",
});
const args = parsed ? parsed.slice(0, -1).split("\0") : [];
// Expand only named environment references, after tokenization, so values remain single arguments.
const expanded = args.map((arg) =>
  arg.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (_, braced, bare) => process.env[braced ?? bare] ?? "")
);
const started = spawnSync(
  "docker",
  ["run", "-d", "--network=host", ...expanded, "--name", "test-container", `ghcr.io/${process.env.IMAGE_NAME}:test`],
  { stdio: "inherit" }
);
if (started.status !== 0) throw new Error("Container failed to start");

try {
  for (let attempt = 0; attempt < Number(limit); attempt++) {
    const [container] = JSON.parse(execFileSync("docker", ["inspect", "test-container"], { encoding: "utf8" }));
    const state = container.State;
    if (mode === "job" && state.Status === "exited") {
      if (state.ExitCode !== 0) throw new Error(`Container exited with code ${state.ExitCode}`);
      console.log("Container exited successfully");
      process.exit(0);
    }
    if (mode === "service" && state.Health?.Status === "healthy") {
      console.log("Container started successfully");
      process.exit(0);
    }
    if (["exited", "dead"].includes(state.Status) || state.Health?.Status === "unhealthy") {
      throw new Error("Container failed before becoming ready");
    }
    await setTimeout(100);
  }
  throw new Error("Container timed out");
} catch (error) {
  console.error(error.message);
  spawnSync("docker", ["stop", "test-container"], { stdio: "inherit" });
  spawnSync("docker", ["logs", "test-container"], { stdio: "inherit" });
  process.exitCode = 1;
}
