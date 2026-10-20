import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const read = (path) => readFileSync(join(root, path), "utf8");
export const manifest = (path) => parse(read(path));

/** Read the shipped run body, independent of YAML indentation and quoting. */
export function step(path, name) {
  const action = manifest(path);
  const steps = action.runs?.steps ?? Object.values(action.jobs).flatMap((job) => job.steps ?? []);
  const selected = steps.find((entry) => entry.id === name || entry.name === name);
  assert.equal(typeof selected?.run, "string", `Missing run step ${name} in ${path}`);
  return selected.run;
}

/** Lift named shell functions from a parsed run body; assertions stay in Node. */
export function functions(script, names) {
  return names.map((name) => shellFunction(script, name)).join("\n");
}

function shellFunction(script, name) {
  const match = script.match(new RegExp(`^${name}\\(\\) \\{[^]*?^\\}`, "m"));
  assert(match, `Missing shell function ${name}`);
  return match[0];
}

export function command(program, args = [], options = {}) {
  const result = spawnSync(program, args, { encoding: "utf8", timeout: 30_000, ...options });
  assert.ifError(result.error);
  return result;
}

/** Each test owns its files, command stubs and environment, including cleanup on failure. */
export function workspace(t) {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GITHUB_OUTPUT: join(cwd, "output"),
    GITHUB_ENV: join(cwd, "env"),
    GITHUB_STEP_SUMMARY: join(cwd, "summary"),
    GIT_CEILING_DIRECTORIES: dirname(cwd),
    // Scratch repositories ignore the developer's Git config, so no commit asks to be signed.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: `${join(cwd, "bin")}:${process.env.PATH}`,
  };
  const write = (path, content) => {
    const file = join(cwd, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
  };
  return {
    cwd,
    env,
    write,
    read: (path) => readFileSync(join(cwd, path), "utf8"),
    run: (program, args = [], extra = {}) => command(program, args, { cwd, env: { ...env, ...extra } }),
    bash: (script, extra = {}, args = []) =>
      command("bash", ["--noprofile", "--norc", "-c", script, "test", ...args], {
        cwd,
        env: { ...env, ...extra },
      }),
    stub(name, body) {
      const file = write(`bin/${name}`, `#!${process.execPath}\n${body}\n`);
      chmodSync(file, 0o755);
    },
  };
}

/**
 * Reads the GraphQL variables of a `gh api` call from its arguments, typed as gh types them: -f sends
 * a string, while -F sends an integer, a boolean or null when the value reads as one.
 */
export function ghVariables(args) {
  const literals = ["true", "false", "null"];
  const typed = (v) => (/^[+-]?\d+$/.test(v) ? Number(v) : literals.includes(v) ? JSON.parse(v) : v);
  const variables = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "-f" && args[i] !== "-F") continue;
    const [key, value] = args[i + 1].split(/=(.*)/s);
    if (key !== "query") variables[key] = args[i] === "-F" ? typed(value) : value;
    i++;
  }
  return variables;
}

export function succeeds(result) {
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout.trimEnd();
}
