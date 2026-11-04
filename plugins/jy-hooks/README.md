# jy-hooks — 个人治理钩子包（canonical）

<!-- provenance: 生成=ZCode(magpie/group/qwen3.8-flash); 核验=tests 实测; 2026-11-04 -->

把原先散在 `~/.zcode/hooks/` + `~/.zcode/cli/config.json` 手工注册的 4 个钩子打包成插件：装完即生效，新机器/新客户端不再需要手改 config.json。

| 钩子 | 事件 / matcher | 作用 | 失败姿态 |
|---|---|---|---|
| `rtk-enforce.ps1` | PreToolUse / Bash | RTK 命令改写适配（转发 `rtk hook claude`，剥掉其权限断言，保 ZCode 权限流权威） | fail-open |
| `commit-guard.ps1` | PreToolUse / Bash | 拦 `git commit -m` 内嵌中文（GBK 乱码事故 f9f70c1 后立的硬规则），强制 `-F <file>` | fail-open |
| `cand-rule-probe.ps1` | PreToolUse / Edit\|Write | 规则面写入观察探针（AGENTS/CLAUDE/SKILL/self-check），只记形状不记内容，observe-only | fail-open |
| `jev-advisory.ps1` | PostToolUse / * | 决策相关写入的 JEV  advisory（typesafe API，带 3 连败熔断 30min），只提示不拦截 | fail-open |

## 本机依赖（脚本内绝对路径，换机需改）

- `C:\Program Files\PowerShell\7\pwsh.exe`（宿主 command）
- `C:\Users\JY806\.local\bin\rtk.exe`（rtk-enforce）
- `%USERPROFILE%\.dsh\.env` 的 `TYPESAFE_API_KEY`（jev-advisory，缺 key 静默放行）
- `E:\workplace\.zcode\v2\`（四个钩子的 jsonl/state 落盘点；目录不存在则静默不记）

## 维护约定

- **canonical = 本目录**；改动只落这里，发布同步到 GitHub 镜像 `jinyue806/zcode-plugins` 的 `plugins/jy-hooks/` + `marketplace.json`（对齐 zcode-plugins 仓模式，永不反向回灌）。
- 脚本保持**零自引用路径**：只依赖上面的绝对路径与 stdin/stdout 协议，因此 `cp` 字节级复制即可入包，禁止经过重打（防编码/占位符事故）。
- 改完跑 `node tests/run-cases.mjs`（断言 exit 码 + `E:\workplace\.zcode\v2\*.jsonl` 审计尾行 outcome，不读内容）；jev-advisory 只测快速路径，不打真实 API。
- 钩子协议约束：ZCode hook 输出只认**扁平键**；`updatedInput` 仅 PreToolUse 支持；PostToolUse 无 permission 通道。
- 装机后 `~/.zcode/cli/config.json` 里同名的旧注册必须摘除（防双触发）；卸载 = 移除 config 注册，脚本文件可留档。

## 版本

- 0.1.0（2026-11-04）：首版收编 4 散钩子，行为与原 config.json 注册逐项对齐（matcher、timeout、statusMessage）。
