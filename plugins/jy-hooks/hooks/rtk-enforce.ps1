# RTK sanitizing adapter (PreToolUse / Bash)
#
# ZCode -> this script -> rtk hook claude -> strip permission fields -> stdout
#
# Division of labour: RTK owns the rewrite rules. This script owns only the
# protocol: forward stdin verbatim, validate the reply, remove rtk's permission
# assertions so ZCode keeps its own permission flow, re-emit updatedInput.
# It must never invent a rewrite of its own.
#
# Hard rules:
#   - fail-open on EVERY path: a broken adapter must not block the user's shell
#   - pure ASCII source: PowerShell may decode UTF-8-without-BOM as GBK, which
#     breaks the parser and then silently fails open
#   - stdin bytes are handed to rtk as UTF-8, never through the pipeline, to
#     avoid $OutputEncoding re-encoding the payload
#   - the internal wait stays under ZCode's configured 5000ms hook timeout
#
# Observability (2026-10-07, jev-advisory F2 pattern): a successful hook run
# writes nothing anywhere, so "no rewrite happened" and "the hook never ran"
# were indistinguishable. One metadata-only line is appended per run to
# rtk-enforce.jsonl. NEVER log the payload itself: only the first token of the
# command plus the outcome, so secrets in args cannot leak into the log.
# The audit is best-effort and guarded; it must never change the outcome.

$ErrorActionPreference = 'Stop'

$AuditLog = 'E:\workplace\.zcode\v2\rtk-enforce.jsonl'
$AuditMaxBytes = 5MB

function Audit([string]$outcome, [bool]$rewritten, [string]$firstToken, [int]$ms) {
  try {
    if (-not (Test-Path -LiteralPath 'E:\workplace\.zcode\v2')) { return }
    if ((Test-Path -LiteralPath $AuditLog) -and ((Get-Item -LiteralPath $AuditLog).Length -gt $AuditMaxBytes)) {
      Move-Item -LiteralPath $AuditLog -Destination ($AuditLog + '.prev') -Force
    }
    $obj = [ordered]@{
      ts = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffK')
      outcome = $outcome
      rewritten = $rewritten
      cmd = $firstToken
      ms = $ms
    }
    Add-Content -LiteralPath $AuditLog -Value ($obj | ConvertTo-Json -Compress) -Encoding UTF8
  } catch { }
}

function FirstToken([string]$rawJson) {
  try {
    $j = $rawJson | ConvertFrom-Json
    $c = $j.tool_input.command
    if (-not $c) { return '' }
    $c = ([string]$c).Trim()
    $i = $c.IndexOf(' ')
    if ($i -gt 0) { return $c.Substring(0, $i) }
    return $c
  } catch { return '' }
}

function Fail-Open([string]$outcome, [string]$firstToken, [int]$ms) {
  Audit $outcome $false $firstToken $ms
  exit 0
}

$Rtk = 'C:\Users\JY806\.local\bin\rtk.exe'
$WaitMs = 3000
$sw = [System.Diagnostics.Stopwatch]::StartNew()

try {
  $raw = [Console]::In.ReadToEnd()
  if (-not $raw) { Fail-Open 'no-stdin' '' $sw.ElapsedMilliseconds }
  $tok = FirstToken $raw
  if (-not (Test-Path -LiteralPath $Rtk)) { Fail-Open 'no-rtk-binary' $tok $sw.ElapsedMilliseconds }

  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $Rtk
  $psi.ArgumentList.Add('hook')
  $psi.ArgumentList.Add('claude')
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

  $proc = [System.Diagnostics.Process]::new()
  $proc.StartInfo = $psi
  if (-not $proc.Start()) { Fail-Open 'spawn-failed' $tok $sw.ElapsedMilliseconds }

  $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($raw)
  $proc.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
  $proc.StandardInput.BaseStream.Flush()
  $proc.StandardInput.BaseStream.Close()

  $stdout = $proc.StandardOutput.ReadToEnd()
  $proc.StandardError.ReadToEnd() | Out-Null
  if (-not $proc.WaitForExit($WaitMs)) {
    $proc.Kill($true)
    Fail-Open 'timeout' $tok $sw.ElapsedMilliseconds
  }
  if ($proc.ExitCode -ne 0) { Fail-Open ('rtk-exit-' + $proc.ExitCode) $tok $sw.ElapsedMilliseconds }

  if (-not $stdout) { Fail-Open 'passthrough-empty' $tok $sw.ElapsedMilliseconds }
  $stdout = $stdout.Trim()
  if (-not $stdout) { Fail-Open 'passthrough-empty' $tok $sw.ElapsedMilliseconds }

  try { $reply = $stdout | ConvertFrom-Json } catch { Fail-Open 'malformed-json' $tok $sw.ElapsedMilliseconds }
  if (-not $reply) { Fail-Open 'malformed-json' $tok $sw.ElapsedMilliseconds }

  $hso = $reply.hookSpecificOutput
  if (-not $hso) { Fail-Open 'no-hookSpecificOutput' $tok $sw.ElapsedMilliseconds }
  if ($hso.hookEventName -ne 'PreToolUse') { Fail-Open 'wrong-event' $tok $sw.ElapsedMilliseconds }
  if (-not $hso.updatedInput) { Fail-Open 'no-updatedInput' $tok $sw.ElapsedMilliseconds }

  # Remove rtk's permission assertions. Keeping them would let RTK silently
  # approve commands; ZCode's own permission decision must stay authoritative.
  $hso.PSObject.Properties.Remove('permissionDecision')
  $hso.PSObject.Properties.Remove('permissionDecisionReason')

  $out = @{ hookSpecificOutput = $hso }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Depth 20 -Compress))
  Audit 'rewritten' $true $tok $sw.ElapsedMilliseconds
  exit 0
} catch {
  try { Audit ('exception-' + $_.Exception.GetType().Name) $false '' $sw.ElapsedMilliseconds } catch { }
  exit 0
}
