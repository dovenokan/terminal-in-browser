# Registers the native host for Chromium browsers (Chrome, Brave, Edge, Chromium, Vivaldi) and Firefox. Current user only, no admin.
$dir = $PSScriptRoot
$id = (Get-Content "$dir\..\extension-id.txt").Trim()
$name = 'com.local.terminal_in_browser'
$base = @{ name = $name; description = 'Starts the terminal-in-browser bridge'; path = "$dir\host.bat"; type = 'stdio' }

$chromium = "$dir\$name.json"
($base + @{ allowed_origins = @("chrome-extension://$id/") }) | ConvertTo-Json | Set-Content $chromium -Encoding ascii
$firefox = "$dir\$name.firefox.json"
($base + @{ allowed_extensions = @('terminal-in-browser@local.addon') }) | ConvertTo-Json | Set-Content $firefox -Encoding ascii

$targets = @{
  'Google\Chrome' = $chromium; 'BraveSoftware\Brave-Browser' = $chromium; 'Microsoft\Edge' = $chromium
  'Chromium' = $chromium; 'Vivaldi' = $chromium; 'Mozilla' = $firefox
}
foreach ($k in $targets.Keys) {
  $key = "HKCU:\Software\$k\NativeMessagingHosts\$name"
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name '(default)' -Value $targets[$k]
}
"Registered $name for extension $id (Chromium browsers) and terminal-in-browser@local.addon (Firefox)"
