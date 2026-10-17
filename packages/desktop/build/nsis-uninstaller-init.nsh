; RMDir cannot remove the current working directory.
; Leave $INSTDIR after electron-builder initializes the uninstall mode.
!macro customUnInit
  SetOutPath "$TEMP"
!macroend
