import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import {
  DOCUMENT_EXTS,
  VIDEO_EXTS,
  extractDocumentText,
  isDocumentExt,
  isVideoExt,
  convertDocxToHtml,
  convertDocToHtml,
  convertXlsxToHtml,
  docTextToHtml,
} from './document-text';

const mk = (name: string, text: string, mime = 'text/plain') => ({
  buffer: Buffer.from(text, 'utf8'),
  originalname: name,
  mimetype: mime,
});

describe('document-text：类型判定', () => {
  it('文档与视频扩展名互不重叠', () => {
    for (const ext of DOCUMENT_EXTS) {
      expect(VIDEO_EXTS).not.toContain(ext);
      expect(isDocumentExt(ext)).toBe(true);
    }
    for (const ext of VIDEO_EXTS) {
      expect(DOCUMENT_EXTS).not.toContain(ext);
      expect(isVideoExt(ext)).toBe(true);
    }
  });

  it('覆盖常见文档、代码与视频格式', () => {
    expect(isDocumentExt('.pdf')).toBe(true);
    expect(isDocumentExt('.docx')).toBe(true);
    expect(isDocumentExt('.doc')).toBe(true);
    expect(isDocumentExt('.xlsx')).toBe(true);
    expect(isDocumentExt('.xls')).toBe(false); // exceljs 不支持老版 .xls
    expect(isDocumentExt('.ts')).toBe(true);
    expect(isDocumentExt('.md')).toBe(true);
    expect(isVideoExt('.mp4')).toBe(true);
    expect(isVideoExt('.mov')).toBe(true);
    expect(isVideoExt('.mkv')).toBe(true);
    expect(isDocumentExt('.mp4')).toBe(false);
    expect(isVideoExt('.pdf')).toBe(false);
  });
});

describe('document-text：文本提取', () => {
  it('文本/代码文件直接按 UTF-8 读取', async () => {
    const code = 'function hi() {\n  return "你好";\n}';
    const out = await extractDocumentText(mk('a.ts', code));
    expect(out).toBe(code);
  });

  it('剥离 NUL 字符（PG text/jsonb 不接受 0x00）', async () => {
    const out = await extractDocumentText(mk('a.txt', 'abc\u0000def'));
    expect(out).toBe('abcdef');
  });

  it('扩展名不在白名单但 mimetype 是 text/* 也按文本读', async () => {
    const out = await extractDocumentText(
      mk('weird.xyz', 'hello', 'text/plain'),
    );
    expect(out).toBe('hello');
  });

  it('不支持的类型返回空串而不是抛错', async () => {
    const out = await extractDocumentText(
      mk('a.xyz', 'binary', 'application/octet-stream'),
    );
    expect(out).toBe('');
  });
});

// 用 exceljs（已是依赖）拼一个最小合法 .xlsx，供抽取测试
async function buildXlsx(rows: (string | number)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (const row of rows) ws.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('document-text：xlsx 文本抽取', () => {
  const xlsxMime =
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  it('抽出工作表文本：表名 + 表头/数据按制表符分隔', async () => {
    const buf = await buildXlsx([
      ['姓名', '年龄'],
      ['张三', 30],
      ['李四', 25],
    ]);
    const out = await extractDocumentText({
      buffer: buf,
      originalname: 'a.xlsx',
      mimetype: xlsxMime,
    });
    expect(out).toContain('工作表：Sheet1');
    expect(out).toContain('姓名\t年龄');
    expect(out).toContain('张三\t30');
    expect(out).toContain('李四\t25');
  });

  it('空表返回空串', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('空表');
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const out = await extractDocumentText({
      buffer: buf,
      originalname: 'empty.xlsx',
      mimetype: xlsxMime,
    });
    expect(out).toBe('');
  });
});

describe('document-text：xlsx 转 HTML 预览', () => {
  it('每个工作表转成一个 table，单元格内容 HTML 转义', async () => {
    const buf = await buildXlsx([
      ['名称', '金额'],
      ['<b>甲</b>', 100],
    ]);
    const html = await convertXlsxToHtml(buf);
    expect(html).toContain('class="xl-sheet"');
    expect(html).toContain('<table class="sheet">');
    expect(html).toContain('<td>名称</td>');
    // 转义后不能出现原始标签
    expect(html).toContain('&lt;b&gt;甲&lt;/b&gt;');
    expect(html).not.toContain('<b>甲</b>');
  });

  it('空工作簿给占位提示', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('S');
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const html = await convertXlsxToHtml(buf);
    expect(html).toContain('xl-empty');
  });
});

// 用 jszip（mammoth 的传递依赖，已 hoist）拼一个最小合法 .docx，供 HTML 转换测试
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

describe('document-text：docx 转 HTML 预览', () => {
  it('把 docx 正文转成 HTML 片段，文本不丢', async () => {
    const buf = await buildDocx(['你好世界', '第二段 Hello']);
    const html = await convertDocxToHtml(buf);
    expect(html).toContain('你好世界');
    expect(html).toContain('第二段 Hello');
    expect(html).toMatch(/<p>/);
  });

  it('非 docx 二进制抛错（调用方据此回退下载）', async () => {
    await expect(convertDocxToHtml(Buffer.from('not a docx'))).rejects.toThrow();
  });
});

describe('document-text：doc 纯文本 HTML 预览', () => {
  it('按空行分段包 <p>，段内换行转 <br>', () => {
    const html = docTextToHtml('第一段\n第二行\n\n第二段');
    expect(html).toBe('<p>第一段<br>第二行</p><p>第二段</p>');
  });

  it('转义 HTML 特殊字符，防注入', () => {
    const html = docTextToHtml('a <b> & c > d');
    expect(html).toBe('<p>a &lt;b&gt; &amp; c &gt; d</p>');
    expect(html).not.toContain('<b>');
  });

  it('空文本与纯空白都返回空串', () => {
    expect(docTextToHtml('')).toBe('');
    expect(docTextToHtml('\n\n  \n')).toBe('');
  });

  it('非 .doc 二进制抛错（调用方据此 415 回退下载）', async () => {
    await expect(convertDocToHtml(Buffer.from('plain text not a doc'))).rejects.toThrow(
      'Unable to read this type of file',
    );
  });
});
