// Collect an org's audit-log alerts: the entries that can hand someone access, weaken a protection or
// push past a rule, minus the caller's ignore rules and the alerts an earlier run already posted.
// GitHub indexes some entries after they happen, so each run rereads an hour before its previous
// successful run, and that run's seen list keeps the overlap from alerting twice.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// An entry GitHub indexes more than an hour late falls before every window and never alerts.
const overlap = 3_600_000;
const artifact = "notify-audit-seen";

/**
 * The audit-log actions that alert, each a category, which watches all its actions, or one action.
 * Each can hand someone access, weaken a protection or push past a rule.
 */
export const watched = [
  // Pushes past a rule, and changes to the rules: rulesets, branch protection, environments.
  "protected_branch",
  "repository_ruleset",
  "environment",
  // Who holds access: members, collaborators, teams and roles.
  "org.add_member",
  "org.invite_member",
  "org.update_member",
  "org.add_outside_collaborator",
  "org.add_billing_manager",
  "repo.add_member",
  "repo.update_member",
  "team",
  "organization_role",
  "role",
  // Credentials, integrations and runners that act on the org's behalf.
  "public_key",
  "hook",
  "integration",
  "integration_installation",
  "integration_installation_request",
  "oauth_application",
  "org.oauth_app_access_approved",
  "org.disable_oauth_app_restrictions",
  "personal_access_token",
  "org_credential_authorization",
  "org.register_self_hosted_runner",
  "org.configure_self_hosted_jit_runner",
  "repo.register_self_hosted_runner",
  "repo.configure_self_hosted_jit_runner",
  // The org's own security settings.
  "org.disable_two_factor_requirement",
  "org.disable_saml",
  "org.recovery_code_used",
  "org.update_default_repository_permission",
  "org.audit_log_export",
  "org.audit_log_git_event_export",
  "org.transfer",
  "org.transfer_outgoing",
  "ip_allow_list",
  "ip_allow_list_entry",
  "secret_scanning_push_protection",
  "repository_secret_scanning_push_protection",
  "repository_secret_scanning",
  "org.secret_scanning_push_protection_disable",
  "org_secret_scanning_push_protection_bypass_list",
  // Repositories appearing, leaving or going public, and workflows switched off, this one included.
  "repo.create",
  "repo.destroy",
  "repo.access",
  "repo.transfer",
  "repo.transfer_outgoing",
  "workflows.disable_workflow",
];

/** Whether an audit-log action alerts. */
export const isWatched = (action) => watched.some((entry) => action === entry || action.startsWith(`${entry}.`));

/** The audit-log search reading the watched actions since an ISO 8601 instant; GitHub ORs one qualifier's values. */
export const phrase = (since) => [`created:>=${since}`, ...watched.map((entry) => `action:${entry}`)].join(" ");

/** A field's text for a rule: a list joins its sorted values with commas, a missing field is empty. */
export function text(value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(text).sort().join(",");
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Whether an ignore rule holds a reason, at least one field pattern, and only strings. */
function validRule(rule) {
  const patterns = Object.entries(rule ?? {}).filter(([field]) => field !== "reason");
  return (
    rule?.constructor === Object &&
    typeof rule.reason === "string" &&
    rule.reason !== "" &&
    patterns.length > 0 &&
    patterns.every(([, pattern]) => typeof pattern === "string")
  );
}

/** Parses the ignore rules, refusing a rule without a reason or without a pattern. */
export function parseRules(json) {
  const rules = JSON.parse(json);
  if (!Array.isArray(rules) || !rules.every(validRule))
    throw new Error("ignore must list rules holding a reason and at least one string pattern.");
  return rules.map(({ reason, ...fields }) => ({
    reason,
    patterns: Object.entries(fields).map(([field, pattern]) => [field, new RegExp(pattern)]),
  }));
}

/**
 * Splits the window's entries into alerts, the watched entries no rule hides, and counts what each
 * rule hid. An entry takes the first rule whose every pattern matches its field's text.
 */
export function select(entries, rules) {
  const hidden = rules.map(() => 0);
  const alerts = [];
  for (const entry of entries) {
    if (!isWatched(entry.action)) continue;
    const rule = rules.findIndex(({ patterns }) =>
      patterns.every(([field, pattern]) => pattern.test(text(entry[field])))
    );
    if (rule >= 0) hidden[rule] += 1;
    else alerts.push(entry);
  }
  return { alerts, rules: rules.map(({ reason }, i) => ({ reason, hidden: hidden[i] })) };
}

// The fields naming an alert's target, in display order. The audit log keeps the rest.
const targets = [
  "branch",
  "overridden_codes",
  "user",
  "team",
  "name",
  "user_programmatic_access_name",
  "environment_name",
  "ruleset_name",
  "ruleset_enforcement",
  "key",
  "permission",
  "visibility",
];

// Browser and system names by the token that gives each away. A browser's agent also names the
// browsers it imitates, and a phone's names the desktop system it builds on, so each list runs from
// the most specific token.
const browsers = [
  ["Edg/", "Edge"],
  ["OPR/", "Opera"],
  ["Firefox/", "Firefox"],
  ["CriOS/", "Chrome"],
  ["Chrome/", "Chrome"],
  ["Safari/", "Safari"],
];
const systems = [
  ["Android", "Android"],
  ["iPhone", "iOS"],
  ["iPad", "iOS"],
  ["Windows", "Windows"],
  ["CrOS", "ChromeOS"],
  ["Mac OS X", "macOS"],
  ["Linux", "Linux"],
];
// The HTTP libraries and tools scripts reach the API with, wherever the agent names them.
const tools =
  /\b(?:Go-http-client|python-requests|python-httpx|aiohttp|curl|Wget|okhttp|axios|node-fetch|undici|PyGithub|go-github|octokit[\w.-]*)\/[\w.+-]+/i;

/**
 * A short label for a user agent, which tells a person in a browser from a token in a script. A
 * browser reads as itself and its system, and anything else as the GitHub CLI, a known library or
 * the agent's first product token. The client sets its agent, so a label copies at most 60
 * product-token characters from it.
 */
export function agent(userAgent) {
  if (!userAgent) return "";
  const browser = userAgent.startsWith("Mozilla/") && browsers.find(([token]) => userAgent.includes(token));
  if (browser) {
    const system = systems.find(([token]) => userAgent.includes(token));
    return system ? `${browser[1]} on ${system[1]}` : browser[1];
  }
  const label =
    userAgent.match(/^GitHub CLI v?[\w.+-]+/) ?? userAgent.match(tools) ?? userAgent.match(/^[\w.+-]+(?:\/[\w.+-]+)?/);
  return label?.[0].slice(0, 60) ?? "unrecognized agent";
}

const time = (entry) => new Date(entry["@timestamp"]).toISOString().slice(0, 16).replace("T", " ") + "Z";
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const code = (value) => `\`${value.replaceAll("`", "'")}\``;

/** One alert group's two post lines: what happened, by whom, to what; then where, when and how. */
function groupLines({ entries }) {
  const [first] = entries;
  const target = targets.map((field) => text(first[field]).replaceAll(",", ", ")).filter(Boolean);
  const repos = [...new Set(entries.map((entry) => entry.repo).filter(Boolean))].sort();
  const where = repos.map((repo) => `[${repo.split("/")[1]}](https://github.com/${repo})`).join(", ");
  const how = [first.programmatic_access_type, agent(first.user_agent)].filter(Boolean).join(" · ");
  return [
    [`**${first.action}**`, code(first.actor ?? "unknown actor"), ...target.map(code)].join(" · "),
    `-# ${[where, entries.map(time).sort()[0], how].filter(Boolean).join(" · ")}`,
  ];
}

/**
 * Groups the fresh alerts that share an action, an actor and a target, such as one change made in
 * several repositories, so a burst reads as one line.
 */
export function groups(alerts) {
  const byKey = new Map();
  for (const entry of alerts) {
    const key = JSON.stringify([entry.action, entry.actor, ...targets.map((field) => text(entry[field]))]);
    byKey.set(key, [...(byKey.get(key) ?? []), entry]);
  }
  return [...byKey.values()].map((entries) => ({ entries }));
}

/** The Discord post: a title, then two lines per group of fresh alerts. */
export function post(org, fresh, rules) {
  const hidden = rules.reduce((sum, rule) => sum + rule.hidden, 0);
  return {
    count: fresh.length,
    title: `${plural(fresh.length, "audit-log alert")} in ${org}`,
    url: `https://github.com/organizations/${org}/settings/audit-log`,
    footer: hidden === 0 ? "" : `${hidden} routine entries hidden by ignore rules`,
    description: groups(fresh).flatMap(groupLines).join("\n"),
  };
}

const cell = (value) => value.replaceAll("|", "\\|").replaceAll("\n", " ");

/**
 * The step summary: the window, the counts, and what each rule hid. A public repository's run
 * summary is public, so the alerts themselves reach only Discord.
 */
export function summary({ since, read, alerts, fresh, rules }) {
  const lines = [`Audit-log entries since ${since}: ${read} read, ${alerts} alerting, ${fresh} not posted before.`, ""];
  if (rules.length > 0) {
    lines.push("| Ignore rule | Hidden |", "| --- | --- |");
    for (const { reason, hidden } of rules) lines.push(`| ${cell(reason)} | ${hidden || "0, matched nothing"} |`);
    lines.push("");
  }
  return lines.join("\n");
}

function gh(args, token) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: token },
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

const iso = (time) => new Date(time).toISOString().replace(/\.\d{3}Z$/, "+00:00");

/** The alert ids a run recorded, or none when its artifact is gone. */
function readSeen(run, repository, token, dir) {
  try {
    gh(["run", "download", String(run), "--repo", repository, "--name", artifact, "--dir", dir], token);
    return new Set(JSON.parse(readFileSync(join(dir, "seen.json"), "utf8")));
  } catch {
    console.log(`::warning::Run ${run} left no ${artifact} artifact; alerts it posted may post again.`);
    return new Set();
  }
}

function main() {
  const { CALLER, IGNORE, GITHUB_TOKEN, AUDIT_TOKEN, GITHUB_REPOSITORY, GITHUB_REPOSITORY_OWNER } = process.env;
  const { RUNNER_TEMP, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY } = process.env;
  const rules = parseRules(IGNORE);

  // The window opens an overlap before the previous successful run's creation, or before now on a
  // first run, and stays open to the present.
  const workflow = CALLER.split("@")[0].split("/").at(-1);
  const list = ["run", "list", "--repo", GITHUB_REPOSITORY, "--workflow", workflow, "--status", "success"];
  const [previous] = JSON.parse(gh([...list, "--limit", "1", "--json", "databaseId,createdAt"], GITHUB_TOKEN));
  const since = iso((previous ? Date.parse(previous.createdAt) : Date.now()) - overlap);
  const seen = previous
    ? readSeen(previous.databaseId, GITHUB_REPOSITORY, GITHUB_TOKEN, join(RUNNER_TEMP, "seen"))
    : new Set();

  const search = `orgs/${GITHUB_REPOSITORY_OWNER}/audit-log?per_page=100&phrase=${encodeURIComponent(phrase(since))}`;
  const entries = JSON.parse(gh(["api", "--paginate", "--slurp", search], AUDIT_TOKEN)).flat();
  const { alerts, rules: hits } = select(entries, rules);
  const fresh = alerts.filter((entry) => !seen.has(entry._document_id));

  const dir = join(RUNNER_TEMP, artifact);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "seen.json"), JSON.stringify(alerts.map((entry) => entry._document_id)));
  appendFileSync(
    GITHUB_STEP_SUMMARY,
    summary({ since, read: entries.length, alerts: alerts.length, fresh: fresh.length, rules: hits })
  );
  const { count, title, url, footer, description } = post(GITHUB_REPOSITORY_OWNER, fresh, hits);
  const delimiter = `EOF_${randomBytes(8).toString("hex")}`;
  appendFileSync(
    GITHUB_OUTPUT,
    `count=${count}\ntitle=${title}\nurl=${url}\nfooter=${footer}\nseen=${dir}\n` +
      `description<<${delimiter}\n${description}\n${delimiter}\n`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
