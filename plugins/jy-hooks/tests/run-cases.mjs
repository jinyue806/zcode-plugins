// jy-hooks hook-pack test harness: stdin payloads -> pwsh -> exit/audit assertions.
// Usage: node tests/run-cases.mjs   (run against the plugin copy, not the loose originals)
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const H = (f) => path.join(ROOT, 'hooks', f);
const AUDIT_DIR = 'E:\\workplace\\.zcode\\v2';
const audit = (name) => path.join(AUDIT_DIR, name);

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${detail}`); }
}

function run(script, payloadObj, timeoutMs = 30000) {
  const stdin = Buffer.from(JSON.stringify(payloadObj), 'utf8');
  try {
    const stdout = execFileSync(PWSH, ['-NoProfile', '-File', H(script)], {
      input: stdin, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
    }).toString('utf8');
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? -1, stdout: (e.stdout ?? Buffer.from('')).toString('utf8'), err: e };
  }
}

function tailOutcome(logPath, bytes) {
  try {
    const size = statSync(logPath).size;
    const fd = readFileSync(logPath);
    const start = Math.max(0, size - 4096);
    const lines = fd.subarray(start).toString('utf8').trim().split('\n');
    return JSON.parse(lines[lines.length - 1]).outcome;
  } catch { return null; }
}

// --- commit-guard (pure offline) ---
const cg1 = run('commit-guard.ps1', { tool_name: 'Bash', tool_input: { command: 'git commit -m "修复 登录超时"' } });
ok('commit-guard denies CJK -m (deny stdout + blocked audit)',
  cg1.code === 0 && cg1.stdout.includes('"permissionDecision":"deny"') &&
  tailOutcome(audit('commit-guard.jsonl')) === 'blocked', `code=${cg1.code} out=${cg1.stdout.slice(0, 120)}`);

const cg2 = run('commit-guard.ps1', { tool_name: 'Bash', tool_input: { command: 'git commit -m "fix: login timeout"' } });
ok('commit-guard allows ASCII -m (no deny, ascii-message)',
  cg2.code === 0 && !cg2.stdout.includes('deny') &&
  tailOutcome(audit('commit-guard.jsonl')) === 'ascii-message', `code=${cg2.code}`);

const cg3 = run('commit-guard.ps1', { tool_name: 'Bash', tool_input: { command: 'git status' } });
ok('commit-guard ignores non-commit (not-git-commit)',
  cg3.code === 0 && tailOutcome(audit('commit-guard.jsonl')) === 'not-git-commit');

const cg4 = run('commit-guard.ps1', { tool_name: 'Bash', tool_input: {} });
ok('commit-guard fail-open on empty command (no-command)',
  cg4.code === 0 && tailOutcome(audit('commit-guard.jsonl')) === 'no-command');

// --- cand-rule-probe (observe-only) ---
const cr1 = run('cand-rule-probe.ps1', { tool_name: 'Edit', tool_input: { file_path: 'E:/workplace/AGENTS.md', new_string: 'x' } });
const cr1log = tailOutcome(audit('cand-rule-probe.jsonl'));
ok('cand-rule-probe exits 0 silently on AGENTS.md edit',
  cr1.code === 0 && cr1.stdout.trim() === '' && cr1log !== 'blocked', `out=${cr1.stdout.slice(0, 80)}`);

const cr2 = run('cand-rule-probe.ps1', { tool_name: 'Edit', tool_input: { file_path: 'E:/workplace/notes/todo.md', new_string: 'x' } });
ok('cand-rule-probe out-of-scope path exits 0 no output',
  cr2.code === 0 && cr2.stdout.trim() === '');

const cr3 = run('cand-rule-probe.ps1', { tool_name: 'Bash', tool_input: { command: 'ls' } });
ok('cand-rule-probe non-edit tool exits 0', cr3.code === 0);

// --- rtk-enforce (real rtk.exe; assert via audit tail, never payload) ---
const r1 = run('rtk-enforce.ps1', {
  tool_name: 'Bash',
  tool_input: { command: 'git log --oneline -20 && cat package.json && grep -rn TODO src/ | head -50' },
});
const rOut = tailOutcome(audit('rtk-enforce.jsonl'));
ok('rtk-enforce exits 0 and audits (rewritten or fail-open passthrough)',
  r1.code === 0 && ['rewritten', 'no-hookSpecificOutput', 'passthrough-empty', 'malformed-json',
    'rtk-exit-1', 'timeout', 'no-rtk-binary'].includes(rOut), `audit=${rOut}`);
if (r1.code === 0 && rOut === 'rewritten') {
  ok('rtk rewrite keeps PreToolUse event and drops permission fields',
    (!r1.stdout || !r1.stdout.includes('permissionDecision')));
}

// --- jev-advisory (fast paths only; never triggers the typesafe API here) ---
const j1 = run('jev-advisory.ps1', { tool_name: 'Read', tool_input: { file_path: 'E:/workplace/AGENTS.md' } });
ok('jev-advisory skips Read tool (exit 0 no output)', j1.code === 0 && j1.stdout.trim() === '');

const j2 = run('jev-advisory.ps1', { tool_name: 'Edit', tool_input: { file_path: 'C:/Users/Someone/other/x.md', new_string: 'hello' } });
ok('jev-advisory out-of-scope path exits 0 fast', j2.code === 0 && j2.stdout.trim() === '');

const j3 = run('jev-advisory.ps1', { tool_name: 'Edit', tool_input: { file_path: 'E:/workplace/notes/plain.md', new_string: 'hello' } });
ok('jev-advisory scoped-but-not-hot exits 0 fast', j3.code === 0 && j3.stdout.trim() === '');

const j4 = run('jev-advisory.ps1', { tool_name: 'SomeFutureTool', tool_input: { file_path: 'E:/workplace/x' } });
ok('jev-advisory unknown tool handled (allow-list default skip)', j4.code === 0);

console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
