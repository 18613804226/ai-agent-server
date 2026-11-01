import { afterEach, describe, expect, it } from 'vitest';
import { PendingToolService } from './pending-tool.service.js';

const originalTimeout = process.env.AGENT_TOOL_WAIT_TIMEOUT_MS;

afterEach(() => {
  if (originalTimeout === undefined) {
    delete process.env.AGENT_TOOL_WAIT_TIMEOUT_MS;
  } else {
    process.env.AGENT_TOOL_WAIT_TIMEOUT_MS = originalTimeout;
  }
});

function pendingPromise(
  service: PendingToolService,
  runId: string,
  id: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    service.register(runId, id, resolve, reject);
  });
}

describe('PendingToolService', () => {
  it('客户端回传结果时正常 resolve', async () => {
    const service = new PendingToolService();
    service.createRun('run-1');
    const promise = pendingPromise(service, 'run-1', 'tool-1');

    expect(service.resolve('run-1', 'tool-1', '文件内容')).toBe(true);
    await expect(promise).resolves.toBe('文件内容');
  });

  it('客户端断开 cleanup 时 reject 所有等待中的工具', async () => {
    const service = new PendingToolService();
    service.createRun('run-1');
    const first = expect(
      pendingPromise(service, 'run-1', 'tool-1'),
    ).rejects.toThrow('客户端已断开');
    const second = expect(
      pendingPromise(service, 'run-1', 'tool-2'),
    ).rejects.toThrow('客户端已断开');

    service.cleanup('run-1');

    await first;
    await second;
  });

  it('客户端一直不回传时超时 reject', async () => {
    process.env.AGENT_TOOL_WAIT_TIMEOUT_MS = '20';
    const service = new PendingToolService();
    service.createRun('run-1');
    const promise = pendingPromise(service, 'run-1', 'tool-1');

    await expect(promise).rejects.toThrow('等待客户端执行工具超时');
  });
});
