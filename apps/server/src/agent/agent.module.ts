import { Global, Module } from '@nestjs/common';
import { AgentOrchestrator } from '@repo/agent-orchestrator';
import { ModelClients, createDefaultModelClients } from './model-clients.js';
import { createOrchestrator } from './orchestrator.factory.js';
import { RunStateService } from '../agents/run-state.service.js';

/**
 * 全局模块：提供全进程唯一的 ModelClients + AgentOrchestrator。
 *
 * 必须全局，否则 chat 和各 agent 会各建一个编排器 → 各有一把智谱并发锁，
 * 免费层「限 1 并发」的约束就被绕过了。
 */
@Global()
@Module({
  providers: [
    { provide: ModelClients, useFactory: createDefaultModelClients },
    {
      provide: AgentOrchestrator,
      useFactory: (clients: ModelClients) => createOrchestrator(clients),
      inject: [ModelClients],
    },
    RunStateService,
  ],
  exports: [ModelClients, AgentOrchestrator, RunStateService],
})
export class AgentModule {}
