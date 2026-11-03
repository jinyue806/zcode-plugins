# auto-continue

回合以**临时性错误**（网络/5xx/429/超时）收尾时，经 Stop 钩子自动续跑（单会话最多 `maxConsecutive` 次，ZCode 硬上限 3）；**永久性错误**（认证/余额/上下文超限）不重试，只注入一句说明。失败分类思路移植自 [dsh-auto-continue](https://github.com/HsiangNianian/dsh-auto-continue)（MIT）。

## 安装

[ZCode 插件市场](https://github.com/jinyue806/zcode-plugins)：设置 → 插件管理 → Discover → `+` 添加 `jinyue806/zcode-plugins`，选装本插件。

## 工作机制

| 回合结尾文本 | 判定 | 动作 |
|:--|:--|:--|
| 网络/5xx/429/timeout/ECONN*/「重试后仍失败」等 error 签名 | 临时错误 | 注入「从中断处继续」自动续跑 |
| 401/403/auth/billing/上下文超限 | 永久错误 | 不续跑，注入「请人工处理」 |
| 正常完成（无 error 签名） | clean | 零输出不干预 |

回环护栏：续跑轮带 `stop_hook_active:true`、冷却 2s、同文本循环检测、引擎崩溃静默放行（宁可漏续不可卡死会话）。用户手动停止的回合不会触发本插件。

## 配置

`hooks/config.json`（插件缓存目录内）：

```json
{
  "enabled": true,
  "cooldownMs": 2000,
  "maxConsecutive": 2,
  "continueText": "上一回合因临时性错误中断。请从中断处继续完成任务。",
  "retryableErrorPatterns": "",
  "permanentErrorPatterns": ""
}
```

- `retryableErrorPatterns` / `permanentErrorPatterns`：每行一条子串 pattern，命中强制归为临时/永久（用户 pattern 优先级最高）
- **配置分层**：`hooks/config.json` 是出厂默认（随插件更新被覆盖）；把改好的 config 放到插件数据目录（`${ZCODE_PLUGIN_DATA}/config.json`）即用户配置，跨更新持久、优先级最高
- 运行态与崩溃日志在数据目录（按会话隔离，7 天自动清理）

## 协议细节

- Stop 钩子输出规范形 `{"decision":"block","reason":"..."}` 续跑一轮（`reason` 注入消息历史；`continue:true` 为 legacy 兼容形，本插件已迁规范形）
- ZCode 连续续跑硬上限 **3 次**（硬编码），本插件默认 `maxConsecutive: 2` 自我收敛
- ZCode 的 Stop 钩子对**正常完成回合也触发**（无 DSH 的 `turn/end reason` 信号），故判据为「默认放行 + 命中显式 error 签名才分类」

## 测试

```bash
node tests/run-cases.mjs   # 16/16 全分支 stdin 模拟（含 config 分层）
```

## License

MIT。失败分类思路源自 [dsh-auto-continue](https://github.com/HsiangNianian/dsh-auto-continue)（MIT）。
