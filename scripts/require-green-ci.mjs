#!/usr/bin/env node
// Release gate: a tag publishes only a commit that ci.yml passed on main.
//
// release.yml builds and publishes from the tag alone, so any tag on a red commit would
// ship it; the 0.9.47 bump landed on a main whose CI was failing. This waits while that commit's
// CI is queued or running and fails unless one push or manual run of it succeeded.
// Pull request runs test a merge commit, not this sha, so they do not count.
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/** "green" | "red" | "pending" for one commit's ci.yml runs, newest first. */
export function ciVerdict(runs, sha) {
  const own = runs.filter(
    (run) => run.head_sha === sha && (run.event === "push" || run.event === "workflow_dispatch"),
  );
  if (own.some((run) => run.conclusion === "success")) return "green";
  if (!own.length || own.some((run) => run.status !== "completed")) return "pending";
  return "red";
}

async function main() {
  const { GITHUB_REPOSITORY: repo, GITHUB_TOKEN: token } = process.env,
    sha = process.argv[2] ?? process.env.GITHUB_SHA,
    deadline = Date.now() + Number(process.env.CI_WAIT_MINUTES ?? 60) * 60_000;
  if (!repo || !token || !sha)
    throw new Error("GITHUB_REPOSITORY, GITHUB_TOKEN and a sha are required");
  const url = `https://api.github.com/repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=50`;
  for (;;) {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status} listing ci.yml runs`);
    const { workflow_runs: runs } = await response.json(),
      verdict = ciVerdict(runs, sha);
    if (verdict === "green") return console.log(`ci.yml passed on ${sha}`);
    if (verdict === "red") {
      for (const run of runs) console.error(`  ${run.event} ${run.conclusion}: ${run.html_url}`);
      throw new Error(`ci.yml failed on ${sha}; fix main and tag a green commit`);
    }
    if (Date.now() > deadline) throw new Error(`ci.yml has not passed on ${sha} in time`);
    console.log(`waiting for ci.yml on ${sha}…`);
    await sleep(60_000);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(`::error title=Release gate::${error.message}`);
    process.exit(1);
  });
