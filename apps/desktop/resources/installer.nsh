!ifndef DESKTOP_PROTOCOL_SCHEME
  !define DESKTOP_PROTOCOL_SCHEME "t3code"
!endif

!macro customInstall
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ${IfNot} ${FileExists} "$newStartMenuLink"
      !insertmacro createMenuDirectory
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${EndIf}
  !endif
!macroend

!macro customUnInstall
  Push $0
  ReadRegStr $0 HKCU "Software\Classes\${DESKTOP_PROTOCOL_SCHEME}\shell\open\command" ""
  ; Electron registers this command at runtime; another install may have replaced it.
  ${If} $0 == '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'
    DeleteRegKey HKCU "Software\Classes\${DESKTOP_PROTOCOL_SCHEME}"
  ${EndIf}
  ClearErrors
  Pop $0
!macroend
