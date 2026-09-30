import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** NUL delimiters preserve tracked paths containing whitespace, quotes or newlines. */
export const tracked = () => execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);

/** Releases start from a stable SemVer; refuse invalid or prerelease baselines before writing. */
export function version() {
  const value = JSON.parse(readFileSync("package.json", "utf8")).version;
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error("package.json must contain a stable SemVer version");
  }
  return value;
}
