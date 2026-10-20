# Read-only Application log projection. Raw XML/Message never leaves this process.
# Field schema: Application Error/1000 process identity; WER/1001 ReportId only
# after the exact 1000 triple has been validated. Unsupported schemas stay unknown.
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$result = [ordered]@{ schemaVersion = 2; queryStatus = 'input-invalid'; applicationErrors = @(); windowsErrors = @(); accounting = $null }
function Stop-Projection([string]$reason) { throw [InvalidOperationException]::new($reason) }
function Read-Fields($event, [string[]]$names) {
  $text = $event.ToXml()
  if ($text.Length -gt 65536) { Stop-Projection 'event-shape' }
  $settings = [Xml.XmlReaderSettings]::new()
  $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
  $settings.XmlResolver = $null
  $settings.MaxCharactersInDocument = 65536
  $reader = [Xml.XmlReader]::Create([IO.StringReader]::new($text), $settings)
  try {
    $document = [Xml.XmlDocument]::new()
    $document.XmlResolver = $null
    $document.Load($reader)
    $fields = @{}
    foreach ($node in $document.Event.EventData.Data) {
      $name = [string]$node.Name
      if ($names -ccontains $name) {
        if ($fields.ContainsKey($name)) { Stop-Projection 'event-shape' }
        $value = [string]$node.InnerText
        if ($value.Length -gt 1024) { Stop-Projection 'event-shape' }
        $fields[$name] = $value
      }
    }
    foreach ($name in $names) {
      if (-not $fields.ContainsKey($name) -or $fields[$name].Length -eq 0) { Stop-Projection 'event-shape' }
    }
    return $fields
  } finally { $reader.Dispose() }
}
function Read-Events([string]$provider, [int]$id, $start, $end, [string]$reportId = '') {
  try {
    $filter = @{ LogName = 'Application'; ProviderName = $provider; Id = $id; StartTime = $start; EndTime = $end }
    if ($reportId.Length -gt 0) { $filter.ReportId = $reportId }
    $rows = @(Get-WinEvent -FilterHashtable $filter -MaxEvents 9 -ErrorAction Stop)
  } catch {
    if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { return @() }
    if ($_.Exception -is [UnauthorizedAccessException] -or $_.Exception -is [Security.SecurityException]) { Stop-Projection 'permission' }
    Stop-Projection 'query-failed'
  }
  if ($rows.Count -gt 8) { Stop-Projection 'event-limit' }
  return $rows
}
try {
  $raw = [Console]::In.ReadToEnd()
  if ($raw.Length -gt 4096) { Stop-Projection 'input-invalid' }
  $target = ConvertFrom-Json -InputObject $raw
  if ((@($target.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'fileTime,observedFileTime,path,pid') { Stop-Projection 'input-invalid' }
  # Decimal strings stay strings on all supported PS7 versions. Passing ISO
  # timestamps to ConvertFrom-Json would permit implicit DateTime conversion.
  if ($target.fileTime -isnot [string] -or $target.observedFileTime -isnot [string] -or $target.fileTime -notmatch '^\d{1,19}$' -or $target.observedFileTime -notmatch '^\d{1,19}$') { Stop-Projection 'input-invalid' }
  $start = [DateTime]::FromFileTimeUtc([long]::Parse($target.fileTime, [Globalization.CultureInfo]::InvariantCulture))
  $end = [DateTime]::FromFileTimeUtc([long]::Parse($target.observedFileTime, [Globalization.CultureInfo]::InvariantCulture))
  $pidExpected = [uint32]$target.pid
  $birthExpected = [uint64]::Parse($target.fileTime, [Globalization.CultureInfo]::InvariantCulture)
  if ($pidExpected -eq 0 -or $start.Kind -ne [DateTimeKind]::Utc -or $end.Kind -ne [DateTimeKind]::Utc -or $start.ToFileTimeUtc() -ne $birthExpected -or $end -lt $start -or ($end - $start).TotalSeconds -gt 600 -or $target.path -notmatch '^[A-Za-z]:\\[^\r\n\x00]+$') { Stop-Projection 'input-invalid' }
  $result.queryStatus = 'ok'
  $counts = [ordered]@{ providerRows = 0; rejectedPid = 0; rejectedBirth = 0; rejectedPath = 0; acceptedTriple = 0; sameMicrosecondDifferentBirth = 0 }
  $werQueried = $false
  $werProviderRows = 0
  $queryStartedUTC = [DateTime]::UtcNow.ToString('o')
  $application = @()
  foreach ($event in @(Read-Events 'Application Error' 1000 $start $end)) {
    $counts.providerRows++
    if ($event.Id -ne 1000 -or $event.ProviderName -cne 'Application Error' -or $null -eq $event.TimeCreated) { Stop-Projection 'event-shape' }
    $fields = Read-Fields $event @('ProcessId', 'ProcessCreationTime', 'AppPath', 'ExceptionCode', 'ModuleName', 'FaultingOffset', 'IntegratorReportId')
    if ($fields.ProcessId -notmatch '^(0x)?[0-9a-fA-F]{1,8}$' -or $fields.ProcessCreationTime -notmatch '^(0x)?[0-9a-fA-F]{1,16}$') { Stop-Projection 'event-shape' }
    $eventPid = [Convert]::ToUInt32(($fields.ProcessId -replace '^0x', ''), 16)
    $eventBirth = [Convert]::ToUInt64(($fields.ProcessCreationTime -replace '^0x', ''), 16)
    # Foreign identities are never projected; neither a PID nor an executable name suffices.
    if ($eventPid -ne $pidExpected -or $eventBirth -ne $birthExpected -or -not [string]::Equals($fields.AppPath, $target.path, [StringComparison]::OrdinalIgnoreCase)) {
      if ($eventPid -ne $pidExpected) { $counts.rejectedPid++ }
      elseif ($eventBirth -ne $birthExpected) {
        $counts.rejectedBirth++
        # Advisory only: exact positive decimal subtraction/remainder computes
        # floor(FILETIME/10) buckets without Double or an assumed rounding mode.
        # This branch remains rejected even for the same PID/path/microsecond.
        if ([string]::Equals($fields.AppPath, $target.path, [StringComparison]::OrdinalIgnoreCase)) {
          $eventBucket = [decimal]$eventBirth - [decimal]::Remainder([decimal]$eventBirth, [decimal]10)
          $expectedBucket = [decimal]$birthExpected - [decimal]::Remainder([decimal]$birthExpected, [decimal]10)
          if ($eventBucket -eq $expectedBucket) { $counts.sameMicrosecondDifferentBirth++ }
        }
      }
      else { $counts.rejectedPath++ }
      continue
    }
    if ($fields.ExceptionCode -notmatch '^(0x)?[0-9a-fA-F]{1,8}$' -or $fields.FaultingOffset -notmatch '^(0x)?[0-9a-fA-F]{1,16}$' -or $fields.ModuleName -notmatch '^[\p{L}\p{N}_. -]{1,128}$' -or @('.', '..') -ccontains $fields.ModuleName -or $fields.IntegratorReportId -notmatch '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' -or $fields.IntegratorReportId -eq '00000000-0000-0000-0000-000000000000' -or $event.TimeCreated.ToUniversalTime() -lt $start -or $event.TimeCreated.ToUniversalTime() -gt $end) { Stop-Projection 'event-shape' }
    $counts.acceptedTriple++
    $application += [ordered]@{
      eventId = 1000; provider = 'Application Error'; eventUTC = $event.TimeCreated.ToUniversalTime().ToString('o')
      processId = $fields.ProcessId; processCreationTime = $fields.ProcessCreationTime; appPath = $fields.AppPath
      exceptionCode = $fields.ExceptionCode; moduleName = $fields.ModuleName
      faultingOffset = $fields.FaultingOffset; reportId = $fields.IntegratorReportId
    }
  }
  $result.applicationErrors = $application
  # A 1001 without an already validated 1000 is not process-identity evidence.
  if ($application.Count -eq 1 -and $application[0].reportId -match '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$') {
    $werQueried = $true
    $wer = @()
    foreach ($event in @(Read-Events 'Windows Error Reporting' 1001 $start $end $application[0].reportId)) {
      $werProviderRows++
      if ($event.Id -ne 1001 -or $event.ProviderName -cne 'Windows Error Reporting' -or $null -eq $event.TimeCreated) { Stop-Projection 'event-shape' }
      $fields = Read-Fields $event @('ReportId')
      if ([string]::Equals($fields.ReportId, $application[0].reportId, [StringComparison]::OrdinalIgnoreCase)) {
        $wer += [ordered]@{ eventId = 1001; provider = 'Windows Error Reporting'; eventUTC = $event.TimeCreated.ToUniversalTime().ToString('o'); reportId = $fields.ReportId }
      }
    }
    $result.windowsErrors = $wer
  }
  $result.accounting = [ordered]@{
    windowStartUTC = $start.ToString('o'); windowEndUTC = $end.ToString('o')
    queryStartedUTC = $queryStartedUTC; queryFinishedUTC = [DateTime]::UtcNow.ToString('o')
    application = $counts; werQueried = $werQueried; werProviderRows = $werProviderRows
  }
} catch {
  $reason = $_.Exception.Message
  if (@('input-invalid', 'event-shape', 'event-limit', 'permission', 'query-failed') -cnotcontains $reason) { $reason = 'query-failed' }
  $result.queryStatus = $reason
  $result.applicationErrors = @()
  $result.windowsErrors = @()
}
$json = ConvertTo-Json -InputObject $result -Depth 6 -Compress
if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 65536) {
  $json = '{"schemaVersion":2,"queryStatus":"event-limit","applicationErrors":[],"windowsErrors":[],"accounting":null}'
}
[Console]::Out.Write($json)
