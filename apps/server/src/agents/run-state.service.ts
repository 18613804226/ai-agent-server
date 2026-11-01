import { Injectable } from '@nestjs/common';
import type { RunCheckpoint, RunState } from '@repo/agent-orchestrator';

export interface RunStateInfo {
  state: RunState;
  checkpoint: RunCheckpoint | null;
}

interface RunEntry {
  state: RunState;
  checkpoint: RunCheckpoint;
  controller: AbortController | null;
}

/**
 * 服务端运行态：按 sessionId 隔离。
 *
 * 编排器只负责 ReAct 循环；暂停 / 取消 / 继续由宿主状态机管理。
 * 继续 = 客户端用保存的上下文重新发起 stream 请求。
 */
@Injectable()
export class RunStateService {
  private readonly runs = new Map<string, RunEntry>();

  start(
    sessionId: string,
    query: string,
    context?: RunCheckpoint['context'],
    history: RunCheckpoint['history'] = [],
    resume = false,
  ): RunStateInfo {
    const existing = this.runs.get(sessionId)?.checkpoint;
    const checkpoint: RunCheckpoint = {
      id: sessionId,
      query: resume && existing ? existing.query : query,
      history,
      context,
      changes: existing?.changes ?? [],
      state: 'running',
      updatedAt: Date.now(),
    };
    this.runs.set(sessionId, {
      state: 'running',
      checkpoint,
      controller: null,
    });
    return this.info(sessionId);
  }

  setController(sessionId: string, controller: AbortController): void {
    const entry = this.runs.get(sessionId);
    if (entry) entry.controller = controller;
  }

  getController(sessionId: string): AbortController | null {
    return this.runs.get(sessionId)?.controller ?? null;
  }

  pause(sessionId: string): RunStateInfo {
    const entry = this.runs.get(sessionId);
    if (!entry) return { state: 'idle', checkpoint: null };
    entry.controller?.abort();
    entry.state = 'paused';
    entry.checkpoint = {
      ...entry.checkpoint,
      state: 'paused',
      updatedAt: Date.now(),
    };
    return this.info(sessionId);
  }

  cancel(sessionId: string): RunStateInfo {
    const entry = this.runs.get(sessionId);
    if (!entry) return { state: 'idle', checkpoint: null };
    entry.controller?.abort();
    entry.state = 'cancelled';
    entry.checkpoint = {
      ...entry.checkpoint,
      state: 'cancelled',
      updatedAt: Date.now(),
    };
    return this.info(sessionId);
  }

  finish(
    sessionId: string,
    state: 'done' | 'failed' | 'cancelled',
  ): RunStateInfo {
    const entry = this.runs.get(sessionId);
    if (!entry) return { state: 'idle', checkpoint: null };
    entry.state = state;
    entry.checkpoint = {
      ...entry.checkpoint,
      state,
      updatedAt: Date.now(),
    };
    return this.info(sessionId);
  }

  get(sessionId: string): RunStateInfo {
    return this.info(sessionId);
  }

  private info(sessionId: string): RunStateInfo {
    const entry = this.runs.get(sessionId);
    return {
      state: entry?.state ?? 'idle',
      checkpoint: entry?.checkpoint ?? null,
    };
  }
}
