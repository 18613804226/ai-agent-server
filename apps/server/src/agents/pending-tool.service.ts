import { Injectable } from '@nestjs/common';

interface PendingTool {
  resolve: (result: string) => void;
  reject: (error: Error) => void;
}

/**
 * 云端编排模式下，后端把工具调用委托给客户端执行。
 * 这里保存「等待客户端返回结果」的 Promise 回调，按 runId 隔离。
 *
 * ⚠️ 必须处理断连/超时：客户端断开或一直不回传时，等待中的 handler
 * 不能被永久挂起，否则整条 run 和 async generator 都会泄漏。
 */
@Injectable()
export class PendingToolService {
  private readonly timeoutMs = Math.max(
    1,
    Number(process.env.AGENT_TOOL_WAIT_TIMEOUT_MS ?? 120_000) || 120_000,
  );

  private readonly runs = new Map<string, Map<string, PendingTool>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  createRun(runId: string): void {
    this.runs.set(runId, new Map());
  }

  register(
    runId: string,
    id: string,
    resolve: (result: string) => void,
    reject: (error: Error) => void,
  ): void {
    const run = this.runs.get(runId);
    if (!run) {
      reject(new Error('run 已结束，工具执行取消'));
      return;
    }

    run.set(id, { resolve, reject });

    const timer = setTimeout(() => {
      const pending = run.get(id);
      if (!pending) return;
      run.delete(id);
      this.timers.delete(this.timerKey(runId, id));
      pending.reject(
        new Error(`等待客户端执行工具超时（${this.timeoutMs}ms）`),
      );
    }, this.timeoutMs);

    timer.unref?.();
    this.timers.set(this.timerKey(runId, id), timer);
  }

  resolve(runId: string, id: string, result: string): boolean {
    const run = this.runs.get(runId);
    const pending = run?.get(id);
    if (!pending) return false;

    this.clearTimer(runId, id);
    pending.resolve(result);
    run!.delete(id);
    return true;
  }

  /** 客户端断开 / run 收尾：拒绝所有还在等待的工具调用 */
  cleanup(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;

    for (const [id, pending] of run) {
      this.clearTimer(runId, id);
      pending.reject(new Error('客户端已断开，工具执行取消'));
    }
    this.runs.delete(runId);
  }

  private timerKey(runId: string, id: string): string {
    return `${runId}:${id}`;
  }

  private clearTimer(runId: string, id: string): void {
    const key = this.timerKey(runId, id);
    const timer = this.timers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(key);
  }
}
