; Modified November 23, 2026: opt-in Windows 10 22H2 admission with warning.
Unicode true
!include "MUI2.nsh"
!include "x64.nsh"
!ifdef NOD_EXPERIMENTAL_WINDOWS10
  !define NOD_INSTALL_KEY "nod-win10-experiment"
  !define NOD_DISPLAY_NAME "Nod Windows 10 Experiment"
  !define NOD_PUBLISHER "Unofficial source build"
!else
  !define NOD_INSTALL_KEY "nod"
  !define NOD_DISPLAY_NAME "Nod"
  !define NOD_PUBLISHER "n8n GmbH"
!endif
Name "${NOD_DISPLAY_NAME}"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\${NOD_INSTALL_KEY}"
InstallDirRegKey HKCU "Software\${NOD_INSTALL_KEY}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID zlib
!ifdef SIGNER
  !uninstfinalize '"${NODE}" "${SIGNER}" "%1"' = 0
!endif
ShowInstDetails hide
AutoCloseWindow true
!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${IsNativeAMD64}
    MessageBox MB_ICONSTOP "Nod needs an x64 computer." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  ReadRegStr $0 HKLM "Software\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  !ifdef NOD_EXPERIMENTAL_WINDOWS10
    ${If} $0 < 19045
      MessageBox MB_ICONSTOP "This experimental build needs Windows 10 22H2 x64 or later." /SD IDOK
      SetErrorLevel 1
      Abort
    ${EndIf}
    ${If} $0 < 22000
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "Experimental Windows 10 build. Runtime compatibility has not been verified. WSL 2 is still required. Select OK only to try this unsupported build." /SD IDCANCEL IDOK experimental_continue
      SetErrorLevel 1
      Abort
      experimental_continue:
    ${EndIf}
  !else
    ${If} $0 < 22000
      MessageBox MB_ICONSTOP "Nod needs Windows 11 or later." /SD IDOK
      SetErrorLevel 1
      Abort
    ${EndIf}
  !endif
FunctionEnd

Function .onInstSuccess
  IfSilent installed
  !ifndef NOD_EXPERIMENTAL_WINDOWS10
    Exec '"$INSTDIR\nod.exe"'
  !endif
  installed:
FunctionEnd

Function CheckInstallDirectory
  IfFileExists "$INSTDIR\.nod-installation" directory_ready
  FindFirst $0 $1 "$INSTDIR\*"
  directory_next:
    StrCmp $1 "" directory_empty
    StrCmp $1 "." directory_continue
    StrCmp $1 ".." directory_continue
    FindClose $0
    MessageBox MB_ICONSTOP "Choose an empty folder for Nod. The selected folder contains other files." /SD IDOK
    SetErrorLevel 1
    Abort
  directory_continue:
    FindNext $0 $1
    Goto directory_next
  directory_empty:
    FindClose $0
  directory_ready:
    ClearErrors
FunctionEnd

Function .onVerifyInstDir
  Call CheckInstallDirectory
FunctionEnd

!macro CLOSE_NOD UN
Function ${UN}CloseNod
  IfFileExists "$INSTDIR\nod.exe" 0 nod_closed
  StrCpy $1 0
  nod_check:
    ClearErrors
    FileOpen $0 "$INSTDIR\nod.exe" a
    IfErrors nod_running
    FileClose $0
    Goto nod_closed
  nod_running:
    IntCmp $1 0 0 nod_wait nod_wait
    MessageBox MB_OKCANCEL|MB_ICONINFORMATION "Nod is still running. Select OK to quit Nod and continue." /SD IDOK IDOK nod_quit
    SetErrorLevel 1
    Abort
  nod_quit:
    DetailPrint "Waiting for Nod to quit..."
    Exec '"$INSTDIR\nod.exe" --quit'
  nod_wait:
    IntOp $1 $1 + 1
    IntCmp $1 240 nod_stuck 0 nod_stuck
    Sleep 500
    Goto nod_check
  nod_stuck:
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Nod is still running. Select its icon at the right of the taskbar, choose Quit Nod, then select Retry." /SD IDCANCEL IDRETRY nod_retry
    SetErrorLevel 1
    Abort
  nod_retry:
    StrCpy $1 1
    Goto nod_check
  nod_closed:
  ClearErrors
FunctionEnd
!macroend
!insertmacro CLOSE_NOD ""
!insertmacro CLOSE_NOD "un."

Section "nod"
  Call CheckInstallDirectory
  Call CloseNod
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  FileOpen $0 "$INSTDIR\.nod-installation" w
  FileWrite $0 "${NOD_INSTALL_KEY}-win32-x64"
  FileClose $0
  IfErrors 0 directory_marked
    SetErrorLevel 1
    Abort
  directory_marked:
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR\previous-resources"
  IfFileExists "$INSTDIR\resources\*.*" 0 resources_moved
    ClearErrors
    Rename "$INSTDIR\resources" "$INSTDIR\previous-resources"
    IfErrors 0 resources_moved
      MessageBox MB_ICONSTOP "Nod could not replace the files of its previous version. Close any program that has files open in the Nod folder, then run this installer again." /SD IDOK
      SetErrorLevel 1
      Abort
  resources_moved:
  File /r "${APP_DIR}\*"
  Rename "$INSTDIR\previous-resources\engine\windows-runtime\guest.tar.gz" "$INSTDIR\resources\engine\windows-runtime\guest.tar.gz"
  RMDir /r "$INSTDIR\previous-resources"
  IfFileExists "$EXEDIR\nod-Runtime-win32-x64.tar.gz" 0 runtime_copied
    ClearErrors
    CopyFiles /SILENT "$EXEDIR\nod-Runtime-win32-x64.tar.gz" "$INSTDIR\resources\engine\windows-runtime\guest.tar.gz"
    IfErrors 0 runtime_copied
      MessageBox MB_ICONSTOP "Nod could not copy its runtime. Check free disk space, then run this installer again." /SD IDOK
      SetErrorLevel 1
      Abort
  runtime_copied:
  CreateDirectory "$SMPROGRAMS\${NOD_DISPLAY_NAME}"
  CreateShortcut "$SMPROGRAMS\${NOD_DISPLAY_NAME}\${NOD_DISPLAY_NAME}.lnk" "$INSTDIR\nod.exe"
  CreateShortcut "$SMPROGRAMS\${NOD_DISPLAY_NAME}\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\${NOD_DISPLAY_NAME}.lnk" "$INSTDIR\nod.exe"
  WriteRegStr HKCU "Software\${NOD_INSTALL_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NOD_INSTALL_KEY}" "DisplayName" "${NOD_DISPLAY_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NOD_INSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NOD_INSTALL_KEY}" "Publisher" "${NOD_PUBLISHER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NOD_INSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NOD_INSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NOD_INSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Call un.CloseNod
  SetShellVarContext current
  Delete "$DESKTOP\${NOD_DISPLAY_NAME}.lnk"
  Delete "$SMPROGRAMS\${NOD_DISPLAY_NAME}\${NOD_DISPLAY_NAME}.lnk"
  Delete "$SMPROGRAMS\${NOD_DISPLAY_NAME}\Uninstall.lnk"
  RMDir "$SMPROGRAMS\${NOD_DISPLAY_NAME}"
  IfFileExists "$INSTDIR\.nod-installation" 0 files_removed
    RMDir /r "$INSTDIR"
  files_removed:
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NOD_INSTALL_KEY}"
  DeleteRegKey HKCU "Software\${NOD_INSTALL_KEY}"
SectionEnd
