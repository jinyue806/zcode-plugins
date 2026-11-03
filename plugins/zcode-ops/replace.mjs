// replace.mjs — 字面批量替换引擎（纯逻辑 + 文件安全薄层，零依赖）
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const NUL_SCAN_BYTES = 8192;
export const PREVIEW_MAX_HITS = 5;
export const PREVIEW_BUDGET = 20000;
const SNIPPET_MAX = 200;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function countLines(text, at) {
  let n = 1;
  for (let i = 0; i < at; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function lineSlice(text, at) {
  const start = text.lastIndexOf('\n', at - 1) + 1;
  let end = text.indexOf('\n', at);
  if (end === -1) end = text.length;
  let line = text.slice(start, end);
  if (line.endsWith('\r')) line = line.slice(0, -1);
  if (line.length > SNIPPET_MAX) line = line.slice(0, SNIPPET_MAX) + '…';
  return line;
}

export function replaceInContent(content, find, replace) {
  if (typeof content !== 'string') throw new Error('content must be a string');
  if (typeof find !== 'string' || find.length === 0) throw new Error('find must be a non-empty string');
  if (typeof replace !== 'string') throw new Error('replace must be a string');

  const hits = [];
  let out = '';
  let cursor = 0;
  for (;;) {
    const at = content.indexOf(find, cursor);
    if (at === -1) {
      out += content.slice(cursor);
      break;
    }
    out += content.slice(cursor, at);
    hits.push({ line: countLines(content, at), newStart: out.length });
    out += replace;
    cursor = at + find.length;
  }

  const previewLines = hits.slice(0, PREVIEW_MAX_HITS).map((h) => `L${h.line}: ${lineSlice(out, h.newStart)}`);
  return { matches: hits.length, content: out, previewLines };
}

async function atomicWrite(filePath, content, hasBom) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  // 同目录临时文件 + rename：中途崩溃时原文件仍是完整旧版本，不会留半截内容
  const data = hasBom ? Buffer.concat([UTF8_BOM, Buffer.from(content, 'utf8')]) : Buffer.from(content, 'utf8');
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function processOne(filePath, find, replace, write, noop) {
  const entry = { path: filePath, matches: 0, applied: false };

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { ...entry, skipped: true, skip_reason: 'not-found' };
    return { ...entry, skipped: true, skip_reason: 'read-error' };
  }
  if (!stat.isFile()) return { ...entry, skipped: true, skip_reason: 'not-a-file' };
  if (stat.size > MAX_FILE_BYTES) return { ...entry, skipped: true, skip_reason: 'too-large' };

  let buf;
  try {
    buf = await fs.readFile(filePath);
  } catch {
    return { ...entry, skipped: true, skip_reason: 'read-error' };
  }

  if (buf.subarray(0, NUL_SCAN_BYTES).includes(0)) return { ...entry, skipped: true, skip_reason: 'binary' };

  // BOM 是字节级契约的一部分：解码前剥离、写回时原样补回
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const body = hasBom ? buf.subarray(3) : buf;

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return { ...entry, skipped: true, skip_reason: 'non-utf8' };
  }

  const r = replaceInContent(text, find, replace);
  entry.matches = r.matches;

  if (noop) {
    if (r.matches === 0) return entry;
    entry.preview = r.previewLines;
    return { ...entry, skipped: true, skip_reason: 'noop' };
  }
  if (r.matches === 0) return entry;
  if (!write) return { ...entry, preview: r.previewLines };

  try {
    await atomicWrite(filePath, r.content, hasBom);
  } catch {
    return { ...entry, skipped: true, skip_reason: 'write-error' };
  }
  entry.applied = true;
  entry.preview = r.previewLines;
  return entry;
}

export async function opsReplace({ paths, find, replace, dryRun = true } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('paths must be a non-empty array');
  if (typeof find !== 'string' || find.length === 0) throw new Error('find must be a non-empty string');
  if (typeof replace !== 'string') throw new Error('replace must be a string');

  const isDry = dryRun !== false;
  const noop = find === replace;

  const files = [];
  for (const raw of paths) {
    files.push(await processOne(String(raw), find, replace, !isDry && !noop, noop));
  }

  let budget = PREVIEW_BUDGET;
  let truncated = false;
  for (const f of files) {
    if (!f.preview) continue;
    const kept = [];
    for (const line of f.preview) {
      if (line.length + 1 > budget) {
        truncated = true;
        break;
      }
      budget -= line.length + 1;
      kept.push(line);
    }
    if (kept.length < f.preview.length) truncated = true;
    if (kept.length > 0) f.preview = kept;
    else delete f.preview;
  }

  const totalMatches = files.reduce((sum, f) => sum + f.matches, 0);
  const totalFilesMatched = files.filter((f) => f.matches > 0).length;

  const result = {
    ok: true,
    dry_run: isDry,
    total_matches: totalMatches,
    total_files_matched: totalFilesMatched,
    files,
  };
  if (truncated) result.truncated = true;
  return result;
}
