/** Advisory NSIS replacement roles from the watchdog's existing Windows query.
 * No role, path hint, or observer callback grants process custody or signaling authority. */
import { execFileSync } from "node:child_process";
import { win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { snapshotElectronTestProcesses } from "./electron-test-process-snapshot.mjs";

const MAX_ROLES = 32;
const MAX_SAMPLES = 8;
const MAX_EARLY_IDENTITIES = 32;
const MAX_EARLY_TRANSITIONS = 32;
const ROLES = new Set([
  "setup-path-match",
  "installed-uninstaller-path-match",
  "owned-temp-old-uninstaller-candidate",
  "unknown",
]);
const BOUNDARY =
  "Advisory lexical path roles from one existing CIM query; only already remembered, same-query PID/parent/full-birth matches. No image-load hash, window, delivery, or deadline-atomic observation.";

// Only this opt-in query requests ExecutablePath. The default query and its
// strict three-field parser remain in electron-test-process-snapshot.mjs.
// Paths stay inside this process/PowerShell transport, never in its stdout.
export const nsisReplacementRolesQuery = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$hints = $null
try { $hints = [Console]::In.ReadToEnd() | ConvertFrom-Json } catch { }
function Test-CanonicalRolePath($value) {
  if ($value -isnot [string] -or $value.Length -gt 2048 -or $value -notmatch '^[A-Za-z]:\\\\' -or $value -match '[\\x00-\\x1f/~]' -or $value -match '[. ](\\\\|$)') { return $false }
  try { return [IO.Path]::GetFullPath($value) -ceq $value } catch { return $false }
}
$rows = [Collections.Generic.List[object]]::new()
$roles = [Collections.Generic.List[object]]::new()
$truncated = $false
$processes = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath |
  Where-Object { $_.ProcessId -gt 0 -and $null -ne $_.CreationDate })
foreach ($item in $processes) {
  $birth = $item.CreationDate.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)
  $rows.Add([PSCustomObject]@{
    ProcessId = [long]$item.ProcessId
    ParentProcessId = [long]$item.ParentProcessId
    CreationDate = $birth
  })
  $role = 'unknown'
  try {
    $path = $item.ExecutablePath
    if ((Test-CanonicalRolePath $path) -and $null -ne $hints) {
      if ($null -ne $hints.setup -and $path -ceq $hints.setup) { $role = 'setup-path-match' }
      elseif ($null -ne $hints.uninstaller -and $path -ceq $hints.uninstaller) { $role = 'installed-uninstaller-path-match' }
      elseif ($null -ne $hints.temporary -and $path.StartsWith($hints.temporary + '\\', [StringComparison]::Ordinal) -and [IO.Path]::GetFileName($path) -ceq 'old-uninstaller.exe') { $role = 'owned-temp-old-uninstaller-candidate' }
    }
  } catch { $role = 'unknown' }
  if ($role -ne 'unknown') {
    if ($roles.Count -lt 32) {
      $roles.Add([PSCustomObject]@{ pid = [long]$item.ProcessId; ppid = [long]$item.ParentProcessId; birth = $birth; role = $role })
    } else { $truncated = $true }
  }
}
ConvertTo-Json -InputObject ([PSCustomObject]@{ processes = @($rows.ToArray()); roles = @($roles.ToArray()); truncated = $truncated }) -Depth 4 -Compress`;

function canonicalPath(value) {
  return (
    typeof value === "string" &&
    value.length <= 2048 &&
    /^[A-Za-z]:\\/.test(value) &&
    !/[\x00-\x1f/~]/.test(value) &&
    !/[. ](\\|$)/.test(value) &&
    win32.normalize(value) === value
  );
}

function roleHints({ root, setup, uninstaller, temporary } = {}) {
  const hints = { setup, uninstaller, temporary };
  // No alias resolution, disk access, or broad fallback. Ambiguous hints are unknown.
  if (
    !canonicalPath(root) ||
    !Object.values(hints).every(canonicalPath) ||
    temporary !== win32.join(root, "tmp") ||
    !setup.startsWith(win32.join(root, "artifacts") + "\\") ||
    !uninstaller.startsWith(root + "\\") ||
    setup === uninstaller ||
    setup.startsWith(temporary + "\\") ||
    uninstaller.startsWith(temporary + "\\")
  )
    return { setup: null, uninstaller: null, temporary: null };
  return hints;
}

function metadataFrom(value) {
  if (
    !Array.isArray(value.roles) ||
    value.roles.length > MAX_ROLES ||
    typeof value.truncated !== "boolean"
  )
    return null;
  const seen = new Set();
  for (const row of value.roles) {
    if (
      !row ||
      Object.keys(row).sort().join(",") !== "birth,pid,ppid,role" ||
      !Number.isSafeInteger(row.pid) ||
      row.pid <= 0 ||
      row.pid > 0xffff_ffff ||
      !Number.isSafeInteger(row.ppid) ||
      row.ppid < 0 ||
      row.ppid > 0xffff_ffff ||
      typeof row.birth !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(row.birth) ||
      !ROLES.has(row.role) ||
      seen.has(row.pid)
    )
      return null;
    seen.add(row.pid);
  }
  return value.roles;
}

/** The sole native effect is the original snapshot's one execFile invocation.
 * Its fixed executable/environment/5000ms/maxBuffer/error handling and original
 * authority parser are reused. The extra projection/JSON work is not zero-cost. */
export function createNsisReplacementRoleObserver({
  root,
  setup,
  uninstaller,
  temporary,
  environment,
  execFile = execFileSync,
  now = () => performance.now(),
} = {}) {
  const hints = roleHints({ root, setup, uninstaller, temporary });
  let started = 0;
  const result = {
    boundary: BOUNDARY,
    limits: { rolesPerSample: MAX_ROLES, samples: MAX_SAMPLES },
    samples: [],
    sampleCount: 0,
    samplesTruncated: false,
    observerFault: false,
    failureObservation: null,
    earlyRoles: {
      boundary:
        "First bounded same-query owned observations and role changes only; absence is not an exit, and lexical roles do not identify an image load or wait point.",
      limits: { identities: MAX_EARLY_IDENTITIES, transitions: MAX_EARLY_TRANSITIONS },
      firstObservations: [],
      transitions: [],
      identitiesTruncated: false,
      transitionsTruncated: false,
      sourceRowsTruncated: false,
      observerFault: false,
    },
  };
  const lastRoles = new Map();
  let transitionCount = 0;
  const rememberEarlyRoles = (sample, phase, rows, rolesTruncated) => {
    try {
      const history = result.earlyRoles;
      history.sourceRowsTruncated ||= rolesTruncated;
      for (const { pid, ppid, birth, role } of rows) {
        const key = `${pid}:${ppid}:${birth}`;
        const previous = lastRoles.get(key);
        const observation = {
          pid,
          ppid,
          birth,
          querySequence: sample.sequence,
          samplePhase: phase,
          sampledElapsedMs: sample.sampledElapsedMs,
        };
        if (previous === undefined) {
          if (lastRoles.size === MAX_EARLY_IDENTITIES) {
            history.identitiesTruncated = true;
            continue;
          }
          lastRoles.set(key, role);
          history.firstObservations.push({ ...observation, role });
        } else if (previous !== role) {
          lastRoles.set(key, role); // Private state never aliases a public receipt row.
          if (transitionCount === MAX_EARLY_TRANSITIONS) {
            history.transitionsTruncated = true;
            continue;
          }
          history.transitions.push({ ...observation, fromRole: previous, toRole: role });
          transitionCount += 1;
        }
      }
    } catch {
      try {
        result.earlyRoles.observerFault = true;
      } catch {
        /* Advisory history must not interrupt the original samples or cleanup. */
      }
    }
  };
  let pending = null;
  let sequence = 0;
  const fault = () => {
    result.observerFault = true;
  };
  try {
    started = now();
  } catch {
    fault();
  }
  const snapshot = () => {
    pending = null;
    let metadata = null;
    let metadataTruncated = false;
    const rows = snapshotElectronTestProcesses({
      platform: "win32",
      environment,
      execFile: (executable, args, options) => {
        const output = execFile(executable, [...args.slice(0, -1), nsisReplacementRolesQuery], {
          ...options,
          input: JSON.stringify(hints),
          stdio: ["pipe", "pipe", "pipe"],
        });
        // Authority failures still fail closed through the unchanged snapshot.
        if (typeof output !== "string" || Buffer.byteLength(output) > 8 * 1024 * 1024)
          throw Error("Invalid query envelope");
        const value = JSON.parse(output.replace(/^\uFEFF/, ""));
        if (!value || !Array.isArray(value.processes)) throw Error("Missing authority rows");
        try {
          metadata = metadataFrom(value);
          metadataTruncated = value.truncated === true;
          if (!metadata) fault();
        } catch {
          fault();
        }
        return JSON.stringify(value.processes);
      },
    });
    try {
      pending = {
        sequence: ++sequence,
        sampledElapsedMs: now() - started,
        metadata,
        metadataTruncated,
      };
    } catch {
      fault();
    }
    return rows;
  };
  const onOwnedSnapshot = ({ phase, ownedCurrent }) => {
    const sample = pending;
    pending = null; // A sidecar can be consumed only by this same synchronous query.
    try {
      if (!sample || !["initial", "watching", "cleaning"].includes(phase)) {
        fault();
        return;
      }
      const metadata = new Map((sample.metadata ?? []).map((row) => [row.pid, row]));
      const rows = ownedCurrent.slice(0, MAX_ROLES).map(({ pid, ppid, birth }) => {
        const hint = metadata.get(pid);
        const role =
          hint?.ppid === ppid && hint?.birth === birth && hints.setup !== null
            ? hint.role
            : "unknown";
        return { pid, ppid, birth, role };
      });
      result.samples.push({
        querySequence: sample.sequence,
        samplePhase: phase,
        sampledElapsedMs: sample.sampledElapsedMs,
        rows,
        rolesTruncated: sample.metadataTruncated || ownedCurrent.length > MAX_ROLES,
      });
      result.sampleCount += 1;
      if (result.samples.length > MAX_SAMPLES) {
        result.samples.shift();
        result.samplesTruncated = true;
      }
      rememberEarlyRoles(
        sample,
        phase,
        rows,
        sample.metadataTruncated || ownedCurrent.length > MAX_ROLES,
      );
    } catch {
      fault();
    }
  };
  const markFailure = () => {
    try {
      if (result.failureObservation) return;
      const last = result.samples.at(-1);
      result.failureObservation = {
        sampleQuerySequence: last?.querySequence ?? null,
        samplePhase: last?.samplePhase ?? "unknown",
        sampleAgeMs: last ? Math.max(0, now() - started - last.sampledElapsedMs) : null,
        sample: last
          ? {
              querySequence: last.querySequence,
              samplePhase: last.samplePhase,
              sampledElapsedMs: last.sampledElapsedMs,
              rows: last.rows.map(({ pid, ppid, birth, role }) => ({ pid, ppid, birth, role })),
              rolesTruncated: last.rolesTruncated,
            }
          : null,
        boundary:
          "After original watchdog failure recording; age of last existing-query sample, not an atomic deadline snapshot. Later cleaning samples may be after the deadline.",
      };
    } catch {
      fault();
    }
  };
  return { snapshot, onOwnedSnapshot, markFailure, receipt: result };
}
