import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-tracker 计时插件
 *
 * pi 自身的会话 JSONL 只记录 token 用量，没有首字/用时信息。
 * 本插件监听 assistant 消息的生命周期事件，记录：
 *   - 首Token耗时 firstTokenMs：从请求开始到收到第一个流式事件（含思考）
 *   - 首字耗时   firstTextMs  ：从请求开始到收到第一段可见文本
 *   - 总用时     durationMs   ：从请求开始到消息结束
 *
 * 数据通过 pi.appendEntry() 以 custom entry（customType="pi-tracker/timing"）
 * 写入当前会话文件（~/.pi/agent/sessions/--<工作目录>--/*.jsonl），
 * 由 opencode-tracker 解析时合并到 pi 的用量记录里。
 *
 * 注意：message_end 事件先于会话持久化触发，因此 timing entry 会落在
 * 对应 assistant 消息的前一行；opencode-tracker 按文件顺序 + 时间戳
 * 窗口做关联，二者保持一致的"零 token 不记录"规则。
 */

const TIMING_TYPE = "pi-tracker/timing";

interface PendingTiming {
  /** 消息自身的 timestamp（ms），与落盘消息一致，用于追踪器关联 */
  messageTimestamp: number;
  /** message_start 时刻（wall clock, ms） */
  start: number;
  /** 首次收到任何流式事件的时刻（含 thinking） */
  firstToken: number;
  /** 首次收到文本增量（text_start/text_delta）的时刻 */
  firstText: number;
}

let pending: PendingTiming | null = null;

export default function (pi: ExtensionAPI) {
  // 新一轮请求开始：记录起点
  pi.on("message_start", (event) => {
    if (event.message.role !== "assistant") return;
    const msg = event.message as { timestamp?: number };
    pending = {
      messageTimestamp: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
      start: Date.now(),
      firstToken: 0,
      firstText: 0,
    };
  });

  // 流式更新：捕获首 token / 首字时刻
  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant" || !pending) return;
    const now = Date.now();
    if (pending.firstToken === 0) {
      pending.firstToken = now;
    }
    const ev = event.assistantMessageEvent;
    if (
      ev &&
      (ev.type === "text_start" || ev.type === "text_delta") &&
      pending.firstText === 0
    ) {
      pending.firstText = now;
    }
  });

  // 消息结束：结算并落盘
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant" || !pending) return;
    const msg = event.message as {
      usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        reasoning?: number;
      };
    };
    const u = msg.usage;
    const tokens =
      (u?.input ?? 0) +
      (u?.output ?? 0) +
      (u?.cacheRead ?? 0) +
      (u?.cacheWrite ?? 0) +
      (u?.reasoning ?? 0);
    const end = Date.now();
    const firstTokenMs = pending.firstToken > 0 ? pending.firstToken - pending.start : 0;
    const firstTextMs = pending.firstText > 0 ? pending.firstText - pending.start : 0;
    const durationMs = end - pending.start;

    // 与 opencode-tracker 的 pi 解析规则保持一致：零 token 消息不生成用量记录，
    // 这里也不写 timing，保证追踪器按顺序关联不会错位。
    if (tokens > 0) {
      pi.appendEntry(TIMING_TYPE, {
        v: 1,
        messageTimestamp: pending.messageTimestamp,
        start: pending.start,
        firstToken: pending.firstToken || 0,
        firstText: pending.firstText || 0,
        end,
        firstTokenMs,
        firstTextMs,
        durationMs,
        outputTokens: u?.output ?? 0,
        reasoningTokens: u?.reasoning ?? 0,
      });
    }
    pending = null;
  });
}
