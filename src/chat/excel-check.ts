// src/chat/excel-check.ts
/**
 * Excel 错误识别：公式错误值 + 数据质量规则。
 *
 * 设计原则：
 * 1. 纯函数尽量独立（类型推断、离群点、去重、文案），便于单测；
 *    exceljs 只负责把工作簿转成「单元格原始值」喂给这些函数。
 * 2. 规则默认全开但保守（宁可得 warning 不可误报 error），
 *    因为误报一次用户就不再信这个功能。
 * 3. 有规模上限：超大表只扫前 N 行、最多返回 N 条，避免一次请求把响应撑爆。
 */

export type Severity = 'error' | 'warning';

export type FindingCode =
  // —— 公式错误值（Excel 原生错误码，severity 恒为 error）——
  | 'DIV0'
  | 'NA'
  | 'VALUE'
  | 'REF'
  | 'NAME'
  | 'NULL'
  | 'NUM'
  | 'GETTING_DATA'
  | 'EXCEL_ERROR'
  // —— 数据质量 ——
  | 'EMPTY_REQUIRED'
  | 'TYPE_MISMATCH'
  | 'DUPLICATE_ROW'
  | 'OUTLIER'
  | 'MIXED_TYPES';

export interface ExcelFinding {
  sheet: string;
  /** 单元格地址，如 B12；整行类问题用 A12 这种首列地址 */
  cell: string;
  row: number;
  /** 列号（1 起），与列名对应，方便前端定位 */
  column: number;
  /** 表头名（没有表头时为 列A/列B） */
  columnName: string;
  type: 'formulaError' | 'dataQuality';
  code: FindingCode;
  severity: Severity;
  /** 触发该问题的单元格内容（字符串化，截断） */
  value: string;
  /** 公式错误值专用：出错的公式原文 */
  formula?: string;
  /** TYPE_MISMATCH 专用：该列推断出的主类型 */
  expected?: string;
  message: string;
  suggestion?: string;
}

export interface ExcelSheetSummary {
  name: string;
  rowCount: number;
  columnCount: number;
  /** 实际参与检查的数据行数（已做上限截断） */
  checkedRows: number;
}

export interface ExcelCheckResult {
  fileName: string;
  sheets: ExcelSheetSummary[];
  summary: {
    total: number;
    formulaErrors: number;
    dataIssues: number;
    errors: number;
    warnings: number;
    /** 是否因规模上限被截断 */
    truncated: boolean;
  };
  findings: ExcelFinding[];
}

export interface ExcelCheckOptions {
  /** 每张表最多扫描的数据行（表头之后），默认 20000 */
  maxRowsPerSheet?: number;
  /** 最多返回多少条 findings，默认 300 */
  maxFindings?: number;
  /** 总单元格数上限，防超大文件拖垮进程，默认 300000 */
  maxCells?: number;
  rules?: {
    formulaErrors?: boolean; // 默认 true
    emptyRequired?: boolean; // 默认 true
    typeMismatch?: boolean; // 默认 true
    duplicateRow?: boolean; // 默认 true
    outlier?: boolean; // 默认 true
    /** 列的空值率低于该比例才视为「必填」（默认 0.05） */
    requiredEmptyThreshold?: number;
    /** 离群点判定倍数（IQR 倍数，默认 3） */
    outlierIqrMultiplier?: number;
    /** 只检查这些列（表头名），默认全部 */
    onlyColumns?: string[];
    /** 跳过这些列（表头名） */
    ignoreColumns?: string[];
    /** 主类型覆盖率达到该值才认定「该列是什么类型」（默认 0.7） */
    typeCoverage?: number;
    /** 行内所有单元格都为空时跳过重复行判定（避免空行互相重复的误报） */
    skipEmptyRowsInDuplicate?: boolean; // 默认 true
  };
}

/** Excel 原生错误码 → 人话 + 修复建议 */
export const FORMULA_ERROR_META: Record<
  string,
  { code: FindingCode; label: string; suggestion: string }
> = {
  '#DIV/0!': {
    code: 'DIV0',
    label: '除数为 0 或空',
    suggestion: '用 IFERROR 包一层，或先判空：=IFERROR(A1/B1,"")',
  },
  '#N/A': {
    code: 'NA',
    label: '查找函数没找到匹配值',
    suggestion: '确认查找值是否存在；可用 IFERROR 或 IFNA 兜底',
  },
  '#VALUE!': {
    code: 'VALUE',
    label: '参数类型不对（例如把文本当数字运算）',
    suggestion: '检查参与运算的单元格是否为文本/含不可见字符',
  },
  '#REF!': {
    code: 'REF',
    label: '引用的单元格被删除',
    suggestion: '重新指定被删行列的地址，不要直接删被引用的区域',
  },
  '#NAME?': {
    code: 'NAME',
    label: '函数名拼错或名称未定义',
    suggestion: '检查函数拼写、中文引号、名称管理器中是否还有该名称',
  },
  '#NULL!': {
    code: 'NULL',
    label: '交集为空（区域没交集）',
    suggestion: '把逗号改成空格取交集，或改用 SUMIFS 等函数',
  },
  '#NUM!': {
    code: 'NUM',
    label: '数值超出范围或无法收敛',
    suggestion: '检查迭代计算设置与参数范围',
  },
  '#GETTING_DATA': {
    code: 'GETTING_DATA',
    label: '公式尚未算出结果',
    suggestion: '等 Excel 重算（F9）后再看，非真实错误',
  },
};

export const EXCEL_LIMITS = {
  maxRowsPerSheet: 20000,
  maxFindings: 300,
  maxCells: 300000,
};

// ---------------- 纯函数：单元格模型 ----------------

export type CellKind = 'number' | 'date' | 'boolean' | 'text' | 'empty' | 'error' | 'formula';

export interface NormalizedCell {
  kind: CellKind;
  /** 展示用字符串（已截断） */
  text: string;
  /** 数字型才有 */
  num?: number;
  /** 日期型才有 */
  date?: Date;
  /** 错误码（如 #DIV/0!） */
  errorCode?: string;
  /** 公式原文 */
  formula?: string;
}

const MAX_CELL_TEXT = 200;

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 把 exceljs 的单元格值归一化。
 * exceljs 的表示：公式 → {formula, result}；错误 → {error}；文本 → string；
 * 数字 → number；布尔 → boolean；日期 → Date；空 → null/undefined。
 */
export function normalizeCell(raw: unknown): NormalizedCell {
  if (raw === null || raw === undefined) {
    return { kind: 'empty', text: '' };
  }
  if (typeof raw === 'number') {
    return { kind: 'number', text: String(raw), num: raw };
  }
  if (typeof raw === 'boolean') {
    return { kind: 'boolean', text: raw ? 'TRUE' : 'FALSE' };
  }
  if (raw instanceof Date) {
    return { kind: 'date', text: raw.toISOString().slice(0, 10), date: raw };
  }
  if (typeof raw === 'string') {
    return { kind: 'text', text: oneLine(raw).slice(0, MAX_CELL_TEXT) };
  }
  if (typeof raw === 'object') {
    const obj = raw as Record<string, any>;
    // 富文本 / 超链接统一按文本处理
    const formula = typeof obj.formula === 'string' ? obj.formula : undefined;

    if (obj.error) {
      const code = String(obj.error);
      return { kind: 'error', text: code, errorCode: code, formula };
    }
    // 公式且带缓存结果：按结果类型归一化，同时保留公式原文
    if (formula) {
      return { ...normalizeCell(obj.result), formula };
    }
    if (Array.isArray(obj.richText)) {
      const joined = obj.richText.map((r: any) => r?.text ?? '').join('');
      return { kind: 'text', text: oneLine(joined).slice(0, MAX_CELL_TEXT) };
    }
    if (obj.hyperlink) {
      const label = obj.text ?? obj.hyperlink;
      return { kind: 'text', text: oneLine(String(label)).slice(0, MAX_CELL_TEXT) };
    }
  }
  // 走到这里说明是 exceljs 没覆盖到的形态，兜底成可读文本
  const text =
    typeof raw === 'string'
      ? raw
      : typeof raw === 'number' || typeof raw === 'boolean'
        ? String(raw)
        : JSON.stringify(raw);
  return { kind: 'text', text: oneLine(text).slice(0, MAX_CELL_TEXT) };
}

/** 列地址后缀 → 列号：A=1, B=2, Z=26, AA=27 */
export function columnLettersToNumber(col: string): number {
  let n = 0;
  for (const ch of col.toUpperCase()) {
    if (ch < 'A' || ch > 'Z') continue;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}

/** 列号 → 列地址：1=A, 27=AA */
export function columnNumberToLetters(num: number): string {
  let n = Math.max(1, Math.floor(num));
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** A1 记号 → {row, column}；row 为 0 表示表头行之前或非法输入 */
export function parseCellRef(ref: string): { row: number; column: number } {
  const m = /^([A-Za-z]+)(\d+)$/.exec(ref.trim());
  if (!m) return { row: 0, column: 0 };
  return { row: Number(m[2]), column: columnLettersToNumber(m[1]) };
}

// ---------------- 纯函数：规则检测 ----------------

/** 列的「主类型」与混杂度：占比最高的类型 + 覆盖率 */
export function inferColumnType(cells: NormalizedCell[]): {
  /** 占比最高的类型；全空列为 unknown */
  dominant: CellKind | 'unknown';
  /** dominant 占非空单元格的比例 */
  ratio: number;
  /** 是否存在第二种类型 */
  isMixed: boolean;
} {
  const counts = new Map<CellKind, number>();
  let total = 0;
  for (const c of cells) {
    if (c.kind === 'empty' || c.kind === 'error' || c.kind === 'formula') continue;
    counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
    total++;
  }
  if (total === 0) return { dominant: 'unknown', ratio: 0, isMixed: false };

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [topKind, topCount] = sorted[0];
  return {
    dominant: topKind,
    ratio: topCount / total,
    isMixed: sorted.length > 1,
  };
}

/** 一列的必填列判定：非空率 >= 1-threshold 视为必填列 */
export function isRequiredColumn(
  cells: NormalizedCell[],
  threshold = 0.05,
): boolean {
  const total = cells.length;
  if (total === 0) return false;
  const empty = cells.filter((c) => c.kind === 'empty').length;
  return 1 - empty / total >= 1 - threshold;
}

/** 行去重：仅用「有内容的单元格」做指纹，整行相同才算重复 */
export function rowFingerprint(cells: NormalizedCell[]): string {
  return cells
    .map((c) => (c.kind === 'empty' ? '' : `${c.kind}:${c.text}`))
    .join('|');
}

/**
 * IQR 离群点判定：返回 (下界, 上界)，界外视为离群。
 * 数据点少于 8 个时直接放弃——样本太少判出来的「离群」基本是误报。
 */
export function outlierBounds(
  nums: number[],
  multiplier = 3,
): { lower: number; upper: number } | null {
  if (nums.length < 8) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const q = (p: number) => {
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };
  const q1 = q(0.25);
  const q3 = q(0.75);
  const iqr = q3 - q1;
  if (iqr === 0) return null; // 数据几乎无波动，离群判定无意义
  return { lower: q1 - multiplier * iqr, upper: q3 + multiplier * iqr };
}

/** 按列聚合 findings：把散落的单元格归类成「列视角」便于前端按列高亮 */
export function groupByColumn<T extends { column: number }>(items: T[]) {
  const map = new Map<number, T[]>();
  for (const item of items) {
    const list = map.get(item.column) ?? [];
    list.push(item);
    map.set(item.column, list);
  }
  return map;
}

// ---------------- 主流程：exceljs 读表 + 跑规则 ----------------

import ExcelJS from 'exceljs';

export class ExcelTooLargeError extends Error {
  constructor(readonly what: string) {
    super(`Excel 文件过大，已中止检查：${what}`);
    this.name = 'ExcelTooLargeError';
  }
}

/** 表头行取第 1 行；空表头名回退成「列A」这种可读名字 */
function headerName(headerRow: NormalizedCell[], colIndex: number): string {
  const cell = headerRow[colIndex - 1];
  if (cell && cell.kind !== 'empty' && cell.text) return cell.text;
  return `列${columnNumberToLetters(colIndex)}`;
}

/** 解析后的完整配置（所有规则字段都有值，业务代码不用再 ?? 兜底） */
type ResolvedOptions = Omit<Required<ExcelCheckOptions>, 'rules'> & {
  rules: Required<NonNullable<ExcelCheckOptions['rules']>>;
};

export async function checkExcelBuffer(
  fileName: string,
  buffer: Buffer,
  options: ExcelCheckOptions = {},
): Promise<ExcelCheckResult> {
  const opts: ResolvedOptions = {
    maxRowsPerSheet: options.maxRowsPerSheet ?? EXCEL_LIMITS.maxRowsPerSheet,
    maxFindings: options.maxFindings ?? EXCEL_LIMITS.maxFindings,
    maxCells: options.maxCells ?? EXCEL_LIMITS.maxCells,
    rules: {
      formulaErrors: options.rules?.formulaErrors ?? true,
      emptyRequired: options.rules?.emptyRequired ?? true,
      typeMismatch: options.rules?.typeMismatch ?? true,
      duplicateRow: options.rules?.duplicateRow ?? true,
      outlier: options.rules?.outlier ?? true,
      // 20% 空值率以内都视为「必填列」：10 行缺 1 行这种典型情况要能抓到
      requiredEmptyThreshold: options.rules?.requiredEmptyThreshold ?? 0.2,
      outlierIqrMultiplier: options.rules?.outlierIqrMultiplier ?? 3,
      onlyColumns: options.rules?.onlyColumns ?? [],
      ignoreColumns: options.rules?.ignoreColumns ?? [],
      typeCoverage: options.rules?.typeCoverage ?? 0.7,
      skipEmptyRowsInDuplicate:
        options.rules?.skipEmptyRowsInDuplicate ?? true,
    },
  };

  const wb = new ExcelJS.Workbook();
  // exceljs 声明的入参是旧版 Buffer<ArrayBuffer>，与 @types/node 的 Buffer<ArrayBufferLike>
  // 在类型层不兼容（运行时完全一致），这里显式绕开
  await wb.xlsx.load(buffer as unknown as any);

  const findings: ExcelFinding[] = [];
  const sheets: ExcelSheetSummary[] = [];
  let truncated = false;
  let cellsSeen = 0;

  const push = (f: ExcelFinding) => {
    // 达到上限就停止再收，但 ongoing 的标记要留住，让调用方知道还有更多
    if (findings.length >= opts.maxFindings) {
      truncated = true;
      return;
    }
    findings.push(f);
  };
  const skipColumn = (rules: any, name: string, colIndex: number) => {
    if (rules.ignoreColumns?.includes(name)) return true;
    if (rules.onlyColumns?.length && !rules.onlyColumns.includes(name)) {
      return colIndex <= 0; // onlyColumns 命中后仍放行未知列，避免漏表头错位
    }
    return false;
  };

  wb.eachSheet((ws) => {
    const sheetName = ws.name;
    const usedCols = Math.max(1, ws.columnCount || 1);
    const totalRows = ws.rowCount || 0;
    const dataRowLimit = Math.min(totalRows, opts.maxRowsPerSheet + 1); // +1 表头
    if (totalRows > dataRowLimit) truncated = true;

    // 先取表头行（第 1 行）
    const headerRow: NormalizedCell[] = [];
    for (let c = 1; c <= usedCols; c++) {
      headerRow.push(normalizeCell(ws.getRow(1).getCell(c).value));
      cellsSeen++;
    }
    const headerNames = Array.from({ length: usedCols }, (_, i) =>
      headerName(headerRow, i + 1),
    );

    // 再取数据行（第 2 行起）
    type Row = { rowNumber: number; cells: NormalizedCell[] };
    const rows: Row[] = [];
    for (let r = 2; r <= dataRowLimit; r++) {
      const rowObj = ws.getRow(r);
      const cells: NormalizedCell[] = [];
      for (let c = 1; c <= usedCols; c++) {
        cells.push(normalizeCell(rowObj.getCell(c).value));
        cellsSeen++;
      }
      rows.push({ rowNumber: r, cells });
    }
    if (cellsSeen > opts.maxCells) {
      throw new ExcelTooLargeError(`单元格数超过 ${opts.maxCells}`);
    }

    sheets.push({
      name: sheetName,
      rowCount: totalRows,
      columnCount: usedCols,
      checkedRows: rows.length,
    });

    const rules = opts.rules;

    // —— 规则 1/2：逐单元格查公式错误值与类型不符 ——
    const columnCells = new Map<number, NormalizedCell[]>();
    for (let c = 1; c <= usedCols; c++) columnCells.set(c, []);
    for (const row of rows) {
      row.cells.forEach((cell, idx) => {
        const col = idx + 1;
        columnCells.get(col)?.push(cell);
      });
    }
    // 列的期望类型：主类型覆盖率达标才认定（默认 70%），避免「半列数字半列文本」乱判
    const expectedType = new Map<number, CellKind>();
    for (let col = 1; col <= usedCols; col++) {
      const { dominant, ratio } = inferColumnType(columnCells.get(col) ?? []);
      if (dominant !== 'unknown' && ratio >= rules.typeCoverage) {
        expectedType.set(col, dominant);
      }
    }
    const typeLabel: Record<string, string> = {
      number: '数字',
      date: '日期',
      boolean: '布尔值',
    };

    for (const row of rows) {
      for (let col = 1; col <= usedCols; col++) {
        const cell = row.cells[col - 1];
        if (!cell) continue;
        const name = headerNames[col - 1];
        if (cell.kind === 'error') {
          if (!rules.formulaErrors) continue;
          const meta = FORMULA_ERROR_META[cell.errorCode || ''] ?? {
            code: 'EXCEL_ERROR' as FindingCode,
            label: 'Excel 公式错误',
            suggestion: '检查该单元格公式及其引用的单元格',
          };
          push({
            sheet: sheetName,
            cell: `${columnNumberToLetters(col)}${row.rowNumber}`,
            row: row.rowNumber,
            column: col,
            columnName: name,
            type: 'formulaError',
            code: meta.code,
            severity: 'error',
            value: cell.errorCode || cell.text,
            formula: cell.formula,
            message: `公式报错 ${cell.errorCode}：${meta.label}`,
            suggestion: meta.suggestion,
          });
          continue;
        }
        if (cell.kind !== 'empty' && rules.typeMismatch && !skipColumn(rules, name, col)) {
          const expected = expectedType.get(col);
          // 只在「该列已认定是数字/日期/布尔，而这里是文本」时报，反向不报
          if (
            expected &&
            cell.kind === 'text' &&
            typeLabel[expected]
          ) {
            push({
              sheet: sheetName,
              cell: `${columnNumberToLetters(col)}${row.rowNumber}`,
              row: row.rowNumber,
              column: col,
              columnName: name,
              type: 'dataQuality',
              code: 'TYPE_MISMATCH',
              severity: 'warning',
              value: cell.text,
              expected,
              message: `列「${name}」绝大多数是${typeLabel[expected]}，这里却是文本`,
              suggestion: '确认是录入错误还是格式问题；文本型数字建议用「分列」或 VALUE() 转换',
            });
          }
        }
      }
    }

    // —— 规则 3：必填列空值 ——
    if (rules.emptyRequired) {
      for (let col = 1; col <= usedCols; col++) {
        const name = headerNames[col - 1];
        if (skipColumn(rules, name, col)) continue;
        const colCells = columnCells.get(col) ?? [];
        if (!isRequiredColumn(colCells, rules.requiredEmptyThreshold)) continue;
        colCells.forEach((cell, idx) => {
          if (cell.kind !== 'empty') return;
          const row = rows[idx];
          push({
            sheet: sheetName,
            cell: `${columnNumberToLetters(col)}${row.rowNumber}`,
            row: row.rowNumber,
            column: col,
            columnName: name,
            type: 'dataQuality',
            code: 'EMPTY_REQUIRED',
            severity: 'warning',
            value: '(空)',
            message: `必填列「${name}」此处为空（该列其它行基本都有值）`,
            suggestion: '补齐该值，或确认此列是否真的必填',
          });
        });
      }
    }

    // —— 规则 4：整行重复 ——
    if (rules.duplicateRow) {
      const seen = new Map<string, number>();
      const reported = new Set<number>();
      for (const row of rows) {
        // 整行空白的行没有信息量，跳过（否则一堆空行会互相当作重复）
        if (
          rules.skipEmptyRowsInDuplicate &&
          row.cells.every((c) => c.kind === 'empty')
        ) {
          continue;
        }
        const fp = rowFingerprint(row.cells);
        const first = seen.get(fp);
        if (first === undefined) {
          seen.set(fp, row.rowNumber);
          continue;
        }
        if (reported.has(first)) continue;
        reported.add(first);
        push({
          sheet: sheetName,
          cell: `A${row.rowNumber}`,
          row: row.rowNumber,
          column: 1,
          columnName: headerNames[0] ?? '列A',
          type: 'dataQuality',
          code: 'DUPLICATE_ROW',
          severity: 'error',
          value: `与第 ${first} 行完全相同`,
          message: `第 ${row.rowNumber} 行与第 ${first} 行内容完全重复`,
          suggestion: '删除多余行，或确认是否为重复录入',
        });
      }
    }

    // —— 规则 5：数值离群点 ——
    if (rules.outlier) {
      for (let col = 1; col <= usedCols; col++) {
        const name = headerNames[col - 1];
        if (skipColumn(rules, name, col)) continue;
        const colCells = columnCells.get(col) ?? [];
        const nums: number[] = [];
        const rowsWithNum: number[] = [];
        colCells.forEach((cell, idx) => {
          if (cell.kind === 'number' && typeof cell.num === 'number') {
            nums.push(cell.num);
            rowsWithNum.push(rows[idx].rowNumber);
          }
        });
        const bounds = outlierBounds(nums, rules.outlierIqrMultiplier);
        if (!bounds) continue;
        colCells.forEach((cell, idx) => {
          if (cell.kind !== 'number' || typeof cell.num !== 'number') return;
          const v = cell.num;
          if (v >= bounds.lower && v <= bounds.upper) return;
          push({
            sheet: sheetName,
            cell: `${columnNumberToLetters(col)}${rows[idx].rowNumber}`,
            row: rows[idx].rowNumber,
            column: col,
            columnName: name,
            type: 'dataQuality',
            code: 'OUTLIER',
            severity: 'warning',
            value: String(v),
            message: `列「${name}」中的 ${v} 明显偏离其它数值（正常区间约 ${bounds.lower.toFixed(2)} ~ ${bounds.upper.toFixed(2)}）`,
            suggestion: '确认真实数值还是多输/少输了位数',
          });
        });
      }
    }
  });

  const formulaErrors = findings.filter((f) => f.type === 'formulaError').length;
  const errors = findings.filter((f) => f.severity === 'error').length;

  return {
    fileName,
    sheets,
    summary: {
      total: findings.length,
      formulaErrors,
      dataIssues: findings.length - formulaErrors,
      errors,
      warnings: findings.length - errors,
      truncated,
    },
    findings: findings.slice(0, opts.maxFindings),
  };
}
