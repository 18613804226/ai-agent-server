import { AuthService } from './auth.service';

// ✅ 多 token 并存：登录只新增 DeviceToken、不作废历史 token
describe('AuthService multi-token', () => {
  const deviceRow = {
    id: 'device-row-1',
    deviceId: 'd3c93be9-23b2-45ce-862d-6b4febe008e8',
    role: 'user',
    token: 'legacy-token-4514a960',
    dailyQuota: 50,
    usedToday: 0,
    usedTokensToday: BigInt(0),
    totalCount: 0,
    totalTokens: BigInt(0),
    createdAt: new Date('2026-10-14T02:19:07.825Z'),
    lastSeenAt: new Date('2026-10-14T02:19:46.191Z'),
  };

  function makePrisma() {
    return {
      device: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue(deviceRow),
        upsert: vi.fn(),
      },
      deviceToken: {
        create: vi.fn().mockResolvedValue({ id: 'token-row-1' }),
        findUnique: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
  }

  beforeAll(() => {
    process.env.ADMIN_PASSWORD = '123456';
  });

  it('deviceLogin 每次签发新 DeviceToken，不覆盖旧 token 字段', async () => {
    const prisma = makePrisma();
    prisma.device.findUnique.mockResolvedValue(deviceRow);
    const service = new AuthService(prisma as never);

    const { token } = await service.deviceLogin(deviceRow.deviceId);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(prisma.deviceToken.create).toHaveBeenCalledTimes(1);
    const created = prisma.deviceToken.create.mock.calls[0][0];
    expect(created.data.token).toBe(token);
    expect(created.data.role).toBe('user'); // 身份写进 token
    expect(created.data.deviceId).toBe(deviceRow.id);
    // 历史 token 不作废：device.update 只允许更新 lastSeenAt
    expect(prisma.device.update).toHaveBeenCalledWith({
      where: { id: deviceRow.id },
      data: { lastSeenAt: expect.any(Date) },
    });
    expect(prisma.device.update.mock.calls[0][0].data.token).toBeUndefined();
  });

  it('adminLogin 只签 admin token、绝不改写 Device.role，user token 不受影响', async () => {
    const prisma = makePrisma();
    prisma.device.upsert.mockResolvedValue({ ...deviceRow, role: 'user' });
    const service = new AuthService(prisma as never);

    const { token } = await service.adminLogin('123456', deviceRow.deviceId);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    // 关键：update 不能带 role，否则会把这台设备永久升级、顺带提权旧 user token
    expect(prisma.device.upsert).toHaveBeenCalledWith({
      where: { deviceId: deviceRow.deviceId },
      update: {},
      create: { deviceId: deviceRow.deviceId, role: 'user' },
    });
    expect(prisma.deviceToken.create).toHaveBeenCalledTimes(1);
    expect(prisma.deviceToken.create.mock.calls[0][0].data.role).toBe('admin');
  });

  it('adminLogin 密码错误直接 401，不写任何 token', async () => {
    const prisma = makePrisma();
    const service = new AuthService(prisma as never);

    await expect(service.adminLogin('wrong')).rejects.toThrow('管理员密码错误');
    expect(prisma.deviceToken.create).not.toHaveBeenCalled();
    expect(prisma.device.upsert).not.toHaveBeenCalled();
  });

  it('validateToken 优先查 DeviceToken 表，并把 token 的 role 挂到返回设备上', async () => {
    const prisma = makePrisma();
    prisma.deviceToken.findUnique.mockResolvedValue({ role: 'admin', device: deviceRow });
    const service = new AuthService(prisma as never);

    // 设备行本身是 user，但这条 token 是 admin 登录签的 → 身份以 token 为准
    await expect(service.validateToken('new-token')).resolves.toEqual({
      ...deviceRow,
      role: 'admin',
    });
    expect(prisma.deviceToken.findUnique).toHaveBeenCalledWith({
      where: { token: 'new-token' },
      include: { device: true },
    });
    expect(prisma.device.findFirst).not.toHaveBeenCalled();
  });

  it('validateToken 查不到时回退旧版 Device.token（历史 token 仍有效）', async () => {
    const prisma = makePrisma();
    prisma.deviceToken.findUnique.mockResolvedValue(null);
    prisma.device.findFirst.mockResolvedValue(deviceRow);
    const service = new AuthService(prisma as never);

    await expect(service.validateToken('legacy-token-4514a960')).resolves.toEqual(
      deviceRow,
    );
    expect(prisma.device.findFirst).toHaveBeenCalledWith({
      where: { token: 'legacy-token-4514a960' },
    });
  });

  it('validateToken 空 token 或两处都查不到时返回 null', async () => {
    const prisma = makePrisma();
    prisma.deviceToken.findUnique.mockResolvedValue(null);
    prisma.device.findFirst.mockResolvedValue(null);
    const service = new AuthService(prisma as never);

    await expect(service.validateToken('')).resolves.toBeNull();
    expect(prisma.deviceToken.findUnique).not.toHaveBeenCalled();
    await expect(service.validateToken('unknown')).resolves.toBeNull();
  });

  it('超过每设备上限时只删最旧的 token', async () => {
    const prisma = makePrisma();
    prisma.device.findUnique.mockResolvedValue(deviceRow);
    prisma.deviceToken.findMany.mockResolvedValue([
      { id: 'old-1' },
      { id: 'old-2' },
    ]);
    const service = new AuthService(prisma as never);

    await service.deviceLogin(deviceRow.deviceId);

    expect(prisma.deviceToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deviceId: deviceRow.id },
        skip: 10,
      }),
    );
    expect(prisma.deviceToken.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['old-1', 'old-2'] } },
    });
  });

  it('同设备 admin token 免配额、user token 仍受限（身份按 token，不按设备）', async () => {
    const prisma = makePrisma();
    // 设备行 quota 已用完
    const device = { ...deviceRow, role: 'user', usedToday: 50, dailyQuota: 50, usedDate: new Date() };
    prisma.device.findUnique.mockResolvedValue(device);
    const service = new AuthService(prisma as never);

    // admin 登录签发的 token → device.role 被覆盖成 admin → 免配额
    const adminDevice = await service.validateToken('admin-token');
    await expect(service.assertQuota({ ...adminDevice, role: 'admin' })).resolves.toBeUndefined();

    // 同一设备的 user token → 仍是 user → 受配额约束，用完即 429
    const userDevice = { ...device, role: 'user' };
    await expect(service.assertQuota(userDevice)).rejects.toThrow('今日体验次数已用完');
  });
});

// ✅ GET /auth/me：只读设备信息，响应里剔除 token、BigInt 转字符串、跨天 usedToday 归 0
describe('AuthService getMyDevice', () => {
  const baseDevice = {
    id: 'device-row-1',
    deviceId: 'd3c93be9-23b2-45ce-862d-6b4febe008e8',
    role: 'user',
    token: 'legacy-secret-4514a960', // 绝不能出现在响应里
    dailyQuota: 50,
    usedToday: 7,
    usedTokensToday: BigInt(9100),
    usedDate: new Date(), // 今天：usedToday/usedTokensToday 原样返回
    totalCount: 58,
    totalTokens: BigInt(123456),
    createdAt: new Date('2026-10-14T02:19:07.825Z'),
    lastSeenAt: new Date('2026-10-14T02:19:46.191Z'),
  };

  it('返回 { device } 包装的 DeviceInfo：无 token 字段、token 计数为字符串', () => {
    const service = new AuthService({} as never);

    const result = service.getMyDevice(baseDevice);

    expect(result.device).toEqual({
      id: 'device-row-1',
      deviceId: baseDevice.deviceId,
      role: 'user',
      dailyQuota: 50,
      usedToday: 7,
      usedTokensToday: '9100',
      totalCount: 58,
      totalTokens: '123456',
      createdAt: baseDevice.createdAt,
      lastSeenAt: baseDevice.lastSeenAt,
    });
    expect(result.device).not.toHaveProperty('token');
    // 固定字段齐全（前端按这些字段渲染）；platform/model/osVersion 是有条件的：
    // 设备没上报过就不出现，由下面的用例单独覆盖
    expect(Object.keys(result.device).sort()).toEqual(
      [
        'createdAt',
        'dailyQuota',
        'deviceId',
        'id',
        'lastSeenAt',
        'role',
        'totalCount',
        'totalTokens',
        'usedToday',
        'usedTokensToday',
      ].sort(),
    );
    // 没上报过终端形态 → 这三个字段不应出现（而不是给 null）
    expect(result.device).not.toHaveProperty('platform');
  });

  it('带上报的终端形态时返回 platform/model/osVersion', () => {
    const service = new AuthService({} as never);

    const result = service.getMyDevice({
      ...baseDevice,
      platform: 'ios',
      model: 'iPhone 15 Pro',
      osVersion: '17.5',
    });

    expect(result.device.platform).toBe('ios');
    expect(result.device.model).toBe('iPhone 15 Pro');
    expect(result.device.osVersion).toBe('17.5');
  });

  it('跨天后 usedToday / usedTokensToday 按配额口径归 0（与 assertQuota 一致）', () => {
    const service = new AuthService({} as never);

    const result = service.getMyDevice({
      ...baseDevice,
      usedDate: new Date('2000-01-01T00:00:00.000Z'),
    });

    expect(result.device.usedToday).toBe(0);
    expect(result.device.usedTokensToday).toBe('0');
  });

  it('admin 角色原样返回', () => {
    const service = new AuthService({} as never);

    expect(service.getMyDevice({ ...baseDevice, role: 'admin' }).device.role).toBe(
      'admin',
    );
  });
});

// ✅ 登录上报的终端形态（platform/model/osVersion）：落库 + 返回 + 脏数据清洗
describe('AuthService 设备形态信息', () => {
  const deviceRow = {
    id: 'device-row-1',
    deviceId: 'd3c93be9-23b2-45ce-862d-6b4febe008e8',
    role: 'user',
    token: null,
    dailyQuota: 50,
    usedToday: 0,
    usedTokensToday: BigInt(0),
    totalCount: 0,
    totalTokens: BigInt(0),
    createdAt: new Date('2026-10-14T02:19:07.825Z'),
    lastSeenAt: new Date('2026-10-14T02:19:46.191Z'),
  };

  function makePrisma() {
    return {
      device: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue(deviceRow),
        upsert: vi.fn(),
      },
      deviceToken: {
        create: vi.fn().mockResolvedValue({ id: 'token-row-1' }),
        findUnique: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
  }

  beforeAll(() => {
    process.env.ADMIN_PASSWORD = '123456';
  });

  it('新设备登录把 platform/model/osVersion 一起写入', async () => {
    const prisma = makePrisma();
    prisma.device.findUnique.mockResolvedValue(null); // 不存在 → 走 create
    prisma.device.create.mockResolvedValue({
      ...deviceRow,
      platform: 'web',
      model: 'Chrome',
      osVersion: '120',
    });
    const service = new AuthService(prisma as never);

    const { device } = await service.deviceLogin(deviceRow.deviceId, {
      platform: 'web',
      model: 'Chrome',
      osVersion: '120',
    });

    expect(prisma.device.create).toHaveBeenCalledWith({
      data: {
        deviceId: deviceRow.deviceId,
        role: 'user',
        platform: 'web',
        model: 'Chrome',
        osVersion: '120',
      },
    });
    expect(device.platform).toBe('web');
    expect(device.model).toBe('Chrome');
    expect(device.osVersion).toBe('120');
  });

  it('已存在设备登录：有上报才 update，缺省不覆盖已有值', async () => {
    const prisma = makePrisma();
    prisma.device.findUnique.mockResolvedValue(deviceRow);
    const service = new AuthService(prisma as never);

    // 1) 带了新机型 → 触发 update
    await service.deviceLogin(deviceRow.deviceId, {
      platform: 'android',
      model: 'Pixel 8',
    });
    expect(prisma.device.update).toHaveBeenCalledWith({
      where: { deviceId: deviceRow.deviceId },
      data: { platform: 'android', model: 'Pixel 8' },
    });

    // 2) 没带任何设备信息 → 不写任何设备信息字段（不覆盖已有值，也不会被清空）
    prisma.device.update.mockClear();
    await service.deviceLogin(deviceRow.deviceId);
    const updates = prisma.device.update.mock.calls.map((c: any[]) => c[0].data);
    expect(updates).not.toHaveLength(0);
    for (const data of updates) {
      expect(data).not.toHaveProperty('platform');
      expect(data).not.toHaveProperty('model');
      expect(data).not.toHaveProperty('osVersion');
    }
  });

  it('脏数据被清洗：非字符串/超长/空白一律丢弃，绝不写库', async () => {
    const prisma = makePrisma();
    prisma.device.findUnique.mockResolvedValue(null);
    prisma.device.create.mockResolvedValue(deviceRow);
    const service = new AuthService(prisma as never);

    await service.deviceLogin(deviceRow.deviceId, {
      platform: '   ', // 空白 → 丢
      model: 123 as any, // 非字符串 → 丢
      osVersion: 'x'.repeat(200), // 超长 → 截断到 64
    });

    const created = prisma.device.create.mock.calls[0][0].data;
    expect(created).not.toHaveProperty('platform');
    expect(created).not.toHaveProperty('model');
    expect(created.osVersion).toHaveLength(64);
  });

  it('adminLogin 也把上报的设备形态写入（upsert）', async () => {
    const prisma = makePrisma();
    prisma.device.upsert.mockResolvedValue({
      ...deviceRow,
      platform: 'ios',
      model: 'iPhone 15 Pro',
      osVersion: '17.5',
    });
    const service = new AuthService(prisma as never);

    await service.adminLogin('123456', deviceRow.deviceId, {
      platform: 'ios',
      model: 'iPhone 15 Pro',
      osVersion: '17.5',
    });

    expect(prisma.device.upsert).toHaveBeenCalledWith({
      where: { deviceId: deviceRow.deviceId },
      update: { platform: 'ios', model: 'iPhone 15 Pro', osVersion: '17.5' },
      create: {
        deviceId: deviceRow.deviceId,
        role: 'user',
        platform: 'ios',
        model: 'iPhone 15 Pro',
        osVersion: '17.5',
      },
    });
  });
});

// ✅ recordUsage：次数 +1、当日 token 累加、跨天从 0 重新起算（与 usedToday 完全同口径）
describe('AuthService recordUsage', () => {
  const deviceRow = {
    id: 'device-row-1',
    deviceId: 'd3c93be9-23b2-45ce-862d-6b4febe008e8',
    role: 'user',
    token: null,
    dailyQuota: 50,
    usedToday: 7,
    usedTokensToday: BigInt(9000),
    usedDate: new Date(), // 今天
    totalCount: 58,
    totalTokens: BigInt(120000),
    createdAt: new Date(),
    lastSeenAt: new Date(),
  };

  function makePrisma(row: any) {
    return {
      device: {
        findUnique: vi.fn().mockResolvedValue(row),
        update: vi.fn().mockResolvedValue(row),
      },
    };
  }

  it('当天：次数 +1、usedTokensToday 累加、totalTokens 累加', async () => {
    const prisma = makePrisma(deviceRow);
    const service = new AuthService(prisma as never);

    await service.recordUsage('device-row-1', 1500);

    expect(prisma.device.update).toHaveBeenCalledWith({
      where: { id: 'device-row-1' },
      data: {
        usedToday: 8,
        usedTokensToday: BigInt(10500),
        usedDate: deviceRow.usedDate,
        totalCount: { increment: 1 },
        totalTokens: { increment: BigInt(1500) },
      },
    });
  });

  it('跨天：usedTokensToday 从本次 token 重新起算（不从旧值累加）', async () => {
    const prisma = makePrisma({
      ...deviceRow,
      usedDate: new Date('2000-01-01T00:00:00.000Z'),
    });
    const service = new AuthService(prisma as never);

    await service.recordUsage('device-row-1', 2000);

    const data = prisma.device.update.mock.calls[0][0].data;
    expect(data.usedToday).toBe(1);
    expect(data.usedTokensToday).toBe(BigInt(2000)); // 不是 9000+2000
    expect(data.usedDate).toBeInstanceOf(Date);
    expect(data.totalTokens).toEqual({ increment: BigInt(2000) });
  });

  it('tokens 非法（负数/浮点）被 floor+max(0) 兜底', async () => {
    const prisma = makePrisma(deviceRow);
    const service = new AuthService(prisma as never);

    await service.recordUsage('device-row-1', -5);
    expect(prisma.device.update.mock.calls[0][0].data.totalTokens).toEqual({
      increment: BigInt(0),
    });

    await service.recordUsage('device-row-1', 12.9);
    expect(prisma.device.update.mock.calls[1][0].data.totalTokens).toEqual({
      increment: BigInt(12),
    });
  });

  it('设备不存在直接返回，不写库', async () => {
    const prisma = makePrisma(null);
    const service = new AuthService(prisma as never);

    await service.recordUsage('no-such', 100);
    expect(prisma.device.update).not.toHaveBeenCalled();
  });
});

