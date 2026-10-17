# Read only product-scoped observations. Never invokes an installer, writes the
# registry/shortcut, enumerates credentials, or uses environment HOME as a hive.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CodeShellOwnedKnownFolder {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
  private static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);
  public static string Read(string id) {
    Guid guid = new Guid(id); IntPtr path;
    // DONT_VERIFY obtains the assigned path without CREATE or creating folders.
    int result = SHGetKnownFolderPath(ref guid, 0x4000, IntPtr.Zero, out path);
    if (result != 0) Marshal.ThrowExceptionForHR(result);
    try { return Marshal.PtrToStringUni(path); }
    finally { Marshal.FreeCoTaskMem(path); }
  }
}
'@
$folders = [ordered]@{
  desktop = [CodeShellOwnedKnownFolder]::Read('B4BFCC3A-DB2C-424C-B029-7FE99A87C641')
  programs = [CodeShellOwnedKnownFolder]::Read('A77F5D77-2E2B-44C3-A6A2-ABA601054A51')
  local = [CodeShellOwnedKnownFolder]::Read('F1B32785-6FBA-4FCF-9D55-7B8E7F157091')
  userPrograms = [CodeShellOwnedKnownFolder]::Read('5CD7AEE2-2219-4A67-B85D-6C9CE15660CB')
  machine32 = [CodeShellOwnedKnownFolder]::Read('7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E')
  machine64 = [CodeShellOwnedKnownFolder]::Read('6D809377-6AF0-444B-8957-A3773F02200E')
}
function Assert-PlainParents([string]$path) {
  $parent = [IO.Path]::GetDirectoryName($path)
  while ($parent) {
    if (Test-Path -LiteralPath $parent) {
      $item = Get-Item -LiteralPath $parent -Force
      if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Non-plain product path parent'
      }
    }
    $next = [IO.Path]::GetDirectoryName($parent)
    if ($next -eq $parent) { break }
    $parent = $next
  }
}
function Read-ProductPath([string]$path, [bool]$shortcut = $false) {
  Assert-PlainParents $path
  $result = [ordered]@{ path = $path; parentsPlain = $true; kind = 'absent' }
  if (Test-Path -LiteralPath $path) {
    $item = Get-Item -LiteralPath $path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $result.kind = 'reparse' }
    elseif ($item.PSIsContainer) { $result.kind = 'directory' }
    else {
      $result.kind = 'file'
      if ($shortcut) {
        $shell = New-Object -ComObject WScript.Shell
        $link = $shell.CreateShortcut($path)
        $result.target = $link.TargetPath
        $result.arguments = $link.Arguments
        $explorer = New-Object -ComObject Shell.Application
        $folder = $explorer.NameSpace([IO.Path]::GetDirectoryName($path))
        $result.appId = $folder.ParseName([IO.Path]::GetFileName($path)).ExtendedProperty('System.AppUserModel.ID')
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link)
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($folder)
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($explorer)
      }
    }
  }
  return $result
}
$paths = [ordered]@{
  desktop = Read-ProductPath (Join-Path $folders.desktop 'code-shell.lnk') $true
  startMenu = Read-ProductPath (Join-Path $folders.programs 'code-shell.lnk') $true
  cache = Read-ProductPath (Join-Path $folders.local '@cjhyycode-shell-desktop-updater')
  userDefault = Read-ProductPath (Join-Path $folders.userPrograms 'code-shell')
  machine32 = Read-ProductPath (Join-Path $folders.machine32 'code-shell')
  machine64 = Read-ProductPath (Join-Path $folders.machine64 'code-shell')
}
$guid = 'e769f1fe-3645-5ce2-ae3e-b8919c42060e'
$registry = @(
  foreach ($hive in @('CurrentUser', 'LocalMachine')) {
    foreach ($view in @('Registry32', 'Registry64')) {
      foreach ($key in @("Software\$guid", "Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid")) {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
          [Microsoft.Win32.RegistryHive]::$hive, [Microsoft.Win32.RegistryView]::$view)
        $opened = $null
        try {
          $opened = $base.OpenSubKey($key, $false)
          $values = $null
          if ($null -ne $opened) {
            $names = if ($key.Contains('\Uninstall\')) {
              @('DisplayName','DisplayVersion','UninstallString','QuietUninstallString','DisplayIcon')
            } else { @('InstallLocation','KeepShortcuts','ShortcutName') }
            $values = [ordered]@{}
            foreach ($name in $names) { $values[$name] = $opened.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
          }
          [ordered]@{ hive = $hive; view = $view; key = $key; present = ($null -ne $opened); values = $values }
        } finally {
          if ($null -ne $opened) { $opened.Dispose() }
          $base.Dispose()
        }
      }
    }
  }
)
# All users, not only the current username used by NSIS's own name-based taskkill.
$processes = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'code-shell.exe'" |
  ForEach-Object { [ordered]@{ pid = [long]$_.ProcessId; ppid = [long]$_.ParentProcessId; name = $_.Name } })
ConvertTo-Json -Depth 8 -Compress -InputObject ([ordered]@{
  knownFolders = $folders; paths = $paths; registry = $registry; processes = $processes
})
