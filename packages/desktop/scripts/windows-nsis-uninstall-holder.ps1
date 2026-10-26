param(
  [string]$Nonce,
  [string]$Target,
  [string]$InstallDir
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$process = $null
$started = $false
$reader = $null
$stdoutTask = $null
$stderrTask = $null
$exitCode = 2
$failureCode = 'protocol'

function Emit([string]$event, [hashtable]$fields = @{}) {
  $row = @{ v = 1; event = $event; nonce = $Nonce }
  foreach ($key in $fields.Keys) { $row[$key] = $fields[$key] }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $row -Compress))
  [Console]::Out.Flush()
}

function Stop-Target([string]$reason) {
  $targetExited = $false
  try {
    if ($null -ne $process -and $started) {
      $process.Kill($true)
      $targetExited = $process.WaitForExit(5000)
    }
  } catch {
    try { $targetExited = $process.WaitForExit(0) } catch { $targetExited = $false }
  }
  Emit 'stopped' @{ reason = $reason; targetExited = [bool]$targetExited }
}

function Assert-Drains {
  foreach ($task in @($stdoutTask, $stderrTask)) {
    if ($task.IsCompleted -and -not $task.GetAwaiter().GetResult()) { throw 'handle-failed' }
  }
}

try {
  if ($args.Count -ne 0 -or $Nonce -cnotmatch '^[a-f0-9]{32}$' -or
      $Target -notmatch '^[A-Za-z]:\\[^\r\n\x00]+$' -or
      $InstallDir -notmatch '^[A-Za-z]:\\[A-Za-z0-9_.\\-]+$' -or
      [IO.Path]::GetFullPath($Target) -cne $Target -or
      [IO.Path]::GetFullPath($InstallDir) -cne $InstallDir) { throw 'protocol' }

  # Console.In is a SyncTextReader: its ReadLineAsync blocks synchronously.
  # One ordinary reader must own both START and STOP, including read-ahead.
  $reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false, $true))
  Emit 'ready' @{ pid = $PID }
  $line = $reader.ReadLine()
  if ($null -eq $line) { Emit 'aborted'; $exitCode = 4 }
  elseif ($line -cne "START $Nonce") { throw 'protocol' }
  else {
    if (-not [IO.File]::Exists($Target)) { $failureCode = 'target-missing'; throw 'target-missing' }
    # Catch CopyToAsync failures inside an async method, so even a pending drain
    # is observed without PowerShell scriptblock continuations on foreign threads.
    Add-Type -TypeDefinition @'
using System.IO;
using System.Threading.Tasks;
public static class NsisUninstallIo {
  public static async Task<bool> Discard(Stream source) {
    try { await source.CopyToAsync(System.IO.Stream.Null).ConfigureAwait(false); return true; }
    catch { return false; }
  }
  public static async Task<string> ReadLineAsync(StreamReader reader) {
    try { return await reader.ReadLineAsync().ConfigureAwait(false); }
    catch { return "\0READ_ERROR"; }
  }
}
'@
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $Target
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    $info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $info.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $info.ArgumentList.Add('/S')
    $info.ArgumentList.Add('/currentuser')
    $info.ArgumentList.Add("_?=$InstallDir")
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    $failureCode = 'start-failed'
    if (-not $process.Start()) { throw 'start-failed' }
    $started = $true
    $failureCode = 'handle-failed'
    $process.StandardInput.Close()
    $stdoutTask = [NsisUninstallIo]::Discard($process.StandardOutput.BaseStream)
    $stderrTask = [NsisUninstallIo]::Discard($process.StandardError.BaseStream)
    $handle = $process.SafeHandle
    if ($handle.IsInvalid -or $handle.IsClosed) { throw 'handle-failed' }
    $targetPid = $process.Id
    $birth = $process.StartTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    # Windows .NET StartTime uses GetProcessTimes on the retained CreateProcess
    # handle with throwIfExited:false. A zero-duration target is still identified.
    Emit 'target' @{ pid = $targetPid; ppid = $PID; birth = $birth }
    $lineTask = [NsisUninstallIo]::ReadLineAsync($reader)
    $finished = $false
    while (-not $finished) {
      Assert-Drains
      if ($lineTask.IsCompleted) {
        $command = $lineTask.GetAwaiter().GetResult()
        if ($null -eq $command -or $command -ceq "STOP $Nonce") {
          $reason = if ($null -eq $command) { 'eof' } else { 'stop' }
          Stop-Target $reason
          $exitCode = 3
          $finished = $true
        } else { $failureCode = 'protocol'; throw 'protocol' }
      } elseif ($process.WaitForExit(200)) {
        Assert-Drains
        Emit 'exit' @{ code = $process.ExitCode }
        $exitCode = 0
        $finished = $true
      }
    }
  }
} catch {
  if ($started) { try { Stop-Target 'error' } catch { } }
  try { Emit 'error' @{ code = $failureCode } } catch { }
  $exitCode = 2
} finally {
  if ($null -ne $process) { $process.Dispose() }
  if ($null -ne $reader) { $reader.Dispose() }
}
exit $exitCode
