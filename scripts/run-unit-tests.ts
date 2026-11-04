#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { workflowProcesses } from "./check-test-shards";
import { runBunTestShard } from "./bun-test-completion.mjs";

export function localTestPlan(workflow: any) {
  // Reuse the Linux CI partitions and isolated SDK boundary. Platform smoke
  // jobs have their own commands; running them again here would duplicate suites.
  return workflowProcesses({
    jobs: Object.fromEntries(
      ["typecheck", "tests"]
        .filter((name) => workflow.jobs?.[name])
        .map((name) => [name, workflow.jobs[name]]),
    ),
  }).map((group) => ({
    label: group.label,
    args: [
      "--timeout",
      "30000",
      ...group.ignores.flatMap((pattern) => ["--path-ignore-patterns", pattern]),
      ...group.paths,
    ],
  }));
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const args = process.argv.slice(2);
  if (
    args.length &&
    !(args.length === 1 && args[0] === "--list") &&
    !(args.length === 2 && args[0] === "--shard" && /^\d+$/.test(args[1]!))
  )
    throw new Error("usage: bun run test [--list | --shard <index>]");
  const plan = localTestPlan(
    Bun.YAML.parse(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8")),
  );
  // CI classifies these dynamic script suites by their declared runner.
  const scripts = execFileSync(
    "git",
    ["ls-files", "packages/desktop/scripts/*.test.mjs", "scripts/*.test.mjs"],
    { cwd: root, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const nodeScripts = scripts.filter((file) =>
    readFileSync(resolve(root, file), "utf8").includes('from "node:test"'),
  );
  const bunScripts = scripts.filter(
    (file) => file.startsWith("packages/desktop/") && !nodeScripts.includes(file),
  );
  if (bunScripts.length)
    plan.push({ label: "Desktop Bun script suites", args: ["--timeout", "30000", ...bunScripts] });
  const nodeIndex = plan.length;
  if (args[0] === "--list") {
    plan.forEach((group, index) => console.log(`${index}: ${group.label}`));
    if (nodeScripts.length) console.log(`${nodeIndex}: isolated Node script suites`);
  } else {
    const selected = args[0] === "--shard" ? Number(args[1]) : undefined;
    if (selected !== undefined && selected >= plan.length + (nodeScripts.length ? 1 : 0))
      throw new Error("unknown shard index; use --list");
    const failures: string[] = [];
    for (const [index, group] of plan.entries()) {
      if (selected !== undefined && selected !== index) continue;
      console.log(`\n[${index}] ${group.label}`);
      try {
        await runBunTestShard(group.args, { cwd: root });
      } catch (error) {
        failures.push(`${group.label}: ${error}`);
      }
    }
    if (nodeScripts.length && (selected === undefined || selected === nodeIndex)) {
      const code = await new Promise<number | null>((done, reject) => {
        const child = spawn(
          "node",
          [resolve(root, "scripts/run-isolated-node-smoke.mjs"), "--test", ...nodeScripts],
          { cwd: root, stdio: "inherit" },
        );
        child.once("error", reject);
        child.once("close", done);
      });
      if (code !== 0) failures.push(`Node script suites: exit ${code}`);
    }
    if (failures.length) throw new Error(failures.join("\n"));
  }
}
