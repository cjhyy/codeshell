# Backport electron-builder a356198ec7c54c7795659342bff36d9a5162cd93 (#9769).
# Retire after the bundled multiUser.nsh has the reviewed bounded copy.
!ifndef CODESHELL_SAFE_PER_USER_INSTALL_MODE
!define CODESHELL_SAFE_PER_USER_INSTALL_MODE
!macroundef setInstallModePerUser
  !macro setInstallModePerUser
    StrCpy $installMode CurrentUser
    SetShellVarContext current

    # сhecks registry for previous installation path
    ReadRegStr $perUserInstallationFolder HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $perUserInstallationFolder != ""
      StrCpy $INSTDIR $perUserInstallationFolder
    ${else}
      StrCpy $0 "$LocalAppData\Programs"
      Push $1
      Push $2
      # UserProgramFiles can be redirected on supported Windows versions.
      StrCpy $2 0
      System::Call 'SHELL32::SHGetKnownFolderPath(g "${FOLDERID_UserProgramFiles}", i ${KF_FLAG_CREATE}, p 0, *p .r2)i.r1'
      ${If} $1 == 0
        System::Call 'KERNEL32::lstrcpynW(w .r0, p r2, i ${NSIS_MAX_STRLEN})p'
      ${endif}
      # The Shell may allocate the output even when lookup fails.
      ${If} $2 != 0
        System::Call 'OLE32::CoTaskMemFree(p r2)'
      ${endif}
      Pop $2
      Pop $1
      StrCpy $INSTDIR "$0\${APP_FILENAME}"
    ${endif}

    # allow /D switch to override installation path https://github.com/electron-userland/electron-builder/issues/1551
    ${StdUtils.GetParameter} $R0 "D" ""
    ${If} $R0 != ""
      StrCpy $INSTDIR $R0
    ${endif}

  !macroend
!endif
