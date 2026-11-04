export interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
  oldNo?: number;
  newNo?: number;
}

const MAX_DP_CELLS = 4_000_000;

/**
 * 行级 LCS diff。超大文件退化为「整段删除 + 整段新增」，避免 DP 占用过高。
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;

  if (n * m > MAX_DP_CELLS) {
    return [
      ...a.map((text, i) => ({ type: 'del' as const, text, oldNo: i + 1 })),
      ...b.map((text, j) => ({ type: 'add' as const, text, newNo: j + 1 })),
    ];
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i], oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i], oldNo: i + 1 });
      i++;
    } else {
      out.push({ type: 'add', text: b[j], newNo: j + 1 });
      j++;
    }
  }
  while (i < n) {
    out.push({ type: 'del', text: a[i], oldNo: i + 1 });
    i++;
  }
  while (j < m) {
    out.push({ type: 'add', text: b[j], newNo: j + 1 });
    j++;
  }
  return out;
}

/** 一个 diff 块（hunk）：相邻的新增/删除行 */
export interface Hunk {
  id: number;
  beforeStart: number;
  beforeLines: string[];
  afterStart: number;
  afterLines: string[];
}

/** 把行级 diff 分组成 hunk（相邻的非 same 行归为一块） */
export function groupHunks(lines: DiffLine[]): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;
  let id = 0;
  while (i < lines.length) {
    if (lines[i].type === 'same') {
      i++;
      continue;
    }
    const first = lines[i];
    const beforeLines: string[] = [];
    const afterLines: string[] = [];
    while (i < lines.length && lines[i].type !== 'same') {
      const l = lines[i];
      if (l.type === 'del') beforeLines.push(l.text);
      else afterLines.push(l.text);
      i++;
    }
    hunks.push({
      id: id++,
      beforeStart: first.oldNo ?? 0,
      beforeLines,
      afterStart: first.newNo ?? 0,
      afterLines,
    });
  }
  return hunks;
}

/**
 * 根据用户选择合并 hunk：
 * accepted 中的 hunk 用 after（新内容），未接受的用 before（旧内容）。
 */
export function mergeHunks(
  before: string,
  after: string,
  accepted: Set<number>,
): string {
  const lines = diffLines(before, after);
  const hunks = groupHunks(lines);
  const result: string[] = [];
  let i = 0;
  let hi = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === 'same') {
      result.push(line.text);
      i++;
      continue;
    }
    const hunk = hunks[hi++];
    result.push(...(accepted.has(hunk.id) ? hunk.afterLines : hunk.beforeLines));
    i++;
    while (i < lines.length && lines[i].type !== 'same') i++;
  }
  return result.join('\n');
}

export function changeLabel(kind: string): string {
  switch (kind) {
    case 'created':
      return 'A';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    default:
      return 'M';
  }
}
