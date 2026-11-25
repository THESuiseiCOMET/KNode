; Install exact notices into an explicit Unicode output directory.
!define KNODE_LICENSE_DIR "${__FILEDIR__}\..\licenses"
!define KNODE_PROJECT_LICENSE "${__FILEDIR__}\..\LICENSE"
!define KNODE_FRONTEND_LICENSES "${__FILEDIR__}\..\dist\FRONTEND-LICENSES.md"

!macro KNODE_LICENSE_FILES ACTION
  !insertmacro ${ACTION} "${KNODE_PROJECT_LICENSE}" "KNode-LICENSE.txt"
  !insertmacro ${ACTION} "${KNODE_LICENSE_DIR}\ELKJS-LICENSE.md" "ELKJS-LICENSE.md"
  !insertmacro ${ACTION} "${KNODE_LICENSE_DIR}\ELKJS-COPYRIGHT.txt" "ELKJS-COPYRIGHT.txt"
  !insertmacro ${ACTION} "${KNODE_LICENSE_DIR}\Lucide-LICENSE.txt" "Lucide-LICENSE.txt"
  !insertmacro ${ACTION} "${KNODE_LICENSE_DIR}\Lucide-Vue-LICENSE.txt" "Lucide-Vue-LICENSE.txt"
  !insertmacro ${ACTION} "${KNODE_LICENSE_DIR}\Tauri-LICENSE-MIT.txt" "Tauri-LICENSE-MIT.txt"
  !insertmacro ${ACTION} "${KNODE_LICENSE_DIR}\RUST-LICENSES.md" "RUST-LICENSES.md"
  !insertmacro ${ACTION} "${KNODE_LICENSE_DIR}\THIRD-PARTY-NOTICES.txt" "THIRD-PARTY-NOTICES.txt"
  !insertmacro ${ACTION} "${KNODE_FRONTEND_LICENSES}" "FRONTEND-LICENSES.md"
!macroend

!macro KNODE_WRITE_LICENSE SOURCE NAME
  ClearErrors
  File /a "/oname=${NAME}" "${SOURCE}"
  IfErrors knode_license_failed
!macroend

!macro KNODE_DELETE_LICENSE SOURCE NAME
  Delete "$INSTDIR\licenses\${NAME}"
!macroend

!macro NSIS_HOOK_PREINSTALL
  Push $0
  ClearErrors
  SetOutPath "$INSTDIR\licenses"
  IfErrors knode_license_failed
  SetOverwrite on
  !insertmacro KNODE_LICENSE_FILES KNODE_WRITE_LICENSE
  SetOutPath "$INSTDIR"
  Pop $0
  Goto knode_license_ready
  knode_license_failed:
    System::Call 'kernel32::GetLastError() i.r0'
    SetErrorLevel 2
    MessageBox MB_OK|MB_ICONSTOP "Cannot write the license files in:$\r$\n$INSTDIR\licenses$\r$\nWindows error: $0$\r$\nCheck folder permissions, read-only files, or another program using this directory. No project data was changed." /SD IDOK
    Pop $0
    Abort
  knode_license_ready:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro KNODE_LICENSE_FILES KNODE_DELETE_LICENSE
  RMDir "$INSTDIR\licenses"
  ; Nonrecursive: preserve any unrelated files in the installation directory.
  RMDir "$INSTDIR"
!macroend
