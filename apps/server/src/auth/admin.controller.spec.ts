import { AdminController } from './admin.controller';

describe('AdminController 每日限额修改', () => {
  const deviceRow = {
    id: 'device-row-1',
    deviceId: 'd3c93be9-23b2-45ce-862d-6b4febe008e8',
    role: 'user',
    dailyQuota: 50,
    usedToday: 5,
    usedTokensToday: BigInt(5000),
    // usedDate 是今天：currentUsed 直接返回 usedToday
    usedDate: new Date(),
    totalCount: 3,
    totalTokens: BigInt(123),
    createdAt: new Date('2026-10-14T02:19:07.825Z'),
    lastSeenAt: new Date('2026-10-14T02:19:46.191Z'),
  };

  function makePrisma() {
    return {
      device: {
        findFirst: vi.fn().mockResolvedValue(deviceRow),
        update: vi.fn(),
      },
    };
  }

  it('按行 id 修改限额并返回设备信息', async () => {
    const prisma = makePrisma();
    prisma.device.update.mockResolvedValue({ ...deviceRow, dailyQuota: 100 });
    const controller = new AdminController(prisma as never);

    const result = await controller.updateDeviceQuota('device-row-1', {
      dailyQuota: 100,
    });

    expect(prisma.device.findFirst).toHaveBeenCalledWith({
      where: { OR: [{ id: 'device-row-1' }, { deviceId: 'device-row-1' }] },
    });
    expect(prisma.device.update).toHaveBeenCalledWith({
      where: { id: 'device-row-1' },
      data: { dailyQuota: 100 },
    });
    expect(result).toMatchObject({
      id: 'device-row-1',
      deviceId: deviceRow.deviceId,
      dailyQuota: 100,
      usedToday: 5,
      usedTokensToday: '5000',
      totalTokens: '123',
    });
  });

  it('resetUsedToday=true 时同时清零当日已用次数', async () => {
    const prisma = makePrisma();
    prisma.device.update.mockResolvedValue({
      ...deviceRow,
      dailyQuota: 10,
      usedToday: 0,
    });
    const controller = new AdminController(prisma as never);

    const result = await controller.updateDeviceQuota(
      deviceRow.deviceId, // 传客户端 deviceId 也能定位（OR 查询）
      { dailyQuota: 10, resetUsedToday: true },
    );

    expect(prisma.device.update).toHaveBeenCalledWith({
      where: { id: 'device-row-1' },
      data: { dailyQuota: 10, usedToday: 0, usedDate: expect.any(Date) },
    });
    expect(result.usedToday).toBe(0);
  });

  it('允许 dailyQuota=0（user 角色当天禁发）', async () => {
    const prisma = makePrisma();
    prisma.device.update.mockResolvedValue({ ...deviceRow, dailyQuota: 0 });
    const controller = new AdminController(prisma as never);

    const result = await controller.updateDeviceQuota('device-row-1', {
      dailyQuota: 0,
    });

    expect(result.dailyQuota).toBe(0);
    expect(prisma.device.update).toHaveBeenCalledWith({
      where: { id: 'device-row-1' },
      data: { dailyQuota: 0 },
    });
  });

  it.each([
    ['负数', { dailyQuota: -1 }],
    ['小数', { dailyQuota: 1.5 }],
    ['超上限', { dailyQuota: 100001 }],
    ['字符串', { dailyQuota: '50' }],
    ['缺失', {}],
  ])('非法 dailyQuota（%s）返回 400 且不写库', async (_label, body) => {
    const prisma = makePrisma();
    const controller = new AdminController(prisma as never);

    await expect(
      controller.updateDeviceQuota('device-row-1', body as any),
    ).rejects.toThrow('dailyQuota 必须是 0~100000 之间的整数');
    expect(prisma.device.findFirst).not.toHaveBeenCalled();
    expect(prisma.device.update).not.toHaveBeenCalled();
  });

  it('resetUsedToday 非布尔值返回 400', async () => {
    const prisma = makePrisma();
    const controller = new AdminController(prisma as never);

    await expect(
      controller.updateDeviceQuota('device-row-1', {
        dailyQuota: 10,
        resetUsedToday: 'yes' as any,
      }),
    ).rejects.toThrow('resetUsedToday 必须是布尔值');
    expect(prisma.device.update).not.toHaveBeenCalled();
  });

  it('设备不存在返回 404，不写库', async () => {
    const prisma = makePrisma();
    prisma.device.findFirst.mockResolvedValue(null);
    const controller = new AdminController(prisma as never);

    await expect(
      controller.updateDeviceQuota('no-such-device', { dailyQuota: 10 }),
    ).rejects.toThrow('Device not found: no-such-device');
    expect(prisma.device.update).not.toHaveBeenCalled();
  });

  it('返回的设备信息带上报的 platform/model/osVersion', async () => {
    const prisma = makePrisma();
    prisma.device.update.mockResolvedValue({
      ...deviceRow,
      platform: 'ios',
      model: 'iPhone 15 Pro',
      osVersion: '17.5',
    });
    const controller = new AdminController(prisma as never);

    const result = await controller.updateDeviceQuota('device-row-1', {
      dailyQuota: 80,
    });

    expect(result.platform).toBe('ios');
    expect(result.model).toBe('iPhone 15 Pro');
    expect(result.osVersion).toBe('17.5');
  });

  it('设备没上报过终端形态 → 不返回这三个字段（而不是给 null）', async () => {
    const prisma = makePrisma();
    prisma.device.update.mockResolvedValue({ ...deviceRow, dailyQuota: 80 });
    const controller = new AdminController(prisma as never);

    const result = await controller.updateDeviceQuota('device-row-1', {
      dailyQuota: 80,
    });

    expect(result).not.toHaveProperty('platform');
    expect(result).not.toHaveProperty('model');
    expect(result).not.toHaveProperty('osVersion');
  });
});
