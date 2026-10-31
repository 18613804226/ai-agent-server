// src/auth/auth.service.ts
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service.js';

// ✅ 每设备最多保留的 token 数：保证 user/admin 两份缓存并存的同时防止无限膨胀
const MAX_TOKENS_PER_DEVICE = 10;

// 对外暴露的设备信息（剔除 token，登录接口单独返回 token）
export interface DeviceInfo {
  id: string;
  deviceId: string;
  role: string;
  platform?: string; // 终端形态：ios | android | web
  model?: string; // 机型
  osVersion?: string; // 系统版本
  dailyQuota: number;
  usedToday: number;
  usedTokensToday: string; // 当日已用 token（字符串，跨天归 0）
  totalCount: number;
  totalTokens: string;
  createdAt: Date;
  lastSeenAt: Date;
}

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService) {}

  // 生成 64 位随机十六进制 token
  private newToken(): string {
    return randomBytes(32).toString('hex');
  }

  // ✅ 签发新 token：只往 DeviceToken 新增一条，不作废任何历史 token（多 token 并存）
  //    role 记录「本次登录的身份」，权限判定与配额都按它来，与 Device.role 解耦
  //    超出每设备上限时只删最旧的，防止反复登录把表撑爆
  private async issueToken(deviceRowId: string, role: string): Promise<string> {
    const token = this.newToken();
    await this.prisma.deviceToken.create({
      data: { token, role, deviceId: deviceRowId },
    });
    const overflow = await this.prisma.deviceToken.findMany({
      where: { deviceId: deviceRowId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: MAX_TOKENS_PER_DEVICE,
      select: { id: true },
    });
    if (overflow.length) {
      await this.prisma.deviceToken.deleteMany({
        where: { id: { in: overflow.map((t) => t.id) } },
      });
    }
    // 登录也算一次活跃：原实现靠覆盖 token 顺带更新 lastSeenAt，这里显式补上
    await this.prisma.device.update({
      where: { id: deviceRowId },
      data: { lastSeenAt: new Date() },
    });
    return token;
  }

  private toInfo(device: any): DeviceInfo {
    return {
      id: device.id,
      deviceId: device.deviceId,
      role: device.role,
      ...(device.platform ? { platform: device.platform } : {}),
      ...(device.model ? { model: device.model } : {}),
      ...(device.osVersion ? { osVersion: device.osVersion } : {}),
      dailyQuota: device.dailyQuota,
      usedToday: device.usedToday,
      usedTokensToday: device.usedTokensToday.toString(),
      totalCount: device.totalCount,
      // BigInt 不能直接 JSON 序列化，转成字符串给前端
      totalTokens: device.totalTokens.toString(),
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
    };
  }

  // ✅ 清洗前端上报的终端形态信息：只保留非空字符串，超长截断，杜绝把任意脏数据写进库
  private deviceInfoFields(input: any): {
    platform?: string;
    model?: string;
    osVersion?: string;
  } {
    const clean = (v: unknown): string | undefined => {
      if (typeof v !== 'string') return undefined;
      const t = v.trim().slice(0, 64);
      return t || undefined;
    };
    const platform = clean(input?.platform);
    const model = clean(input?.model);
    const osVersion = clean(input?.osVersion);
    return {
      ...(platform ? { platform } : {}),
      ...(model ? { model } : {}),
      ...(osVersion ? { osVersion } : {}),
    };
  }

  // ✅ 本次请求的真实身份：优先用「登录时写进 token 的 role」，取不到再回退 Device.role（历史 token）
  //    AuthGuard 已把 token 行上的 role 挂到 device.role 上，这里统一取，保证权限/配额/展示口径一致
  private effectiveRole(device: any): string {
    return device?.role === 'admin' || device?.role === 'user'
      ? device.role
      : 'user';
  }

  // ✅ GET /auth/me 用：当前登录设备的只读信息（不写库、不签发 token、无副作用）
  //    usedToday/usedTokensToday 按配额口径归一：跨天了显示 0，与 assertQuota 的实际判断保持一致
  getMyDevice(device: any): { device: DeviceInfo } {
    return {
      device: {
        ...this.toInfo(device),
        role: this.effectiveRole(device),
        usedToday: this.currentUsedToday(device),
        usedTokensToday: this.currentUsedTokensToday(device),
      },
    };
  }

  private assertDeviceId(deviceId: string) {
    if (!deviceId || typeof deviceId !== 'string' || !deviceId.trim()) {
      throw new BadRequestException('deviceId 不能为空');
    }
    const trimmed = deviceId.trim();
    if (trimmed.length > 128) {
      throw new BadRequestException('deviceId 过长');
    }
    return trimmed;
  }

  // ✅ 普通用户登录：首次登录自动注册，role 固定 user（已存在则保留原角色）
  //    token 只增不换：历史 token（含之前签发的 admin token）继续有效
  //    身份写进 token（role='user'），与 Device.role 解耦 —— user/admin 在同一设备上互相独立
  //    info：前端上报的终端形态（platform/model/osVersion），仅在提供了新值时才更新，缺省不覆盖
  async deviceLogin(
    deviceId: string,
    info?: any,
  ): Promise<{ token: string; device: DeviceInfo }> {
    deviceId = this.assertDeviceId(deviceId);
    const deviceInfo = this.deviceInfoFields(info);

    const existing = await this.prisma.device.findUnique({ where: { deviceId } });
    // 角色不变（Device.role 仅历史回退，新权限判定不看它）
    const device = existing
      ? Object.keys(deviceInfo).length
        ? // 有上报才更新设备信息；lastSeenAt 由下面 issueToken 兜底
          await this.prisma.device.update({
            where: { deviceId },
            data: deviceInfo,
          })
        : existing // 没上报就少一次写库，直接用已查到的行
      : await this.prisma.device.create({
          data: { deviceId, role: 'user', ...deviceInfo },
        });
    const token = await this.issueToken(device.id, 'user');

    return { token, device: this.toInfo({ ...device, role: 'user' }) };
  }

  // ✅ 管理员登录：校验密码（默认 123456，可用 ADMIN_PASSWORD 覆盖）
  //    未带 deviceId 时用固定占位，保证管理员 token 也能绑定到一条设备记录上
  //    关键：不再改写 Device.role —— 身份只写进本次 token（role='admin'），
  //    这样同一设备的旧 user token 不会被顺带提权，user/admin 配额各自独立
  async adminLogin(
    password: string,
    deviceId?: string,
    info?: any,
  ): Promise<{ token: string; device: DeviceInfo }> {
    const expected = process.env.ADMIN_PASSWORD || '123456';
    if (password !== expected) {
      throw new UnauthorizedException('管理员密码错误');
    }
    const id = deviceId?.trim() || 'admin-console';
    deviceId = this.assertDeviceId(id);
    const deviceInfo = this.deviceInfoFields(info);
    // upsert 只保证设备行存在，绝不覆盖 role（历史 user 身份不受影响）
    const device = await this.prisma.device.upsert({
      where: { deviceId },
      update: deviceInfo,
      create: { deviceId, role: 'user', ...deviceInfo },
    });
    const token = await this.issueToken(device.id, 'admin');

    return { token, device: this.toInfo({ ...device, role: 'admin' }) };
  }

  // ✅ 供 AuthGuard 使用：token 查设备，无效返回 null
  //   多 token 并存：先查 DeviceToken；查不到再回退旧版 Device.token 字段（迁移前签发的 token 仍有效）
  //   权限按「token 本次登录的身份(DeviceToken.role)」判定，再挂回 device.role 供守卫/配额读取
  async validateToken(token: string): Promise<any> {
    if (!token) return null;
    const row = await this.prisma.deviceToken.findUnique({
      where: { token },
      include: { device: true },
    });
    if (row) {
      // row 同时含 DeviceToken.role（本次登录身份）与 row.device（设备行）。
      // 权限以 token 行上的 role 为准：把它提到最外层覆盖设备行的 role。
      const { role } = row;
      return { ...row.device, role };
    }
    // 历史 token 没有 DeviceToken 行，退回用 Device.role
    return this.prisma.device.findFirst({ where: { token } });
  }

  // 当日零点（UTC 口径做跨天重置，简单可靠）
  private startOfToday(): Date {
    const iso = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return new Date(`${iso}T00:00:00.000Z`);
  }

  // 当前有效已用次数（跨天了就按 0 算，不写库，真正扣减在 recordUsage 时落库）
  private currentUsedToday(device: any): number {
    return device.usedDate >= this.startOfToday() ? device.usedToday : 0;
  }

  // 当前有效当日 token（与次数同口径：跨天了就按 0 算，真正累加在 recordUsage 时落库）
  private currentUsedTokensToday(device: any): string {
    return device.usedDate >= this.startOfToday()
      ? device.usedTokensToday.toString()
      : '0';
  }

  // ✅ 发言前校验配额：user 受 dailyQuota 限制，admin 无限额
  async assertQuota(device: any): Promise<void> {
    if (device.role === 'admin') return;
    const used = this.currentUsedToday(device);
    if (used >= device.dailyQuota) {
      throw new HttpException(
        `今日体验次数已用完（${used}/${device.dailyQuota}），明天再来吧`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  // ✅ 成功后记账：次数 +1、token 累加，跨天自动重置计数
  async recordUsage(deviceId: string, tokens = 0): Promise<void> {
    const start = this.startOfToday();
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) return;
    const isNewDay = device.usedDate < start;
    const addTokens = BigInt(Math.max(0, Math.floor(tokens)));
    await this.prisma.device.update({
      where: { id: deviceId },
      data: {
        usedToday: isNewDay ? 1 : device.usedToday + 1,
        // 与 usedToday 同步：跨天从 0 重新起算，当天累加
        usedTokensToday: isNewDay ? addTokens : device.usedTokensToday + addTokens,
        usedDate: isNewDay ? new Date() : device.usedDate,
        totalCount: { increment: 1 },
        totalTokens: { increment: addTokens },
      },
    });
  }
}
