# Single pixels-only collector for a fresh disposable hosted Windows VM.
# No window discovery, text API, input, activation, dismissal or process query.
param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$bitmap = $null; $graphics = $null; $memory = $null; $file = $null
try {
  if ([Console]::In.ReadLine() -cne 'CAPTURE1') { throw 'gate' }
  if ($OutputPath.Length -ge 180 -or $OutputPath -notmatch '^[A-Za-z]:\\[A-Za-z0-9_.\\-]+$' -or
      [IO.Path]::GetFullPath($OutputPath) -cne $OutputPath -or
      [IO.Path]::GetFileName($OutputPath) -cne 'desktop.png') { throw 'path' }
  foreach ($part in $OutputPath.Substring(3).Split('\')) {
    if (!$part -or $part -match '[. ]$' -or
        $part -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') { throw 'alias' }
  }
  $parent = [IO.Path]::GetDirectoryName($OutputPath)
  if ([IO.Path]::GetFileName($parent) -cne 'replacement-desktop-observation') { throw 'parent' }
  $depth = 0
  while ($parent) {
    $depth += 1
    if ($depth -gt 40) { throw 'parent-cap' }
    $item = Get-Item -LiteralPath $parent -Force
    if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'reparse' }
    $next = [IO.Path]::GetDirectoryName($parent)
    if ($next -eq $parent) { break }
    $parent = $next
  }
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $bounds = [Windows.Forms.Screen]::PrimaryScreen.Bounds
  if ($bounds.Width -lt 1 -or $bounds.Height -lt 1 -or $bounds.Width -gt 4096 -or
      $bounds.Height -gt 2160 -or ([long]$bounds.Width * $bounds.Height) -gt 8847360) { throw 'screen-cap' }
  $bitmap = [Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size)
  $memory = [IO.MemoryStream]::new()
  $bitmap.Save($memory, [Drawing.Imaging.ImageFormat]::Png)
  if ($memory.Length -lt 1 -or $memory.Length -gt 8388608) { throw 'png-cap' }
  # CreateNew cannot overwrite a preexisting leaf. Never delete on any failure.
  $file = [IO.File]::Open($OutputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  $memory.Position = 0
  $memory.CopyTo($file)
  $file.Dispose(); $file = $null
  [Console]::Out.WriteLine(([ordered]@{ status='observed'; scope='primary-desktop';
    width=$bounds.Width; height=$bounds.Height; bytes=$memory.Length } | ConvertTo-Json -Compress))
} catch {
  # No arbitrary exception, path, window title or text in stdout/stderr.
  [Console]::Out.WriteLine('{"status":"unknown","reason":"capture-failed"}')
} finally {
  if ($file) { $file.Dispose() }
  if ($memory) { $memory.Dispose() }
  if ($graphics) { $graphics.Dispose() }
  if ($bitmap) { $bitmap.Dispose() }
}
