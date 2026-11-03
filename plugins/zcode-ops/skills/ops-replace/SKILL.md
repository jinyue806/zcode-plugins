---
name: ops-replace
description: "跨文件字面批量替换走 ops_replace（MCP 工具）：dry_run 默认 true、CRLF/BOM 字节级保持、原子写、二进制/非 UTF-8/超大文件显式跳过。Trigger: 批量替换/全局改名/跨文件改配置段/rename symbol across files/多文件 find replace。"
---

<!-- provenance: 生成=ZCode(magpie/group/deepseek-v4.1-flash); 核验=待核; 2026-11-03 -->

# ops-replace — 批量字面替换路由

## 何时用哪个工具

| 场景 | 工具 |
|:--|:--|
| 字面替换跨 **≥2 个文件**，或单文件 **≥5 处** | `ops_replace` |
| 单文件、少量（<5 处）、需要精确上下文定位 | 原生 `Edit` |
| 正则 / 结构化改写 / 非替换类操作（移动、生成、跑命令） | `Bash` 或对应工具 |

判据：**能不能预先列出确切文件路径**。能 → `ops_replace`；需要 glob 展开或目录递归 → 本工具不支持，先自己列出路径。

## 零门槛示例

```json
{
  "name": "ops_replace",
  "arguments": {
    "paths": ["E:/workplace/project/src/a.ts", "E:/workplace/project/src/b.ts"],
    "find": "oldName",
    "replace": "newName",
    "dry_run": true
  }
}
```

先跑 `dry_run: true`（默认，可省略）：看 `total_matches`、`total_files_matched`、每文件 `matches` 与 `preview`（`L<行号>: 变更后整行`，行号锚定原文件匹配起始行）。只有每项都符合预期，才带 `"dry_run": false` 再调一次落盘。

返回要点：`ok`、`dry_run`、`total_matches`、`total_files_matched`、`files[]`（`path`/`matches`/`applied`/`skipped?`/`skip_reason?`/`preview?`）。预览超输出上限时顶层带 `truncated: true`。

## 失败路径（不是错误，是结构化报告）

| skip_reason | 含义 | 怎么办 |
|:--|:--|:--|
| `non-utf8` | 文件不是合法 UTF-8（GBK 等） | 先转码，别让工具猜编码 |
| `binary` | 前 8KB 含 NUL 字节 | 从 `paths` 移除；确有需求另走专门工具 |
| `too-large` | 文件 >2MB | 拆分或改用流式脚本，人工确认 |
| `not-found` | 路径不存在（同批其它文件照常处理） | 核对路径，重新发一次 |
| `not-a-file` | 路径是目录 | 本工具不做目录递归，列出具体文件 |
| `noop` | `find === replace`，未写任何文件 | 改 `find` 或 `replace` |
| `write-error` | 原子写失败，原文件保持不动 | 查权限/占用，重试 |

误用了怎么办：`dry_run` 默认 true ⇒ 误调不会落盘；已落盘且内容不符 ⇒ 用同一组 `paths` 反向替换（`find`/`replace` 互换）回滚，或走 git 恢复。

其他硬约束：`paths` 1..100 条、显式路径（无 glob、无递归）；`find` 非空（空则 `isError`）；`replace` 可为空串 = 删除；匹配为纯字面、左到右非重叠、每文件全量替换。
