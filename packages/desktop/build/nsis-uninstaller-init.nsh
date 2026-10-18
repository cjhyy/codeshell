; RMDir cannot remove the current working directory.
; Leave $INSTDIR after electron-builder initializes the uninstall mode.
!macro customUnInit
  SetOutPath "$TEMP"
!macroend

# Assisted mode expands this hook before its per-user install/uninstall paths.
!macro customInstallMode
  !include "nsis-safe-per-user-install-mode.nsh"
!macroend
