import { execFileSync } from "node:child_process";
import { win32 } from "node:path";
import { performance } from "node:perf_hooks";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PROCESSES = 100_000;
const windowsQuery = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$rows = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate |
  Where-Object { $_.ProcessId -gt 0 -and $null -ne $_.CreationDate } |
  ForEach-Object {
    [PSCustomObject]@{
      ProcessId = [long]$_.ProcessId
      ParentProcessId = [long]$_.ParentProcessId
      CreationDate = $_.CreationDate.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    }
  })
ConvertTo-Json -InputObject $rows -Compress`;

function invalidSnapshot() {
  return Object.assign(new Error("Invalid Electron test process metadata snapshot"), {
    code: "ELECTRON_TEST_PROCESS_SNAPSHOT_INVALID",
  });
}

function boundedText(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_BYTES) throw invalidSnapshot();
  return value;
}

function checkedRows(rows) {
  if (rows.length > MAX_PROCESSES) throw invalidSnapshot();
  const seen = new Set();
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.pid) ||
      row.pid <= 0 ||
      row.pid > 0xffff_ffff ||
      !Number.isSafeInteger(row.ppid) ||
      row.ppid < 0 ||
      row.ppid > 0xffff_ffff ||
      seen.has(row.pid)
    )
      throw invalidSnapshot();
    seen.add(row.pid);
  }
  return rows;
}

export function parsePosixProcessSnapshot(output) {
  const rows = [];
  for (const line of boundedText(output).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match =
      /^\s*(\d+)\s+(\d+)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/.exec(
        line,
      );
    if (!match || !Number.isFinite(Date.parse(match[3]))) throw invalidSnapshot();
    // Some POSIX hosts expose a PID 0 kernel row; it is never a signalable child.
    if (Number(match[1]) === 0) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), birth: match[3] });
  }
  return checkedRows(rows);
}

export function parseWindowsProcessSnapshot(output) {
  let parsed;
  try {
    parsed = JSON.parse(boundedText(output).replace(/^\uFEFF/, ""));
  } catch {
    throw invalidSnapshot();
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_PROCESSES) throw invalidSnapshot();
  const rows = parsed.map((row) => {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      Object.keys(row).sort().join(",") !== "CreationDate,ParentProcessId,ProcessId" ||
      typeof row.CreationDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(row.CreationDate)
    )
      throw invalidSnapshot();
    const milliseconds = `${row.CreationDate.slice(0, 23)}Z`;
    const date = new Date(milliseconds);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== milliseconds)
      throw invalidSnapshot();
    return { pid: row.ProcessId, ppid: row.ParentProcessId, birth: row.CreationDate };
  });
  return checkedRows(rows);
}

/** Fixed commands query finite process identity only, never command lines or environments. */
export function snapshotElectronTestProcesses({
  platform = process.platform,
  environment = process.env,
  execFile = execFileSync,
} = {}) {
  let executable, args, env, timeout, parse;
  if (platform === "darwin" || platform === "linux") {
    executable = "/bin/ps";
    args = ["-axo", "pid=,ppid=,lstart="];
    env = { PATH: "/usr/bin:/bin", LC_ALL: "C" };
    timeout = 1_500;
    parse = parsePosixProcessSnapshot;
  } else if (platform === "win32") {
    const root = environment.SystemRoot ?? environment.SYSTEMROOT;
    if (
      typeof root !== "string" ||
      !/^[a-z]:[\\/]/i.test(root) ||
      /[\r\n\0]/.test(root) ||
      win32.normalize(root) !== root
    )
      throw new Error("Windows process metadata query requires a canonical SystemRoot");
    // Windows acceptance requires the fixed PowerShell 7 installation. The
    // legacy transport exceeded the fresh-query budget even after warmup;
    // neither a PATH search nor fallback can establish custody safely.
    executable = win32.join(win32.parse(root).root, "Program Files", "PowerShell", "7", "pwsh.exe");
    args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsQuery];
    env = { SystemRoot: root, WINDIR: root, PATH: win32.join(root, "System32") };
    timeout = 5_000;
    parse = parseWindowsProcessSnapshot;
  } else throw new Error("Unsupported Electron test process metadata platform");
  let output;
  const started = performance.now();
  try {
    output = execFile(executable, args, {
      env,
      encoding: "utf8",
      timeout,
      maxBuffer: MAX_BYTES,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // Never forward native stderr or a command's raw error into acceptance logs.
    const reason =
      error?.code === "ETIMEDOUT"
        ? "timeout"
        : error?.code === "ENOENT"
          ? "unavailable"
          : error?.code === "EACCES"
            ? "permission"
            : error?.code === "ENOBUFS"
              ? "output-limit"
              : Number.isInteger(error?.status)
                ? "native-exit"
                : "unknown";
    const elapsedMs = Math.round(performance.now() - started);
    throw Object.assign(
      new Error(`Cannot query Electron test process metadata (${reason}, ${elapsedMs}ms)`),
      { code: "ELECTRON_TEST_PROCESS_QUERY_FAILED", reason, elapsedMs },
    );
  }
  return parse(output);
}
