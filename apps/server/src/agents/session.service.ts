import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * agent 会话存储：复用现有 ChatSession / Message 表。
 * 与 chat 模块共用同一套表，便于后续统一查看。
 */
@Injectable()
export class AgentSessionService {
  constructor(private readonly prisma: PrismaService) {}

  createSession(deviceId?: string, title?: string) {
    return this.prisma.chatSession.create({
      data: { deviceId, title: title || '新对话' },
    });
  }

  listSessions(deviceId?: string) {
    return this.prisma.chatSession.findMany({
      where: deviceId ? { deviceId } : {},
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
  }

  async getHistory(
    sessionId: string,
    limit = 20,
  ): Promise<Array<Record<string, unknown>>> {
    const rows = await this.prisma.message.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows
      .filter((r) => typeof r.content === 'string' && r.content.trim())
      .map((r) => ({ role: r.role, content: r.content }));
  }

  saveMessage(sessionId: string, role: string, content: string) {
    return this.prisma.message.create({ data: { sessionId, role, content } });
  }

  touchSession(sessionId: string) {
    return this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { updatedAt: new Date() },
    });
  }
}
