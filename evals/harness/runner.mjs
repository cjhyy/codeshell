import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadModelConnection, publicModel } from "./model-config.mjs";
import { createProviderProxy, redact } from "./provider-proxy.mjs";
import { renderMarkdownReport, summarizeResults } from "./report.mjs";
import { judgeResult } from "./judge.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function parseArgs(args) {
  const parsed = {};
  const flags = new Set(["live", "list", "validate", "help", "judge"]);
  const values = new Set([
    "executable",
    "connection",
    "cases",
    "trials",
    "seed",
    "output",
    "max-requests",
    "max-output-tokens",
    "max-reported-cost-usd",
    "timeout-ms",
  ]);
  for (let i = 0; i < args.length; i++) {
    const name = args[i].replace(/^--/, "");
    if (!args[i].startsWith("--") || !(flags.has(name) || values.has(name)))
      throw new Error(`Unknown option: ${args[i]}`);
    if (name in parsed) throw new Error(`Duplicate option: --${name}`);
    if (flags.has(name)) parsed[name] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Missing value: --${name}`);
      parsed[name] = args[++i];
    }
  }
  for (const [name, fallback, max] of [
    ["trials", 1, 10],
    ["max-requests", 30, 500],
    ["max-output-tokens", 4096, 32768],
    ["timeout-ms", 180000, 900000],
  ]) {
    parsed[name] = Number(parsed[name] ?? fallback);
    if (!Number.isInteger(parsed[name]) || parsed[name] < 1 || parsed[name] > max)
      throw new Error(`Invalid --${name}`);
  }
  parsed["max-reported-cost-usd"] = Number(parsed["max-reported-cost-usd"] ?? 3);
  if (!Number.isFinite(parsed["max-reported-cost-usd"]) || parsed["max-reported-cost-usd"] <= 0)
    throw new Error("Invalid reported cost stop threshold");
  return parsed;
}

export async function validateSuite(suite) {
  if (suite.schemaVersion !== 1 || !Array.isArray(suite.cases) || !suite.cases.length)
    throw new Error("Invalid suite");
  const ids = new Set();
  for (const item of suite.cases) {
    if (!/^[a-z0-9-]+$/.test(item.id) || ids.has(item.id))
      throw new Error("Invalid or duplicate case id");
    ids.add(item.id);
    if (!(item.version > 0) || !item.hardAssertions?.length || !item.provenance?.fixCommits?.length)
      throw new Error(`Incomplete case ${item.id}`);
    if (
      new Set(item.hardAssertions.map((assertion) => assertion.id)).size !==
      item.hardAssertions.length
    )
      throw new Error(`Duplicate assertion in ${item.id}`);
    for (const path of item.repositoryRegression ?? []) {
      if (isAbsolute(path) || path.split(/[\\/]/).includes(".."))
        throw new Error("Regression path escapes repository");
      await access(join(root, path));
    }
    for (const artifact of item.provenance.artifacts ?? [])
      if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error("Invalid evidence digest");
  }
  return suite;
}

export function runSucceeded(results, { judge = false, appUnchanged = true } = {}) {
  return (
    appUnchanged &&
    results.length > 0 &&
    results.every(
      (result) =>
        result.executionStatus === "passed" &&
        result.hardAssertions?.length > 0 &&
        result.hardAssertions.every((assertion) => assertion.passed === true) &&
        result.semantic?.status !== "failed" &&
        (!judge || ["passed", "not_applicable"].includes(result.semantic?.status)),
    )
  );
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help || !args.length) {
    console.log(
      "Usage: bun run evals:list | bun run evals:validate | bun run evals:live --executable PATH [--connection ID] [--cases ID,ID] [--trials 1] [--seed 20260912] [--judge]",
    );
    console.log(
      "Live runs use paid real requests. Defaults: 30 requests, 4096 output tokens/request, 180 seconds/case; stop starting requests after $3 of REPORTED cost. Missing usage means total cost is unknown.",
    );
    return;
  }
  const suiteBytes = await readFile(join(root, "evals/harness/cases.json"));
  const suite = await validateSuite(JSON.parse(suiteBytes));
  if (options.list) {
    console.log(suite.cases.map((item) => `${item.id}\t${item.adapter}\t${item.title}`).join("\n"));
    return;
  }
  if (options.validate && !options.live) {
    console.log(`Validated ${suite.cases.length} cases; no model calls.`);
    return;
  }
  if (!options.live) throw new Error("Use --live explicitly for model calls");
  if (!options.executable) throw new Error("Select a packaged executable with --executable");
  const executable = resolve(options.executable);
  await access(executable);
  const selectedIds =
    options.cases?.split(",") ??
    suite.cases.filter((item) => item.adapter === "desktop").map((item) => item.id);
  if (new Set(selectedIds).size !== selectedIds.length) throw new Error("Duplicate selected case");
  const selected = selectedIds.map((id) => {
    const item = suite.cases.find((entry) => entry.id === id);
    if (!item || item.adapter !== "desktop")
      throw new Error(`Case has no live desktop adapter: ${id}`);
    return item;
  });
  const loaded = await loadModelConnection({ connectionId: options.connection });
  const model = {
    ...loaded,
    maxOutputTokens: options["max-output-tokens"],
    maxContextTokens: loaded.preset?.maxContextTokens ?? 200000,
  };
  const runId = `live-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const output = resolve(options.output ?? join(root, "evals/runs", runId));
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length)
    throw new Error("Output directory must be empty (previous trials are immutable)");
  const asarPath = join(dirname(executable), "../Resources/app.asar");
  const app = {
    executable,
    sha256: sha(await readFile(asarPath)),
    executableSha256: sha(await readFile(executable)),
  };
  const budget = {
    maxRequests: options["max-requests"],
    maxOutputTokens: options["max-output-tokens"],
    maxReportedCostUsd: options["max-reported-cost-usd"],
    requestTimeoutMs: Math.min(options["timeout-ms"], 120000),
  };
  const harnessFiles = (await readdir(join(root, "evals/harness")))
    .filter((file) => file.endsWith(".mjs") || file === "cases.json")
    .sort();
  const harnessHashes = Object.fromEntries(
    await Promise.all(
      harnessFiles.map(async (file) => [
        file,
        sha(await readFile(join(root, "evals/harness", file))),
      ]),
    ),
  );
  const run = {
    id: runId,
    startedAt: new Date().toISOString(),
    fixtureSeed: options.seed ?? "20260912",
    suiteVersion: suite.suiteVersion,
    suiteSha256: sha(suiteBytes),
    model: publicModel(model),
    budget,
    app,
    harnessHashes,
    semanticJudge: options.judge ? "same selected live model; advisory" : "disabled",
    trialsPerCase: options.trials,
    selectedCaseIds: selectedIds,
    sampling:
      "provider default; selected connection parameters; fixture seed is not a provider sampling seed",
    source: {
      head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      dirty: !!execFileSync("git", ["status", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      appSource:
        "identified independently by packaged ASAR hash; current checkout is not asserted to equal this app",
    },
    limitations: [
      "Small pilot; not a statistical reliability estimate",
      "Reported-cost threshold cannot cap charges whose usage the provider omits",
      "Controlled pause only changes delivery timing of real model bytes",
      "Auxiliary and retry requests are included in request budget",
    ],
  };
  const results = [];
  const { runDesktopCase } = await import("./desktop.mjs");
  const proxy = await createProviderProxy({ model, budget });
  const safe = (value) => redact(value, [model.apiKey, proxy.apiKey]);
  const checkpoint = async () => {
    await writeFile(
      join(output, "results.json"),
      JSON.stringify(safe({ run, results, summary: summarizeResults(results) }), null, 2),
      { mode: 0o600 },
    );
    await writeFile(join(output, "requests.json"), JSON.stringify(safe(proxy.requests), null, 2), {
      mode: 0o600,
    });
    await writeFile(
      join(output, "REPORT.md"),
      renderMarkdownReport({ run: safe(run), results: safe(results), cases: suite.cases }),
    );
  };
  console.log(
    `Run ${runId}: ${selected.length} cases × ${options.trials} trial(s), ${model.model}. Output: ${output}`,
  );
  try {
    for (let trial = 1; trial <= options.trials; trial++)
      for (const item of selected) {
        const offset = proxy.requests.length;
        const caseOutput = join(output, `${item.id}-trial-${trial}`);
        let result;
        console.log(`START ${item.id} trial ${trial}`);
        try {
          result = await runDesktopCase({
            caseId: item.id,
            trial,
            seed: run.fixtureSeed,
            executable,
            output: caseOutput,
            model,
            proxy,
            timeoutMs: options["timeout-ms"],
          });
        } catch (error) {
          result = {
            caseId: item.id,
            trial,
            executionStatus: "inconclusive",
            hardAssertions: [],
            semantic: { status: "not_evaluated" },
            evidenceLevel: "packaged_live_llm",
            reason: `adapter_error: ${safe(String(error.message))}`,
          };
        }
        for (const request of proxy.requests.slice(offset)) request.role = "application";
        const applicationRequests = proxy.requests.slice(offset);
        result.model = {
          ...publicModel(model),
          responseModel:
            [
              ...new Set(applicationRequests.flatMap((request) => request.responseModels ?? [])),
            ].join(", ") || null,
        };
        result.fixtureSeed = run.fixtureSeed;
        const actualAssertions = new Map(
          (result.hardAssertions ?? []).map((assertion) => [assertion.id, assertion]),
        );
        result.hardAssertions = item.hardAssertions.map(
          (assertion) =>
            actualAssertions.get(assertion.id) ?? {
              id: assertion.id,
              passed: null,
              detail: `Required evidence not reported: ${assertion.criterion}`,
            },
        );
        for (const assertion of actualAssertions.values()) {
          if (!result.hardAssertions.some((item) => item.id === assertion.id))
            result.hardAssertions.push(assertion);
        }
        if (
          result.executionStatus === "passed" &&
          result.hardAssertions.some((assertion) => assertion.passed !== true)
        ) {
          result.executionStatus = result.hardAssertions.some(
            (assertion) => assertion.passed === false,
          )
            ? "failed"
            : "inconclusive";
          result.reason ??= "Required hard assertions are failed or missing evidence";
        }
        result.artifacts = {
          ...(result.artifacts ?? {}),
          directory: relative(output, caseOutput),
          requests: "requests.json",
        };
        const hasRealOutput = applicationRequests.some(
          (request) =>
            request.role === "application" &&
            request.status >= 200 &&
            request.status < 300 &&
            request.events?.some((event) =>
              event.choices?.some(
                (choice) =>
                  choice.delta?.content ||
                  choice.delta?.tool_calls ||
                  choice.message?.content ||
                  choice.message?.tool_calls,
              ),
            ),
        );
        if (!hasRealOutput && result.executionStatus === "passed") {
          result.executionStatus = "inconclusive";
          result.reason = "No successful real model output captured";
        }
        if (options.judge)
          result.semantic = await judgeResult({ result, definition: item, model, proxy });
        const requests = proxy.requests.slice(offset);
        result.requests = safe(
          requests.map((request) => ({
            id: request.id,
            role: request.role,
            model: request.responseModels?.join(", ") || null,
            status: request.status,
            aborted: request.aborted,
            usage: request.usage,
            durationMs: request.durationMs,
          })),
        );
        results.push(result);
        await checkpoint();
        console.log(
          `END ${item.id} trial ${trial}: ${result.executionStatus}${result.reason ? ` (${result.reason})` : ""}; ${requests.length} requests`,
        );
      }
  } finally {
    await proxy.close();
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
    run.appUnchanged = sha(await readFile(asarPath)) === app.sha256;
    await checkpoint();
  }
  if (!runSucceeded(results, { judge: options.judge, appUnchanged: run.appUnchanged }))
    process.exitCode = 1;
  console.log(`Report: ${join(output, "REPORT.md")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
