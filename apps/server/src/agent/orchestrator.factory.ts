import {
  AgentOrchestrator,
  loadModelCascadeConfig,
  SimpleLock,
} from '@repo/agent-orchestrator';
import { ModelClients } from './model-clients.js';

function envMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

/** 用给定的客户端集构造一个编排器实例 */
export function createOrchestrator(clients: ModelClients): AgentOrchestrator {
  return new AgentOrchestrator({
    getClient: (provider) => clients.getClient(provider),
    modelConfig: loadModelCascadeConfig(),
    showRoutingThought: process.env.CHAT_SHOW_ROUTING_THOUGHT !== 'false',
    rateLimitRetries: Math.max(
      0,
      Number(process.env.CHAT_RATE_LIMIT_RETRIES ?? '2'),
    ),
    zhipuLock: new SimpleLock(),
    // 策略层：所有“可能永远不返回”的边界都要有超时
    connectTimeoutMs: envMs('CHAT_MODEL_CONNECT_TIMEOUT_MS', 60_000),
    streamIdleTimeoutMs: envMs('CHAT_MODEL_IDLE_TIMEOUT_MS', 90_000),
    lockAcquireTimeoutMs: envMs('CHAT_ZHIPU_LOCK_TIMEOUT_MS', 30_000),
    toolTimeoutMs: envMs('CHAT_TOOL_TIMEOUT_MS', 120_000),
    toolMaxResultChars: envMs('CHAT_TOOL_MAX_RESULT_CHARS', 8_000),
    // 上下文治理：旧工具结果压成预览，控制多轮工具调用的输入 token
    contextOptions: {
      maxInputTokens: envInt('CHAT_CONTEXT_MAX_INPUT_TOKENS', 24_000),
      keepRecentToolResults: envInt('CHAT_CONTEXT_KEEP_RECENT_TOOLS', 3),
      keepRecentToolCallRounds: envInt(
        'CHAT_CONTEXT_KEEP_RECENT_TOOL_ROUNDS',
        2,
      ),
      toolResultPreviewChars: envMs('CHAT_CONTEXT_TOOL_PREVIEW_CHARS', 240),
      oldMessagePreviewChars: envMs(
        'CHAT_CONTEXT_OLD_MESSAGE_PREVIEW_CHARS',
        800,
      ),
    },
  });
}
