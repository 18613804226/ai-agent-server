// src/auth/admin.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { DeviceInfo } from './auth.service.js';
import { AuthGuard } from './auth.guard.js';
import { AdminGuard } from './admin.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Controller('admin')
@UseGuards(AuthGuard, AdminGuard)
export class AdminController {
  constructor(private readonly prisma: PrismaService) {}

  // ✅ 设备列表（含用量，按今日用量/累计用量倒序）
  @Get('devices')
  async listDevices(
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
  ) {
    const p = Math.max(1, Number(page) || 1);
    const size = Math.min(100, Math.max(1, Number(pageSize) || 20));
    const [devices, total] = await this.prisma.$transaction([
      this.prisma.device.findMany({
        orderBy: { lastSeenAt: 'desc' },
        skip: (p - 1) * size,
        take: size,
      }),
      this.prisma.device.count(),
    ]);
    return {
      total,
      page: p,
      pageSize: size,
      list: (devices as any[]).map((d) => this.toInfo(d)),
    };
  }

  // ✅ 修改单个设备的每日限额（仅管理员）：路径 :id 支持设备行 id 或客户端 deviceId（两者都唯一）
  //    dailyQuota=0 表示 user 角色当天一次都发不了（admin 角色本来就不受限额约束）
  //    resetUsedToday=true 时顺带把当日已用次数清零
  @Put('devices/:id/quota')
  async updateDeviceQuota(
    @Param('id') id: string,
    @Body() body: { dailyQuota?: number; resetUsedToday?: boolean },
  ) {
    const dailyQuota = body?.dailyQuota;
    if (
      typeof dailyQuota !== 'number' ||
      !Number.isInteger(dailyQuota) ||
      dailyQuota < 0 ||
      dailyQuota > 100000
    ) {
      throw new BadRequestException('dailyQuota 必须是 0~100000 之间的整数');
    }
    if (
      body?.resetUsedToday !== undefined &&
      typeof body.resetUsedToday !== 'boolean'
    ) {
      throw new BadRequestException('resetUsedToday 必须是布尔值');
    }

    // 行 id 与客户端 deviceId 都能定位，避免前端不知道该传哪个
    const device = await this.prisma.device.findFirst({
      where: { OR: [{ id }, { deviceId: id }] },
    });
    if (!device) {
      throw new NotFoundException(`Device not found: ${id}`);
    }

    const updated = await this.prisma.device.update({
      where: { id: device.id },
      data: {
        dailyQuota,
        ...(body.resetUsedToday ? { usedToday: 0, usedDate: new Date() } : {}),
      },
    });
    return this.toInfo(updated);
  }

  // ✅ 用量总览：设备数、今日对话、累计对话、累计 token、Top 设备
  @Get('stats')
  async stats() {
    const todayStart = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    const [deviceCount, adminCount, usersTodayCount, totalCountAgg, topDevices] =
      await this.prisma.$transaction([
        this.prisma.device.count(),
        this.prisma.device.count({ where: { role: 'admin' } }),
        this.prisma.device.count({ where: { usedDate: { gte: todayStart }, usedToday: { gt: 0 } } }),
        this.prisma.device.aggregate({ _sum: { totalCount: true, totalTokens: true } }),
        this.prisma.device.findMany({
          orderBy: { usedToday: 'desc' },
          take: 10,
        }),
      ]);
    return {
      deviceCount,
      adminCount,
      todayActiveDevices: usersTodayCount,
      totalRequests: totalCountAgg._sum.totalCount ?? 0,
      totalTokens: (totalCountAgg._sum.totalTokens ?? BigInt(0)).toString(),
      topDevicesToday: (topDevices as any[]).map((d) => ({
        deviceId: d.deviceId,
        role: d.role,
        usedToday: this.currentUsed(d),
        usedTokensToday: this.currentUsedTokensToday(d),
        totalCount: d.totalCount,
        totalTokens: d.totalTokens.toString(),
      })),
    };
  }

  // 跨天后 usedToday 无意义，统计时按 0 展示
  private currentUsed(device: any): number {
    const todayStart = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    return device.usedDate >= todayStart ? device.usedToday : 0;
  }

  // 跨天后 usedTokensToday 无意义，统计时按 '0' 展示（与 usedToday 同口径）
  private currentUsedTokensToday(device: any): string {
    const todayStart = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    return device.usedDate >= todayStart ? device.usedTokensToday.toString() : '0';
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
      usedToday: this.currentUsed(device),
      usedTokensToday: this.currentUsedTokensToday(device),
      totalCount: device.totalCount,
      totalTokens: device.totalTokens.toString(),
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
    };
  }
}
