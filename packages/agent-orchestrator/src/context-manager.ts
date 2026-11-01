import type { ContextStats } from './types.js';

export interface ContextManagerOptions {
  /**
   * 单次请求的输入 token 预算；<=0 表示不做预算压缩。
   * 注意：这是软上限，估算的是 messages，不含 tools schema。
   */
  maxInputTokens?: number;
  /** 最近的多少个 tool 结果保留全文，更早的压缩成摘要 */
  keepRecentToolResults?: number;
  /** 最近多少轮 assistant(tool_calls) 的参数保留全文 */
  keepRecentToolCallRounds?: number;
  /** 被压缩的 tool 结果保留多少字符的预览 */
  toolResultPreviewChars?: number;
  /** 超预算时，旧的非 tool 消息保留多少字符 */
  oldMessagePreviewChars?: number;
}

const COMPACT_MARK = '【已压缩】';

/** 粗略但保守的 token 估算：中文按 1 字/token，其他按 4 字符/token */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

function preview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

/**
 * 上下文治理：不改 ReAct 循环，只在每次模型调用前压缩 messages。
 *
 * 核心策略：
 * 1. 最近 N 个 tool 结果保留全文，更早的替换成「预览 + 原长」
 * 2. 仍超预算时，连最近的 tool 结果也压缩（至少保留最后一个）
 * 3. 再超预算，压缩旧的非 system / 非当前 user 消息
 *
 * 只压缩字符串 content，多模态数组和 null 不动；不删除消息，避免破坏
 * assistant(tool_calls) 与 role:tool 的配对关系。
 */
export class ContextManager {
  private readonly maxInputTokens: number;
  private readonly keepRecentToolResults: number;
  private readonly keepRecentToolCallRounds: number;
  private readonly toolResultPreviewChars: number;
  private readonly oldMessagePreviewChars: number;

  constructor(options: ContextManagerOptions = {}) {
    this.maxInputTokens = options.maxInputTokens ?? 24_000;
    this.keepRecentToolResults = Math.max(
      0,
      options.keepRecentToolResults ?? 3,
    );
    this.keepRecentToolCallRounds = Math.max(
      0,
      options.keepRecentToolCallRounds ?? 2,
    );
    this.toolResultPreviewChars = Math.max(
      40,
      options.toolResultPreviewChars ?? 240,
    );
    this.oldMessagePreviewChars = Math.max(
      80,
      options.oldMessagePreviewChars ?? 800,
    );
  }

  compact(messages: Array<Record<string, unknown>>): ContextStats {
    const beforeTokens = this.estimateMessages(messages);
    let compactedToolResults = 0;
    let compactedToolCalls = 0;
    let compactedMessages = 0;

    const toolIndices = messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.role === 'tool')
      .map(({ index }) => index);

    // 0. 旧的 tool_call 参数（write_file / edit_file 的正文）同样是 token 大头
    compactedToolCalls = this.compactToolCallMessages(messages);

    const keep = this.keepRecentToolResults;
    const firstKept = Math.max(0, toolIndices.length - keep);
    const lastToolCallIndex = this.lastAssistantToolCallIndex(messages);

    // 1. 结构性压缩：当前轮刚拿到的工具结果保留全文，更早的只留最近 N 个
    for (let i = 0; i < toolIndices.length; i++) {
      if (i >= firstKept) continue;
      const index = toolIndices[i];
      // 最后一次 assistant(tool_calls) 之后的结果，是模型这一轮刚请求的，
      // 比如一次读了 5 个文件，不能只保留最后 3 个。
      if (lastToolCallIndex >= 0 && index > lastToolCallIndex) continue;
      if (this.compactToolMessage(messages[index])) {
        compactedToolResults++;
      }
    }

    // 2. 仍超预算：连最近的 tool 结果也压缩，但保留最后一个完整结果
    if (this.isOverBudget(messages)) {
      for (let i = firstKept; i < toolIndices.length - 1; i++) {
        if (this.compactToolMessage(messages[toolIndices[i]])) {
          compactedToolResults++;
        }
      }
    }

    // 3. 再超预算：压缩旧的非 system / 非当前 user 消息
    if (this.isOverBudget(messages)) {
      const lastUserIndex = this.lastUserIndex(messages);
      for (let i = 0; i < messages.length; i++) {
        if (i === lastUserIndex) continue;
        const message = messages[i];
        if (message.role === 'system' || message.role === 'tool') continue;
        if (this.compactNormalMessage(message)) compactedMessages++;
        if (!this.isOverBudget(messages)) break;
      }
    }

    return {
      beforeTokens,
      afterTokens: this.estimateMessages(messages),
      compactedToolResults,
      compactedToolCalls,
      compactedMessages,
    };
  }

  /** 保留最近 N 轮 assistant(tool_calls) 的参数，更早的替换成“已省略”说明 */
  private compactToolCallMessages(
    messages: Array<Record<string, unknown>>,
  ): number {
    const callIndices: number[] = [];
    messages.forEach((message, index) => {
      if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        callIndices.push(index);
      }
    });

    const firstKept = Math.max(
      0,
      callIndices.length - this.keepRecentToolCallRounds,
    );
    let compacted = 0;

    for (let i = 0; i < firstKept; i++) {
      const message = messages[callIndices[i]];
      for (const call of message.tool_calls as Array<
        Record<string, any>
      >) {
        const fn = call?.function;
        if (!fn || typeof fn.arguments !== 'string') continue;
        if (fn.arguments.length <= 200) continue;
        if (fn.arguments.startsWith('{"_omitted":"context-manager"')) {
          continue; // 已经压缩过
        }

        const originalChars = fn.arguments.length;
        fn.arguments = JSON.stringify({
          _omitted: 'context-manager',
          originalChars,
          preview: preview(fn.arguments, 120),
        });
        compacted++;
      }
    }
    return compacted;
  }

  private isOverBudget(messages: Array<Record<string, unknown>>): boolean {
    if (this.maxInputTokens <= 0) return false;
    return this.estimateMessages(messages) > this.maxInputTokens;
  }

  private estimateMessages(messages: Array<Record<string, unknown>>): number {
    let total = 0;
    for (const message of messages) {
      total += 4; // role / 结构开销
      if (typeof message.content === 'string') {
        total += estimateTextTokens(message.content);
      }
      if (Array.isArray(message.tool_calls)) {
        total += estimateTextTokens(JSON.stringify(message.tool_calls));
      }
    }
    return total;
  }

  private lastUserIndex(messages: Array<Record<string, unknown>>): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return i;
    }
    return -1;
  }

  private lastAssistantToolCallIndex(
    messages: Array<Record<string, unknown>>,
  ): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (
        messages[i].role === 'assistant' &&
        Array.isArray(messages[i].tool_calls)
      ) {
        return i;
      }
    }
    return -1;
  }

  private compactToolMessage(message: Record<string, unknown>): boolean {
    if (typeof message.content !== 'string') return false;
    if (message.content.startsWith(COMPACT_MARK)) return false;
    if (message.content.length <= this.toolResultPreviewChars) return false;

    const originalLength = message.content.length;
    const name = typeof message.name === 'string' ? message.name : '工具';
    message.content = `${COMPACT_MARK}${name} 返回 ${originalLength} 字符，已省略大部分，预览：
${preview(message.content, this.toolResultPreviewChars)}`;
    return true;
  }

  private compactNormalMessage(message: Record<string, unknown>): boolean {
    if (typeof message.content !== 'string') return false;
    if (message.content.startsWith(COMPACT_MARK)) return false;
    if (message.content.length <= this.oldMessagePreviewChars) return false;

    const originalLength = message.content.length;
    message.content = `${COMPACT_MARK}原消息 ${originalLength} 字符，已省略：
${preview(message.content, this.oldMessagePreviewChars)}`;
    return true;
  }
}
