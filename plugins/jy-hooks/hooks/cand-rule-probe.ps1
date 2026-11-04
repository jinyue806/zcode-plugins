# cand-rule-probe.ps1 -- PreToolUse observation probe for rule-surface writes.
# Status: OBSERVE-ONLY (2026-10-29 user ruling: no advisory emission, no blocking).
# Purpose: build trigger-record evidence (who edits rule surfaces, how often,
#          rule-word density) so that rules which recur AND must-happen can later
#          justify the upgrade path observe -> advisory -> (platform-tested) gate.
#          It does NOT convert candidate-rules into enforcement.
# Rollback: remove the cand-rule-probe entry from the PreToolUse array in
#          C:\Users\JY806\.zcode\cli\config.json and delete this file.
#          Config backup: config.json.bak-crp-202610292026
# Schema notes (inherited from jev-advisory audit F1 + rtk V2 experience):
#   - ZCode hook output accepts FLAT keys only; any wrapper is dropped silently.
#   - permissionDecision gets stripped on this platform, so an exit-2/ask gate
#     path must be platform-tested before any upgrade -- hence observe-only now.
#   - STDIN IS READ AS RAW BYTES and decoded as UTF-8 explicitly: measured 2026-10-29,
#     [Console]::In under 'pwsh -File' with a piped stdin decodes the pipe as the
#     console ANSI codepage (GBK here) and silently mangles CJK payload characters
#     (snip_len 43 became 50 mojibake chars). Byte-level UTF-8 decode fixes it.
# Encoding: file saved UTF-8 WITH BOM; CJK appears only inside regex literals.
# Fail-open everywhere: any error -> exit 0 (allow), nothing logged.
$ErrorActionPreference = 'SilentlyContinue'
function Allow() { exit 0 }
try {
  $ms = New-Object System.IO.MemoryStream
  [Console]::OpenStandardInput().CopyTo($ms)
  $bytes = $ms.ToArray()
  if ($bytes.Length -eq 0) { Allow }
  $raw = [System.Text.Encoding]::UTF8.GetString($bytes)
  $j = $raw | ConvertFrom-Json

  $tool = if ($j.tool_name) { [string]$j.tool_name } else { '' }
  if ($tool -notmatch '(?i)^(edit|write|multiedit)$') { Allow }

  $path = ''
  if ($j.tool_input) {
    foreach ($k in @('file_path','path','filepath','target_file')) {
      if ($j.tool_input.$k) { $path = [string]$j.tool_input.$k; break }
    }
  }
  if (-not $path) { Allow }

  # Rule-surface fence: exact governance filenames only. Path-independent so it
  # catches both real dirs and junction aliases (.agents/skills, .skill-repos,
  # project-level AGENTS.md).
  $norm = $path -replace '\\','/'
  if ($norm -notmatch '(?i)[\\/](AGENTS\.md|CLAUDE\.md|SKILL\.md|self-check\.md)$') { Allow }

  # Snippet SHAPE only -- length + rule-word count. Never store content.
  $snippet = ''
  if ($j.tool_input) {
    foreach ($k in @('new_string','content','text')) {
      if ($j.tool_input.$k) { $snippet = [string]$j.tool_input.$k; break }
    }
  }
  $kw = 0
  if ($snippet) {
    $kw = ([regex]::Matches($snippet, '必须|禁止|不得|不要|勿|须|NEVER|MUST|SHALL|ALWAYS|DO NOT')).Count
  }

  $dir = 'E:\workplace\.zcode\v2'
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $obj = [ordered]@{
    ts           = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffK')
    tool         = $tool
    path         = $norm
    snip_len     = $snippet.Length
    rule_kw_hits = $kw
    mode         = 'observe'
  }
  Add-Content -LiteralPath (Join-Path $dir 'cand-rule-probe.jsonl') -Value ($obj | ConvertTo-Json -Compress) -Encoding UTF8
  Allow
} catch {
  Allow
}
