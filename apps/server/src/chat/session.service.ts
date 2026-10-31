import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * 会话 CRUD 与归属校验。
 * 从 ChatService 抽出来，避免核心流水线文件继续膨胀。
 */
@Injectable()
export class SessionService {
  /** 每设备最多保留的会话数 */
  private static readonly MAX_SESSIONS = 20;

  constructor(private readonly prisma: PrismaService) {}

  // 创建新对话会话（deviceId 为空时保留旧行为，方便内部/测试调用）
  async createSession(deviceId?: string, title?: string) {
    const existingSessions = await this.prisma.chatSession.findMany({
      // ✅ 每设备独立限额，不再全局共享 20 条
      ...(deviceId ? { where: { deviceId } } : {}),
      orderBy: { createdAt: 'asc' },
    });
    if (existingSessions.length >= SessionService.MAX_SESSIONS) {
      // ✅ 一次删够差额：并发创建/历史数据可能已超上限，只删一条会「删一加一」永远回不到 20 以内
      const overflow =
        existingSessions.length - SessionService.MAX_SESSIONS + 1;
      const oldestIds = existingSessions
        .slice(0, overflow)
        .map((session) => session.id);
      // 用 deleteMany：并发下同一会话被抢先删掉也不会抛 P2025 把整个请求带崩
      await this.prisma.chatSession.deleteMany({
        where: { id: { in: oldestIds } },
      });
    }
    return this.prisma.chatSession.create({
      data: { title: title || '', deviceId: deviceId || null },
    });
  }

  // ✅ 校验会话归属：传了 deviceId 就要求会话属于该设备，否则 403
  private async assertSessionOwner(id: string, deviceId?: string) {
    const session = await this.prisma.chatSession.findUnique({
      where: { id },
      select: { id: true, deviceId: true },
    });
    if (!session) {
      throw new NotFoundException(`ChatSession not found: ${id}`);
    }
    if (deviceId && session.deviceId && session.deviceId !== deviceId) {
      throw new ForbiddenException('无权访问该会话');
    }
    return session;
  }

  async updateSessionTitle(id: string, title: string, deviceId?: string) {
    await this.assertSessionOwner(id, deviceId);
    return this.prisma.chatSession.update({ where: { id }, data: { title } });
  }

  async deleteSession(id: string, deviceId?: string) {
    await this.assertSessionOwner(id, deviceId);
    return this.prisma.chatSession.delete({ where: { id } });
  }

  async getSessions(deviceId?: string) {
    return this.prisma.chatSession.findMany({
      // ✅ 只看本设备的会话（老数据 deviceId 为空：普通用户看不到，管理员可见）
      ...(deviceId ? { where: { deviceId } } : {}),
      orderBy: { updatedAt: 'desc' },
    });
  }

  async getSessionDetail(id: string, deviceId?: string) {
    const session = await this.prisma.chatSession.findUnique({
      where: { id },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!session) return null;
    // ✅ 传了 deviceId 才校验归属（老会话 deviceId 为空视为公共，兼容历史数据）
    if (deviceId && session.deviceId && session.deviceId !== deviceId) {
      throw new ForbiddenException('无权访问该会话');
    }

    const sourceIds = [
      ...new Set(
        session.messages.flatMap((message: any) =>
          Array.isArray(message.sources)
            ? message.sources
                .map((source: any) => source?.fileId)
                .filter(
                  (fileId: unknown): fileId is string =>
                    typeof fileId === 'string',
                )
            : [],
        ),
      ),
    ];
    const sourceFiles = sourceIds.length
      ? await this.prisma.knowledgeFile.findMany({
          where: { id: { in: sourceIds } },
          select: { id: true, enabled: true, status: true },
        })
      : [];
    const sourceFilesById = new Map(sourceFiles.map((file) => [file.id, file]));

    return {
      ...session,
      messages: session.messages.map((message: any) => ({
        ...message,
        sources: Array.isArray(message.sources)
          ? message.sources.map((source: any) => {
              const currentFile = sourceFilesById.get(source?.fileId);
              return {
                ...source,
                currentlyEnabled: currentFile?.enabled ?? false,
                currentStatus: currentFile?.status ?? 'deleted',
              };
            })
          : message.sources,
      })),
    };
  }
}
