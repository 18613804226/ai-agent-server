import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Res,
  Sse,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import type { Response } from 'express';
import { randomUUID } from 'crypto';
import { buildEditorSystemPrompt, createEditorAgent } from '@repo/editor-agent';
import type { ContextStats, RegisteredTool } from '@repo/agent-orchestrator';
import { AuthService } from '../auth/auth.service.js';
import { CurrentDevice } from '../auth/current-device.decorator.js';
import { AgentRunner } from './runner.js';
import { getAgent, listAgents } from './registry.js';
import { AgentSessionService } from './session.service.js';
import { PendingToolService } from './pending-tool.service.js';
import { RunStateService } from './run-state.service.js';

/**
 * 通用 agent 路由：路径里的 agentId 决定用哪套工具集 + 系统提示，
 * 流式循环由 AgentRunner + 共享编排器统一处理。
 *
 * 云端模式（localTools=true）：后端只跑编排器，工具调用通过
 * `tool_request` 事件转给客户端执行，再 POST 回 `/tool-result`。
 */
@Controller('agent')
export class AgentController {
  constructor(
    private readonly runner: AgentRunner,
    private readonly sessions: AgentSessionService,
    private readonly authService: AuthService,
    private readonly pending: PendingToolService,
    private readonly runState: RunStateService,
  ) {}

  @Get('list')
  list() {
    return listAgents();
  }

  @Post(':agentId/session')
  async createSession(
    @CurrentDevice() device: any,
    @Param('agentId') agentId: string,
    @Body('title') title?: string,
  ) {
    this.assertAgent(agentId);
    return this.sessions.createSession(device?.id, title);
  }

  @Get(':agentId/sessions')
  async listSessions(
    @CurrentDevice() device: any,
    @Param('agentId') agentId: string,
  ) {
    this.assertAgent(agentId);
    return this.sessions.listSessions(device?.id);
  }

  @Post(':agentId/session/:id/stream')
  @Sse()
  async stream(
    @CurrentDevice() device: any,
    @Param('agentId') agentId: string,
    @Param('id') sessionId: string,
    @Body()
    body: {
      query?: string;
      model?: string;
      workspaceRoot?: string;
      workspaceRoots?: string[];
      workspaceSummary?: string;
      localTools?: boolean;
      context?: {
        activeFile?: string;
        activeContent?: string;
        selection?: string;
      };
      resume?: boolean;
    },
    @Res({ passthrough: true }) res: Response,
  ): Promise<Observable<MessageEvent>> {
    const agent = this.assertAgent(agentId);
    const query = typeof body?.query === 'string' ? body.query.trim() : '';
    if (!query) throw new BadRequestException('query 不能为空');
    const modelOverride =
      typeof body?.model === 'string' && body.model.trim()
        ? body.model.trim()
        : undefined;
    const localTools = body?.localTools === true;
    const workspaceRoots =
      Array.isArray(body?.workspaceRoots) && body.workspaceRoots.length
        ? body.workspaceRoots
        : typeof body?.workspaceRoot === 'string' && body.workspaceRoot
          ? [body.workspaceRoot]
          : [process.cwd()];

    // 发言前校验每日配额（超限抛 429，不计费）
    await this.authService.assertQuota(device);

    const abortController = new AbortController();
    // 客户端断开就中断上游模型请求，避免继续烧 token
    res.on('close', () => {
      if (!res.writableFinished) abortController.abort();
    });

    return new Observable<MessageEvent>((subscriber) => {
      const runId = randomUUID();
      if (localTools) this.pending.createRun(runId);

      void (async () => {
          try {
            const history = await this.sessions.getHistory(sessionId);
            // 运行态：暂停/取消/继续由宿主状态机管理
            this.runState.start(
              sessionId,
              query,
              body.context,
              history as Array<{ role: 'user' | 'assistant'; content: string }>,
              body.resume === true,
            );
            this.runState.setController(sessionId, abortController);
            if (body.resume !== true) {
              await this.sessions.saveMessage(sessionId, 'user', query);
            }

            // 云端模式：用 editor agent 的「工具定义」，handler 换成把调用转给客户端
          let proxyTools: RegisteredTool[] | undefined;
          let systemPromptOverride: string | undefined;
          if (localTools) {
            const base = createEditorAgent(workspaceRoots);
            systemPromptOverride = buildEditorSystemPrompt(
              workspaceRoots,
              body.workspaceSummary,
              body.context,
            );
            proxyTools = base.tools.map((tool) => ({
              definition: tool.definition,
              handler: (args) =>
                new Promise<string>((resolve, reject) => {
                  const id = randomUUID();
                  this.pending.register(runId, id, resolve, reject);
                  subscriber.next({
                    data: {
                      type: 'tool_request',
                      runId,
                      id,
                      name: tool.definition.function.name,
                      args,
                    },
                  } as MessageEvent);
                }),
            }));
          }

          let fullReply = '';
          let usedTokens = 0;
          let usedModel = '';
          let finishReason: string | undefined;
          let truncated = false;
          let contextStats: ContextStats | undefined;

          for await (const ev of this.runner.run(agent, {
            query,
            history,
            signal: abortController.signal,
            modelOverride,
            toolsOverride: proxyTools,
            systemPromptOverride,
            // 云端代理模式：工具在客户端执行，自动验证也必须由客户端发起
            disableAutoVerify: localTools,
            context: body.context,
          })) {
            switch (ev.type) {
              case 'thought':
                subscriber.next({
                  data: { type: 'thought', content: ev.content ?? '' },
                } as MessageEvent);
                break;
              case 'content':
                subscriber.next({
                  data: { type: 'content', content: ev.content ?? '' },
                } as MessageEvent);
                break;
              case 'tool_call':
                subscriber.next({
                  data: {
                    type: 'tool_call',
                    name: ev.name,
                    args: ev.args,
                    // ⚠️ 必须带上序号：UI 按 index 匹配 tool_result，
                    //    丢掉后所有工具结果会互相覆盖（多轮调用时尤其明显）
                    index: ev.index,
                  },
                } as MessageEvent);
                break;
              case 'tool_result':
                subscriber.next({
                  data: {
                    type: 'tool_result',
                    name: ev.name,
                    result: ev.result,
                    index: ev.index,
                  },
                } as MessageEvent);
                break;
              case 'file_edit':
                subscriber.next({
                  data: { type: 'file_edit', edit: ev.edit },
                } as MessageEvent);
                break;
              case 'error':
                subscriber.next({
                  data: { type: 'error', content: ev.content ?? '' },
                } as MessageEvent);
                break;
              case 'done':
                fullReply = ev.fullReply ?? '';
                usedTokens = ev.tokens ?? 0;
                usedModel = ev.model ?? '';
                finishReason = ev.finishReason;
                truncated = ev.truncated === true;
                contextStats = ev.context;
                break;
            }
          }

          if (fullReply) {
            await this.sessions.saveMessage(sessionId, 'assistant', fullReply);
          }
          await this.sessions.touchSession(sessionId);
          void this.authService.recordUsage(device?.id, usedTokens);
          subscriber.next({
            data: {
              type: 'done',
              model: usedModel,
              tokens: usedTokens,
              finishReason,
              truncated,
              context: contextStats,
            },
          } as MessageEvent);
          subscriber.complete();
        } catch (err) {
          subscriber.error(err);
        } finally {
          if (localTools) this.pending.cleanup(runId);
          this.runState.finish(
            sessionId,
            abortController.signal.aborted ? 'cancelled' : 'done',
          );
        }
      })();

      return () => {
        abortController.abort();
        // 客户端断开时立即唤醒等待中的工具 Promise；只靠在 finally 里 cleanup
        // 不够——run 正卡在 await handler 时，finally 根本不会执行。
        if (localTools) this.pending.cleanup(runId);
      };
    });
  }

  /** 云端模式：客户端执行完工具后把结果回传，唤醒后端等待中的 handler */
  @Post(':agentId/session/:id/tool-result')
  async toolResult(
    @Body() body: { runId?: string; id?: string; result?: string },
  ) {
    if (!body?.runId || !body?.id) {
      throw new BadRequestException('runId / id 不能为空');
    }
    return {
      ok: this.pending.resolve(body.runId, body.id, String(body.result ?? '')),
    };
  }

  /** 暂停当前运行：中断模型请求，保存检查点 */
  @Post(':agentId/session/:id/pause')
  pause(@Param('agentId') agentId: string, @Param('id') sessionId: string) {
    this.assertAgent(agentId);
    return this.runState.pause(sessionId);
  }

  /** 取消当前运行：中断模型请求，检查点保留可继续 */
  @Post(':agentId/session/:id/cancel')
  cancel(@Param('agentId') agentId: string, @Param('id') sessionId: string) {
    this.assertAgent(agentId);
    return this.runState.cancel(sessionId);
  }

  /** 查询运行态与检查点 */
  @Get(':agentId/session/:id/state')
  state(@Param('agentId') agentId: string, @Param('id') sessionId: string) {
    this.assertAgent(agentId);
    return this.runState.get(sessionId);
  }

  private assertAgent(agentId: string) {
    const agent = getAgent(agentId);
    if (!agent) throw new NotFoundException(`未知 agent: ${agentId}`);
    return agent;
  }
}
