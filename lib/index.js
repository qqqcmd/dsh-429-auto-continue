/**
 * dsh-429-auto-continue — DSH host plugin.
 *
 * 429 兜底：当回合以失败结束时，如果失败是 HTTP 429（或错误码在可配置
 * 白名单内，默认 RATE_LIMIT / QUOTA —— 商汤 SenseNova 的
 * `429 insufficient_quota` 会被归类为 QUOTA），插件等待 delayMs
 * （默认 10 秒）后，向同一会话发送配置好的消息（默认「继续任务」），
 * 效果等同于用户手动输入 —— 任务自动接着跑，无需人守着。
 *
 * 定位是内置重试链（dsh-llm-retry、dsh-retry-boost 等）之后的最后一道网：
 * 只有在回合真的以 429 类失败死掉时才触发；重试还在进行中不会打扰。
 * 同一会话一旦开始新回合（turn/start）或用户/其他路径追加了消息
 * （user/message append），定时器立即取消，避免和手动操作打架。
 *
 * 与 dsh-retry-boost 保持同样的最小依赖形态：只 import node 内置模块
 * （零外部依赖，规避宿主模块解析风险），不声明顶层 inject
 * （防止服务作用域不匹配导致加载失败），服务在发送时按需取用并做防御。
 */

import { randomUUID } from "node:crypto";

/** 插件身份，与 cordis.patch.yml roster 行的 id 对应。 */
export const name = "429-auto-continue";

/**
 * 默认配置（仅供文档与 normalizeConfig 参考，**不要** `export const Config`）。
 *
 * cordis 的 resolveConfig（@deepseek-ai/cordis/lib/index.js:956-962）把插件导出的
 * `Config` 当作 Standard Schema 使用：
 *     if (!runtime.Config) return config;
 *     const result = runtime.Config["~standard"].validate(config);
 * 纯对象没有 `~standard`，于是启动时抛
 *     TypeError: Cannot read properties of undefined (reading 'validate')
 * 该 entry 直接变成 failed（插件页显示「1 异常」）。dsh-retry-boost 等可用插件
 * 的做法是干脆不导出 `Config`，配置在 apply 内自行归一化——这里保持一致。
 */
export const DEFAULT_CONFIG = Object.freeze({
  delayMs: 10000,
  message: "继续任务",
  codes: ["RATE_LIMIT", "QUOTA"],
  excludeSubagents: true,
});

/** 防御性归一化：即使 roster 没传 config 也有合理默认值。 */
function normalizeConfig(config) {
  const raw = config ?? {};
  const delayInput =
    typeof raw.delayMs === "string" && raw.delayMs.trim().length > 0
      ? Number(raw.delayMs)
      : raw.delayMs;
  const delayMs =
    typeof delayInput === "number" && Number.isFinite(delayInput) && delayInput >= 0
      ? Math.min(delayInput, 3_600_000)
      : DEFAULT_CONFIG.delayMs;
  const message =
    typeof raw.message === "string" && raw.message.trim().length > 0
      ? raw.message
      : "继续任务";
  const codes =
    Array.isArray(raw.codes) && raw.codes.length > 0
      ? raw.codes.map((c) => String(c).toUpperCase())
      : ["RATE_LIMIT", "QUOTA"];
  const excludeSubagents = raw.excludeSubagents !== false;
  return { delayMs, message, codes, excludeSubagents };
}

/**
 * 判断一个 LlmFailure 是否属于「429 类」失败。
 * status === 429 是最可靠的信号（覆盖被归类成 QUOTA 的 429）；
 * 否则看 code 是否在白名单。
 * @param {object|undefined} failure - turn/end reason.error（LlmFailure）。
 * @param {string[]} codes - 触发白名单（已大写）。
 */
function isTrigger(failure, codes) {
  if (!failure || typeof failure !== "object") return false;
  if (failure.status === 429) return true;
  const code = typeof failure.code === "string" ? failure.code.toUpperCase() : "";
  return code.length > 0 && codes.includes(code);
}

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx - cordis 插件上下文。
 * @param {object} [config] - roster 行 config（见 cordis.patch.yml）。
 */
export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config);

  /** sessionId -> { timer }：每个会话至多一个待发定时器。 */
  const pending = new Map();

  const clearPending = (sessionId) => {
    const entry = pending.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(sessionId);
    entry.cancelled = true;
  };

  /**
   * 取 sessionController。
   *
   * 不能写 `ctx.sessionController`：本插件没有声明 `inject`，cordis 的 ctx 代理在
   * 属性读取时会抛 `cannot get property "sessionController" without inject`
   * （不是返回 undefined，try/catch 也必须包住才能挡）。而 `ctx.get(name, false)`
   * 是 cordis 官方的「不要求 inject 的读取」，能拿到服务实例。
   */
  const resolveController = () => {
    try {
      const byName = ctx.get("sessionController", false);
      if (byName && typeof byName.prompt === "function") return byName;
    } catch {
      /* 落到下面的属性兜底 */
    }
    try {
      const direct = ctx.sessionController;
      if (direct && typeof direct.prompt === "function") return direct;
    } catch {
      /* 没注入时属性访问会抛，忽略即可 */
    }
    return undefined;
  };

  /** 定时到期：向会话发送配置的继续消息（走官方用户输入通道）。 */
  const sendContinue = async (sessionId) => {
    const entry = pending.get(sessionId);
    if (!entry || entry.cancelled) return;
    pending.delete(sessionId);

    const controller = resolveController();
    if (!controller) {
      ctx.logger.warn(
        `[${name}] sessionController unavailable; cannot auto-send "${cfg.message}" to ${sessionId}`,
      );
      return;
    }
    try {
      await controller.prompt(
        {
          requestId: randomUUID(),
          sessionId,
          mode: "queue",
          content: [{ type: "text", text: cfg.message }],
        },
        new AbortController().signal,
      );
      ctx.logger.info(
        `[${name}] 429 fallback: sent "${cfg.message}" to session ${sessionId}`,
      );
    } catch (error) {
      ctx.logger.warn(
        `[${name}] failed to send "${cfg.message}" to session ${sessionId}: ${String(error?.message ?? error)}`,
      );
    }
  };

  /** 监听所有会话事件（根作用域注册）。 */
  const onSessionEvent = (session, event) => {
    if (!session || typeof session !== "object") return;
    if (cfg.excludeSubagents && (session.header?.origin === "subagent" || session.header?.parentSession)) {
      return;
    }
    const sessionId = session.id;
    if (typeof sessionId !== "string" || sessionId.length === 0) return;

    if (event?.type === "turn/end") {
      const reason = event.data?.reason;
      if (!reason || reason.kind !== "error") return;
      if (!isTrigger(reason.error, cfg.codes)) return;
      // 防抖：同一会话连续失败只保留最新一个定时器。
      clearPending(sessionId);
      // 定时器回调不接受任何宿主异常：cordis 的容器化派发管不到它，
      // 未捕获的 rejection 会变成宿主的 fatal load failure。
      const timer = setTimeout(() => {
        void sendContinue(sessionId).catch((error) => {
          try {
            ctx.logger.warn(
              `[${name}] auto-continue failed: ${String(error?.message ?? error)}`,
            );
          } catch {
            /* 记日志本身失败就彻底放弃 */
          }
        });
      }, cfg.delayMs);
      pending.set(sessionId, { timer, cancelled: false });
      ctx.logger.info(
        `[${name}] 429 detected (code=${reason.error?.code ?? "?"}, status=${reason.error?.status ?? "?"}) on session ${sessionId}; will send "${cfg.message}" in ${cfg.delayMs}ms`,
      );
      return;
    }

    // 用户/其他路径已经手动继续：取消待发定时器。
    if (pending.has(sessionId) && event?.type === "turn/start") {
      clearPending(sessionId);
      return;
    }
    if (
      pending.has(sessionId) &&
      event?.type === "user/message" &&
      (event.surfaceOp === "append" || event.data?.surfaceOp === "append")
    ) {
      clearPending(sessionId);
    }
  };

  /**
   * 包一层总兜底：观察者由宿主容器化派发，但本插件不该在派发里抛任何东西。
   */
  const listener = (session, event) => {
    try {
      onSessionEvent(session, event);
    } catch {
      /* 永不打断宿主的事件派发 */
    }
  };

  // 插件卸载时：取消所有定时器并注销监听。
  const disposeListener = ctx.on("session/event", listener);
  ctx.effect(() => () => {
    disposeListener();
    for (const sessionId of [...pending.keys()]) clearPending(sessionId);
  }, `${name}: dispose timers`);
}
