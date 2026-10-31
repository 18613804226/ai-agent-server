import { Module } from '@nestjs/common';
import { AgentController } from './controller.js';
import { EditorController } from './editor/editor.controller.js';
import { AgentRunner } from './runner.js';
import { AgentSessionService } from './session.service.js';
import { PendingToolService } from './pending-tool.service.js';

/**
 * 各 agent 的注册与路由。
 * AgentRunner 复用全局 AgentModule 提供的同一个编排器实例。
 */
@Module({
  controllers: [AgentController, EditorController],
  providers: [AgentRunner, AgentSessionService, PendingToolService],
  exports: [AgentRunner, AgentSessionService, PendingToolService],
})
export class AgentsModule {}
