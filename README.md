# dsh-429-auto-continue

DSH 插件：回合因 **429 / 限流 / 配额耗尽** 死掉后，等待可配置的延迟（默认 **10 秒**），
自动向同一会话发送 **「继续任务」**——效果等同于你手动输入，任务自动接着跑，不用人守着。

## 定位

这是内置重试链（`dsh-llm-retry`、`dsh-retry-boost` 等）之后的**最后一道网**：

- 重试还在进行中 → 回合没有死 → 本插件**不打扰**；
- 重试耗尽 / 不在重试范围内（比如图片输入变体路由、第三方 adapter 路由）→
  回合以失败结束 → 本插件等 10 秒后自动发「继续任务」。

检测信号：`turn/end` 失败里 `status === 429`（覆盖商汤 SenseNova 会被归类成
`QUOTA` 的 `429 insufficient_quota`），或错误码在 `codes` 白名单
（默认 `RATE_LIMIT` / `QUOTA`）。

## 防打扰

- 同一会话连续 429 → 只保留最新一个定时器（防抖）；
- 定时期间用户手动输入、或会话已经开始新回合（`turn/start`）→ 定时器立即取消；
- 默认排除子会话（subagent），不会给后台子任务乱发消息；
- 插件卸载 → 所有定时器取消、监听注销。

## 安装

```bash
dsh plugin --profile desktop add dsh-429-auto-continue
```

或手动放入 profile 的 `node_modules` 并在 `package.json` 的
`dependencies` / `dsh.profile.bundles` 里登记。装完**重启 DSH** 生效。

## 配置

在合并进 profile 的 `cordis.patch.yml` roster 行（或 DSH 插件配置界面）里调整：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `delayMs` | `10000` | 429 后等待多少毫秒再自动发送（可改，比如 5000 = 5 秒） |
| `message` | `继续任务` | 自动发送的文本 |
| `codes` | `[RATE_LIMIT, QUOTA]` | 触发自动发送的错误码白名单 |
| `excludeSubagents` | `true` | 是否排除子会话 |

示例（5 秒 + 自定义文案）：

```yaml
- insert:
    - id: 429-auto-continue
      name: dsh-429-auto-continue
      config:
        delayMs: 5000
        message: 继续任务
        codes:
          - RATE_LIMIT
          - QUOTA
        excludeSubagents: true
```

## 日志

触发与发送都会打日志，形如：

```
[429-auto-continue] 429 detected (code=QUOTA, status=429) on session <id>; will send "继续任务" in 10000ms
[429-auto-continue] 429 fallback: sent "继续任务" to session <id>
```

## 1.0.2 修复记录（插件页「1 异常」的根因）

之前重启后插件管理器显示 **1 异常（phase = failed）**，有两个独立原因，均已修复：

1. **`export const Config` 是纯对象**。cordis 的 `resolveConfig`
   （`@deepseek-ai/cordis/lib/index.js:956`）会把插件导出的 `Config` 当
   Standard Schema 用：`runtime.Config["~standard"].validate(config)`。
   纯对象没有 `~standard`，启动时抛
   `TypeError: Cannot read properties of undefined (reading 'validate')`，
   该 entry 直接 failed。现在**不导出 `Config`**，改用 `DEFAULT_CONFIG` +
   `apply()` 内部归一化（与 `dsh-retry-boost` 同一范式）。
2. **`ctx.sessionController` 属性读取会抛**。没声明 `inject` 时，cordis 的 ctx
   代理直接抛 `cannot get property "sessionController" without inject`，且原代码
   在定时器回调里抛出 → 未捕获 rejection → 宿主
   `fatal load failure`（真实 429 时不是续跑，是把 DSH 打挂）。现在用
   `ctx.get("sessionController", false)`（inject-free 读取）按需取用，
   定时器回调与事件监听都做了兜底，永不向外抛。

回归用例：`node smoke-429-auto-continue.mjs`（8 例，含 service 不可达场景与
「不得导出 Config」守卫）。

## 许可证

MIT
