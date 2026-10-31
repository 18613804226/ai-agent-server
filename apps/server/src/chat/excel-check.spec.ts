import { describe, expect, it } from 'vitest';
import {
  columnLettersToNumber,
  columnNumberToLetters,
  FORMULA_ERROR_META,
  formatExcelFindingsForModel,
  inferColumnType,
  isRequiredColumn,
  normalizeCell,
  outlierBounds,
  parseCellRef,
  rowFingerprint,
  type ExcelCheckResult,
  type ExcelFinding,
  type NormalizedCell,
} from './excel-check';

const num = (n: number): NormalizedCell => ({
  kind: 'number',
  text: String(n),
  num: n,
});
const txt = (s: string): NormalizedCell => ({ kind: 'text', text: s });
const empty = (): NormalizedCell => ({ kind: 'empty', text: '' });
const cells = (...cs: NormalizedCell[]) => cs;

describe('excel-check：单元格归一化', () => {
  it('数字/布尔/日期/文本各自归类', () => {
    expect(normalizeCell(42)).toMatchObject({ kind: 'number', num: 42 });
    expect(normalizeCell(true)).toMatchObject({ kind: 'boolean', text: 'TRUE' });
    const d = new Date('2026-01-03T00:00:00Z');
    expect(normalizeCell(d)).toMatchObject({ kind: 'date' });
    expect(normalizeCell('  你好\n世界 ')).toMatchObject({
      kind: 'text',
      text: '你好 世界',
    });
  });

  it('null/undefined 视为空', () => {
    expect(normalizeCell(null).kind).toBe('empty');
    expect(normalizeCell(undefined).kind).toBe('empty');
  });

  it('错误值带错误码，且保留公式', () => {
    const c = normalizeCell({ error: '#DIV/0!', formula: 'A1/B1' });
    expect(c.kind).toBe('error');
    expect(c.errorCode).toBe('#DIV/0!');
    expect(c.formula).toBe('A1/B1');
  });

  it('公式按缓存结果归一化，同时保留公式原文', () => {
    const c = normalizeCell({ formula: 'A1+B1', result: 3 });
    expect(c).toMatchObject({ kind: 'number', num: 3, formula: 'A1+B1' });
  });

  it('公式结果为空的降级成 empty，不误报为文本', () => {
    const c = normalizeCell({ formula: 'A1+B1' });
    expect(c.formula).toBe('A1+B1');
    expect(c.kind).toBe('empty');
  });

  it('富文本拼接后按文本处理', () => {
    const c = normalizeCell({ richText: [{ text: '甲' }, { text: '乙' }] });
    expect(c).toMatchObject({ kind: 'text', text: '甲乙' });
  });

  it('超长文本被截断到 200 字以内', () => {
    const c = normalizeCell('啊'.repeat(1000));
    expect(c.text.length).toBeLessThanOrEqual(200);
  });
});

describe('excel-check：列地址换算', () => {
  it('A=1 Z=26 AA=27 双向一致', () => {
    expect(columnLettersToNumber('A')).toBe(1);
    expect(columnLettersToNumber('Z')).toBe(26);
    expect(columnLettersToNumber('AA')).toBe(27);
    expect(columnNumberToLetters(1)).toBe('A');
    expect(columnNumberToLetters(27)).toBe('AA');
  });

  it('解析 A1 记号为行列号', () => {
    expect(parseCellRef('B12')).toEqual({ row: 12, column: 2 });
    expect(parseCellRef('AA3')).toEqual({ row: 3, column: 27 });
    expect(parseCellRef('非单元格')).toEqual({ row: 0, column: 0 });
  });
});

describe('excel-check：列类型推断', () => {
  it('单一类型成为主类型', () => {
    expect(inferColumnType(cells(txt('a'), txt('b')))).toMatchObject({
      dominant: 'text',
      isMixed: false,
    });
    expect(inferColumnType(cells(num(1), num(2)))).toMatchObject({
      dominant: 'number',
      isMixed: false,
    });
  });

  it('混合列返回主类型 + isMixed + 覆盖率', () => {
    const r = inferColumnType(cells(txt('a'), num(1)));
    expect(r.isMixed).toBe(true);
    expect(r.ratio).toBe(0.5);
  });

  it('9 个数字 1 个文本：主类型 number、覆盖率 0.9（最常见脏数据形态）', () => {
    const r = inferColumnType([
      ...Array.from({ length: 9 }, () => num(1)),
      txt('九十'),
    ]);
    expect(r.dominant).toBe('number');
    expect(r.ratio).toBeCloseTo(0.9);
    expect(r.isMixed).toBe(true);
  });

  it('全空列返回 unknown', () => {
    expect(inferColumnType(cells(empty(), empty()))).toMatchObject({
      dominant: 'unknown',
    });
  });

  it('空单元格与错误值不参与类型投票', () => {
    expect(
      inferColumnType([
        empty(),
        { kind: 'error', text: '#N/A' },
        num(1),
        num(2),
      ]).dominant,
    ).toBe('number');
  });
});

describe('excel-check：必填列判定', () => {
  it('空值率 20% 以内视为必填（10 行缺 1 行要能抓到）', () => {
    const ten = [...Array.from({ length: 9 }, () => txt('v')), empty()];
    expect(isRequiredColumn(ten, 0.2)).toBe(true);
  });

  it('刚好卡在阈值上也算必填', () => {
    const ceil = [...Array.from({ length: 8 }, () => txt('v')), empty(), empty()];
    expect(isRequiredColumn(ceil, 0.2)).toBe(true); // 空值率恰好 20%
  });

  it('大面积为空 → 非必填，避免满屏误报', () => {
    expect(
      isRequiredColumn([empty(), empty(), empty(), txt('偶发')], 0.2),
    ).toBe(false); // 空值率 75%
  });
});

describe('excel-check：离群点', () => {
  it('样本少于 8 个直接放弃（样本太少判出来都是误报）', () => {
    expect(outlierBounds([1, 2, 3])).toBeNull();
  });

  it('正常数据里插入一个极端值能被识别', () => {
    const nums = [10, 11, 12, 10, 11, 12, 10, 11, 12, 99999];
    const b = outlierBounds(nums, 3)!;
    expect(b).not.toBeNull();
    expect(99999).toBeGreaterThan(b.upper);
    expect(10).toBeGreaterThanOrEqual(b.lower);
    expect(10).toBeLessThanOrEqual(b.upper);
  });

  it('数据完全无波动（IQR=0）时放弃判定', () => {
    expect(outlierBounds([5, 5, 5, 5, 5, 5, 5, 5])).toBeNull();
  });
});

describe('excel-check：行指纹', () => {
  it('空单元格不参与指纹', () => {
    const a = rowFingerprint([txt('x'), empty(), num(1)]);
    const b = rowFingerprint([txt('x'), empty(), num(1)]);
    expect(a).toBe(b);
  });

  it('内容不同指纹不同', () => {
    expect(rowFingerprint([txt('x')])).not.toBe(rowFingerprint([txt('y')]));
  });
});

describe('excel-check：错误码元数据', () => {
  it('七种 Excel 错误都有中文解释和修复建议', () => {
    for (const code of [
      '#DIV/0!',
      '#N/A',
      '#VALUE!',
      '#REF!',
      '#NAME?',
      '#NULL!',
      '#NUM!',
    ]) {
      const meta = FORMULA_ERROR_META[code];
      expect(meta, code).toBeTruthy();
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.suggestion.length).toBeGreaterThan(0);
    }
  });
});

describe('excel-check：formatExcelFindingsForModel', () => {
  const mkResult = (
    summary: Partial<ExcelCheckResult['summary']>,
    findings: ExcelFinding[],
  ): ExcelCheckResult => ({
    fileName: 'report.xlsx',
    sheets: [{ name: 'Sheet1', rowCount: 3, columnCount: 2, checkedRows: 2 }],
    summary: {
      total: 0,
      formulaErrors: 0,
      dataIssues: 0,
      errors: 0,
      warnings: 0,
      truncated: false,
      ...summary,
    },
    findings,
  });

  const mkFinding = (over: Partial<ExcelFinding>): ExcelFinding => ({
    sheet: 'Sheet1',
    cell: 'A2',
    row: 2,
    column: 1,
    columnName: '金额',
    type: 'formulaError',
    code: 'DIV0',
    severity: 'error',
    value: '#DIV/0!',
    message: '公式报错 #DIV/0!：除数为 0 或空',
    suggestion: '用 IFERROR 包一层',
    ...over,
  });

  it('无问题时给「未发现明显问题」', () => {
    const out = formatExcelFindingsForModel(mkResult({}, []));
    expect(out).toContain('未发现明显问题');
    expect(out).toContain('report.xlsx');
  });

  it('有问题时列出位置/类型/建议', () => {
    const out = formatExcelFindingsForModel(
      mkResult(
        { total: 1, formulaErrors: 1, errors: 1 },
        [mkFinding({})],
      ),
    );
    expect(out).toContain('共 1 个问题');
    expect(out).toContain('Sheet1!A2');
    expect(out).toContain('公式错误');
    expect(out).toContain('建议：用 IFERROR 包一层');
  });

  it('超过 maxItems 条时截断并提示', () => {
    const findings = Array.from({ length: 5 }, (_, i) =>
      mkFinding({ cell: `A${i + 1}`, message: `问题${i}` }),
    );
    const out = formatExcelFindingsForModel(
      mkResult(
        { total: 5, formulaErrors: 5, errors: 5 },
        findings,
      ),
      2,
    );
    expect(out).toContain('问题0');
    expect(out).toContain('问题1');
    expect(out).not.toContain('问题2');
    expect(out).toContain('仅列出前 2 条');
  });
});
