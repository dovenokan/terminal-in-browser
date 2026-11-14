# Renders Markdown (with $math$ and $$display$$) in the terminal-in-browser terminal.
# Usage:  render-md.ps1 notes.md        or        Get-Content notes.md -Raw | render-md.ps1
# Works only inside a terminal tab from the extension; elsewhere it just prints a stray escape code.
param([string]$Path)
$text = if ($Path) { Get-Content -Raw -LiteralPath $Path -Encoding utf8 } else { [Console]::In.ReadToEnd() }
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))
[Console]::Write("$([char]27)]7770;$b64$([char]7)")
