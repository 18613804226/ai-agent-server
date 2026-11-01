import { describe, expect, it, vi } from 'vitest';
import { AgentSessionService } from './session.service.js';

describe('AgentSessionService.getHistory', () => {
  it('按时间倒序取最近 N 条，再翻回正序', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: '2', role: 'assistant', content: '最新回答' },
      { id: '1', role: 'user', content: '上一条问题' },
    ]);
    const service = new AgentSessionService({
      message: { findMany },
    } as never);

    const history = await service.getHistory('session-1', 10);

    expect(findMany).toHaveBeenCalledWith({
      where: { sessionId: 'session-1' },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    expect(history).toEqual([
      { role: 'user', content: '上一条问题' },
      { role: 'assistant', content: '最新回答' },
    ]);
  });

  it('过滤空 content 的历史消息', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: '3', role: 'user', content: '   ' },
      { id: '2', role: 'assistant', content: '有内容' },
    ]);
    const service = new AgentSessionService({
      message: { findMany },
    } as never);

    await expect(service.getHistory('session-1')).resolves.toEqual([
      { role: 'assistant', content: '有内容' },
    ]);
    expect(findMany).toHaveBeenCalledWith({
      where: { sessionId: 'session-1' },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  });
});
