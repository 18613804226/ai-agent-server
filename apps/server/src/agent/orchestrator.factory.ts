import {
  AgentOrchestrator,
  loadModelCascadeConfig,
  SimpleLock,
} from '@repo/agent-orchestrator';
import { ModelClients } from './model-clients.js';

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
  });
}
