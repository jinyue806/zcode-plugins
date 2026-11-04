# JEV advisory hook (PostToolUse, matcher "*"; gated by tool_name exclude-list + scope + hot-path)
# Positioning: advisory signal only, never a gate (2026-09-21 ruling).
# Community research: Stop is the only hook that can block, but blocking feeds the
# message back into another model turn with no convergence guarantee.
# Design: fail-open on every path; ASCII-only source because PowerShell 5.1
# decodes a UTF-8-without-BOM script as GBK and the mojibake breaks the parser.
# Pitfalls verified on PS 5.1.26100 and handled below:
#   - ConvertFrom-Json has no -Encoding parameter in PS 5.1.
#   - The $job.Output property stays empty for a completed job, but Receive-Job
#     returns the value correctly and returns immediately for a still-running job,
#     so the bounded wait is: Wait-Job -Timeout N, then Receive-Job, then treat
#     an empty result as a timeout and fail open.
#   - Console input encoding is GB2312 by default; hook input JSON stays ASCII.
# Constraint: TYPESAFE_API_KEY never written to logs or repos; bounded wait.
#
# ---- 2026-09-25 audit fixes (see docs/2026-09-25-jev-audit.md) --------------
# F1 SCHEMA: the output was wrapped in `hookSpecificOutput` (the Claude Code
#    shape). ZCode's hook schema is strict and knows only the FLAT key
#    `additionalContext`; an extra top-level key makes validation fail and the
#    effect is DISCARDED SILENTLY (zcode-guide diagnosing-hooks, rule 8).
#    Fix: emit `{"additionalContext": "..."}` with no wrapper.
# F2 OBSERVABILITY: a hook that succeeds writes no ZCode log at all -- only
#    `hook.run.failed` exists -- so "no advisory appeared" and "the hook never
#    ran" were indistinguishable. Fix: append one metadata-only line here
#    (never the content, never the credential).
# F3 REDACTION: the previous rules missed credentials embedded in URLs
#    (`scheme://user:pass@host`) and every private/internal address. Both now
#    masked. A repo holding internal IPs must not leak them to a third party.
# F4 TIMEOUT: the configured budget is 8000ms total but the inner wait was 15s,
#    so the host could kill the hook before it emitted. Inner wait is now 6s.
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'SilentlyContinue'
function Allow() { exit 0 }
function Emitted([object]$o) { $o | ConvertTo-Json -Compress | Write-Output; exit 0 }
function Dbg([string]$m) { if ($env:JEV_HOOK_DEBUG) { [Console]::Error.WriteLine($m) } }

# F2: metadata-only audit trail so a successful run is observable.
function Audit([string]$path, [string]$verdict, [double]$f, [double]$rv) {
  try {
    $dir = 'E:\workplace\.zcode\v2'
    if (-not (Test-Path -LiteralPath $dir)) { return }
    $obj = [ordered]@{
      ts = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffK')
      path = ($path -replace '\\', '/')
      verdict = $verdict
      forward = $f
      reverse = $rv
    }
    Add-Content -LiteralPath (Join-Path $dir 'jev-advisory.jsonl') -Value ($obj | ConvertTo-Json -Compress) -Encoding UTF8
  } catch { }
}

# F5 CIRCUIT BREAKER (2026-11-03): the endpoint has been answering HTTP 451
# "Unavailable For Legal Reasons" in long stretches (regional block). Every
# hot-path write then pays a ~0.6s round trip that cannot possibly succeed.
# After $script:JevMaxFail consecutive failed attempts -- any kind -- the hook
# goes silent for $script:JevCoolMin minutes and then probes again on its own.
# F8 (2026-11-04): the scope widened from 451-only to any failure. Measured
# upstream behaviour is three-state and unpredictable: slow 200, fast 451, and
# TLS handshakes that stall until the timeout expires. Counting only 451 left
# the two expensive kinds (timeout, SSL stall) burning the full budget on every
# write. A latched breaker is the only way to stop paying for calls that cannot
# answer, and the cool-down makes it self-healing.
# A malformed body is NOT counted: the service answered, so that is schema
# drift worth seeing rather than an outage to hide.
# State lives next to the audit log, ASCII JSON, no credential, no content.
$script:JevMaxFail = 3
$script:JevCoolMin = 30
function JevStatePath() { return 'E:\workplace\.zcode\v2\jev-advisory-state.json' }
function JevStateRead() {
  try {
    $f = JevStatePath
    if (-not (Test-Path -LiteralPath $f)) { return $null }
    return (Get-Content -LiteralPath $f -Raw | ConvertFrom-Json)
  } catch { return $null }
}
function JevCircuitOpen() {
  $s = JevStateRead
  if (-not $s) { return $false }
  if (-not $s.open_until_epoch) { return $false }
  # Epoch seconds, not an ISO string: ConvertFrom-Json silently turns ISO
  # strings into DateTime and the round trip would then be culture-dependent.
  return ([long]$s.open_until_epoch -gt [datetimeoffset]::UtcNow.ToUnixTimeSeconds())
}
function JevRecord([string]$outcome) {
  try {
    $s = JevStateRead
    $fails = 0
    if ($s -and $s.fails) { $fails = [int]$s.fails }
    $until = 0
    if ($s -and $s.open_until_epoch) { $until = [long]$s.open_until_epoch }
    if ($outcome -eq 'ok') {
      $fails = 0
      $until = 0
    } elseif ($outcome -ne 'malformed') {
      $fails = $fails + 1
      if ($fails -ge $script:JevMaxFail) {
        $until = [datetimeoffset]::UtcNow.AddMinutes($script:JevCoolMin).ToUnixTimeSeconds()
        $fails = 0
      }
    }
    $dir = Split-Path -Parent (JevStatePath)
    if (-not (Test-Path -LiteralPath $dir)) { return }
    $o = [ordered]@{
      fails = $fails
      open_until_epoch = $until
      updated = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffK')
    }
    Set-Content -LiteralPath (JevStatePath) -Value ($o | ConvertTo-Json -Compress) -Encoding UTF8
  } catch { }
}

try {
  $raw = [Console]::In.ReadToEnd()
  if (-not $raw) { Allow }
  $j = $raw | ConvertFrom-Json

  # The settings.json matcher is "*", so every tool fires this hook.
  # Gate on tool_name first so only file-writing tools cost anything.
  # Use an exclude-list over an allow-list: the safe default is "skip" when an
  # unknown tool_name appears, so a future tool variant still gets reviewed.
  $tool = ''
  if ($j.tool_name) { $tool = [string]$j.tool_name }
  $skipTools = '(?i)^(read|bash|grep|glob|todo_|task_|websearch|webfetch|sendmessage|agent|subagent|notebook|exit_plan_mode|askuserquestion|enterplanmode)$'
  if ($tool -match $skipTools) { Allow }

  # Resolve the target path across the tool_input field-name variants.
  $path = ''
  if ($j.tool_input) {
    foreach ($k in @('file_path', 'path', 'filepath', 'target_file')) {
      if ($j.tool_input.$k) { $path = [string]$j.tool_input.$k; break }
    }
  }
  if (-not $path) { Allow }

  # Scope fence: only the known managed trees. Never send foreign content
  # (other machines, other users, the hook's own memory or credential files).
  # Match drive letters case-insensitively and accept both / and \ separators.
  $normPath = $path -replace '\\', '/'
  $scoped = $normPath -match '(?i)^(E:/workplace|C:/Users/JY806/\.agents/skills|C:/Users/JY806/\.codebuddy/skills)'
  if (-not $scoped) { Allow }

  # Only decision-relevant writes are worth an LLM call: deploy / CI / config / scripts.
  $lower = $path.ToLower()
  $hot = ($path -match '(?i)(^|[/\\])(deploy|deployment|deployments?|ci|cron|scripts?|compose|config|secrets?|security|pipeline|infra)')
  $hotname = ($path -match '(?i)(docker-compose|compose\.ya?ml|\.ya?ml$|\.toml$|Dockerfile|Makefile|jenkinsfile|\.cron|backup|restore|rollback|gen[._-]?)')
  $envHit = $lower -match '(?i)\.env$'
  if (-not ($hot -or $hotname -or $envHit)) { Allow }

  # Circuit open: the endpoint has been 451 for a while, so stop paying for a
  # call that cannot succeed. Re-probes by itself after the cool-down.
  if (JevCircuitOpen) { Audit $path 'circuit' -1 -1; Allow }

  # Read the credential; missing means allow.
  $key = ''
  $credFile = Join-Path $env:USERPROFILE '.dsh\.env'
  if (Test-Path $credFile) {
    $hit = Get-Content $credFile | Where-Object { $_ -like 'TYPESAFE_API_KEY=*' } | Select-Object -First 1
    if ($hit) { $key = ($hit -split '=', 2)[1].Trim().Trim('"').Trim("'") }
  }
  if (-not $key) { Allow }

  # Prefer the tool payload (always reliable) over reading the file back off disk.
  $snippet = ''
  if ($j.tool_input) {
    foreach ($k in @('content', 'new_string', 'text')) {
      if ($j.tool_input.$k) { $snippet = [string]$j.tool_input.$k; break }
    }
  }
  if ((-not $snippet) -and (Test-Path $path)) { $snippet = Get-Content $path -Raw }
  if (-not $snippet) { Allow }
  if ($snippet.Length -gt 6000) { $snippet = $snippet.Substring(0, 6000) }

  # The content is posted to an external API (typesafe.ai). Mask credential-shaped
  # values first so a real secret never leaves the machine, even inside a hot file.
  # F3: order matters. URL-embedded credentials and private addresses are masked
  # unconditionally (they carry no provider prefix and the label rules missed them),
  # then labelled secrets line by line, then bare provider-prefixed tokens.
  # scheme://user:pass@host -> the pass is the secret; keep scheme and host shape.
  $snippet = $snippet -replace '(?i)(://[^/\s:@]{1,64}:)([^/\s@]{1,200})(@)', '$1<REDACTED>$3'
  # RFC1918 + common NAS/CGNAT ranges. A repo that holds internal IPs must not
  # ship them to a third party (AGENTS.md: evidence is desensitized before publish).
  # The wildcard spelling (e.g. `192.168.5.x`) is masked too: it still discloses
  # the subnet, which is the thing worth protecting.
  $snippet = $snippet -replace '\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.(?:\d{1,3}|x)|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.(?:\d{1,3}|x)|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.(?:\d{1,3}|x))\b', '<REDACTED_ADDR>'
  $snippet = $snippet -replace '\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.x\b', '<REDACTED_ADDR>'

  if ($snippet -match '(?i)(api[_-]?key|secret|token|password|passwd|pwd|private[_-]?key|bearer|authorization|sk-|ghp_|github_pat|xox|AIza)') {
    $lines = $snippet -split "`n"
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -match '(?i)(api[_-]?key|token|secret|password|passwd|pwd|private[_-]?key|bearer|authorization)\b') {
        $lines[$i] = $lines[$i] -replace '(?i)((?:\b|auth(?:orization)?\s+bearer\s*|:\s*))([A-Za-z0-9._\-]{16,})', '$1<REDACTED>'
        $lines[$i] = $lines[$i] -replace '(?i)(=\s*)([A-Za-z0-9._\-]{16,})', '$1<REDACTED>'
      }
    }
    $snippet = $lines -join "`n"
    $snippet = $snippet -replace '\b(?:sk-[A-Za-z0-9_\-]{16,}|ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9_\-]{16,}|AIza[0-9A-Za-z_\-]{16,})\b', '<REDACTED_KEY>'
  }

  $state = "## Tool write under review (PostToolUse, advisory only, not a gate)`n## Target path`n$path`n## Change content (truncated)`n$snippet"
  $qs = [ordered]@{
    forward = [ordered]@{
      type = 'noul'
      instructions = 'Is this write decision-relevant AND does it contain an unverified assumption, an unsupported claim, or overstated authority that should be checked before being relied on?'
    }
    reverse = [ordered]@{
      type = 'noul'
      instructions = 'Is this write entirely low-stakes with every assumption already verified against independent evidence, so no further judgment call is needed?'
    }
  }
  $body = ([ordered]@{ state = $state; model = 'jev-latest'; questions = $qs }) | ConvertTo-Json -Compress -Depth 8

  # F6 TRANSPORT (2026-11-03): the old Start-Job + WebClient path paid job spawn
  # and teardown on top of the request itself -- measured 10.4s end to end against
  # an 8000ms host budget. HttpClient enforces the timeout in process, so the
  # wall time is startup + request and nothing else.
  # Timeout is the only cancellation source here, so a TaskCanceledException means
  # timeout; every other exception is a transport error. Fail open on both.
  # F7 BUDGET (2026-11-04): direct probes put the endpoint at p50 ~5s, p90 ~8s
  # with occasional 20s SSL stalls, so the old 6s inner wait discarded most calls
  # that would have answered. The host budget moved 8000 -> 12000ms to match, so
  # worst case is startup ~0.5s + 10s timeout and still fits.
  $timeoutSec = 10
  $resp = ''
  try {
    if (-not ('System.Net.Http.HttpClient' -as [type])) { Add-Type -AssemblyName System.Net.Http }
    try { [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12 } catch { }
    $hc = [System.Net.Http.HttpClient]::new()
    $hc.Timeout = [TimeSpan]::FromSeconds($timeoutSec)
    try {
      $hc.DefaultRequestHeaders.TryAddWithoutValidation('Authorization', 'Bearer ' + $key) | Out-Null
      $content = [System.Net.Http.StringContent]::new($body, [System.Text.Encoding]::UTF8, 'application/json')
      $r = $hc.PostAsync('https://api.typesafe.ai/v1/systemone', $content).GetAwaiter().GetResult()
      $code = [int]$r.StatusCode
      $resp = $r.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      $r.Dispose()
      if ($code -lt 200 -or $code -ge 300) { $resp = 'ERR HTTP ' + $code + ' ' + $resp }
    } finally {
      $hc.Dispose()
    }
  } catch [System.Threading.Tasks.TaskCanceledException] {
    $resp = 'ERR TIMEOUT'
  } catch {
    $resp = 'ERR ' + $_.Exception.Message
  }
  if ($resp -eq 'ERR TIMEOUT') { JevRecord 'timeout'; Dbg ('allow: JEV timeout >' + $timeoutSec + 's'); Audit $path 'timeout' -1 -1; Allow }

  if ($resp -like 'ERR*') {
    $v = 'error'
    if ($resp -match '451') { $v = 'error451' }
    JevRecord $v
    Dbg ('allow: JEV call failed: ' + $resp); Audit $path $v -1 -1; Allow
  }

  $ans = ($resp | ConvertFrom-Json).answers
  if (-not $ans -or -not $ans.forward -or -not $ans.reverse) { Audit $path 'malformed' -1 -1; Allow }
  $f = [double]$ans.forward.noul
  $rv = [double]$ans.reverse.noul

  # The endpoint answered, so the failure streak and any breaker are reset.
  JevRecord 'ok'

  # Trust table: emit only when both framings point the same way.
  # forward high + reverse low = consistent signal, worth flagging.
  # Otherwise (both high / both low / reversed) = wobble or flip, stay silent.
  if ($f -gt 0.7 -and $rv -lt 0.35) {
    $msg = ([string]::Format(
      'JEV advisory (not a gate, reference only): this write carries an unverified assumption or overstated authority. Forward {0:F2} / reverse {1:F2} agree. Verify the mechanically-checkable parts yourself and do not treat the rest as settled.',
      $f, $rv))
    Audit $path 'emitted' $f $rv
    # F1: FLAT key only. Wrapping in `hookSpecificOutput` fails the strict schema
    # and the advisory is dropped without any error surfacing to the session.
    Emitted ([ordered]@{ additionalContext = $msg })
  }
  Audit $path 'silent' $f $rv
  Allow
} catch {
  Allow
}
