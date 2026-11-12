// Offline on import. Only sendExact opens a connection; it never retries.
import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { constants } from "node:fs";
import { open, readFile, realpath, rename, unlink, lstat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { usageEvidence } from "./native-tool-reference-probe.mjs";

export const LIMITS = Object.freeze({
  endpoint: "https://openrouter.ai/api/v1/messages",
  model: "anthropic/claude-sonnet-5",
  budgetNanoUsd: 2_000_000_000,
  priorCostNanoUsd: 50_524_600,
  maxRequests: 80,
  maxOutputTokens: 768,
  maxBodyBytes: 48_000,
  maxResponseBytes: 262_144,
  overheadTokens: 8_192,
  inputUsdPerMillion: 8,
  outputUsdPerMillion: 12,
});
export const ROUTING = Object.freeze({
  only: Object.freeze(["anthropic"]),
  allow_fallbacks: false,
  max_price: Object.freeze({ prompt: 4, completion: 12, request: 0 }),
});
export const PRIOR_EVIDENCE_SHA256 =
  "88b9e9f14d495df96af7af494cb51c22a89f5704b224f9e0915b73e815f5f822";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const POLICY_SHA256 = sha256(JSON.stringify({ LIMITS, ROUTING }));
const MAX_LEDGER_BYTES = 1_048_576;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const inside = (path, root) => path === root || path.startsWith(root + sep);
const label = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
const onlyKeys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const archiveReason = (value) =>
  typeof value === "string" && /^[\x20-\x7e]{1,512}$/.test(value) && value.trim() === value;

/** Round decimal provider charges upward without binary floating-point undercount. */
export function costNanoUsd(cost) {
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
    throw new Error("Missing or invalid billed cost");
  const match = String(cost).match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/);
  if (!match) throw new Error("Invalid billed cost");
  const fraction = match[2] ?? "";
  const digits = BigInt(match[1] + fraction);
  const shift = 9 + Number(match[3] ?? 0) - fraction.length;
  const value =
    shift >= 0
      ? digits * 10n ** BigInt(shift)
      : (digits + 10n ** BigInt(-shift) - 1n) / 10n ** BigInt(-shift);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Billed cost exceeds numeric bounds");
  return Number(value);
}

export function validateBody(body) {
  if (
    !isObject(body) ||
    !onlyKeys(body, [
      "model",
      "max_tokens",
      "stream",
      "thinking",
      "provider",
      "system",
      "tools",
      "messages",
      "tool_choice",
    ]) ||
    body.model !== LIMITS.model ||
    body.max_tokens !== LIMITS.maxOutputTokens ||
    body.stream !== false ||
    JSON.stringify(body.thinking) !== JSON.stringify({ type: "disabled" }) ||
    JSON.stringify(body.provider) !== JSON.stringify(ROUTING)
  )
    throw new Error("Unexpected model, output, thinking or routing configuration");
  if (!Array.isArray(body.tools) || !body.tools.length || !Array.isArray(body.messages))
    throw new Error("A bounded client tool directory and messages are required");
  const markers = [];
  const marker = (value) => {
    if (value === undefined) return;
    if (
      !isObject(value) ||
      !onlyKeys(value, ["type", "ttl"]) ||
      value.type !== "ephemeral" ||
      (value.ttl !== undefined && value.ttl !== "5m" && value.ttl !== "1h")
    )
      throw new Error("Invalid cache marker");
    markers.push(value);
  };
  const blocks = (value) => {
    if (typeof value === "string") return;
    if (!Array.isArray(value)) throw new Error("Invalid message content");
    for (const block of value) {
      if (
        !isObject(block) ||
        !["text", "tool_use", "tool_result", "tool_reference"].includes(block.type)
      )
        throw new Error("Only synthetic text and client-tool blocks are allowed");
      marker(block.cache_control);
      if (block.type === "tool_result" && Array.isArray(block.content)) blocks(block.content);
    }
  };
  for (const tool of body.tools) {
    if (
      !isObject(tool) ||
      !onlyKeys(tool, ["name", "description", "input_schema", "defer_loading", "cache_control"]) ||
      typeof tool.name !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(tool.name) ||
      typeof tool.description !== "string" ||
      !isObject(tool.input_schema) ||
      (tool.defer_loading !== undefined && tool.defer_loading !== true)
    )
      throw new Error("Only client JSON-schema tools are allowed");
    marker(tool.cache_control);
  }
  if (new Set(body.tools.map((tool) => tool.name)).size !== body.tools.length)
    throw new Error("Duplicate tool name");
  const markedTools = body.tools.filter((tool) => tool.cache_control !== undefined);
  if (
    markedTools.length !== 1 ||
    markedTools[0] !== body.tools.findLast((tool) => !tool.defer_loading)
  )
    throw new Error("Tool marker must be on the last eager tool only");
  blocks(body.system);
  for (const message of body.messages) {
    if (!isObject(message) || !["user", "assistant"].includes(message.role))
      throw new Error("Invalid message role");
    blocks(message.content);
  }
  if (markers.length > 4) throw new Error("At most four cache breakpoints are allowed");
  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice;
    if (
      !isObject(choice) ||
      !onlyKeys(choice, ["type", "name", "disable_parallel_tool_use"]) ||
      !["auto", "any", "tool", "none"].includes(choice.type) ||
      (choice.disable_parallel_tool_use !== undefined &&
        typeof choice.disable_parallel_tool_use !== "boolean") ||
      (choice.type === "tool"
        ? !body.tools.some((tool) => tool.name === choice.name)
        : choice.name !== undefined)
    )
      throw new Error("Invalid client tool choice");
  }
  let serialized;
  try {
    serialized = JSON.stringify(body);
  } catch {
    throw new Error("Invalid request serialization");
  }
  if (!/^[\x00-\x7f]*$/.test(serialized)) throw new Error("Probe request must be ASCII");
  if (Buffer.byteLength(serialized) > LIMITS.maxBodyBytes)
    throw new Error("Request body limit exceeded");
  return serialized;
}

function reservationForBytes(bytes) {
  // Two tokens per ASCII request byte plus provider overhead; input rate includes
  // the maximum 2x Anthropic cache-write multiplier over the $4/M routing cap.
  return (
    ((2 * bytes + LIMITS.overheadTokens) * LIMITS.inputUsdPerMillion +
      LIMITS.maxOutputTokens * LIMITS.outputUsdPerMillion) *
    1_000
  );
}
export function reservationForBody(body) {
  const serialized = validateBody(body);
  const bodyBytes = Buffer.byteLength(serialized);
  return {
    bodyHash: sha256(serialized),
    bodyBytes,
    reservationNanoUsd: reservationForBytes(bodyBytes),
  };
}

function checkedUsage(response, record) {
  if (!isObject(response) || response.error || response.type !== "message")
    throw new Error("Unsupported endpoint response");
  if (![LIMITS.model, "claude-sonnet-5"].includes(response.model))
    throw new Error("Unexpected or missing response model");
  const metadata = response.openrouter_metadata;
  if (metadata != null && !isObject(metadata)) throw new Error("Invalid provider metadata");
  const selected =
    metadata?.endpoints?.available?.filter((entry) => entry?.selected === true) ?? [];
  const providers = [response.provider, ...selected.map((entry) => entry.provider)].filter(
    (value) => value !== undefined,
  );
  if (
    !providers.length ||
    providers.some((value) => typeof value !== "string" || value.toLowerCase() !== "anthropic")
  )
    throw new Error("Unexpected or missing response provider");
  for (const value of [response.usage?.is_byok, metadata?.is_byok])
    if (value !== undefined && value !== false)
      throw new Error("BYOK or uncertain billing is not allowed");
  if (metadata?.attempt !== undefined && metadata.attempt !== 1)
    throw new Error("Provider retry or uncertain attempt count");
  if (
    response.usage?.server_tool_use &&
    Object.values(response.usage.server_tool_use).some((value) => value !== 0)
  )
    throw new Error("Unexpected server-tool billing");
  const usage = usageEvidence(response);
  const cost = costNanoUsd(usage.reportedCostUsd);
  if (
    usage.totalInput === null ||
    usage.output === null ||
    !integer(usage.totalInput) ||
    usage.totalInput > 2 * record.bodyBytes + LIMITS.overheadTokens ||
    usage.output > LIMITS.maxOutputTokens ||
    cost > record.reservationNanoUsd
  )
    throw new Error("Missing usage or observed bill exceeds the reservation");
  return { costNanoUsd: cost, usage };
}

async function readHttpErrorEvidence(path, expectedSha256, maxBytes) {
  if (typeof path !== "string" || !isAbsolute(path) || !digest(expectedSha256))
    throw new Error("Absolute evidence paths and explicit SHA256 digests are required");
  const canonical = resolve(await realpath(dirname(path)), basename(path));
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Invalid HTTP evidence file");
    const bytes = await file.readFile();
    if (bytes.length > maxBytes || sha256(bytes) !== expectedSha256)
      throw new Error("HTTP evidence digest or size mismatch");
    let value;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("HTTP evidence is not valid JSON");
    }
    return { path: canonical, sha256: expectedSha256, value };
  } finally {
    await file.close();
  }
}

/** Manual accounting conservatism, never a claim that the provider billed this amount. */
async function verifiedHttpErrorArchive(record, options) {
  if (options?.operatorAcknowledged !== true || !archiveReason(options.reason))
    throw new Error("Explicit operator acknowledgement and an audit reason are required");
  const request = await readHttpErrorEvidence(
    options.requestEvidencePath,
    options.requestEvidenceSha256,
    LIMITS.maxBodyBytes * 4,
  );
  const response = await readHttpErrorEvidence(
    options.responseEvidencePath,
    options.responseEvidenceSha256,
    LIMITS.maxResponseBytes * 2 + 65_536,
  );
  if (
    dirname(request.path) !== dirname(response.path) ||
    basename(request.path) !== record.stage + "-request.json" ||
    basename(response.path) !== record.stage + "-response.json"
  )
    throw new Error("HTTP evidence files do not match the reserved stage");
  if (request.value?.endpoint !== LIMITS.endpoint)
    throw new Error("HTTP evidence endpoint does not match the authorization");
  const original = reservationForBody(request.value.body);
  if (
    original.bodyHash !== record.bodyHash ||
    original.bodyBytes !== record.bodyBytes ||
    original.reservationNanoUsd !== record.reservationNanoUsd
  )
    throw new Error("HTTP request evidence does not match the pending reservation");
  if (
    !isObject(response.value) ||
    !Number.isSafeInteger(response.value.status) ||
    response.value.status < 400 ||
    response.value.status > 599 ||
    typeof response.value.rawBody !== "string"
  )
    throw new Error("Only recorded HTTP 4xx/5xx responses allow manual archival");
  return {
    previousStatus: "pending",
    actualBill: "unknown",
    operatorAcknowledged: true,
    reason: options.reason,
    archivedAt: Date.now(),
    httpStatus: response.value.status,
    requestEvidencePath: request.path,
    requestEvidenceSha256: request.sha256,
    responseEvidencePath: response.path,
    responseEvidenceSha256: response.sha256,
  };
}

function validateLedger(state) {
  if (
    !isObject(state) ||
    state.version !== 1 ||
    state.policySha256 !== POLICY_SHA256 ||
    state.priorEvidenceSha256 !== PRIOR_EVIDENCE_SHA256 ||
    state.priorCostNanoUsd !== LIMITS.priorCostNanoUsd ||
    state.priorRequests !== 7 ||
    !Array.isArray(state.records) ||
    state.records.length > LIMITS.maxRequests
  )
    throw new Error("Invalid or incompatible budget ledger");
  for (const [index, record] of state.records.entries()) {
    if (
      !isObject(record) ||
      record.id !== index + 1 ||
      !label(record.stage) ||
      !label(record.runId) ||
      !/^[a-f0-9]{64}$/.test(record.bodyHash) ||
      !integer(record.bodyBytes) ||
      record.bodyBytes < 1 ||
      record.bodyBytes > LIMITS.maxBodyBytes ||
      record.reservationNanoUsd !== reservationForBytes(record.bodyBytes) ||
      !integer(record.reservedAt) ||
      !["pending", "settled", "charged-reservation"].includes(record.status) ||
      (record.status === "pending" &&
        (index !== state.records.length - 1 || record.costNanoUsd !== undefined)) ||
      (record.status === "settled" &&
        (!integer(record.costNanoUsd) ||
          record.costNanoUsd > record.reservationNanoUsd ||
          !integer(record.settledAt)))
    )
      throw new Error("Invalid budget ledger record");
    if (record.status === "charged-reservation") {
      const archive = record.httpErrorArchive;
      if (
        record.costNanoUsd !== undefined ||
        record.usage !== undefined ||
        record.settledAt !== undefined ||
        record.chargedReservationNanoUsd !== record.reservationNanoUsd ||
        !isObject(archive) ||
        archive.previousStatus !== "pending" ||
        archive.actualBill !== "unknown" ||
        archive.operatorAcknowledged !== true ||
        !archiveReason(archive.reason) ||
        !integer(archive.archivedAt) ||
        archive.archivedAt < record.reservedAt ||
        !Number.isSafeInteger(archive.httpStatus) ||
        archive.httpStatus < 400 ||
        archive.httpStatus > 599 ||
        typeof archive.requestEvidencePath !== "string" ||
        !isAbsolute(archive.requestEvidencePath) ||
        typeof archive.responseEvidencePath !== "string" ||
        !isAbsolute(archive.responseEvidencePath) ||
        !digest(archive.requestEvidenceSha256) ||
        !digest(archive.responseEvidenceSha256) ||
        dirname(archive.requestEvidencePath) !== dirname(archive.responseEvidencePath) ||
        basename(archive.requestEvidencePath) !== record.stage + "-request.json" ||
        basename(archive.responseEvidencePath) !== record.stage + "-response.json"
      )
        throw new Error("Invalid manual reservation archival");
    } else if (
      record.httpErrorArchive !== undefined ||
      record.chargedReservationNanoUsd !== undefined
    ) {
      throw new Error("Unexpected reservation archival metadata");
    }
    if (record.status === "settled") {
      const usage = record.usage;
      if (
        !isObject(usage) ||
        ![usage.input, usage.cacheRead, usage.cacheWrite, usage.output, usage.totalInput].every(
          integer,
        ) ||
        usage.totalInput !== usage.input + usage.cacheRead + usage.cacheWrite ||
        usage.totalInput > 2 * record.bodyBytes + LIMITS.overheadTokens ||
        usage.output > LIMITS.maxOutputTokens ||
        costNanoUsd(usage.reportedCostUsd) !== record.costNanoUsd
      )
        throw new Error("Invalid settled usage evidence");
    }
  }
  if (exposure(state) > LIMITS.budgetNanoUsd)
    throw new Error("Budget ledger exceeds authorization");
}
const exposure = (state) =>
  state.priorCostNanoUsd +
  state.records.reduce(
    (sum, entry) =>
      sum + (entry.status === "settled" ? entry.costNanoUsd : entry.reservationNanoUsd),
    0,
  );
async function syncDirectory(path) {
  const handle = await open(dirname(path), "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function durableWrite(path, state) {
  const temporary = path + ".pending";
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(state, null, 2) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await syncDirectory(path);
}
async function verifiedPrior(path) {
  const bytes = await readFile(path);
  if (sha256(bytes) !== PRIOR_EVIDENCE_SHA256)
    throw new Error("Prior probe evidence digest mismatch");
  const evidence = JSON.parse(bytes.toString("utf8"));
  if (
    evidence.status !== "passed" ||
    evidence.requestsAttempted !== 7 ||
    evidence.records?.length !== 7
  )
    throw new Error("Prior probe evidence is incomplete");
  const total = evidence.records.reduce(
    (sum, record) => sum + costNanoUsd(record.usage?.reportedCostUsd),
    0,
  );
  if (total !== LIMITS.priorCostNanoUsd) throw new Error("Prior probe bill mismatch");
}

/** One authorization ledger for all runs; stale locks/pending bills require manual review. */
export async function openBudgetLedger(path, { priorEvidencePath } = {}) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    typeof priorEvidencePath !== "string" ||
    !isAbsolute(priorEvidencePath)
  )
    throw new Error("Absolute ledger and prior evidence paths are required");
  const parent = await realpath(dirname(path));
  const canonical = resolve(parent, path.slice(dirname(path).length + 1));
  const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));
  if (inside(canonical, root) || inside(canonical, resolve(homedir(), ".code-shell")))
    throw new Error("Budget ledger must be outside the repository and application state");
  await verifiedPrior(priorEvidencePath);
  const lockPath = canonical + ".lock";
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new Error("Budget ledger is locked; no automatic lock recovery");
  }
  let closed = false;
  let poisoned = false;
  let busy = false;
  const close = async () => {
    if (busy) throw new Error("Budget mutation is in progress");
    if (closed) return;
    closed = true;
    await lock.close();
    await unlink(lockPath);
    await syncDirectory(canonical);
  };
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }) + "\n");
    await lock.sync();
    await syncDirectory(canonical);
    let state;
    try {
      const stat = await lstat(canonical);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LEDGER_BYTES)
        throw new Error("Invalid budget ledger file");
      state = JSON.parse(await readFile(canonical, "utf8"));
      validateLedger(state);
    } catch (error) {
      // Existing files may contain private data; never expose parser diagnostics.
      // eslint-disable-next-line preserve-caught-error -- keep unknown ledger contents out of errors
      if (error.code !== "ENOENT") throw new Error("Cannot safely read the existing budget ledger");
      state = {
        version: 1,
        policySha256: POLICY_SHA256,
        priorEvidenceSha256: PRIOR_EVIDENCE_SHA256,
        priorCostNanoUsd: LIMITS.priorCostNanoUsd,
        priorRequests: 7,
        records: [],
      };
      await durableWrite(canonical, state);
    }
    const mutate = async (operation) => {
      if (closed || poisoned || busy) throw new Error("Budget ledger is closed, failed or busy");
      busy = true;
      try {
        const next = globalThis.structuredClone(state);
        const result = await operation(next);
        validateLedger(next);
        try {
          await durableWrite(canonical, next);
        } catch {
          poisoned = true;
          throw new Error("Budget evidence write failed; no further requests allowed");
        }
        state = next;
        return globalThis.structuredClone(result);
      } finally {
        busy = false;
      }
    };
    return {
      reserve: (stage, body, runId) =>
        mutate((next) => {
          if (!label(stage) || !label(runId))
            throw new Error("Invalid probe stage or run identifier");
          if (next.records.some((entry) => entry.status === "pending"))
            throw new Error("Unresolved request billing blocks further requests");
          const reservation = reservationForBody(body);
          if (
            next.records.length >= LIMITS.maxRequests ||
            exposure(next) + reservation.reservationNanoUsd > LIMITS.budgetNanoUsd
          )
            throw new Error("Request or cumulative budget cap would be exceeded");
          const record = {
            id: next.records.length + 1,
            stage,
            runId,
            ...reservation,
            status: "pending",
            reservedAt: Date.now(),
          };
          next.records.push(record);
          return record;
        }),
      settle: (id, response) =>
        mutate((next) => {
          const record = next.records.find((entry) => entry.id === id);
          if (!record || record.status !== "pending")
            throw new Error("Request is missing or is no longer pending");
          const billed = checkedUsage(response, record);
          Object.assign(record, billed, { status: "settled", settledAt: Date.now() });
          return record;
        }),
      chargePendingReservation: (id, options) =>
        mutate(async (next) => {
          const record = next.records.find((entry) => entry.id === id);
          if (!record || record.status !== "pending")
            throw new Error("Only an unresolved pending request can be archived");
          const archive = await verifiedHttpErrorArchive(record, options);
          Object.assign(record, {
            status: "charged-reservation",
            chargedReservationNanoUsd: record.reservationNanoUsd,
            httpErrorArchive: archive,
          });
          return record;
        }),
      snapshot: () =>
        globalThis.structuredClone({
          ...state,
          exposureNanoUsd: exposure(state),
          remainingNanoUsd: LIMITS.budgetNanoUsd - exposure(state),
          pendingRequests: state.records.filter((entry) => entry.status === "pending").length,
          chargedReservations: state.records.filter(
            (entry) => entry.status === "charged-reservation",
          ).length,
          chargedReservationNanoUsd: state.records.reduce(
            (sum, entry) =>
              sum + (entry.status === "charged-reservation" ? entry.reservationNanoUsd : 0),
            0,
          ),
          newRequests: state.records.length,
          totalRequests: state.records.length + state.priorRequests,
        }),
      close,
    };
  } catch {
    await close();
    throw new Error("Budget ledger initialization failed; no request was dispatched");
  }
}

/** Single bounded request. Test dependency injection never changes the endpoint/body guards. */
export function sendExact({ endpoint, key, body, timeoutMs = 60_000 }, dependencies = {}) {
  if (endpoint !== LIMITS.endpoint) throw new Error("Endpoint is not the authorized exact URL");
  const payload = validateBody(body);
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{8,4096}$/.test(key))
    throw new Error("Invalid probe credential");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new Error("Invalid request timeout");
  return new Promise((resolveResponse, reject) => {
    let request;
    let response;
    let done = false;
    const finish = (value, failed = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (failed) {
        request?.destroy();
        response?.destroy();
        reject(new Error("Request or bounded response failed; no retry was attempted"));
      } else resolveResponse(value);
    };
    const timer = setTimeout(() => finish(undefined, true), timeoutMs);
    try {
      request = (dependencies.request ?? httpsRequest)(
        endpoint,
        {
          method: "POST",
          agent: false,
          rejectUnauthorized: true,
          maxHeaderSize: 16_384,
          headers: {
            Authorization: "Bearer " + key,
            "Content-Type": "application/json",
            "Accept-Encoding": "identity",
            "anthropic-version": "2023-06-01",
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (incoming) => {
          response = incoming;
          const chunks = [];
          let size = 0;
          incoming.on("data", (chunk) => {
            size += chunk.length;
            if (size > LIMITS.maxResponseBytes) finish(undefined, true);
            else chunks.push(chunk);
          });
          incoming.on("end", () =>
            finish({
              status: incoming.statusCode,
              headers: incoming.headers,
              rawBody: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          incoming.on("error", () => finish(undefined, true));
          incoming.on("aborted", () => finish(undefined, true));
        },
      );
      request.on("error", () => finish(undefined, true));
      request.end(payload);
    } catch {
      finish(undefined, true);
    }
  });
}

/** Explicit offline recovery only. This path never reads a credential or opens a socket. */
export async function runReservationArchiveCli(args) {
  const values = {};
  const seen = new Set();
  const flags = ["--charge-pending-reservation", "--operator-acknowledged"];
  const options = [
    "--ledger-path",
    "--request-id",
    "--request-evidence-path",
    "--response-evidence-path",
    "--request-sha256",
    "--response-sha256",
    "--reason",
  ];
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error("Duplicate archival option");
    seen.add(flag);
    if (flags.includes(flag)) values[flag] = true;
    else if (options.includes(flag)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("Missing archival option value");
      values[flag] = value;
    } else throw new Error("Unknown archival option");
  }
  if ([...flags, ...options].some((flag) => !seen.has(flag)))
    throw new Error("All archival options and explicit operator acknowledgement are required");
  const id = Number(values["--request-id"]);
  if (!Number.isSafeInteger(id) || id < 1 || id > LIMITS.maxRequests)
    throw new Error("Invalid archival request id");
  const path = values["--ledger-path"];
  if (!isAbsolute(path)) throw new Error("An absolute existing ledger path is required");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("An existing regular ledger is required");
  const ledger = await openBudgetLedger(path, {
    priorEvidencePath: resolve(
      dirname(fileURLToPath(import.meta.url)),
      "native-tool-reference-evidence-20261111.json",
    ),
  });
  try {
    const record = await ledger.chargePendingReservation(id, {
      operatorAcknowledged: values["--operator-acknowledged"] === true,
      reason: values["--reason"],
      requestEvidencePath: values["--request-evidence-path"],
      responseEvidencePath: values["--response-evidence-path"],
      requestEvidenceSha256: values["--request-sha256"],
      responseEvidenceSha256: values["--response-sha256"],
    });
    return {
      status: record.status,
      requestId: id,
      actualBill: "unknown",
      chargedReservationNanoUsd: record.reservationNanoUsd,
      ledger: ledger.snapshot(),
    };
  } finally {
    await ledger.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runReservationArchiveCli(process.argv.slice(2))
    .then((result) => process.stdout.write(JSON.stringify(result, null, 2) + "\n"))
    .catch(() => {
      console.error("Offline reservation archival failed; no request was sent.");
      process.exitCode = 1;
    });
}
