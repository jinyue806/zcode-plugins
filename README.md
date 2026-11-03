# zcode-plugins

JY 的 ZCode 插件合集（marketplace 仓）。在 ZCode **设置 → 插件管理 → Discover → `+`** 添加本仓地址即可浏览安装。

## 安装

Discover 界面 `+` 添加：

```
jinyue806/zcode-plugins
```

或手动编辑 `~/.zcode/cli/config.json`：

```json
{
  "plugins": {
    "extraKnownMarketplaces": {
      "jinyue806-zcode-plugins": { "source": "github", "repo": "jinyue806/zcode-plugins" }
    }
  }
}
```

## 插件清单

| 插件 | 说明 |
|:--|:--|
| [auto-continue](./plugins/auto-continue/) | 回合以临时性错误（网络/5xx/429/超时）收尾时经 Stop 钩子自动续跑；永久性错误（认证/余额/上下文超限）不重试只提示。单会话最多续 2 次（ZCode 硬上限 3），带冷却与同文本循环护栏。失败分类思路移植自 [dsh-auto-continue](https://github.com/HsiangNianian/dsh-auto-continue)（MIT）。 |
| [zcode-ops](./plugins/zcode-ops/) | MCP 工具 `ops_replace`：跨文件字面（非正则）批量替换。`dry_run` 默认只报告不落盘；原子写；UTF-8 BOM 与 CRLF/LF 字节级保持；二进制/非 UTF-8/超大/缺失文件显式跳过并给理由。 |

## 结构（对齐官方 distribution 布局）

```
marketplace.json          # marketplace 清单（仓库根）
plugins/
├── auto-continue/        # 插件本体（.zcode-plugin/plugin.json，hooks/hooks.json 自动发现）
└── zcode-ops/            # 插件本体（.zcode-plugin/plugin.json + .mcp.json 挂 MCP server）
```

## License

MIT
