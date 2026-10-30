#!/usr/bin/env bun
// Guard: every Bun test file in the checkout runs in some CI Bun process, and no single
// Bun process is handed more files than it can hold.
//
// WHY THIS EXISTS
// ---------------
// Shards are hand-written path lists. A file outside every list silently never runs in
// CI, and nothing reported it: splitting `rest` in 2026-10 had to be checked by hand.
// The opposite failure is worse to diagnose. Bun 1.3.11 keeps one resolver descriptor per
// path it resolved for the life of a `bun test` process; past a few thousand, late suites'
// spawns fail with EBADF (see the Hub panels and core plugins steps in ci.yml), although
// each suite passes alone. File count is only a proxy for that, so each shard has a
// budget: its size when last known to pass, plus headroom. A shard past its budget is not
// known to fail, only no longer known to pass. Split it, or raise the budget after a green
// CI run at the new size.
//
// Paths follow scripts/run-bun-test-shard.mjs: an existing path becomes `./path`, so it
// selects that file or subtree (not a substring), minus each --path-ignore-patterns glob.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
/** Files per shard, from its size on 2026-10-27 plus headroom (desktop 739, core-rest 451, core-engine 274, rest 376, rest-server 215). */
export const SHARD_BUDGETS: Record<string, number> = {
  // 2026-10-30: +2 for the panel identity cache and external output recovery
  // suites; the shard is at its ceiling, split it before raising this again.
  "tests (desktop)": 772,
  "tests (core-rest)": 470,
  "tests (core-engine)": 300,
  "tests (rest)": 400,
  "tests (rest-server)": 240,
  // 2026-10-29: replace the 34-file Panel process with 4–8-file partitions.
  "tests: test Hub Panel packages": 8,
  "tests: test Hub Panel runtime and scopes": 8,
  "tests: test Hub Panel native processes": 6,
  "tests: test Hub Panel tasks": 6,
  "tests: test Hub Panel resources and files": 10,
  "tests: test Hub Panel connections and automations": 6,
};
/** Any other Bun process is a step that isolates a few suites on purpose. */
export const DEFAULT_BUDGET = 60;
/** Renaming a Panel step must not silently restore the general 60-file budget. */
export const PANEL_PROCESS_BUDGET = 10;
const TEST_FILE = /(?:\.|_)(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
/** Run by their own runners rather than a Bun shard; the reason must stay true. */
const RUN_ELSEWHERE: Array<[RegExp, string]> = [
  // ci.yml selects these at run time: node:test suites under `node --test`, the rest with Bun.
  [/^packages\/desktop\/scripts\/[^/]+\.test\.mjs$/, "Desktop script suites step"],
  [/^scripts\/.+\.test\.mjs$/, "root script suites step (node:test)"],
  // Audit and review evidence: dated records of what was reproduced, not suites.
  [/^docs\//, "dated evidence, not a suite"],
];

/**
 * Suites that call Bun.build inside the test process and are known to pass where they run.
 * An in-process Bun.build shares the runner's resolver cache; two new ones (bfe3fbe87) made
 * later suites in their shards lose modules. New suites use tests/helpers/bundle-in-subprocess.ts.
 */
const IN_PROCESS_BUNDLERS = new Set([
  "packages/coding/src/lsp/client-lifecycle.test.ts",
  "packages/core/src/links/remote-providers.test.ts",
  "packages/core/src/panel-apps/runtime.browser-contract.test.ts",
  "packages/core/src/tool-system/builtin/repl.test.ts",
  "packages/desktop/src/main/cloud-management.test.ts",
  "packages/server/src/links/providers/providers.test.ts",
  "packages/server/src/mobile-remote/remote-host-manager.native.test.ts",
  "packages/server/src/project-runtime/cloud-browser-native.test.ts",
  "packages/server/src/project-runtime/control-shutdown.integration.test.ts",
  "packages/server/src/project-runtime/proxy.integration.test.ts",
  "packages/server/src/project-runtime/restore-durability.test.ts",
  "packages/server/src/remote-relay/relay.native.test.ts",
  "tests/plugins-installer-symlinks.test.ts",
]);

/** Shard test files that bundle in-process without being one of the known suites. */
export function newInProcessBundlers(files: string[], read: (file: string) => string): string[] {
  return files.filter(
    (file) =>
      !file.startsWith("docs/") &&
      !IN_PROCESS_BUNDLERS.has(file) &&
      read(file).includes("Bun.build("),
  );
}

interface Process {
  label: string;
  paths: string[];
  ignores: string[];
}

function words(value: string): string[] {
  return value.match(/'[^']*'|"[^"]*"|\S+/g)?.map((word) => word.replace(/^['"]|['"]$/g, "")) ?? [];
}

/** One Bun process per run-bun-test-shard.mjs invocation in the workflow. */
export function workflowProcesses(workflow: any): Process[] {
  const processes: Process[] = [];
  for (const [jobName, job] of Object.entries<any>(workflow.jobs ?? {})) {
    const include: any[] = job.strategy?.matrix?.include ?? [];
    for (const step of job.steps ?? []) {
      const run: string = step.run ?? "";
      for (const line of run.split("\n")) {
        const at = line.indexOf("run-bun-test-shard.mjs");
        if (at < 0) continue;
        const raw = line.slice(at + "run-bun-test-shard.mjs".length).replace(/`$/, "");
        const variants = raw.includes("${{ matrix.")
          ? include.map((entry) => ({
              label: `${jobName} (${entry.shard ?? JSON.stringify(entry)})`,
              text: raw
                .replace("${{ matrix.ignore }}", entry.ignore ?? "")
                .replace("${{ matrix.paths }}", entry.paths ?? ""),
            }))
          : [{ label: `${jobName}: ${step.name ?? "step"}`, text: raw }];
        for (const variant of variants) {
          const parts = words(variant.text),
            paths: string[] = [],
            ignores: string[] = [];
          for (let index = 0; index < parts.length; index++) {
            const part = parts[index]!;
            if (part === "--path-ignore-patterns") ignores.push(parts[++index]!);
            else if (part === "--timeout") index++;
            else if (!part.startsWith("-") && !part.startsWith("$"))
              paths.push(part.replace(/^\.\//, ""));
          }
          if (paths.length) processes.push({ label: variant.label, paths, ignores });
        }
      }
    }
  }
  return processes;
}

export function selects(process: Process, file: string): boolean {
  const under = process.paths.some(
    (path) => file === path || file.startsWith(`${path.replace(/\/$/, "")}/`),
  );
  return under && !process.ignores.some((pattern) => new Bun.Glob(pattern).match(file));
}

export function checkShards(files: string[], processes: Process[], budgets = SHARD_BUDGETS) {
  const counts = processes.map((process) => {
    const selected = files.filter((file) => selects(process, file));
    const hasPanels = selected.some((file) => file.startsWith("packages/server/src/panels/"));
    return {
      label: process.label,
      files: selected.length,
      budget: Math.min(
        budgets[process.label] ?? DEFAULT_BUDGET,
        hasPanels ? PANEL_PROCESS_BUDGET : Infinity,
      ),
    };
  });
  const uncovered = files.filter(
    (file) =>
      !processes.some((process) => selects(process, file)) &&
      !RUN_ELSEWHERE.some(([pattern]) => pattern.test(file)),
  );
  const oversized = counts.filter((count) => count.files > count.budget);
  // These partitions replace one complete directory invocation. A stale broad
  // selection or overlapping resource subtree must not run a Panel suite twice.
  // Other packages intentionally repeat selected files on Windows.
  const overlappingPanels = files
    .filter((file) => file.startsWith("packages/server/src/panels/"))
    .map((file) => ({
      file,
      processes: processes.filter((process) => selects(process, file)).map(({ label }) => label),
    }))
    .filter(({ processes }) => processes.length > 1);
  return { counts, uncovered, oversized, overlappingPanels };
}

if (import.meta.main) {
  const workflowFile = resolve(ROOT, ".github/workflows/ci.yml");
  const workflow = Bun.YAML.parse(readFileSync(workflowFile, "utf8"));
  const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((file) => TEST_FILE.test(file) && !file.includes("/node_modules/"));
  const { counts, uncovered, oversized, overlappingPanels } = checkShards(
    files,
    workflowProcesses(workflow),
  );
  for (const count of [...counts].sort((a, b) => b.files - a.files))
    console.log(
      `${String(count.files).padStart(5)} / ${String(count.budget).padEnd(4)} ${count.label}`,
    );
  let failed = false;
  if (uncovered.length) {
    failed = true;
    console.error(`\n✗ ${uncovered.length} test files run in no CI Bun process:`);
    for (const file of uncovered) console.error(`  ${file}`);
  }
  if (oversized.length) {
    failed = true;
    console.error(
      "\n✗ Bun processes past their budget; split them, or raise the budget after a green run:",
    );
    for (const count of oversized)
      console.error(`  ${count.files} > ${count.budget}  ${count.label}`);
  }
  if (overlappingPanels.length) {
    failed = true;
    console.error("\n✗ Panel partitions must select every suite exactly once:");
    for (const item of overlappingPanels)
      console.error(`  ${item.file}: ${item.processes.join(", ")}`);
  }
  const bundlers = newInProcessBundlers(files, (file) => readFileSync(resolve(ROOT, file), "utf8"));
  if (bundlers.length) {
    failed = true;
    console.error(
      "\n✗ Bun.build inside a test process; use tests/helpers/bundle-in-subprocess.ts:",
    );
    for (const file of bundlers) console.error(`  ${file}`);
  }
  if (failed) process.exit(1);
  console.log(
    `\n✓ ${files.length} test files covered; largest process ${Math.max(...counts.map((c) => c.files))} files`,
  );
}
