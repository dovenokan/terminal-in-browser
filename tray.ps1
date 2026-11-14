# Tray host: runs the bridge hidden, offers Open / Copy token / Quit.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$root = $PSScriptRoot
$extId = (Get-Content "$root\extension-id.txt").Trim()

$mutex = New-Object Threading.Mutex($false, 'Global\TerminalInBrowserTray')
if (-not $mutex.WaitOne(0)) { exit }   # already running

function Server-Pid { (Get-NetTCPConnection -LocalPort 7681 -State Listen -ErrorAction SilentlyContinue | select -First 1).OwningProcess }
function Server-Up { [bool]([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ? { $_.Port -eq 7681 }) }   # fast (no UI stall)
function Ensure-Server {
  if (Server-Up) { return }
  Start-Process node -ArgumentList 'server.js' -WorkingDirectory "$root\server" -WindowStyle Hidden | Out-Null
  for ($i = 0; $i -lt 30 -and -not (Server-Up); $i++) { Start-Sleep -Milliseconds 150 }
}
Ensure-Server   # reuses a bridge that is already listening
function Token { (Get-Content "$root\server\.token" -ErrorAction SilentlyContinue | Select -First 1) }

function Open-Term {
  $url = "chrome-extension://$extId/terminal.html#$(Token)"
  $exe = Find-Browser
  if ($exe) { Start-Process $exe $url } else { [Windows.Forms.MessageBox]::Show('No Chromium browser (Brave/Chrome/Edge/Vivaldi) found.') | Out-Null }
}
# First installed Chromium browser, via App Paths (covers per-user and per-machine installs); cached.
$BROWSERS = 'brave.exe', 'chrome.exe', 'msedge.exe', 'vivaldi.exe'
function Find-Browser {
  if ($script:browserExe -and (Test-Path $script:browserExe)) { return $script:browserExe }
  foreach ($b in $BROWSERS) {
    foreach ($hive in 'HKCU:', 'HKLM:') {
      $p = (Get-ItemProperty "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$b" -ErrorAction SilentlyContinue).'(default)'
      if ($p -and (Test-Path $p.Trim('"'))) { return ($script:browserExe = $p.Trim('"')) }
    }
  }
}

$ni = New-Object Windows.Forms.NotifyIcon
$logo = "$root\extension\assets\logo.png"
$ni.Icon = if (Test-Path $logo) { [Drawing.Icon]::FromHandle(([Drawing.Bitmap]::FromFile($logo)).GetHicon()) } else { [Drawing.SystemIcons]::Application }
$ni.Text = 'terminal-in-browser'
$menu = New-Object Windows.Forms.ContextMenuStrip
$menu.Items.Add('Open terminal tab').add_Click({ Open-Term }) | Out-Null
$menu.Items.Add('Copy token').add_Click({ [Windows.Forms.Clipboard]::SetText((Token)) }) | Out-Null
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$auto = New-Object Windows.Forms.ToolStripMenuItem 'Start with Windows'
$auto.Checked = [bool](Get-ItemProperty $runKey -Name TerminalInBrowser -ErrorAction SilentlyContinue)
$auto.add_Click({
  if ($auto.Checked) { Remove-ItemProperty $runKey -Name TerminalInBrowser -ErrorAction SilentlyContinue; $auto.Checked = $false }
  else { Set-ItemProperty $runKey -Name TerminalInBrowser -Value "wscript.exe `"$root\launch.vbs`""; $auto.Checked = $true }
})
$menu.Items.Add($auto) | Out-Null
$menu.Items.Add('Quit').add_Click({
  $ni.Visible = $false
  $sp = Server-Pid; if ($sp) { Stop-Process -Id $sp -Force }
  [Windows.Forms.Application]::Exit()
}) | Out-Null
$ni.ContextMenuStrip = $menu
$ni.add_MouseClick({ if ($_.Button -eq 'Left') { Open-Term } })

$timer = New-Object Windows.Forms.Timer; $timer.Interval = 3000
$timer.add_Tick({ Ensure-Server })   # watchdog: keep the bridge alive while the tray runs
$timer.Start()
$ni.Visible = $true
[Windows.Forms.Application]::Run()
