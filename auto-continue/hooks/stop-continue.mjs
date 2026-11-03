// stop-continue.mjs — auto-continue 插件 Stop 钩子引擎
// 移植自 dsh-auto-continue（MIT, HsiangNianian）的失败分类思路；ZCode Stop 协议细节见记忆 zcode-auto-continue-port-plan
// 输出协议（源码钉死）：{continue:true, additionalContext} 且 additionalContext 非空才续跑；ZCode 硬上限 3 次
// stdin: {session_id, last_assistant_message, stop_hook_active, transcript_path, cwd, hook_event_name}
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');
const STATE_DIR = process.env.ZCODE_PLUGIN_DATA || path.join(__dirname, 'state');

const DEFAULTS = {
  enabled: true,
  // 临时性错误追加的 pattern（每行一条，子串匹配，命中强制可续）
  retryableErrorPatterns: '',
  // 永久性错误追加的 pattern（优先级最高，命中绝不续）
  permanentErrorPatterns: '',
  cooldownMs: 2000,
  maxConsecutive: 2,          // 单会话连续续跑上限（ZCode 硬上限 3，留 1 次余量给用户手动）
  continueText: '上一回合因临时性错误中断。请从中断处继续完成任务。',
  maxStateEntries: 256
};

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function loadConfig() {
  const file = readJson(CONFIG_PATH, {});
  return { ...DEFAULTS, ...file };
}

// ---- 状态：每会话 {count, lastAt, lastText}，文件落 ZCODE_PLUGIN_DATA ----
function statePath(sessionId) {
  // session_id 可信（钩子协议生成），仍做一层文件名消毒
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return path.join(STATE_DIR, `${safe}.json`);
}

function loadState(sessionId, now) {
  const st = readJson(statePath(sessionId), null);
  if (!st) return { count: 0, lastAt: 0, lastText: '' };
  // 冷却窗过期则重置连续计数（与 dsh cooldown 语义一致：冷却过了=新一轮）
  if (now - st.lastAt > 10 * 60 * 1000) return { count: 0, lastAt: st.lastAt, lastText: st.lastText };
  return st;
}

function saveState(sessionId, st, now) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const p = statePath(sessionId);
    fs.writeFileSync(p, JSON.stringify({ ...st, lastAt: now }), 'utf8');
    pruneStates(now);
  } catch { /* 状态写失败不阻断主流程：宁可漏续不可误续 */ }
}

function pruneStates(now) {
  try {
    const files = fs.readdirSync(STATE_DIR).filter(f => f.endsWith('.json'));
    if (files.length <= DEFAULTS.maxStateEntries) return;
    for (const f of files) {
      const p = path.join(STATE_DIR, f);
      try {
        const st = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (now - (st.lastAt || 0) > 7 * 24 * 3600 * 1000) fs.rmSync(p, { force: true });
      } catch { fs.rmSync(p, { force: true }); }
    }
  } catch { /* ignore */ }
}

// ---- 失败判别 ----
// ⚠️ ZCode Stop 钩子对正常完成也触发（不像 dsh 有 turn/end reason=error 信号），
//    所以判据必须反过来：默认放行，只有文本命中显式 error 签名才考虑续跑。
//    dsh 的 isTransientFailure 白名单语义不能照搬（那是只对 error 回合调用的）。
const ERROR_SIGNATURES = [
  /\berror\b/i,
  /\bfailed\b/i,
  /\bfailure\b/i,
  /\bfetch failed\b/i,
  /\btimeout\b/i,
  /\btimed out\b/i,
  /\beconn[a-z]*\b/i,          // ECONNRESET/ECONNREFUSED/ETIMEDOUT
  /\b5\d{2}\b/,                // 5xx
  /\b4(?:01|03|29)\b/,         // 裸状态码也是信号（401/403 进永久分支，429 进临时）
  /网络/, /连接中断/, /请求失败/, /重试后仍失败/
];

function classify(text, cfg) {
  const hay = String(text || '');
  const has = (patterns) => patterns.split(/\r?\n/).map(s => s.trim()).filter(Boolean).some(p => hay.toLowerCase().includes(p.toLowerCase()));

  // 用户显式永久 pattern 优先——命中绝不续
  if (has(cfg.permanentErrorPatterns)) return 'permanent';

  // 无 error 签名 = 正常完成 → 放行（这是修正后的核心判据）
  const hasErrorSig = ERROR_SIGNATURES.some(re => re.test(hay)) || has(cfg.retryableErrorPatterns);
  if (!hasErrorSig) return 'clean';

  // 命中 error 签名后再分永久/临时：认证/余额/上下文类重试无意义
  const lower = hay.toLowerCase();
  const status = /(?:^|\D)(40[13])(?:\D|$)/.exec(lower);   // 只裁 401/403；429 不落入（42[39] 会误吞 429）
  if (status) return 'permanent';
  const permanent =
    /\b(auth|unauthorized|forbidden|credential|api[_-]?key|permission)\b/.test(lower) ||
    /insufficient.*(balance|quota)|billing|payment|quota.*exceeded/.test(lower) ||
    /model.*not[_-]?found|unknown[_-]?model/.test(lower) ||
    /context.*(length|limit|overflow|exceed)|token.*limit|max.*context/.test(lower) ||
    /invalid[_-]?request|bad[_-]?request/.test(lower);
  return permanent ? 'permanent' : 'transient';
}

// ---- 判读：stdin → 决定是否续跑 ----
function decide(input, cfg, now) {
  const sessionId = input.session_id || 'unknown';
  const text = String(input.last_assistant_message || '');
  const isContinuation = input.stop_hook_active === true;

  // 已经是钩子续跑轮：按连续计数决定是否再续（ZCode 硬上限 3 之外我们自我收敛）
  const st = loadState(sessionId, now);

  if (!cfg.enabled) return { action: 'off' };
  // 用户手动停（abort）时 ZCode 不触发 Stop 续跑路径，无信号可判——放行
  if (!text.trim()) return { action: 'pass' };

  const verdict = classify(text, cfg);
  if (verdict === 'clean') return { action: 'pass', note: 'clean' };
  if (verdict === 'permanent') {
    return { action: 'pass', note: 'permanent' };
  }

  // 临时性失败 → 判回环护栏
  if (st.count >= cfg.maxConsecutive) {
    return { action: 'pass', note: `max-consecutive(${st.count})` };
  }
  if (now - st.lastAt < cfg.cooldownMs) {
    return { action: 'pass', note: 'cooldown' };
  }
  // 同文本循环检测：上一轮续跑后输出与上上次完全一致 = 疑似空转
  if (isContinuation && st.lastText && st.lastText === text) {
    return { action: 'pass', note: 'same-text-loop' };
  }

  return {
    action: 'continue',
    text: cfg.continueText,
    next: { count: st.count + 1, lastAt: now, lastText: text }
  };
}

// ---- main ----
function main() {
  const raw = fs.readFileSync(0, 'utf8');
  const input = JSON.parse(raw);
  const cfg = loadConfig();
  const now = Date.now();
  const d = decide(input, cfg, now);

  if (d.action === 'continue') {
    saveState(input.session_id || 'unknown', d.next, now);
    process.stdout.write(JSON.stringify({
      continue: true,
      additionalContext: d.text,
      stopReason: 'auto-continue: transient failure'
    }));
    return;
  }
  if (d.action === 'pass' && d.note === 'permanent') {
    // 永久性错误不续，但给会话留一句说明（顶层 additionalContext，不触发续跑）
    process.stdout.write(JSON.stringify({
      additionalContext: 'auto-continue: 判定为永久性错误（认证/配额/上下文超限类），未自动续跑，请人工处理。'
    }));
    return;
  }
  // off / pass：零输出 = 不干预
}

try { main(); } catch (e) {
  // 钩子崩了绝不阻塞会话：静默放行
  try { fs.appendFileSync(path.join(STATE_DIR, 'hook-errors.log'), `${new Date().toISOString()} ${e && e.message}\n`); } catch { }
}
