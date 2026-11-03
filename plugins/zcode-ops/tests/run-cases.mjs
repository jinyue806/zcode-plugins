// run-cases.mjs — zcode-ops 全语义用例（零依赖，fixture 全部运行时生成于 os.tmpdir）
// 用法: node tests/run-cases.mjs
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { opsReplace, replaceInContent } from '../replace.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'server.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-ops-cases-'));

let seq = 0;
function fixture(name, bytes) {
  const dir = path.join(TMP, `c${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

function hash(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function rpc(requests) {
  const input = requests.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const out = spawnSync(process.execPath, [SERVER], { input, encoding: 'utf8', timeout: 60000 });
  const lines = String(out.stdout || '')
    .split('\n')
    .filter((l) => l.trim() !== '');
  return {
    status: out.status,
    stderr: out.stderr,
    stdout: out.stdout,
    messages: lines.map((l) => JSON.parse(l)),
  };
}

const CASES = [];
function test(name, fn) {
  CASES.push({ name, fn });
}

test('01 CRLF 文件替换后行尾字节级不变', async () => {
  const p = fixture('crlf.txt', 'alpha\r\nFIND\r\nomega\r\n');
  const r = await opsReplace({ paths: [p], find: 'FIND', replace: 'REPL', dryRun: false });
  assert(r.total_matches === 1, `total_matches=${r.total_matches}`);
  assert(r.files[0].applied === true, 'applied should be true');

  const got = fs.readFileSync(p);
  const want = Buffer.from('alpha\r\nREPL\r\nomega\r\n', 'utf8');
  assert(got.equals(want), `bytes mismatch: ${JSON.stringify(got.toString('latin1'))}`);
  let crlf = 0;
  for (let i = 0; i < got.length - 1; i++) if (got[i] === 0x0d && got[i + 1] === 0x0a) crlf++;
  assert(crlf === 3, `expected 3 CRLF pairs, got ${crlf}`);

  const q = fixture('crlf-lf-find.txt', 'a\r\nb\r\nc\r\n');
  const before = hash(q);
  const r2 = await opsReplace({ paths: [q], find: 'a\nb', replace: 'X', dryRun: false });
  assert(r2.total_matches === 0, `LF-only find on CRLF file must not match, got ${r2.total_matches}`);
  assert(hash(q) === before, 'file bytes changed on zero-match LF find');
});

test('02 LF 文件替换正确', async () => {
  const p = fixture('lf.txt', 'one\ntwo FIND\nthree');
  const r = await opsReplace({ paths: [p], find: 'FIND', replace: 'OK', dryRun: false });
  assert(r.total_matches === 1, `total_matches=${r.total_matches}`);
  assert(fs.readFileSync(p).equals(Buffer.from('one\ntwo OK\nthree')), 'LF content mismatch');
});

test('03 UTF-8 BOM 保留 + 内容正确', async () => {
  const body = Buffer.from('a FIND b', 'utf8');
  const p = fixture('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]));
  const r = await opsReplace({ paths: [p], find: 'FIND', replace: 'REPL', dryRun: false });
  assert(r.total_matches === 1, `total_matches=${r.total_matches}`);
  const got = fs.readFileSync(p);
  assert(got.length >= 3, 'file too short');
  assert(got[0] === 0xef && got[1] === 0xbb && got[2] === 0xbf, 'BOM lost');
  assert(got.subarray(3).equals(Buffer.from('a REPL b', 'utf8')), 'body mismatch');
});

test('04 单文件多处匹配计数与全量替换', async () => {
  const p = fixture('multi.txt', 'x1 x2 x3\nno match here\nx4\n');
  const r = await opsReplace({ paths: [p], find: 'x', replace: 'yy', dryRun: false });
  assert(r.total_matches === 4, `total_matches=${r.total_matches}`);
  assert(r.files[0].matches === 4, `file matches=${r.files[0].matches}`);
  assert(r.total_files_matched === 1, `total_files_matched=${r.total_files_matched}`);
  assert(fs.readFileSync(p).equals(Buffer.from('yy1 yy2 yy3\nno match here\nyy4\n')), 'content mismatch');

  const unit = replaceInContent('x x x', 'x', 'ab');
  assert(unit.matches === 3, `unit matches=${unit.matches}`);
  assert(unit.content === 'ab ab ab', `unit content=${unit.content}`);
});

test('05 零匹配：计数为 0、applied:false、字节不变', async () => {
  const p = fixture('zero.txt', 'nothing to see\r\nhere\r\n');
  const before = hash(p);
  const r = await opsReplace({ paths: [p], find: 'ABSENT', replace: 'X', dryRun: false });
  assert(r.total_matches === 0, `total_matches=${r.total_matches}`);
  assert(r.total_files_matched === 0, `total_files_matched=${r.total_files_matched}`);
  assert(r.files[0].applied === false, 'applied should be false');
  assert(r.files[0].skipped === undefined, 'zero-match file must not be reported as skipped');
  assert(hash(p) === before, 'file bytes changed on zero match');
});

test('06 dry_run 全文件字节不变且 preview 行号正确', async () => {
  const p = fixture('dry1.txt', 'l1\nl2 FIND\nl3\n');
  const q = fixture('dry2.txt', 'FIND\nFIND\n');
  const h1 = hash(p);
  const h2 = hash(q);
  const r = await opsReplace({ paths: [p, q], find: 'FIND', replace: 'REPL', dryRun: true });
  assert(r.dry_run === true, 'dry_run should be true');
  assert(r.total_matches === 3, `total_matches=${r.total_matches}`);
  assert(r.files.every((f) => f.applied === false), 'dry_run must not apply');
  assert(hash(p) === h1 && hash(q) === h2, 'dry_run wrote to disk');
  assert(Array.isArray(r.files[0].preview), 'preview missing');
  assert(r.files[0].preview[0] === 'L2: l2 REPL', `preview=${JSON.stringify(r.files[0].preview)}`);
});

test('07 含 NUL 二进制文件 → skipped:binary', async () => {
  const p = fixture('bin.dat', Buffer.from('abc\u0000def FIND', 'utf8'));
  const before = hash(p);
  const r = await opsReplace({ paths: [p], find: 'FIND', replace: 'X', dryRun: false });
  assert(r.files[0].skipped === true, 'skipped should be true');
  assert(r.files[0].skip_reason === 'binary', `skip_reason=${r.files[0].skip_reason}`);
  assert(r.total_matches === 0, `total_matches=${r.total_matches}`);
  assert(hash(p) === before, 'binary file touched');
});

test('08 >2MB 文件 → skipped:too-large', async () => {
  const p = fixture('big.txt', Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
  const before = hash(p);
  const r = await opsReplace({ paths: [p], find: 'a', replace: 'b', dryRun: false });
  assert(r.files[0].skipped === true, 'skipped should be true');
  assert(r.files[0].skip_reason === 'too-large', `skip_reason=${r.files[0].skip_reason}`);
  assert(hash(p) === before, 'oversized file touched');
});

test('09 非法 UTF-8 字节序列 → skipped:non-utf8', async () => {
  const p = fixture('bad-utf8.txt', Buffer.from([0x61, 0x20, 0x80, 0x20, 0x62]));
  const before = hash(p);
  const r = await opsReplace({ paths: [p], find: 'a', replace: 'z', dryRun: false });
  assert(r.files[0].skipped === true, 'skipped should be true');
  assert(r.files[0].skip_reason === 'non-utf8', `skip_reason=${r.files[0].skip_reason}`);
  assert(hash(p) === before, 'non-utf8 file touched');
});

test('10 find===replace → no-op 报告', async () => {
  const p = fixture('noop.txt', 'abc abc\n');
  const q = fixture('noop-zero.txt', 'zzz zzz\n');
  const before = hash(p);
  const r = await opsReplace({ paths: [p, q], find: 'abc', replace: 'abc', dryRun: false });
  assert(r.files[0].applied === false, 'applied should be false');
  assert(r.files[0].skip_reason === 'noop', `skip_reason=${r.files[0].skip_reason}`);
  assert(hash(p) === before, 'noop wrote to disk');
  assert(r.files[1].matches === 0, `zero-match matches=${r.files[1].matches}`);
  assert(r.files[1].skipped === undefined, `zero-match file must not carry noop skip: ${JSON.stringify(r.files[1])}`);
});

test('11 空 find → tools/call 返回 isError', async () => {
  const p = fixture('empty-find.txt', 'abc\n');
  const { messages } = rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ops_replace', arguments: { paths: [p], find: '', replace: 'x' } } },
  ]);
  const call = messages.find((m) => m.id === 2);
  assert(call && call.result, 'no tools/call response');
  assert(call.result.isError === true, 'isError should be true');
  assert(/find/.test(call.result.content[0].text), `error text=${call.result.content[0].text}`);
});

test('12 不存在路径 → skipped:not-found，同批其它文件照常', async () => {
  const missing = path.join(TMP, 'definitely', 'not-here.txt');
  const p = fixture('present.txt', 'FIND and FIND\n');
  const r = await opsReplace({ paths: [missing, p], find: 'FIND', replace: 'OK', dryRun: false });
  assert(r.ok === true, 'ok should be true');
  assert(r.files[0].skipped === true && r.files[0].skip_reason === 'not-found', `missing=${JSON.stringify(r.files[0])}`);
  assert(r.files[1].applied === true, 'present file not written');
  assert(fs.readFileSync(p).equals(Buffer.from('OK and OK\n')), 'present file content mismatch');
  assert(r.total_matches === 2, `total_matches=${r.total_matches}`);
});

test('13 MCP 冒烟：initialize / tools/list / tools/call', async () => {
  const p = fixture('smoke.txt', 'hello FIND\n');
  const before = hash(p);
  const { status, stderr, messages } = rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ops_replace', arguments: { paths: [p], find: 'FIND', replace: 'REPL', dry_run: true } } },
  ]);
  assert(status === 0, `server exit ${status}: ${stderr}`);
  assert(messages.length === 3, `expected 3 responses (notification silent), got ${messages.length}`);

  const init = messages.find((m) => m.id === 1);
  assert(init.jsonrpc === '2.0' && init.result.protocolVersion === '2025-06-18', `initialize response=${JSON.stringify(init)}`);
  assert(init.result.capabilities && init.result.capabilities.tools, 'capabilities.tools missing');
  assert(init.result.serverInfo && init.result.serverInfo.name === 'zcode-ops', 'serverInfo mismatch');

  const list = messages.find((m) => m.id === 2);
  const tool = list.result.tools.find((t) => t.name === 'ops_replace');
  assert(tool, 'ops_replace not listed');
  assert(tool.inputSchema.required.join(',') === 'paths,find,replace', `required=${tool.inputSchema.required}`);

  const call = messages.find((m) => m.id === 3);
  assert(call.result && call.result.isError !== true, 'tools/call failed');
  const payload = JSON.parse(call.result.content[0].text);
  assert(payload.ok === true, 'payload.ok false');
  assert(payload.dry_run === true, 'dry_run echo wrong');
  assert(payload.total_matches === 1, `payload.total_matches=${payload.total_matches}`);
  assert(payload.files[0].path === p, 'path echo wrong');
  assert(hash(p) === before, 'MCP dry_run wrote to disk');
});

test('14 多行 find/replace：preview 行号=原文件匹配起始行，片段=替换后首行', async () => {
  const p = fixture('ml.txt', 'a\nb\nc\n');
  const r = await opsReplace({ paths: [p], find: 'a\nb', replace: 'x\ny\nz', dryRun: true });
  assert(r.files[0].preview[0] === 'L1: x', `preview=${JSON.stringify(r.files[0].preview)}`);
  const q = fixture('ml2.txt', 'p\nq\n');
  const r2 = await opsReplace({ paths: [q], find: 'q', replace: 'r\ns', dryRun: true });
  assert(r2.files[0].preview[0] === 'L2: r', `preview=${JSON.stringify(r2.files[0].preview)}`);
});

test('15 ping 回 result、未知 method 回 -32601', async () => {
  const { messages } = rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
    { jsonrpc: '2.0', id: 2, method: 'ping' },
    { jsonrpc: '2.0', id: 3, method: 'no/such-method' },
  ]);
  const ping = messages.find((m) => m.id === 2);
  assert(ping && ping.result !== undefined, `ping=${JSON.stringify(ping)}`);
  const unknown = messages.find((m) => m.id === 3);
  assert(unknown && unknown.error && unknown.error.code === -32601, `unknown=${JSON.stringify(unknown)}`);
});

let passed = 0;
const failed = [];
for (const c of CASES) {
  try {
    await c.fn();
    passed++;
    console.log(`PASS  ${c.name}`);
  } catch (err) {
    failed.push(c.name);
    console.log(`FAIL  ${c.name}`);
    console.log(`      ${(err && err.message) || err}`);
  }
}

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  // 清理失败不影响判定
}

console.log('');
console.log(`${passed}/${CASES.length} PASS`);
if (failed.length > 0) {
  console.log(`FAILED: ${failed.join(' | ')}`);
  process.exit(1);
}
