#!/usr/bin/env node
// Synthetic prerequisite probe. Importing this module or running without --live is offline.
import { request as httpsRequest } from "node:https";
import { readFile, writeFile, mkdir, readdir, lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LIMITS = Object.freeze({
  endpoint: "https://openrouter.ai/api/v1/messages",
  model: "anthropic/claude-sonnet-5",
  credentialId: "openrouter-key",
  requests: 8,
  plannedRequests: 7,
  outputTokens: 256,
  bodyBytes: 25_000,
  responseBytes: 65_536,
  overheadTokens: 4_096,
  inputUsdPerMillion: 8,
  outputUsdPerMillion: 50,
  budgetUsd: 2,
});
export const MAX_REQUEST_USD =
  ((LIMITS.bodyBytes + LIMITS.overheadTokens) * LIMITS.inputUsdPerMillion +
    LIMITS.outputTokens * LIMITS.outputUsdPerMillion) /
  1_000_000;
const MARKER = { type: "ephemeral" };
const ROUTING = {
  only: ["anthropic"],
  allow_fallbacks: false,
  max_price: { prompt: 4, completion: 50, request: 0 },
};
const TARGET = "Synthetic17";
const STAGES = [
  "baseline-search-only",
  "baseline-eager-24",
  "baseline-deferred-24",
  "native-search",
  "native-reference",
  "native-synthetic-result",
  "native-cache-repeat",
];
const SOURCES = [
  "https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool",
  "https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching",
  "https://platform.claude.com/docs/en/release-notes/overview#february-17-2026",
  "https://openrouter.ai/docs/guides/features/server-tools/tool-search#client-side-tool-search",
  "https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message",
  "https://openrouter.ai/docs/guides/routing/provider-selection#max-price",
];
const MANUAL = Array.from(
  { length: 80 },
  (_, index) =>
    "Synthetic record " +
    String(index).padStart(3, "0") +
    ": keep the supplied tag unchanged, " +
    "confirm the simulated receipt, and finish. This example does not operate on any real resource.",
).join("\n");

export function parseArgs(args) {
  const options = { live: false, authorized: false, budgetUsd: 2, maxRequests: 8 };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error("Duplicate option: " + flag);
    seen.add(flag);
    if (flag === "--live") options.live = true;
    else if (flag === "--authorized-paid-probe") options.authorized = true;
    else if (flag === "--dry-run") options.dryRun = true;
    else if (["--budget-usd", "--max-requests", "--output-dir"].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error("Missing value for " + flag);
      if (flag === "--output-dir") options.outputDir = value;
      else options[flag === "--budget-usd" ? "budgetUsd" : "maxRequests"] = Number(value);
    } else throw new Error("Unknown option: " + flag);
  }
  if (options.live && options.dryRun) throw new Error("--live and --dry-run conflict");
  if (!Number.isFinite(options.budgetUsd) || options.budgetUsd <= 0 || options.budgetUsd > 2)
    throw new Error("Budget must be positive and no greater than USD 2");
  if (!Number.isInteger(options.maxRequests) || options.maxRequests < 7 || options.maxRequests > 8)
    throw new Error("Request cap must be 7 or 8");
  if (options.budgetUsd + 1e-9 < options.maxRequests * MAX_REQUEST_USD)
    throw new Error("Budget is below the conservative reservation for the request cap");
  if (
    options.live &&
    (!options.authorized || !seen.has("--budget-usd") || !seen.has("--max-requests"))
  )
    throw new Error("Live mode requires --authorized-paid-probe, --budget-usd and --max-requests");
  if (options.live && !options.outputDir) throw new Error("Live mode requires --output-dir");
  return options;
}

export function catalog(deferred = true, searchOnly = false) {
  const tools = [
    {
      name: "ToolSearch",
      description:
        "Synthetic discovery only. Select a named synthetic tool with query select:NAME.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  ];
  if (!searchOnly)
    for (let i = 0; i < 24; i++)
      tools.push({
        name: "Synthetic" + String(i).padStart(2, "0"),
        description:
          "Synthetic record " +
          i +
          ": accepts an inert tag, returns an inert receipt. " +
          "No files, network, credentials or external effects exist. ",
        input_schema: {
          type: "object",
          properties: {
            tag: {
              type: "string",
              enum: ["native-probe"],
              description:
                "The fixed synthetic test tag. It identifies a simulated operation only.",
            },
          },
          required: ["tag"],
          additionalProperties: false,
        },
        ...(deferred ? { defer_loading: true } : {}),
      });
  tools.findLast((tool) => !tool.defer_loading).cache_control = MARKER;
  return tools;
}

export function makeBody(tools, messages, nonce) {
  return {
    model: LIMITS.model,
    max_tokens: LIMITS.outputTokens,
    stream: false,
    thinking: { type: "disabled" },
    provider: ROUTING,
    system: [
      {
        type: "text",
        text:
          "Synthetic native tool discovery evaluation " +
          nonce +
          ". " +
          "Follow the user's exact stage instruction. All tools are inert simulation names. " +
          "Never call an unrequested tool. Do not use CallTool. Keep text under 20 words. " +
          "After a synthetic tool result, reply DONE and stop.\n" +
          MANUAL,
        cache_control: MARKER,
      },
    ],
    tools,
    messages,
  };
}

export function validateBody(body) {
  const serialized = JSON.stringify(body);
  if (body.model !== LIMITS.model || body.max_tokens !== 256 || body.stream !== false)
    throw new Error("Unexpected model, output limit or streaming setting");
  if (
    body.thinking?.type !== "disabled" ||
    JSON.stringify(body.provider) !== JSON.stringify(ROUTING) ||
    ["temperature", "top_p", "top_k", "fallbacks", "models"].some((name) => name in body)
  )
    throw new Error("Unexpected thinking, sampling or routing configuration");
  if (!/^[\x00-\x7f]*$/.test(serialized)) throw new Error("Probe request must be ASCII");
  if (Buffer.byteLength(serialized) > LIMITS.bodyBytes)
    throw new Error("Request body limit exceeded");
  const marked = body.tools.filter((tool) => tool.cache_control);
  if (marked.length !== 1 || marked[0] !== body.tools.findLast((tool) => !tool.defer_loading))
    throw new Error("Tool cache marker must be on the last non-deferred tool only");
  if (body.tools.some((tool) => tool.defer_loading && tool.cache_control))
    throw new Error("Deferred tool has a cache breakpoint");
  return serialized;
}

const counter = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
export function usageEvidence(response) {
  const usage = response?.usage ?? {};
  const input = counter(usage.input_tokens);
  const read = counter(usage.cache_read_input_tokens);
  const write = counter(usage.cache_creation_input_tokens);
  const output = counter(usage.output_tokens);
  const total = [input, read, write].includes(null) ? null : input + read + write;
  return {
    input,
    cacheRead: read,
    cacheWrite: write,
    output,
    totalInput: total,
    reportedCostUsd:
      typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0
        ? usage.cost
        : null,
  };
}

export async function loadCredential() {
  let settings;
  try {
    settings = JSON.parse(await readFile(resolve(homedir(), ".code-shell/settings.json"), "utf8"));
  } catch {
    throw new Error("Cannot read the configured settings credential");
  }
  const matches = Array.isArray(settings.credentials)
    ? settings.credentials.filter((item) => item?.id === LIMITS.credentialId)
    : [];
  const key = matches.length === 1 ? matches[0]?.apiKey : undefined;
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{8,4096}$/.test(key))
    throw new Error("The exact openrouter-key credential is missing or invalid");
  return key;
}

export function sendExact({ endpoint, key, body }) {
  if (endpoint !== LIMITS.endpoint) throw new Error("Endpoint is not the authorized exact URL");
  const payload = validateBody(body);
  return new Promise((resolveResponse, reject) => {
    const req = httpsRequest(
      endpoint,
      {
        method: "POST",
        agent: false,
        rejectUnauthorized: true,
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "Content-Length": Buffer.byteLength(payload),
        },
        // node:https does not follow redirects, retry, or use environment proxy credentials.
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > LIMITS.responseBytes) response.destroy(new Error("Response limit exceeded"));
          else chunks.push(chunk);
        });
        response.on("end", () =>
          resolveResponse({
            status: response.statusCode,
            headers: response.headers,
            rawBody: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", () =>
          reject(new Error("Bounded response failed; no retry was attempted")),
        );
      },
    );
    const deadline = setTimeout(() => req.destroy(new Error("Request timeout")), 60_000);
    req.once("close", () => clearTimeout(deadline));
    req.on("error", () => reject(new Error("Request failed; no retry was attempted")));
    req.end(payload);
  });
}

const inside = (path, root) => path === root || path.startsWith(root + sep);
export async function prepareEvidence(outputDir) {
  if (!isAbsolute(outputDir)) throw new Error("Evidence directory must be absolute");
  const destination = resolve(outputDir);
  const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));
  const parent = await realpath(dirname(destination));
  const canonical = resolve(parent, relative(dirname(destination), destination));
  if (inside(canonical, root) || inside(canonical, resolve(homedir(), ".code-shell")))
    throw new Error(
      "Evidence directory must be disjoint from the repository and application state",
    );
  try {
    await mkdir(destination, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw new Error("Cannot create evidence directory");
  }
  const stat = await lstat(destination);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await readdir(destination)).length)
    throw new Error("Evidence directory must be an empty non-symlink directory");
  return destination;
}

function redact(value, key = "") {
  const json = JSON.stringify(
    value,
    (name, item) =>
      /^(authorization|x-api-key|apiKey|api_key|cookie|set-cookie)$/i.test(name)
        ? "[REDACTED]"
        : item,
    2,
  );
  return (key ? json.split(key).join("[REDACTED]") : json) + "\n";
}
const save = (directory, name, value, key) =>
  writeFile(resolve(directory, name), redact(value, key), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });

export function plan(options) {
  return {
    mode: options.live ? "live" : "dry-run",
    endpoint: LIMITS.endpoint,
    model: LIMITS.model,
    credential: "settings.json credentials[id=openrouter-key]; read only in live mode",
    limits: LIMITS,
    conservativeReservationUsd: options.maxRequests * MAX_REQUEST_USD,
    authorizedBudgetUsd: options.budgetUsd,
    requestCap: options.maxRequests,
    stages: STAGES,
    sources: SOURCES,
    costAssumption:
      "ASCII request bytes upper-bound prompt tokens plus 4096 server-overhead tokens; " +
      "$8/M input includes cache writes, $50/M output. This is a conservative reservation, not a provider quote.",
    acceptance:
      "Eager minus search-only >=1000 input tokens; deferred retains at most 10% of that " +
      "overhead (minimum tolerance 128 tokens); exact native target and tag; warm repeat reads cache.",
    safety:
      "Synthetic inputs only. No tools execute. No retries, redirects, endpoint overrides or " +
      "environment credential lookup. Missing usage stops the sequence and remains unknown.",
  };
}

function toolCall(response, name, expectedInput) {
  const calls = response.content?.filter((block) => block.type === "tool_use") ?? [];
  if (
    response.stop_reason !== "tool_use" ||
    calls.length !== 1 ||
    calls[0].name !== name ||
    typeof calls[0].id !== "string" ||
    !calls[0].id ||
    JSON.stringify(calls[0].input) !== JSON.stringify(expectedInput)
  )
    throw new Error("Expected exactly one native " + name + " call with the fixed synthetic input");
  return calls[0];
}
function noCall(response) {
  if (
    response.stop_reason !== "end_turn" ||
    !Array.isArray(response.content) ||
    response.content.some((block) => block.type === "tool_use" || block.type === "server_tool_use")
  )
    throw new Error("Expected a completed text response without tool execution");
}

export async function runProbe(options, dependencies = {}) {
  // Revalidate injected callers too, before reading credentials or opening a connection.
  const checked = parseArgs(
    options.live
      ? [
          "--live",
          "--authorized-paid-probe",
          "--budget-usd",
          String(options.budgetUsd),
          "--max-requests",
          String(options.maxRequests),
          "--output-dir",
          options.outputDir ?? "",
        ]
      : [],
  );
  if (options.live && !options.authorized)
    throw new Error("Explicit paid authorization is required");
  const configuration = { ...checked, ...options };
  const report = plan(configuration);
  const output = configuration.outputDir ? await prepareEvidence(configuration.outputDir) : null;
  if (output) {
    await save(output, "plan.json", report);
    if (!configuration.live)
      await save(output, "dry-run-request-templates.json", {
        baselineBodies: [catalog(false, true), catalog(false), catalog(true)].map((tools) =>
          makeBody(
            tools,
            [{ role: "user", content: "Do not call any tool. Reply READY only." }],
            "dry-run",
          ),
        ),
        continuations:
          "Live continuations use only actual response blocks and IDs. " +
          "ToolSearch receives tool_reference(Synthetic17); Synthetic17 receives an inert synthetic receipt.",
      });
  }
  if (!configuration.live) return report;
  const key = await (dependencies.loadCredential ?? loadCredential)();
  const transport = dependencies.transport ?? sendExact;
  const nonce = "probe-" + Date.now().toString(36);
  const records = [];
  let reservedUsd = 0;
  let actualReportedCostUsd = 0;
  const send = async (stage, body) => {
    validateBody(body);
    if (
      records.length >= configuration.maxRequests ||
      reservedUsd + MAX_REQUEST_USD > configuration.budgetUsd + 1e-9
    )
      throw new Error("Request or budget cap would be exceeded");
    reservedUsd += MAX_REQUEST_USD;
    const prefix = String(records.length + 1).padStart(2, "0") + "-" + stage;
    const record = { stage, reservedUsd: MAX_REQUEST_USD, usage: null };
    records.push(record);
    await save(
      output,
      prefix + "-request.json",
      {
        endpoint: LIMITS.endpoint,
        method: "POST",
        headers: {
          Authorization: "[REDACTED]",
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body,
      },
      key,
    );
    const result = await transport({ endpoint: LIMITS.endpoint, key, body });
    await save(output, prefix + "-response.json", result, key);
    if (result.status < 200 || result.status >= 300)
      throw new Error(
        "Endpoint rejected request (HTTP " + result.status + "); no redirect or retry",
      );
    let response;
    try {
      response = JSON.parse(result.rawBody);
    } catch {
      throw new Error("Non-JSON endpoint response");
    }
    if (response.error || response.type !== "message")
      throw new Error("Unsupported endpoint response");
    record.usage = usageEvidence(response);
    record.responseMetadata = {
      model: response.model ?? null,
      provider: response.provider ?? null,
      id: response.id ?? null,
      stopReason: response.stop_reason ?? null,
      openrouterMetadata: response.openrouter_metadata ?? null,
    };
    if (response.model !== LIMITS.model && response.model !== "claude-sonnet-5")
      throw new Error("Endpoint returned an unexpected or missing model identity");
    const provider =
      response.provider ??
      response.openrouter_metadata?.endpoints?.available?.find((endpoint) => endpoint.selected)
        ?.provider;
    if (provider && provider.toLowerCase() !== "anthropic")
      throw new Error("Endpoint returned an unexpected provider");
    const usage = record.usage;
    if (usage.reportedCostUsd !== null) actualReportedCostUsd += usage.reportedCostUsd;
    if (usage.totalInput === null || usage.output === null)
      throw new Error("Missing usage: input/cache/output evidence is unknown; stopping");
    if (
      usage.totalInput > LIMITS.bodyBytes + LIMITS.overheadTokens ||
      usage.output > 256 ||
      (usage.reportedCostUsd !== null && usage.reportedCostUsd > MAX_REQUEST_USD + 1e-9) ||
      actualReportedCostUsd > reservedUsd + 1e-9
    )
      throw new Error("Observed usage or reported cost exceeded the conservative reservation");
    return response;
  };
  try {
    const initial = [{ role: "user", content: "Do not call any tool. Reply READY only." }];
    for (const [index, tools] of [catalog(false, true), catalog(false), catalog(true)].entries())
      noCall(await send(STAGES[index], makeBody(tools, initial, nonce)));
    const [only, eager, deferred] = records.map((record) => record.usage.totalInput);
    const overhead = eager - only;
    if (only < 2048) throw new Error("Synthetic prefix did not reach the 2048-token cache minimum");
    report.contextEvidence = {
      searchOnly: only,
      eager,
      deferred,
      eagerOverhead: overhead,
      deferredOverhead: deferred - only,
      supported: overhead >= 1000 && deferred - only <= Math.max(128, overhead * 0.1),
    };
    if (!report.contextEvidence.supported)
      throw new Error("Deferred initial context exclusion was not demonstrated");
    const tools = catalog(true);
    const frozenTools = JSON.stringify(tools);
    const history = [
      {
        role: "user",
        content:
          "First call ToolSearch with query select:Synthetic17. " +
          "After its result, call Synthetic17 directly with tag native-probe. Then reply DONE.",
      },
    ];
    const searchResponse = await send(STAGES[3], makeBody(tools, history, nonce));
    const search = toolCall(searchResponse, "ToolSearch", { query: "select:Synthetic17" });
    history.push(
      { role: "assistant", content: searchResponse.content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: search.id,
            content: [{ type: "tool_reference", tool_name: TARGET }],
            cache_control: MARKER,
          },
        ],
      },
    );
    const nativeResponse = await send(STAGES[4], makeBody(tools, history, nonce));
    const native = toolCall(nativeResponse, TARGET, { tag: "native-probe" });
    history.push(
      { role: "assistant", content: nativeResponse.content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: native.id,
            content: "SIMULATED: native-probe accepted. No tool was executed.",
            cache_control: MARKER,
          },
        ],
      },
    );
    const finalBody = makeBody(tools, history, nonce);
    noCall(await send(STAGES[5], finalBody));
    noCall(await send(STAGES[6], finalBody));
    report.nativeCallVerified = true;
    report.frozenCatalogVerified = JSON.stringify(tools) === frozenTools;
    report.warmCacheVerified = records[6].usage.cacheRead > 0;
    if (!report.warmCacheVerified) throw new Error("Warm repeat did not demonstrate a cache read");
    report.status = "passed";
  } catch (error) {
    report.status = "stopped";
    report.reason = String(error.message ?? "Probe failed")
      .split(key)
      .join("[REDACTED]");
  }
  report.requestsAttempted = records.length;
  report.reservedUsd = reservedUsd;
  report.reportedCostUsd = records.every(
    (record) => record.usage?.reportedCostUsd !== null && record.usage,
  )
    ? actualReportedCostUsd
    : null;
  report.records = records;
  await save(output, "evidence.json", report, key);
  return report;
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(args);
  const result = await runProbe(options, dependencies);
  const write = dependencies.write ?? ((line) => process.stdout.write(line + "\n"));
  write("Native tool-reference prerequisite probe: " + result.mode);
  write("Endpoint: " + result.endpoint + " | Model: " + result.model);
  write("Seven planned requests; cap " + result.requestCap + "; max 256 output tokens each.");
  write(
    "Conservative reservation: USD " +
      result.conservativeReservationUsd.toFixed(6) +
      "; hard budget USD " +
      result.authorizedBudgetUsd.toFixed(2) +
      ".",
  );
  for (const [index, stage] of result.stages.entries()) write(String(index + 1) + ". " + stage);
  write(result.safety);
  if (!options.live)
    write(
      "No credentials were read and no network requests were made. " +
        "Live execution additionally requires --live --authorized-paid-probe --budget-usd 2 " +
        "--max-requests 8 --output-dir /absolute/empty/evidence-directory.",
    );
  else write("Result: " + result.status + (result.reason ? ": " + result.reason : ""));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
    .then((result) => {
      if (result.status === "stopped") process.exitCode = 1;
    })
    .catch(() => {
      console.error("Probe configuration or evidence setup failed; no retry attempted.");
      process.exitCode = 1;
    });
}
