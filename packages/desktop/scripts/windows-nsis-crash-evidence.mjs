/** Passive diagnostic only. No event result grants process or installer authority. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./windows-nsis-crash-evidence.ps1", import.meta.url));
const MAX_BYTES = 64 * 1024;
const MAX_EVENTS = 8;
const TIMEOUT = 30_000;
const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HEX32 = /^(?:0x)?[a-f0-9]{1,8}$/i;
const HEX64 = /^(?:0x)?[a-f0-9]{1,16}$/i;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const unknown = (reason) => ({ status: "unknown", reason });
const exactKeys = (row, keys) =>
  row &&
  typeof row === "object" &&
  !Array.isArray(row) &&
  Object.keys(row).sort().join(",") === keys.sort().join(",");

/** CIM supplies seven fractional digits; Date milliseconds alone lose birth identity. */
export function windowsBirthToFileTime(birth) {
  if (typeof birth !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(birth))
    throw Error("Invalid complete Windows birth");
  const prefix = birth.slice(0, 19);
  const seconds = Date.parse(`${prefix}.000Z`);
  if (!Number.isFinite(seconds) || new Date(seconds).toISOString() !== `${prefix}.000Z`)
    throw Error("Invalid complete Windows birth");
  const ticks = BigInt(seconds) * 10_000n + BigInt(birth.slice(20, 27)) + 116_444_736_000_000_000n;
  if (ticks < 0n) throw Error("Invalid complete Windows birth");
  return ticks.toString();
}

function utcTicks(value) {
  return BigInt(windowsBirthToFileTime(value));
}
function unsigned(value, max, expression) {
  if (typeof value !== "string" || !expression.test(value)) throw Error("Invalid integer");
  const actual = /^0x/i.test(value) ? BigInt(value) : BigInt(`0x${value}`);
  if (actual > max) throw Error("Invalid integer");
  return actual;
}
function canonicalPath(value) {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    !/^[a-z]:\\[^\r\n\0]+$/i.test(value) ||
    win32.normalize(value) !== value ||
    value.split("\\").some((part) => /[. ]$/.test(part))
  )
    throw Error("Invalid owned executable path");
  return value.toLowerCase();
}

function checkedTarget({ operation, installer, root, observedAt, ci }) {
  if (
    ci?.runner !== "github-hosted/windows-2022/x64" ||
    !/^[1-9]\d{0,19}$/.test(ci.run ?? "") ||
    !/^[a-f0-9]{40}$/.test(ci.source ?? "") ||
    operation?.label !== "install" ||
    operation.status !== "failed" ||
    !Number.isSafeInteger(operation.result?.code) ||
    operation.result.code === 0 ||
    operation.result.signal !== null ||
    operation.exitObserved?.code !== operation.result.code ||
    operation.exitObserved?.signal !== null ||
    operation.cachedExit?.code !== operation.result.code ||
    operation.cachedExit?.signal !== null ||
    operation.errors?.length !== 0 ||
    operation.signalRequests?.length !== 0 ||
    operation.settlement?.status !== "cleaned" ||
    operation.settlement.queryFailed !== false ||
    operation.settlement.evidenceTruncated !== false ||
    operation.settlement.remainingCount !== 0 ||
    operation.settlement.remaining?.length !== 0
  )
    throw Error("Unproven failed installer boundary");
  const { pid, ppid, birth } = operation.child ?? {};
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    pid > 0xffff_ffff ||
    !Number.isSafeInteger(ppid) ||
    ppid <= 0 ||
    ppid > 0xffff_ffff
  )
    throw Error("Unproven failed installer identity");
  const settlement = operation.settlement;
  if (
    !Array.isArray(settlement.owned) ||
    settlement.ownedCount !== settlement.owned.length ||
    !settlement.owned.some((row) => row.pid === pid && row.ppid === ppid && row.birth === birth)
  )
    throw Error("Unproven failed installer birth");
  const path = canonicalPath(installer?.path);
  if (
    canonicalPath(operation.command?.executable) !== path ||
    canonicalPath(win32.dirname(installer.path)) !== canonicalPath(win32.join(root, "artifacts")) ||
    !/^[a-f0-9]{64}$/.test(installer.sha256 ?? "") ||
    operation.command.sha256 !== installer.sha256 ||
    !Number.isSafeInteger(installer.size) ||
    installer.size <= 0 ||
    operation.command.size !== installer.size
  )
    throw Error("Unproven owned installer pin");
  const start = utcTicks(birth),
    end = utcTicks(observedAt);
  if (end < start || end - start > 600n * 10_000_000n) throw Error("Invalid diagnostic window");
  return { pid, birth, fileTime: start.toString(), path: installer.path, observedAt };
}

/** Input is the ephemeral, bounded projection from our PS script, never raw XML/Message.
 * Identity fields are consumed here and are excluded from the public result. */
export function matchNsisCrashEvents(output, target) {
  try {
    if (typeof output !== "string" || Buffer.byteLength(output) > MAX_BYTES)
      return unknown("output-limit");
    const data = JSON.parse(output.replace(/^\uFEFF/, ""));
    if (
      !exactKeys(data, ["schemaVersion", "queryStatus", "applicationErrors", "windowsErrors"]) ||
      data.schemaVersion !== 1
    )
      return unknown("invalid-projection");
    if (data.queryStatus !== "ok") {
      return unknown(
        ["permission", "event-limit", "event-shape", "query-failed", "input-invalid"].includes(
          data.queryStatus,
        )
          ? data.queryStatus
          : "invalid-projection",
      );
    }
    if (!Array.isArray(data.applicationErrors) || !Array.isArray(data.windowsErrors))
      return unknown("invalid-projection");
    if (data.applicationErrors.length > MAX_EVENTS || data.windowsErrors.length > MAX_EVENTS)
      return unknown("event-limit");
    if (data.applicationErrors.length === 0) return unknown("no-exact-application-event");
    const lower = canonicalPath(target.path);
    const matched = [];
    for (const row of data.applicationErrors) {
      if (
        !exactKeys(row, [
          "eventId",
          "provider",
          "eventUTC",
          "processId",
          "processCreationTime",
          "appPath",
          "exceptionCode",
          "moduleName",
          "faultingOffset",
          "reportId",
        ]) ||
        row.eventId !== 1000 ||
        row.provider !== "Application Error"
      )
        return unknown("invalid-projection");
      const eventAt = utcTicks(row.eventUTC);
      if (eventAt < utcTicks(target.birth) || eventAt > utcTicks(target.observedAt))
        return unknown("event-window-mismatch");
      if (
        unsigned(row.processId, 0xffff_ffffn, HEX32) !== BigInt(target.pid) ||
        unsigned(row.processCreationTime, 0xffff_ffff_ffff_ffffn, HEX64) !==
          BigInt(target.fileTime) ||
        canonicalPath(row.appPath) !== lower
      )
        return unknown("identity-mismatch");
      if (
        !HEX32.test(row.exceptionCode) ||
        !HEX64.test(row.faultingOffset) ||
        !GUID.test(row.reportId) ||
        row.reportId === "00000000-0000-0000-0000-000000000000" ||
        typeof row.moduleName !== "string" ||
        !/^[\p{L}\p{N}_. -]{1,128}$/u.test(row.moduleName) ||
        [".", ".."].includes(row.moduleName)
      )
        return unknown("invalid-projection");
      matched.push({
        eventUTC: row.eventUTC,
        exceptionCode: `0x${unsigned(row.exceptionCode, 0xffff_ffffn, HEX32).toString(16).padStart(8, "0")}`,
        moduleBasename: row.moduleName,
        faultingOffset: `0x${unsigned(row.faultingOffset, 0xffff_ffff_ffff_ffffn, HEX64).toString(16)}`,
        reportId: row.reportId.toLowerCase(),
      });
    }
    if (matched.length !== 1) return unknown("ambiguous-application-events");
    const event = matched[0];
    const related = [];
    for (const row of data.windowsErrors) {
      if (
        !exactKeys(row, ["eventId", "provider", "eventUTC", "reportId"]) ||
        row.eventId !== 1001 ||
        row.provider !== "Windows Error Reporting" ||
        !GUID.test(row.reportId)
      )
        return unknown("invalid-projection");
      const eventAt = utcTicks(row.eventUTC);
      if (
        eventAt < utcTicks(event.eventUTC) ||
        eventAt > utcTicks(target.observedAt) ||
        row.reportId.toLowerCase() !== event.reportId
      )
        return unknown("wer-association-mismatch");
      related.push({ eventUTC: row.eventUTC, reportId: row.reportId.toLowerCase() });
    }
    return {
      status: "matched",
      reason: "exact-application-error-event",
      applicationError: event,
      windowsErrorReporting:
        related.length === 1
          ? { status: "matched", ...related[0] }
          : unknown(related.length === 0 ? "no-related-event" : "ambiguous-related-events"),
    };
  } catch {
    return unknown("invalid-projection");
  }
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

/** Exactly one bounded, read-only native query, after existing custody cleanup.
 * Injected transport/file check exists solely for pure Node contracts, not a CLI bypass. */
export function collectNsisCrashEvidence(
  options,
  {
    platform = process.platform,
    query = execFileSync,
    verifyExecutable = checkFixedExecutable,
  } = {},
) {
  const result = {
    schemaVersion: 1,
    ...unknown("unproven-failed-installer"),
    queried: false,
    queryTimeoutMs: TIMEOUT,
    maxEventsPerProvider: MAX_EVENTS,
    boundary:
      "Passive event association only; not a faulting-module root cause, OS restoration or installer repair. Fixed read-only query timeout is not all-descendant custody. No raw events, Message, XML, path, arguments or environment are retained.",
  };
  try {
    if (platform !== "win32") return { ...result, reason: "unsupported-platform" };
    const target = checkedTarget(options);
    const root = options.environment?.SystemRoot ?? options.environment?.SYSTEMROOT;
    canonicalPath(root);
    const executable = win32.join(
      win32.parse(root).root,
      "Program Files",
      "PowerShell",
      "7",
      "pwsh.exe",
    );
    result.reason = "query-executable-unavailable";
    verifyExecutable(executable);
    result.reason = "script-unavailable";
    const script = readFileSync(SCRIPT);
    if (script.length > MAX_BYTES) return { ...result, reason: "script-limit" };
    result.scriptSHA256 = sha(script);
    result.installerSHA256 = options.installer.sha256;
    result.queried = true;
    const output = query(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", SCRIPT],
      {
        input: JSON.stringify(target),
        env: { SystemRoot: root, WINDIR: root, PATH: win32.join(root, "System32") },
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
      /* Native diagnostics cannot replace the original failure. */
    }
    const reason =
      code === "ETIMEDOUT"
        ? "query-timeout"
        : code === "EACCES"
          ? "permission"
          : code === "ENOBUFS"
            ? "output-limit"
            : "query-failed";
    return { ...result, reason };
  }
}
