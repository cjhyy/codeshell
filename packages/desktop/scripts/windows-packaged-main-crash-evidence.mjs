/** Passive hosted-CI diagnostic. Never grants launch, signal or cleanup authority. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { matchNsisCrashEvents, windowsBirthToFileTime } from "./windows-nsis-crash-evidence.mjs";

const SCRIPT = fileURLToPath(new URL("./windows-nsis-crash-evidence.ps1", import.meta.url));
const SOURCE_FILES = {
  collector: fileURLToPath(import.meta.url),
  matcher: fileURLToPath(new URL("./windows-nsis-crash-evidence.mjs", import.meta.url)),
  script: SCRIPT,
  fixture: fileURLToPath(new URL("./packaged-pet-fixture.mjs", import.meta.url)),
  driver: fileURLToPath(new URL("./e2e-ui-packaged.mjs", import.meta.url)),
  isolation: fileURLToPath(new URL("../../../scripts/bun-test-completion.mjs", import.meta.url)),
};
const MAX_BYTES = 64 * 1024;
const TIMEOUT = 30_000;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const pid = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffff_ffff;
const unknown = (reason) => ({ status: "unknown", reason });

function canonicalPath(value) {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    !/^[a-z]:\\[^\r\n\0]+$/i.test(value) ||
    win32.normalize(value) !== value ||
    value.split("\\").some((part) => /[. ]$/.test(part))
  )
    throw Error("Unproven canonical path");
  return value.toLowerCase();
}

function sourceBytes(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES)
    throw Error("Unproven diagnostic source");
  const bytes = readFileSync(path);
  if (bytes.length > MAX_BYTES) throw Error("Unproven diagnostic source");
  return bytes;
}

/** Capture only fixed source bytes, before launch. No executable is run or discovered. */
export function capturePackagedMainDiagnosticSources(read = sourceBytes) {
  return Object.fromEntries(
    Object.entries(SOURCE_FILES).map(([key, path]) => {
      const bytes = read(path);
      if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES)
        throw Error("Unproven diagnostic source");
      return [key, sha(bytes)];
    }),
  );
}

/** A catch's first observed error, before its awaits. IO cannot replace it. */
export function recordPackagedMainFirstError(file, error, details, { write = writeFileSync } = {}) {
  let truncated = false;
  const string = (value, max) => {
    if (typeof value !== "string") {
      truncated = true;
      return "Uninspectable thrown value";
    }
    if (value.length > max) truncated = true;
    return value.slice(0, max);
  };
  const describe = (value, depth = 0) => {
    try {
      return {
        name: string(value?.name, 128),
        message: string(value?.message, 12_000),
        ...(depth < 2 && value?.cause ? { cause: describe(value.cause, depth + 1) } : {}),
      };
    } catch {
      truncated = true;
      return { name: "Error", message: "Uninspectable thrown value" };
    }
  };
  try {
    const row = {
      schemaVersion: 1,
      phase: ["playwright-launch", "startup-barrier", "identity-read", "ui-operation"].includes(
        details?.phase,
      )
        ? details.phase
        : "unknown",
      child: {
        pid: pid(details?.pid) ? details.pid : null,
        ppid: pid(details?.ppid) ? details.ppid : null,
      },
      firstError: describe(error),
      truncated,
      boundary:
        "Catch-observed error persisted before this catch awaits; no SDK/startup-cleanup or native-fault ordering claim",
    };
    const bytes = Buffer.from(JSON.stringify(row, null, 2) + "\n");
    if (bytes.length > MAX_BYTES) return { written: false, reason: "first-error-limit" };
    write(file, bytes, { mode: 0o600, flag: "wx" });
    return { written: true, sha256: sha(bytes), bytes: bytes.length, truncated, ...row.child };
  } catch {
    return { written: false, reason: "first-error-recording-failed" };
  }
}

function checkedTarget(options) {
  const { ci, firstError, context, artifacts, mainGuards } = options;
  if (
    ci?.GITHUB_ACTIONS !== "true" ||
    ci.RUNNER_OS !== "Windows" ||
    ci.RUNNER_ARCH !== "X64" ||
    ci.RUNNER_ENVIRONMENT !== "github-hosted" ||
    ci.ImageOS !== "win22" ||
    ci.GITHUB_REPOSITORY !== "cjhyy/codeshell" ||
    !/^[1-9]\d{0,19}$/.test(ci.GITHUB_RUN_ID ?? "") ||
    !/^[a-f0-9]{40}$/.test(ci.GITHUB_SHA ?? "") ||
    ci.ACT !== undefined ||
    options.failed !== true ||
    firstError?.written !== true ||
    firstError.truncated !== false ||
    !digest(firstError.sha256) ||
    !Number.isSafeInteger(firstError.bytes) ||
    firstError.bytes <= 0 ||
    firstError.bytes > MAX_BYTES ||
    !pid(firstError.pid) ||
    !pid(firstError.ppid)
  )
    throw Error("Unproven failed hosted Main");
  const home = canonicalPath(context.home);
  if (
    home !== canonicalPath(win32.join(context.root, "home")) ||
    !/^codeshell-packaged-ui-[a-z0-9]{6}$/i.test(win32.basename(context.root)) ||
    canonicalPath(context.executable) !==
      canonicalPath(win32.join(context.appRoot, "code-shell.exe")) ||
    !digest(context.executableSHA256) ||
    !digest(context.appTreeSHA256) ||
    artifacts?.platform !== "win32" ||
    artifacts.arch !== "x64" ||
    artifacts.unchangedAfterRuntime !== true ||
    artifacts.executableSHA256 !== context.executableSHA256 ||
    artifacts.appTreeSHA256 !== context.appTreeSHA256 ||
    artifacts.beforeAppTreeSHA256 !== context.appTreeSHA256 ||
    !digest(artifacts.asarSHA256) ||
    !digest(artifacts.managedNodeManifestSHA256)
  )
    throw Error("Unproven packaged executable pin");
  if (
    artifacts.mainExits?.length !== 1 ||
    artifacts.observedProcessSettlements?.length !== 1 ||
    artifacts.observedSignalRequests?.truncated !== false ||
    !Array.isArray(artifacts.observedSignalRequests.requests) ||
    artifacts.observedSignalRequests.requests.length !== 0 ||
    artifacts.windowsTransports?.length !== 1
  )
    throw Error("Unproven Main exit observation");
  const exit = artifacts.mainExits[0];
  const transport = artifacts.windowsTransports[0];
  if (
    exit.pid !== firstError.pid ||
    exit.mainPid !== firstError.pid ||
    !Number.isSafeInteger(exit.code) ||
    exit.code === 0 ||
    exit.signal !== null ||
    transport.pid !== firstError.pid ||
    transport.directMain !== true ||
    transport.nativeTaskkillExecuted !== false
  )
    throw Error("Unproven abnormal Main exit");
  const settlement = artifacts.observedProcessSettlements[0];
  if (
    settlement?.status !== "cleaned" ||
    settlement.queryFailed !== false ||
    settlement.evidenceTruncated !== false ||
    settlement.remainingCount !== 0 ||
    !Array.isArray(settlement.remaining) ||
    settlement.remaining.length !== 0 ||
    !Array.isArray(settlement.owned) ||
    settlement.owned.length === 0 ||
    settlement.owned.length > 512 ||
    settlement.ownedCount !== settlement.owned.length
  )
    throw Error("Unproven Main custody settlement");
  const rows = new Map();
  for (const row of settlement.owned) {
    if (!pid(row.pid) || !pid(row.ppid) || row.pid === row.ppid || rows.has(row.pid))
      throw Error("Unproven Main custody identity");
    windowsBirthToFileTime(row.birth);
    rows.set(row.pid, row);
  }
  for (const row of rows.values()) {
    const parent = rows.get(row.ppid);
    if (parent && row.birth < parent.birth) throw Error("Unproven custody chronology");
    const seen = new Set([row.pid]);
    for (let next = parent; next; next = rows.get(next.ppid)) {
      if (seen.has(next.pid)) throw Error("Unproven custody cycle");
      seen.add(next.pid);
    }
  }
  const main = rows.get(firstError.pid);
  if (!main || main.ppid !== firstError.ppid) throw Error("Unproven Main parent");
  const guard = mainGuards?.filter((row) => row.role === "Main");
  if (
    guard?.length !== 1 ||
    guard[0].pid !== main.pid ||
    guard[0].ppid !== main.ppid ||
    canonicalPath(guard[0].executable) !== canonicalPath(context.executable) ||
    guard[0].homeId !== sha(context.home) ||
    guard[0].negativeProbes !== 7
  )
    throw Error("Unproven actual guarded Main");
  const start = windowsBirthToFileTime(main.birth);
  const end = windowsBirthToFileTime(options.observedAt);
  if (BigInt(end) < BigInt(start) || BigInt(end) - BigInt(start) > 600n * 10_000_000n)
    throw Error("Unproven diagnostic window");
  return {
    pid: main.pid,
    birth: main.birth,
    fileTime: start,
    path: context.executable,
    observedAt: options.observedAt,
  };
}

function queryEnvironment(environment, home) {
  const systemRoot = environment?.SystemRoot ?? environment?.SYSTEMROOT;
  canonicalPath(systemRoot);
  const expected = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: win32.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: win32.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: win32.join(home, ".config"),
    XDG_DATA_HOME: win32.join(home, ".local", "share"),
    TEMP: win32.join(home, "tmp"),
    TMP: win32.join(home, "tmp"),
    TMPDIR: win32.join(home, "tmp"),
  };
  const env = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    PATH: win32.join(systemRoot, "System32"),
  };
  for (const [key, path] of Object.entries(expected)) {
    if (canonicalPath(environment[key]) !== canonicalPath(path))
      throw Error("Unproven packaged query HOME");
    env[key] = environment[key];
  }
  return env;
}

function checkFixedExecutable(path) {
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    canonicalPath(realpathSync.native(path)) !== canonicalPath(path)
  )
    throw Error("Fixed query executable unavailable");
}

/** One call at the driver after existing cleanup. Unknown never changes original acceptance. */
export function collectPackagedMainCrashEvidence(
  options,
  {
    platform = process.platform,
    arch = process.arch,
    query = execFileSync,
    verifyExecutable = checkFixedExecutable,
    readSource = sourceBytes,
  } = {},
) {
  const result = {
    schemaVersion: 1,
    ...unknown("unproven-failed-packaged-main"),
    queried: false,
    queryTimeoutMs: TIMEOUT,
    maxEventsPerProvider: 8,
    boundary:
      "Passive exact Main event association only; not fault causality, repaired launch, normal exit or OS restoration. No raw events, Message, XML, arguments, path or environment retained.",
  };
  try {
    if (platform !== "win32" || arch !== "x64")
      return { ...result, reason: "unsupported-platform" };
    const target = checkedTarget(options);
    result.reason = "unproven-query-isolation";
    const env = queryEnvironment(options.environment, options.context.home);
    result.reason = "unproven-diagnostic-source";
    const pins = capturePackagedMainDiagnosticSources(readSource);
    if (
      Object.keys(options.sourcePins ?? {})
        .sort()
        .join(",") !== Object.keys(pins).sort().join(",") ||
      Object.entries(pins).some(([key, value]) => options.sourcePins[key] !== value)
    )
      return result;
    result.sourcePins = pins;
    result.sourceHead = options.ci.GITHUB_SHA;
    result.run = options.ci.GITHUB_RUN_ID;
    result.executableSHA256 = options.context.executableSHA256;
    const executable = win32.join(
      win32.parse(env.SystemRoot).root,
      "Program Files",
      "PowerShell",
      "7",
      "pwsh.exe",
    );
    result.reason = "query-executable-unavailable";
    verifyExecutable(executable);
    const script = readSource(SCRIPT);
    if (script.length > MAX_BYTES || sha(script) !== pins.script)
      return { ...result, reason: "unproven-diagnostic-source" };
    result.scriptSHA256 = pins.script;
    result.queried = true;
    const output = query(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", SCRIPT],
      {
        input: JSON.stringify({
          pid: target.pid,
          path: target.path,
          fileTime: target.fileTime,
          observedFileTime: windowsBirthToFileTime(target.observedAt),
        }),
        env,
        encoding: "utf8",
        timeout: TIMEOUT,
        maxBuffer: MAX_BYTES,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    return { ...result, ...matchNsisCrashEvents(output, target) };
  } catch (error) {
    if (!result.queried) return result;
    let code;
    try {
      code = error?.code;
    } catch {
      /* Never replace the first launch error. */
    }
    return {
      ...result,
      reason:
        code === "ETIMEDOUT"
          ? "query-timeout"
          : code === "EACCES"
            ? "permission"
            : code === "ENOBUFS"
              ? "output-limit"
              : "query-failed",
    };
  }
}
