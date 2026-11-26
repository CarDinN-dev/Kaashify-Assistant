!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.kaashify.chrome"
    Delete "$APPDATA\Kaashify\chrome-bridge.json"
    Delete "$APPDATA\Kaashify\chrome-native-host.json"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.kaashify.desktop"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.kaashify.desktop"
  ${endIf}
!macroend
