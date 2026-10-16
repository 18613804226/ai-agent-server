import { ChatService } from './chat.service';
import { join } from 'path';
import { mkdir, writeFile, rm } from 'fs/promises';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';

describe('ChatService session source metadata', () => {
  beforeAll(() => {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
  });

  it('returns the current enabled state for saved sources and marks deleted files', async () => {
    const prisma = {
      chatSession: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'session-1',
          messages: [
            {
              id: 'message-1',
              sources: [
                { fileId: 'disabled-file', fileName: '已停用文档.pdf' },
                { fileId: 'deleted-file', fileName: '已删除文档.pdf' },
              ],
            },
          ],
        }),
      },
      knowledgeFile: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'disabled-file', enabled: false, status: 'indexed' },
        ]),
      },
    };
    const service = new ChatService(prisma as never, {} as never);

    const result = await service.getSessionDetail('session-1');

    expect(result?.messages[0].sources).toEqual([
      {
        fileId: 'disabled-file',
        fileName: '已停用文档.pdf',
        currentlyEnabled: false,
        currentStatus: 'indexed',
      },
      {
        fileId: 'deleted-file',
        fileName: '已删除文档.pdf',
        currentlyEnabled: false,
        currentStatus: 'deleted',
      },
    ]);
    expect(prisma.knowledgeFile.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['disabled-file', 'deleted-file'] } },
      select: { id: true, enabled: true, status: true },
    });
  });

  it('returns null without querying source files when the session does not exist', async () => {
    const prisma = {
      chatSession: { findUnique: vi.fn().mockResolvedValue(null) },
      knowledgeFile: { findMany: vi.fn() },
    };
    const service = new ChatService(prisma as never, {} as never);

    await expect(service.getSessionDetail('missing')).resolves.toBeNull();
    expect(prisma.knowledgeFile.findMany).not.toHaveBeenCalled();
  });
});

describe('ChatService createSession 超额清理', () => {
  it('已超上限时一次删够差额（23 → 删 4 → 建 1 = 20）', async () => {
    const existing = Array.from({ length: 23 }, (_, i) => ({
      id: `s-${i}`,
      createdAt: new Date(2026, 0, i + 1),
    }));
    const prisma = {
      chatSession: {
        findMany: vi.fn().mockResolvedValue(existing),
        deleteMany: vi.fn().mockResolvedValue({ count: 4 }),
        create: vi.fn().mockResolvedValue({ id: 's-new' }),
      },
    };
    const service = new ChatService(prisma as never, {} as never);

    await service.createSession('device-1');

    expect(prisma.chatSession.findMany).toHaveBeenCalledWith({
      where: { deviceId: 'device-1' },
      orderBy: { createdAt: 'asc' },
    });
    expect(prisma.chatSession.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['s-0', 's-1', 's-2', 's-3'] } },
    });
    expect(prisma.chatSession.create).toHaveBeenCalledWith({
      data: { title: '', deviceId: 'device-1' },
    });
  });

  it('未到上限时不删任何会话', async () => {
    const prisma = {
      chatSession: {
        findMany: vi.fn().mockResolvedValue([{ id: 's-1' }]),
        deleteMany: vi.fn(),
        create: vi.fn().mockResolvedValue({ id: 's-new' }),
      },
    };
    const service = new ChatService(prisma as never, {} as never);

    await service.createSession('device-1');

    expect(prisma.chatSession.deleteMany).not.toHaveBeenCalled();
  });
});

describe('ChatService deleteChatAttachment', () => {
  const mkService = (prisma: any) => new ChatService(prisma as never, {} as never);

  it('拒绝非法文件名（400）', async () => {
    const prisma = { $queryRaw: vi.fn().mockResolvedValue([]) };
    const service = mkService(prisma);
    await expect(service.deleteChatAttachment('not-a-valid-ref.txt')).rejects.toThrow(
      '非法文件名',
    );
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('已被消息引用时返回 409', async () => {
    const prisma = { $queryRaw: vi.fn().mockResolvedValue([{ n: 1 }]) };
    const service = mkService(prisma);
    await expect(
      service.deleteChatAttachment('62cd2715-8d34-4c2b-9d7a-1f5a9c8b0000.pdf'),
    ).rejects.toThrow('该附件已被消息引用，不能删除');
  });
});

// 拼一个最小合法 .docx（jszip 是 mammoth 的传递依赖，已 hoist），供预览端到端测试
async function buildDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  const bodyXml = paragraphs
    .map(
      (t) =>
        `<w:p><w:r><w:t xml:space="preserve">${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`,
    )
    .join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${bodyXml}</w:body>
</w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('ChatService getAttachmentHtml（docx 在线预览）', () => {
  const mkService = () => new ChatService({} as never, {} as never);
  const dir = join(process.cwd(), 'files', 'chat-attachments');
  const validDocxRef = '00000000-0000-4000-8000-000000000003.docx';

  afterAll(async () => {
    await rm(join(dir, validDocxRef), { force: true });
  });

  it('拒绝非法文件名（400）', async () => {
    await expect(mkService().getAttachmentHtml('bad.txt')).rejects.toThrow(
      '非法文件名',
    );
  });

  it('非 docx 类型返回 415（前端据此回退下载）', async () => {
    await expect(
      mkService().getAttachmentHtml('00000000-0000-4000-8000-000000000001.pdf'),
    ).rejects.toThrow('该文件类型不支持在线预览');
  });

  it('docx 文件不存在时 404', async () => {
    await expect(
      mkService().getAttachmentHtml('00000000-0000-4000-8000-000000000002.docx'),
    ).rejects.toThrow('附件不存在或已过期删除');
  });

  it('doc 也支持预览（走 404 而非 415，证明已纳入可转类型）', async () => {
    await expect(
      mkService().getAttachmentHtml('00000000-0000-4000-8000-000000000004.doc'),
    ).rejects.toThrow('附件不存在或已过期删除');
  });

  it('xlsx 也支持预览（走 404 而非 415，证明已纳入可转类型）', async () => {
    await expect(
      mkService().getAttachmentHtml('00000000-0000-4000-8000-000000000005.xlsx'),
    ).rejects.toThrow('附件不存在或已过期删除');
  });

  it('xlsx 端到端转出带外壳的 HTML 表格', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('数据');
    ws.addRow(['名称', '金額']);
    ws.addRow(['甲', 100]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const ref = '00000000-0000-4000-8000-000000000006.xlsx';
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ref), buf);
    try {
      const html = await mkService().getAttachmentHtml(ref);
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('class="xl-sheet"');
      expect(html).toContain('<td>甲</td>');
      expect(html).toContain('数据');
    } finally {
      await rm(join(dir, ref), { force: true });
    }
  });

  it('转出带样式外壳的自包含 HTML（正文不丢）', async () => {
    const buf = await buildDocx(['预览测试段落', '第二段内容']);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, validDocxRef), buf);

    const html = await mkService().getAttachmentHtml(validDocxRef);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('color-scheme');
    expect(html).toContain('预览测试段落');
    expect(html).toContain('第二段内容');
    expect(html).toMatch(/<\/html>$/);
  });
});

describe('ChatService validateChatAttachment：xlsx 放行', () => {
  const mkFile = (name: string, mime: string): Express.Multer.File =>
    ({
      originalname: name,
      mimetype: mime,
      buffer: Buffer.from('x'),
      size: 1,
    }) as never;

  it('xlsx 通过校验（不再被「不支持」拒绝）', () => {
    const service = new ChatService({} as never, {} as never);
    expect(() =>
      service.validateChatAttachment(
        mkFile(
          'data.xlsx',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ),
      ),
    ).not.toThrow();
  });

  it('xls 仍被拒绝（exceljs 不支持老版 BIFF）', () => {
    const service = new ChatService({} as never, {} as never);
    expect(() =>
      service.validateChatAttachment(
        mkFile('data.xls', 'application/vnd.ms-excel'),
      ),
    ).toThrow('不支持的文件类型');
  });
});

describe('ChatService parseChatAttachment：xlsx 默认走检查', () => {
  const dir = join(process.cwd(), 'files', 'chat-attachments');

  it('抽取文本含自动检查结果，且回传 excelCheck（重复行被报出）', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('数据');
    ws.addRow(['名称', '金额']);
    ws.addRow(['甲', 100]);
    ws.addRow(['甲', 100]); // 与上一行完全相同 → DUPLICATE_ROW
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const service = new ChatService({} as never, {} as never);
    const parsed = await service.parseChatAttachment({
      originalname: '报表.xlsx',
      mimetype:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: buf,
      size: buf.length,
    } as never);

    try {
      expect(parsed.kind).toBe('document');
      expect(parsed.excelCheck?.summary.total).toBeGreaterThan(0);
      expect(parsed.text).toContain('Excel 自动检查');
      expect(parsed.text).toContain('重复');
      // 原始数据仍附在后面，便于追问具体数据
      expect(parsed.text).toContain('【原始数据】');
    } finally {
      await rm(join(dir, parsed.fileRef), { force: true });
    }
  });
});
