/**
 * uploads 图片删除 + 孤儿清扫的单元测试。
 *
 * 重点关注安全边界：文件名穿越、非我方生成的文件、被消息引用的文件必须拒删。
 * fs 只 mock rm/readdir/stat 三个会用到的函数，其余保持真实实现。
 */
import { beforeEach, beforeAll, describe, expect, it, vi } from 'vitest';

// ChatService 构造时会 new OpenAI(...)，缺 key 直接抛错（与 chat.service.spec.ts 同款垫片）
beforeAll(() => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
});

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    rm: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
  };
});

import { rm, readdir, stat } from 'fs/promises';
import { resolve } from 'path';
import { ChatService } from './chat.service';

// 与 uploadImage 生成规则一致的真实格式文件名
const IMG_A = 'img-1792021885894-4d725f64-5be3-46f1-906d-96a861b8fca6.png';
const IMG_B = 'img-1792022007007-9eb42ff8-9564-46b0-9896-cc0d9638f5e1.png';

const UPLOADS = resolve(process.cwd(), 'uploads');

function mkService(opts: { referenced?: boolean; basenames?: string[] } = {}) {
  const prisma = {
    $queryRaw: vi.fn(async (sql: unknown) => {
      const text = Array.isArray(sql) ? sql.join('?') : String(sql);
      // isImageReferenced 用的 SQL 带 LIMIT 1
      if (text.includes('LIMIT 1')) return opts.referenced ? [{ n: 1 }] : [];
      // referencedImageBasenames 返回 { name } 列表
      return (opts.basenames ?? []).map((name) => ({ name }));
    }),
  };
  return { prisma, service: new ChatService(prisma as never, {} as never) };
}

beforeEach(() => {
  vi.mocked(rm).mockReset();
  vi.mocked(readdir).mockReset();
  vi.mocked(stat).mockReset();
  vi.mocked(rm).mockResolvedValue(undefined);
});

describe('deleteUploadedImage：文件名校验', () => {
  it.each([
    ['路径穿越', '../../etc/passwd'],
    ['子目录', 'sub/img-1792021885894-4d725f64-5be3-46f1-906d-96a861b8fca6.png'],
    ['NUL 字节', 'img-1792021885894-4d725f64-5be3-46f1-906d-96a861b8fca6.pn\u0000g'],
    ['格式不符（短 uuid）', 'img-1792021885894-abcdef.png'],
    ['格式不符（无 uuid）', 'img-1792021885894.png'],
    ['非图片后缀', 'img-1792021885894-4d725f64-5be3-46f1-906d-96a861b8fca6.sh'],
    ['白名单外的图片后缀', 'img-1792021885894-4d725f64-5be3-46f1-906d-96a861b8fca6.svg+xml'],
    ['空串', ''],
  ])('拒绝 %s', async (_label, name) => {
    const { service } = mkService();
    await expect(service.deleteUploadedImage(name)).rejects.toThrow(
      /非法文件名/,
    );
    expect(vi.mocked(rm)).not.toHaveBeenCalled();
  });

  it('合法文件名放行并删除 uploads 内的对应文件', async () => {
    const { service } = mkService();
    await service.deleteUploadedImage(IMG_A);
    expect(vi.mocked(rm)).toHaveBeenCalledWith(
      resolve(UPLOADS, IMG_A),
      { force: false },
    );
  });

  it('大写扩展名也能删（mime 可能带大写）', async () => {
    const { service } = mkService();
    const upper = IMG_A.replace('.png', '.PNG');
    await service.deleteUploadedImage(upper);
    expect(vi.mocked(rm)).toHaveBeenCalled();
  });
});

describe('deleteUploadedImage：引用保护与 404', () => {
  it('被消息引用的图返回 409 且绝不删文件', async () => {
    const { service } = mkService({ referenced: true });
    await expect(service.deleteUploadedImage(IMG_A)).rejects.toThrow(
      /已被消息引用/,
    );
    // 关键：被拒时不能真的删，否则历史回显坏掉
    expect(vi.mocked(rm)).not.toHaveBeenCalled();
  });

  it('文件不存在返回 404', async () => {
    vi.mocked(rm).mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    const { service } = mkService();
    await expect(service.deleteUploadedImage(IMG_A)).rejects.toThrow(
      /文件不存在/,
    );
  });
});

describe('sweepOrphanUploads：孤儿清扫', () => {
  const now = Date.now();
  const old = now - 2 * 60 * 60 * 1000; // 2 小时前 → 够老
  const young = now - 5 * 60 * 1000; // 5 分钟前 → 太新，不能删

  it('只删「未被引用 + 够老」的文件', async () => {
    vi.mocked(readdir).mockResolvedValue([
      IMG_A, // 被引用 → 跳过
      IMG_B, // 孤且老 → 删
      'other.txt', // 非我方生成 → 跳过
    ] as never);
    vi.mocked(stat).mockImplementation(async (p: any) => ({
      isFile: () => true,
      mtimeMs: String(p).includes(IMG_B) ? old : young,
    }) as never);

    const { service } = mkService({ basenames: [IMG_A] });
    const removed = await service.sweepOrphanUploads();

    expect(removed).toBe(1);
    expect(vi.mocked(rm)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rm)).toHaveBeenCalledWith(resolve(UPLOADS, IMG_B), {
      force: true,
    });
  });

  it('刚上传不久的文件不删（可能还在编辑中）', async () => {
    vi.mocked(readdir).mockResolvedValue([IMG_A, IMG_B] as never);
    vi.mocked(stat).mockResolvedValue({
      isFile: () => true,
      mtimeMs: young,
    } as never);

    const { service } = mkService({ basenames: [] });
    expect(await service.sweepOrphanUploads()).toBe(0);
    expect(vi.mocked(rm)).not.toHaveBeenCalled();
  });

  it('uploads 目录不存在时安全返回 0', async () => {
    vi.mocked(readdir).mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    const { service } = mkService();
    expect(await service.sweepOrphanUploads()).toBe(0);
  });

  it('目录为空时直接返回 0，不去查库', async () => {
    vi.mocked(readdir).mockResolvedValue([] as never);
    const { prisma, service } = mkService();
    expect(await service.sweepOrphanUploads()).toBe(0);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('单个文件删除失败不影响其它文件', async () => {
    vi.mocked(readdir).mockResolvedValue([IMG_A, IMG_B] as never);
    vi.mocked(stat).mockResolvedValue({
      isFile: () => true,
      mtimeMs: old,
    } as never);
    vi.mocked(rm).mockImplementation(async (p: any) => {
      if (String(p).includes(IMG_A)) throw new Error('EBUSY');
      return undefined;
    });

    const { service } = mkService({ basenames: [] });
    expect(await service.sweepOrphanUploads()).toBe(1); // B 成功
  });
});
