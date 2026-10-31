import { Injectable } from '@nestjs/common';

/**
 * 云端编排模式下，后端把工具调用委托给客户端执行。
 * 这里保存「等待客户端返回结果」的 Promise resolver，按 runId 隔离。
 */
@Injectable()
export class PendingToolService {
  private readonly runs = new Map<
    string,
    Map<string, (result: string) => void>
  >();

  createRun(runId: string): void {
    this.runs.set(runId, new Map());
  }

  register(
    runId: string,
    id: string,
    resolve: (result: string) => void,
  ): void {
    this.runs.get(runId)?.set(id, resolve);
  }

  resolve(runId: string, id: string, result: string): boolean {
    const run = this.runs.get(runId);
    const fn = run?.get(id);
    if (!fn) return false;
    fn(result);
    run!.delete(id);
    return true;
  }

  cleanup(runId: string): void {
    this.runs.delete(runId);
  }
}
