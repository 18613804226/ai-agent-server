/**
 * 集成测试：用 exceljs 写出真实 xlsx，再跑完整检查流程。
 *
 * 不依赖数据库，但涉及真实文件格式读写，所以放在 test/integration/，
 * 用 `npm run test:integration` 单独跑（默认的 `npm test` 只跑纯函数单测）。
 */
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { checkExcelBuffer } from '../../src/chat/excel-check';

async function makeXlsx(
  build: (wb: ExcelJS.Workbook) => void,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('excel-check 集成：真实 xlsx', () => {
  it('识别公式错误值，并带上公式与修复建议', async () => {
    const buf = await makeXlsx((wb) => {
      const ws = wb.addWorksheet('销售表');
      ws.addRow(['月份', '金额']);
      ws.addRow(['1月', 100]);
      ws.addRow(['2月', 200]);
      ws.addRow(['3月', { formula: 'B2/B5', result: { error: '#DIV/0!' } }]);
    });
    const r = await checkExcelBuffer('销售.xlsx', buf);

    expect(r.summary.formulaErrors).toBeGreaterThanOrEqual(1);
    const f = r.findings.find((x) => x.code === 'DIV0')!;
    expect(f).toBeTruthy();
    expect(f.type).toBe('formulaError');
    expect(f.severity).toBe('error');
    expect(f.sheet).toBe('销售表');
    expect(f.cell).toBe('B4');
    expect(f.columnName).toBe('金额');
    expect(f.suggestion).toContain('IFERROR');
  });

  it('识别必填列空值', async () => {
    const buf = await makeXlsx((wb) => {
      const ws = wb.addWorksheet('员工');
      ws.addRow(['姓名', '手机号']);
      for (let i = 0; i < 10; i++) {
        // 第 5 条数据故意把手机号留空
        ws.addRow([`员工${i}`, i === 5 ? null : `1380000000${i}`]);
      }
    });
    const r = await checkExcelBuffer('员工.xlsx', buf);
    const missing = r.findings.filter((x) => x.code === 'EMPTY_REQUIRED');
    expect(missing.length).toBe(1);
    expect(missing[0].row).toBe(7); // 第 1 行表头 + 第 6 条数据
    expect(missing[0].columnName).toBe('手机号');
    expect(missing[0].severity).toBe('warning');
  });

  it('识别整行重复', async () => {
    const buf = await makeXlsx((wb) => {
      const ws = wb.addWorksheet('订单');
      ws.addRow(['订单号', '金额']);
      ws.addRow(['A001', 10]);
      ws.addRow(['A002', 20]);
      ws.addRow(['A001', 10]);
      ws.addRow(['A001', 10]);
    });
    const r = await checkExcelBuffer('订单.xlsx', buf);
    const dup = r.findings.filter((x) => x.code === 'DUPLICATE_ROW');
    expect(dup.length).toBe(1);
    expect(dup[0].severity).toBe('error');
    expect(dup[0].row).toBe(4);
    expect(dup[0].value).toContain('第 2 行');
  });

  it('整行空白不判重复（否则一堆空行互相误报）', async () => {
    const buf = await makeXlsx((wb) => {
      const ws = wb.addWorksheet('表');
      ws.addRow(['A', 'B']);
      for (let i = 0; i < 5; i++) ws.addRow([null, null]);
    });
    const r = await checkExcelBuffer('表.xlsx', buf);
    expect(r.findings.filter((x) => x.code === 'DUPLICATE_ROW')).toHaveLength(0);
  });

  it('识别类型不符：数字列里混进文本', async () => {
    const buf = await makeXlsx((wb) => {
      const ws = wb.addWorksheet('成绩');
      ws.addRow(['科目', '分数']);
      for (const s of ['语文', '数学', '英语', '物理', '化学', '生物', '地理', '历史']) {
        ws.addRow([s, 90]);
      }
      ws.addRow(['政治', '九十']);
    });
    const r = await checkExcelBuffer('成绩.xlsx', buf);
    const tm = r.findings.filter((x) => x.code === 'TYPE_MISMATCH');
    expect(tm.length).toBe(1);
    expect(tm[0].columnName).toBe('分数');
    expect(tm[0].value).toBe('九十');
    expect(tm[0].expected).toBe('number');
  });

  it('识别数值离群点（多输一位数）', async () => {
    const buf = await makeXlsx((wb) => {
      const ws = wb.addWorksheet('日活');
      ws.addRow(['日期', 'DAU']);
      const base = [1000, 1010, 1020, 1030, 1040, 1050, 1060, 1070, 1080, 1090];
      base.forEach((v, i) => ws.addRow([`D${i}`, v]));
      ws.addRow(['异常', 999999]);
    });
    const r = await checkExcelBuffer('日活.xlsx', buf);
    const out = r.findings.filter((x) => x.code === 'OUTLIER');
    expect(out.length).toBe(1);
    expect(out[0].value).toBe('999999');
    expect(out[0].columnName).toBe('DAU');
  });

  it('干净表应零 findings', async () => {
    const buf = await makeXlsx((wb) => {
      const ws = wb.addWorksheet('干净');
      ws.addRow(['名称', '数量']);
      ws.addRow(['甲', 1]);
      ws.addRow(['乙', 2]);
      ws.addRow(['丙', 3]);
    });
    const r = await checkExcelBuffer('干净.xlsx', buf);
    expect(r.summary.total).toBe(0);
    expect(r.sheets[0]).toMatchObject({ name: '干净', rowCount: 4, columnCount: 2 });
  });

  it('空表头列回退成「列A」这类可读名', async () => {
    const buf = await makeXlsx((wb) => {
      const ws = wb.addWorksheet('无表头');
      ws.getCell('A1').value = null;
      ws.getCell('B1').value = '有名字';
      for (let i = 0; i < 10; i++) {
        ws.getCell(`B${i + 2}`).value = `v${i}`;
        ws.getCell(`A${i + 2}`).value = i === 3 ? '文本' : i;
      }
    });
    const r = await checkExcelBuffer('无表头.xlsx', buf);
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.findings[0].columnName).toBe('列A');
  });

  it('多工作表逐张统计', async () => {
    const buf = await makeXlsx((wb) => {
      const a = wb.addWorksheet('表1');
      a.addRow(['x']);
      a.addRow([1]);
      const b = wb.addWorksheet('表2');
      b.addRow(['y']);
      b.addRow([2]);
    });
    const r = await checkExcelBuffer('多表.xlsx', buf);
    expect(r.sheets.map((s) => s.name)).toEqual(['表1', '表2']);
    expect(r.sheets).toHaveLength(2);
  });

  it('findings 上限生效并标记截断', async () => {
    const buf = await makeXlsx((wb) => {
      const ws = wb.addWorksheet('大表');
      ws.addRow(['必填']);
      // 100 行里 20 行留空 → 空值率 20%（卡在必填阈值上）→ 应报 20 条
      for (let i = 0; i < 100; i++) {
        ws.addRow([i < 80 ? `v${i}` : null]);
      }
    });
    const r = await checkExcelBuffer('大表.xlsx', buf, { maxFindings: 10 });
    expect(r.findings.length).toBe(10);
    expect(r.summary.truncated).toBe(true);
  });

  it('规则可整体关闭', async () => {
    const buf = await makeXlsx((wb) => {
      const ws = wb.addWorksheet('表');
      ws.addRow(['必填']);
      for (let i = 0; i < 10; i++) ws.addRow([null]);
    });
    const r = await checkExcelBuffer('表.xlsx', buf, {
      rules: {
        emptyRequired: false,
        typeMismatch: false,
        duplicateRow: false,
        outlier: false,
        formulaErrors: false,
      },
    });
    expect(r.summary.total).toBe(0);
  });

  it('ignoreColumns 可让指定列不参与检查', async () => {
    const buf = await makeXlsx((wb) => {
      const ws = wb.addWorksheet('表');
      ws.addRow(['备注', '号码']);
      for (let i = 0; i < 10; i++) {
        ws.addRow([i === 2 ? null : `备注${i}`, i === 2 ? null : `N${i}`]);
      }
    });
    const withAll = await checkExcelBuffer('表.xlsx', buf);
    const withoutNote = await checkExcelBuffer('表.xlsx', buf, {
      rules: { ignoreColumns: ['备注'] },
    });
    expect(withoutNote.summary.total).toBeLessThan(withAll.summary.total);
  });

  it('单元格数超规模上限时抛错而不是拖死进程', async () => {
    const buf = await makeXlsx((wb) => {
      const ws = wb.addWorksheet('表');
      ws.addRow(['a', 'b']);
      for (let i = 0; i < 20; i++) ws.addRow([i, `t${i}`]);
    });
    await expect(
      checkExcelBuffer('超大.xlsx', buf, { maxCells: 10 }),
    ).rejects.toThrow(/Excel 文件过大/);
  });
});
