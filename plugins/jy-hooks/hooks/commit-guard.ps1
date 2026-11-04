# Commit guard (PreToolUse / Bash)
#
# Blocks `git commit -m` / `-m`-style flags whose message contains CJK characters.
# Chinese commit text MUST go through `git commit -F <file>`: an inline -m with
# Chinese is decoded as GBK by the git/shell stack on this machine and lands
# mojibake in history (f9f7 0c1 incident, 2026-11-03).
#
# Hard rules (inherited from rtk-enforce.ps1 discipline):
#   - fail-open on EVERY path: a broken guard must not block normal commits
#   - pure ASCII source only: PowerShell may decode UTF-8-without-BOM as GBK
#   - CJK detection works on raw bytes (UTF-8 lead bytes), immune to console
#     codepage display issues
#   - never logs the message content, only the outcome

$ErrorActionPreference = 'Stop'

function Fail-Open { param([string]$outcome)
  try {
    $log = 'E:\workplace\.zcode\v2\commit-guard.jsonl'
    if (Test-Path -LiteralPath 'E:\workplace\.zcode\v2') {
      $obj = [ordered]@{ ts=(Get-Date).ToString('yyyy-MM-ddTHH:mm:ss'); outcome=$outcome }
      Add-Content -LiteralPath $log -Value ($obj | ConvertTo-Json -Compress) -Encoding UTF8
    }
  } catch { }
  exit 0
}

try {
  # Read stdin as raw bytes then UTF-8 decode: [Console]::In would decode with
  # the system codepage (GBK) and corrupt CJK payloads into invalid JSON.
  $stdin = [Console]::OpenStandardInput()
  $ms = New-Object System.IO.MemoryStream
  $stdin.CopyTo($ms)
  $raw = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
  if (-not $raw) { Fail-Open 'no-stdin' }

  $j = $raw | ConvertFrom-Json
  $cmd = [string]$j.tool_input.command
  if (-not $cmd) { Fail-Open 'no-command' }

  # Only care about git commit invocations
  if ($cmd -notmatch '(?i)\bgit\b[^|;&]*\bcommit\b') { Fail-Open 'not-git-commit' }

  # Extract -m/-m=/--message args (both quoted and bare), then test for CJK.
  # CJK ranges: U+3000-9FFF (CJK punct + ideographs), U+FF00-FFEF (fullwidth).
  $msgArgs = @()
  if ($cmd -match '(?s)') {
    $tokens = [regex]::Matches($cmd, '(?ms)(?:-m|--message)(?:=(?:"([^"]*)"|\x27([^\x27]*)\x27|(\S+))|\s+(?:"([^"]*)"|\x27([^\x27]*)\x27|([^\s]+)))')
    foreach ($t in $tokens) {
      foreach ($g in @($t.Groups[1..7])) { if ($g.Success -and $g.Value) { $msgArgs += $g.Value } }
    }
  }
  if ($msgArgs.Count -eq 0) { Fail-Open 'no-inline-message' }

  foreach ($m in $msgArgs) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($m)
    for ($i = 0; $i -lt $bytes.Length - 2; $i++) {
      $b = $bytes[$i]
      # UTF-8 3-byte lead for U+3000-U+9FFF and U+FF00-U+FFEF: 0xE3-0xE9
      if ($b -ge 0xE3 -and $b -le 0xE9 -and ($bytes[$i+1] -band 0xC0) -eq 0x80 -and ($bytes[$i+2] -band 0xC0) -eq 0x80) {
        $out = @{
          hookSpecificOutput = @{
            hookEventName = 'PreToolUse'
            permissionDecision = 'deny'
            permissionDecisionReason = 'git commit -m contains Chinese text: it will land as GBK mojibake. Write the message to a UTF-8 file and use: git commit -F <file>. (Hard rule 2026-11-02; incident f9f70c1.)'
          }
        }
        [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 6))
        try {
          $log = 'E:\workplace\.zcode\v2\commit-guard.jsonl'
          $obj = [ordered]@{ ts=(Get-Date).ToString('yyyy-MM-ddTHH:mm:ss'); outcome='blocked' }
          Add-Content -LiteralPath $log -Value ($obj | ConvertTo-Json -Compress) -Encoding UTF8
        } catch { }
        exit 0
      }
    }
  }
  Fail-Open 'ascii-message'
} catch {
  Fail-Open ('exception-' + $_.Exception.GetType().Name)
}
