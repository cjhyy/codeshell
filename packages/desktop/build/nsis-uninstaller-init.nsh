; RMDir cannot remove the current working directory.
; Leave $INSTDIR after electron-builder initializes the uninstall mode.
!macro customUnInit
  SetOutPath "$TEMP"
!macroend

# These early assisted hooks must run before the vendor install-mode page macros.
!ifdef ONE_CLICK
  !error "The safe per-user override requires the assisted installer."
!endif
!ifdef INSTALL_MODE_PER_ALL_USERS
  !error "The safe per-user override requires the per-user install-mode page."
!endif
!ifdef removeDefaultUninstallWelcomePage
  !error "The safe per-user override requires the default uninstall welcome hook."
!endif

!macro customWelcomePage
  !include "nsis-safe-per-user-install-mode.nsh"
!macroend

!macro customUnWelcomePage
  !include "nsis-safe-per-user-install-mode.nsh"
  !insertmacro MUI_UNPAGE_WELCOME
!macroend
