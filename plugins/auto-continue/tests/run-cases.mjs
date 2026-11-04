// run-cases.mjs — 全分支 stdin 模拟测试（跑真引擎进程，验证 stdout 协议）
// 用法: node tests/run-cases.mjs
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(__dirname, '..', 'hooks', 'stop-continue.mjs');
// 测试隔离：state 指到 tests/state，绝不碰真 state/
const ENV = { ...process.env, ZCODE_PLUGIN_DATA: path.join(__dirname, 'state') };

const HOOK = (session_id, last_assistant_message, stop_hook_active = false) =>
  JSON.stringify({ session_id, last_assistant_message, stop_hook_active, hook_event_name: 'Stop', cwd: 'E:\\x' });

const CASES = [
  { name: 'T1 网络错误→续跑', input: HOOK('s1', 'Error: fetch failed: network timeout, status 502'), want: c => c.decision === 'block' && c.reason && c.reason.length > 0 },
  { name: 'T2 429 限流→续跑', input: HOOK('s2', 'API error: 429 Too Many Requests'), want: c => c.decision === 'block' && c.reason && c.reason.length > 0 },
  { name: 'T3 401 认证→不续+说明', input: HOOK('s3', 'Error: 401 Unauthorized, invalid api key'), want: c => c.decision === undefined && /永久性错误/.test(c.additionalContext || '') },
  { name: 'T4 403 禁止→不续', input: HOOK('s4', '403 Forbidden'), want: c => c.decision === undefined && /永久性错误/.test(c.additionalContext || '') },
  { name: 'T5 余额→不续', input: HOOK('s5', 'Insufficient balance, please top up'), want: c => c.decision === undefined },
  { name: 'T6 上下文超限→不续', input: HOOK('s6', 'prompt is too long: context length exceeded'), want: c => c.decision === undefined },
  { name: 'T7 正常完成→零输出', input: HOOK('s7', '任务完成，共修改 3 个文件，测试全绿。'), want: c => c.decision === undefined && c.additionalContext === undefined },
  { name: 'T8 空消息→零输出', input: HOOK('s8', ''), want: c => Object.keys(c).length === 0 },
  { name: 'T9 中文兜底文案(WorkBuddy同款)→续跑', input: HOOK('s9', '重试后仍失败，请检查网络连接'), want: c => c.decision === 'block' && c.reason && c.reason.length > 0 },
  { name: 'T10 自定义 permanent pattern 优先', input: HOOK('s10', '服务端抽风了，重试也没有用 code X9001'), want: c => c.decision === undefined, config: { permanentErrorPatterns: 'x9001' } },
  { name: 'T11 maxConsecutive 护栏', input: HOOK('s11', 'fetch failed 502', true), want: c => c.decision === undefined, presetState: { count: 2, lastAt: Date.now(), lastText: 'x' } },
  { name: 'T12 冷却期内→不续', input: HOOK('s12', 'fetch failed 502'), want: c => c.decision === undefined, presetState: { count: 1, lastAt: Date.now(), lastText: 'x' } },
  { name: 'T13 同文本循环→停', input: HOOK('s13', 'fetch failed 502', true), want: c => c.decision === undefined, presetState: { count: 1, lastAt: Date.now() - 5000, lastText: 'fetch failed 502' } },
  { name: 'T14 enabled=false→零输出', input: HOOK('s14', 'fetch failed 502'), want: c => Object.keys(c).length === 0, config: { enabled: false } },
  { name: 'T15 续跑轮正常推进→再续', input: HOOK('s15', 'fetch failed 502', true), want: c => c.decision === 'block' && c.reason && c.reason.length > 0, presetState: { count: 1, lastAt: Date.now() - 5000, lastText: '别的错误' } },
  // T16 专测 config 分层：DATA_DIR 用户配置覆盖出厂 config.json
  { name: 'T16 用户配置覆盖出厂(config 分层)', input: HOOK('s16', 'fetch failed 502'), want: c => c.decision === 'block' && /USER-OVERRIDE/.test(c.reason), presetUserConfig: { continueText: 'USER-OVERRIDE-续跑' } },
  // T17-T20 P0 修正（2026-11-04）：问句豁免 + 签名位置约束
  { name: 'T17 错误分析+问句结尾→不续', input: HOOK('s17', '断流根因是 timeout 和 ECONNRESET，429 也会触发。要我落地 P0 补丁吗？'), want: c => c.decision === undefined && c.additionalContext === undefined },
  { name: 'T18 长分析文本签名散布正文→不续', input: HOOK('s18', '结论如下。\n\n' + '错误机制分析：error、failed、timeout、ECONNRESET、429、5xx、网络中断、重试后仍失败。'.repeat(5)), want: c => c.decision === undefined && c.additionalContext === undefined },
  { name: 'T19 头部真实错误→仍续跑', input: HOOK('s19', 'Error: fetch failed: socket hang up\n（后续为正常分析文本）' + '已完成排查，共修改 3 个文件。'.repeat(10)), want: c => c.decision === 'block' && c.reason && c.reason.length > 0 },
  { name: 'T20 英文问句结尾→不续', input: HOOK('s20', 'The failure was caused by timeout and error 502. Should I proceed with the patch?'), want: c => c.decision === undefined && c.additionalContext === undefined },
];

let pass = 0, fail = 0;
for (const [i, tc] of CASES.entries()) {
  // 每例干净状态
  fs.rmSync(path.join(__dirname, 'state'), { recursive: true, force: true });
  if (tc.presetUserConfig) {
    fs.mkdirSync(path.join(__dirname, 'state'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'state', 'config.json'), JSON.stringify(tc.presetUserConfig));
  }
  if (tc.presetState) {
    fs.mkdirSync(path.join(__dirname, 'state'), { recursive: true });
    // 引擎按 session_id 落状态文件：t{N} 案例用 s{N} 会话，文件名必须对齐
    const sid = tc.input.match(/"session_id":"([^"]+)"/)[1];
    fs.writeFileSync(path.join(__dirname, 'state', `${sid}.json`), JSON.stringify(tc.presetState));
  }
  if (tc.config) {
    fs.writeFileSync(path.join(__dirname, 'config-ovr.json'), JSON.stringify({ ...tc.config, _ovr: true }));
  }
  // config 覆盖用环境变量不行（引擎读固定路径）→ 临时替换 config.json
  const cfgPath = path.join(__dirname, '..', 'hooks', 'config.json');
  const origCfg = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : null;
  if (tc.config) fs.writeFileSync(cfgPath, JSON.stringify(tc.config));

  const r = spawnSync('node', [ENGINE], { input: tc.input, env: ENV, encoding: 'utf8' });

  if (origCfg !== null) fs.writeFileSync(cfgPath, origCfg);

  let out = {};
  try { out = JSON.parse(r.stdout || '{}'); } catch { }
  const ok = tc.want(out) && r.status === 0;
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${tc.name}\n  stdout: ${r.stdout}\n  stderr: ${r.stderr}\n  status: ${r.status}`);
  }
}
fs.rmSync(path.join(__dirname, 'state'), { recursive: true, force: true });
console.log(`\n${pass}/${CASES.length} PASS${fail ? `，${fail} FAIL` : ''}`);
process.exit(fail ? 1 : 0);
