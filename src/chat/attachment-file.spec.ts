/**
 * 附件文件落盘/读取/复活/清扫的单元测试。
 * fs 只 mock 会用到的那几个函数，Prisma 只 mock $queryRaw。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    statSync: vi.fn(),
  };
});
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, rm: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn() };
});

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { rm } from 'fs/promises';
import { ChatService } from './chat.service';

beforeAll(() => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
});

const UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const REF = `${UUID}.pdf`;
const REF_TXT = `${UUID}.txt`;
const REF_BAD = `${UUID}.sh`;

function mkService(opts: { refs?: string[] } = {}) {
  const prisma = {
    $queryRaw: vi.fn(async () =>
      (opts.refs ?? []).map((ref) => ({ ref })),
    ),
  };
  return { prisma, service: new ChatService(prisma as never, {} as never) };
}

beforeEach(() => {
  vi.mocked(existsSync).mockReset().mockReturnValue(true);
  vi.mocked(readdirSync).mockReset().mockReturnValue([]);
  vi.mocked(readFileSync).mockReset();
  vi.mocked(statSync).mockReset();
  vi.mocked(rm).mockReset().mockResolvedValue(undefined);
});

describe('getAttachmentFile：文件名校验', () => {
  it.each([
    ['穿越', '../../etc/passwd'],
    ['子目录', `sub/${REF}`],
    ['非 uuid', 'not-a-uuid.pdf'],
    ['空扩展名', UUID],
    ['白名单外扩展名', `${UUID}.sh`],
    ['白名单外的 html（XSS 通道）', `${UUID}.html`],
    ['空串', ''],
  ])('拒绝 %s', async (_l, name) => {
    const { service } = mkService();
    await expect(service.getAttachmentFile(name as string)).rejects.toThrow(
      /非法文件名/,
    );
  });

  it('合法文件返回绝对路径与白名单 content-type', async () => {
    const { service } = mkService();
    const r = await service.getAttachmentFile(REF);
    expect(r.path.endsWith(REF)).toBe(true);
    expect(r.contentType).toBe('application/pdf');
    expect(r.fileName).toBe(REF); // 不泄露原始文件名
  });

  it('txt/md 走带 charset 的 text/plain（中文不能乱码），docx 走对应 mime', async () => {
    const { service } = mkService();
    expect((await service.getAttachmentFile(REF_TXT)).contentType).toBe(
      'text/plain; charset=utf-8',
    );
    expect(
      (
        await service.getAttachmentFile(
          'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.docx',
        )
      ).contentType,
    ).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('bin（白名单外扩展名的归一化结果）只能下载', async () => {
    const { service } = mkService();
    const r = await service.getAttachmentFile(
      'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.bin',
    );
    expect(r.contentType).toBe('application/octet-stream');
  });

  it('视频 mime 正确（前端要能 inline 播放）', async () => {
    const { service } = mkService();
    expect(
      (
        await service.getAttachmentFile(
          'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.mp4',
        )
      ).contentType,
    ).toBe('video/mp4');
  });

  it('文件不存在返回 404', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const { service } = mkService();
    await expect(service.getAttachmentFile(REF)).rejects.toThrow(
      /附件不存在/,
    );
  });
});

describe('附件复活：内存过期后从磁盘解析', () => {
  it('文本类附件可复活，并回填内存', async () => {
    vi.mocked(readdirSync).mockReturnValue([REF_TXT] as never);
    vi.mocked(readFileSync).mockReturnValue(
      Buffer.from('附件正文内容') as never,
    );
    const { service } = mkService();

    // 直接调 buildAttachmentContext：id 不在内存 → 触发磁盘复活
    const { context, used, missing } = service.buildAttachmentContext([UUID]);
    expect(missing).toEqual([]);
    expect(used).toHaveLength(1);
    expect(used[0].fileRef).toBe(REF_TXT);
    expect(context).toContain('附件正文内容');
  });

  it('视频不做自动转写（避免静默花钱），只给提示文本', async () => {
    vi.mocked(readdirSync).mockReturnValue([REF.replace('.pdf', '.mp4')] as never);
    vi.mocked(readFileSync).mockReturnValue(Buffer.from('binary') as never);
    const { service } = mkService();

    const { context, used } = service.buildAttachmentContext([UUID]);
    expect(used[0].kind).toBe('video');
    expect(context).toContain('请重新发送该视频');
  });

  it('二进制文档（PDF）复活时给提示而不是抛错', async () => {
    vi.mocked(readdirSync).mockReturnValue([REF] as never);
    // PDF 头部含控制字符，同步解析会判定为二进制
    vi.mocked(readFileSync).mockReturnValue(
      Buffer.from('%PDF-1.7\u0001\u0002binary') as never,
    );
    const { service } = mkService();

    const { context } = service.buildAttachmentContext([UUID]);
    expect(context).toContain('请重新发送以解析');
  });

  it('磁盘上也没有该文件时如实报 missing', async () => {
    vi.mocked(readdirSync).mockReturnValue([] as never);
    const { service } = mkService();
    const { context, missing } = service.buildAttachmentContext([UUID]);
    expect(context).toBe('');
    expect(missing).toEqual([UUID]);
  });

  it('目录不存在时安全降级为 missing', async () => {
    vi.mocked(readdirSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const { service } = mkService();
    expect(service.buildAttachmentContext([UUID]).missing).toEqual([UUID]);
  });

  it('非 uuid 形态的 id 直接忽略，不去翻目录', async () => {
    const { service } = mkService();
    expect(service.buildAttachmentContext(['../etc/passwd']).missing).toEqual([
      '../etc/passwd',
    ]);
    expect(readdirSync).not.toHaveBeenCalled();
  });
});

describe('sweepExpiredAttachments：30 天清扫', () => {
  const now = Date.now();
  const old = now - 31 * 86400000; // 31 天前 → 该删
  const recent = now - 2 * 86400000; // 2 天前 → 保留

  it('只删「未被引用 + 超过 30 天」的', async () => {
    vi.mocked(readdirSync).mockReturnValue([REF, REF_TXT] as never);
    vi.mocked(statSync).mockImplementation((p: any) =>
      String(p).includes(REF)
        ? ({ isFile: () => true, mtimeMs: old } as never)
        : ({ isFile: () => true, mtimeMs: recent } as never),
    );
    const { service } = mkService({ refs: [] });
    expect(await service.sweepExpiredAttachments()).toBe(1);
    expect(vi.mocked(rm)).toHaveBeenCalledTimes(1);
  });

  it('被消息引用的文件即使超期也不删', async () => {
    vi.mocked(readdirSync).mockReturnValue([REF, REF_TXT] as never);
    vi.mocked(statSync).mockReturnValue({
      isFile: () => true,
      mtimeMs: old,
    } as never);
    const { service } = mkService({ refs: [REF, REF_TXT] });
    expect(await service.sweepExpiredAttachments()).toBe(0);
    expect(vi.mocked(rm)).not.toHaveBeenCalled();
  });

  it('目录里非 uuid 文件一律不碰', async () => {
    vi.mocked(readdirSync).mockReturnValue(['notes.txt', '.keep'] as never);
    vi.mocked(statSync).mockReturnValue({
      isFile: () => true,
      mtimeMs: old,
    } as never);
    const { service } = mkService();
    expect(await service.sweepExpiredAttachments()).toBe(0);
  });

  it('目录不存在时返回 0', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const { service } = mkService();
    expect(await service.sweepExpiredAttachments()).toBe(0);
    expect(readdirSync).not.toHaveBeenCalled();
  });
});
