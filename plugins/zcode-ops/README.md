# zcode-ops

ZCode 插件，提供 MCP 工具 `ops_replace`：跨文件**字面**（非正则）批量替换。默认 dry-run 只报告不落盘；`dry_run: false` 才写，写入为「同目录临时文件 + rename」原子操作。

设计目标是把「sed 静默剥 CRLF / 中文转码损坏 / 静默重定向假成功」这类事故从「靠运气」变成「结构上不可能」：UTF-8 BOM 保留、CRLF/LF 行尾原样、二进制/非 UTF-8/超大/不存在文件显式跳过并给理由。

## 安装

纯文件插件，无 install 步骤、零 npm 依赖、不生成 `node_modules`。

```
zcode-plugins/zcode-ops/
  .zcode-plugin/plugin.json    # 清单：mcpServers + skills
  .mcp.json                    # stdio 服务器：node ${CLAUDE_PLUGIN_ROOT}/server.mjs
  server.mjs                   # 最小 MCP stdio 服务（newline-delimited JSON-RPC 2.0）
  replace.mjs                  # 替换引擎（纯逻辑 + 文件安全薄层）
  skills/ops-replace/SKILL.md  # 路由 skill
  tests/run-cases.mjs          # 零依赖测试
```

- 本地调试：插件目录放进 ZCode 插件目录（或市场安装本仓插件），插件加载器把 `${CLAUDE_PLUGIN_ROOT}` 解析为插件根，`.mcp.json` 随插件自动挂载 `zcode-ops` MCP server。
- 验证装载：会话工具清单里出现 `ops_replace` 即为生效。
- 要求 Node 18+（只用内置模块）。

## 工具契约

`ops_replace`

| 参数 | 类型 | 约束 |
|:--|:--|:--|
| `paths` | string[] | 1..100 条**显式文件路径**；不支持 glob、不支持目录递归 |
| `find` | string | 非空（空串 → `isError`）；纯字面匹配，非正则 |
| `replace` | string | 可为空串（= 删除） |
| `dry_run` | boolean | 默认 `true`（只报告不写盘） |

替换语义：字面子串、每文件全量替换、左到右非重叠（等价 `split/join`）。

输出（`tools/call` 的 text 为 JSON 字符串）：

| 字段 | 说明 |
|:--|:--|
| `ok` | 调用是否完成（单文件失败走 `skip_reason`，不置 false） |
| `dry_run` | 本次是否未落盘 |
| `total_matches` | 全部文件匹配总数 |
| `total_files_matched` | 有匹配的文件数 |
| `files[]` | 每项 `path` / `matches` / `applied` / `skipped?` / `skip_reason?` / `preview?` |
| `truncated?` | 预览总长度超上限被截断时为 `true` |
| `files[].preview` | 前 5 处变更片段，形如 `L<行号>: <变更后整行>`（单行最长 200 字符）。行号锚定**原文件**匹配起始行，片段取**替换后**该处所在行（即 `replace` 文本首行）；多行 `find`/`replace` 时两者分属新旧内容，按行号回原文件定位 |

`skip_reason` 取值：`non-utf8` / `binary`（前 8KB 含 NUL）/ `too-large`（>2MB）/ `not-found` / `not-a-file`（路径是目录）/ `noop`（`find === replace`）/ `read-error` / `write-error`（原子写失败，原文件不动）。

## 测试

```bash
node tests/run-cases.mjs   # 15/15 PASS，夹具运行时生成于 os.tmpdir
```

覆盖：CRLF 字节级保持（含「只含 `\n` 的 find 在 CRLF 文件上 0 匹配」）、LF、BOM 保留、多处匹配计数、零匹配字节不变、dry_run 哈希不变 + 预览行号（含多行 find/replace 的坐标语义）、binary/too-large/non-utf8/not-found 跳过、`find === replace` no-op（零匹配文件不标 skipped）、空 find `isError`、MCP 冒烟（initialize / tools/list / tools/call）、`ping` 与未知 method（`-32601`）。

## 已知边界

- 只做字面替换，不支持正则/多行结构化改写（走 Bash 或专门工具）。
- 只接受显式文件列表；glob 展开与目录递归不在 MVP 范围。
- >2MB 文件一律跳过，不提供流式模式。
- 改写后不做格式化/lint，行尾与编码层面的字节语义由工具保证，语义层面由调用方负责。
