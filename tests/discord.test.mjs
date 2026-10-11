import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { step, succeeds, workspace } from "./helpers.mjs";

const post = step("generic-actions/discord-post/action.yaml", "post");

/** A workspace whose curl answers each call with the next status in CODES and logs the payload. */
function discord(t) {
  const w = workspace(t);
  w.stub(
    "curl",
    `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.appendFileSync('posts', args[args.indexOf('--data') + 1] + '\\n');
    const calls = fs.readFileSync('posts', 'utf8').trimEnd().split('\\n').length;
    process.stdout.write(process.env.CODES.split(',')[calls - 1]);
  `
  );
  w.stub("sleep", "");
  const run = (env) =>
    w.bash(post, {
      WEBHOOK: "https://discord.invalid/api/webhooks/1/token",
      TITLE: "master CI failed in a-novel/infra",
      URL: "https://github.com/a-novel/infra/actions/runs/1",
      DESCRIPTION: "",
      COLOR: "failed",
      FOOTER: "",
      MENTION_ROLES: "",
      MENTION_USERS: "",
      DRY_RUN: "false",
      CODES: "204",
      ...env,
    });
  const posts = () => (existsSync(join(w.cwd, "posts")) ? w.read("posts").trimEnd().split("\n").map(JSON.parse) : []);
  const delivered = () =>
    w
      .read("output")
      .match(/^delivered=(.*)$/gm)
      .at(-1);
  return { w, run, posts, delivered };
}

test("discord-post pings exactly the ids it is given and repeats the title for push notifications", (t) => {
  const { run, posts, delivered } = discord(t);
  succeeds(
    run({
      MENTION_ROLES: "11, 22",
      MENTION_USERS: "33",
      DESCRIPTION: "fix by <@&99> @everyone",
      FOOTER: "a-novel/infra",
    })
  );
  assert.deepEqual(posts(), [
    {
      embeds: [
        {
          title: "master CI failed in a-novel/infra",
          color: 15158332,
          url: "https://github.com/a-novel/infra/actions/runs/1",
          description: "fix by <@&99> @everyone",
          footer: { text: "a-novel/infra" },
        },
      ],
      allowed_mentions: { parse: [], roles: ["11", "22"], users: ["33"] },
      content: "<@&11> <@&22> <@33> master CI failed in a-novel/infra",
    },
  ]);
  assert.equal(delivered(), "delivered=true");
});

test("discord-post cuts a long description by character and links to the full text", (t) => {
  const { run, posts } = discord(t);
  succeeds(run({ DESCRIPTION: "é".repeat(5000), COLOR: "released" }));
  const [{ embeds, content }] = posts();
  const description = embeds[0].description;
  assert.equal([...description].length, 4096);
  assert.match(description, /^é+…\n\n\[Read more\]\(https:\/\/github\.com\/a-novel\/infra\/actions\/runs\/1\)$/);
  assert.equal(embeds[0].color, 10181046);
  assert.equal(content, undefined);
});

test("discord-post retries, then warns without failing the job", (t) => {
  for (const [codes, calls, outcome] of [
    ["500,429,204", 3, "delivered=true"],
    ["500,500,500", 3, "delivered=false"],
  ]) {
    const { run, posts, delivered } = discord(t);
    const result = run({ CODES: codes });
    succeeds(result);
    assert.equal(posts().length, calls, codes);
    assert.equal(delivered(), outcome, codes);
    assert.equal(result.stdout.includes("::warning::"), outcome === "delivered=false", codes);
  }
});

test("discord-post skips without a webhook or on a dry run, and rejects caller mistakes", (t) => {
  const { w, run, posts } = discord(t);
  assert.match(succeeds(run({ WEBHOOK: "" })), /::notice::No Discord webhook configured/);
  succeeds(run({ DRY_RUN: "true", MENTION_ROLES: "11" }));
  assert.match(w.read("summary"), /would post to Discord:[^]*"roles":\["11"\]/);
  assert.deepEqual(posts(), []);
  for (const env of [{ COLOR: "red" }, { MENTION_ROLES: "<@&11>" }, { MENTION_USERS: "kushuh" }]) {
    assert.equal(run(env).status, 1, JSON.stringify(env));
  }
  assert.deepEqual(posts(), []);
});
