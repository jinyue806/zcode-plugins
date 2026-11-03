#!/usr/bin/env node
// server.mjs — 最小 MCP stdio 服务（newline-delimited JSON-RPC 2.0，零依赖）
import readline from 'readline';
import { opsReplace } from './replace.mjs';

const SERVER_NAME = 'zcode-ops';
const SERVER_VERSION = '0.1.0';
const DEFAULT_PROTOCOL = '2024-11-05';
const TOOL_NAME = 'ops_replace';

const TOOL_DESCRIPTION =
  'Literal (non-regex) find & replace across an explicit list of files. All occurrences are replaced. ' +
  'dry_run defaults to true and writes nothing. Preserves UTF-8 BOM and CRLF/LF line endings byte-for-byte; ' +
  'skips binary, non-UTF-8, oversized (>2MB) and missing files with an explicit reason. Writes are atomic. ' +
  'No globs, no directory recursion.';

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    paths: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 100,
      description: 'Explicit file paths to scan. No globs, no directory recursion.',
    },
    find: { type: 'string', minLength: 1, description: 'Literal string to search for (not a regex).' },
    replace: { type: 'string', description: 'Replacement string; empty string deletes matches.' },
    dry_run: {
      type: 'boolean',
      default: true,
      description: 'When true (default) nothing is written; only counts and previews are returned.',
    },
  },
  required: ['paths', 'find', 'replace'],
  additionalProperties: false,
};

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function okResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

function textResult(id, text, isError) {
  const result = { content: [{ type: 'text', text }] };
  if (isError) result.isError = true;
  return { jsonrpc: '2.0', id, result };
}

function validateArguments(args) {
  const errors = [];
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return ['arguments must be an object'];
  const known = new Set(['paths', 'find', 'replace', 'dry_run']);
  for (const key of Object.keys(args)) {
    if (!known.has(key)) errors.push(`unknown argument: ${key}`);
  }
  const { paths, find, replace, dry_run } = args;
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 100) {
    errors.push('paths must be an array of 1..100 file paths');
  } else if (paths.some((p) => typeof p !== 'string' || p.length === 0)) {
    errors.push('every path must be a non-empty string');
  }
  if (typeof find !== 'string' || find.length === 0) errors.push('find must be a non-empty string');
  if (typeof replace !== 'string') errors.push('replace must be a string (empty string is allowed)');
  if (dry_run !== undefined && typeof dry_run !== 'boolean') errors.push('dry_run must be a boolean');
  return errors;
}

async function handleToolsCall(id, params) {
  const name = params && params.name;
  if (name !== TOOL_NAME) return errorResponse(id, -32602, `Unknown tool: ${name}`);

  const args = (params && params.arguments) || {};
  const errors = validateArguments(args);
  if (errors.length > 0) return textResult(id, errors.join('; '), true);

  try {
    const output = await opsReplace({
      paths: args.paths,
      find: args.find,
      replace: args.replace,
      dryRun: args.dry_run === undefined ? true : args.dry_run,
    });
    return textResult(id, JSON.stringify(output, null, 2), false);
  } catch (err) {
    return textResult(id, String((err && err.message) || err), true);
  }
}

async function handle(msg) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return errorResponse(null, -32600, 'Invalid Request');
  const { id, method, params } = msg;
  if (typeof method !== 'string') return errorResponse(id, -32600, 'Invalid Request');

  if (method.startsWith('notifications/')) return null;

  switch (method) {
    case 'initialize': {
      const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL;
      return okResponse(id, {
        protocolVersion: requested || DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping':
      return okResponse(id, {});
    case 'tools/list':
      return okResponse(id, {
        tools: [{ name: TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema: INPUT_SCHEMA }],
      });
    case 'tools/call':
      return handleToolsCall(id, params);
    default:
      if (id === undefined) return null;
      return errorResponse(id, -32601, `Method not found: ${method}`);
  }
}

async function onLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    send(errorResponse(null, -32700, 'Parse error'));
    return;
  }

  let response;
  try {
    response = await handle(msg);
  } catch (err) {
    response = errorResponse(msg && msg.id, -32603, String((err && err.message) || err));
  }
  if (response) send(response);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

let pending = 0;
let closing = false;

function maybeExit() {
  if (closing && pending === 0) process.exit(0);
}

rl.on('line', (line) => {
  pending++;
  onLine(line)
    .catch((err) => {
      process.stderr.write(`zcode-ops: ${(err && err.stack) || err}\n`);
    })
    .finally(() => {
      pending--;
      maybeExit();
    });
});
rl.on('close', () => {
  closing = true;
  maybeExit();
});
process.stdout.on('error', () => process.exit(0));
