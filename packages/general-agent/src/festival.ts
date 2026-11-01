import { Solar } from 'lunar-javascript';
import type { RegisteredTool } from '@repo/agent-orchestrator';

/**
 * 传统节日/农历节日 → 公历日期。
 *
 * 春节、中秋等农历节日的公历日期每年不同（如 2025 春节 1/29、2026 春节 2/17），
 * 模型训练数据给不出准确值，必须靠计算。这里用 lunar-javascript 遍历该年每一天的
 * 农历节日，命中即返回公历日期。
 *
 * 除了让模型调用 festival_info，本轮还会把算好的日期直接注入 system prompt：
 * 免费小模型经常「知道有这个工具但不调用」，直接给权威结果最稳。
 */

/** 常见别名 → lunar 库返回的节日名 */
const FESTIVAL_ALIASES: Record<string, string[]> = {
  春节: ['春节'],
  过年: ['春节'],
  新春: ['春节'],
  元宵: ['元宵节'],
  元宵节: ['元宵节'],
  小年: ['小年'],
  清明: ['清明节'],
  清明节: ['清明节'],
  端午: ['端午节'],
  端午节: ['端午节'],
  七夕: ['七夕'],
  七巧: ['七夕'],
  中元: ['中元节'],
  中元节: ['中元节'],
  中秋: ['中秋节'],
  中秋节: ['中秋节'],
  重阳: ['重阳节'],
  重阳节: ['重阳节'],
  腊八: ['腊八节'],
  腊八节: ['腊八节'],
  除夕: ['除夕'],
};

/** 按名称长度降序，避免「元宵」先于「元宵节」命中等歧义 */
const FESTIVAL_NAMES = Object.keys(FESTIVAL_ALIASES).sort(
  (a, b) => b.length - a.length,
);

const pad = (n: number) => String(n).padStart(2, '0');

interface FestivalHit {
  date: string;
  lunarLabel: string;
}

/** 遍历某年每一天，找农历节日/节气；找不到返回 null */
function findFestival(name: string, year: number): FestivalHit | null {
  const targets = FESTIVAL_ALIASES[name] ?? [name];
  // 清明、冬至等属于「节气」，不在 getFestivals() 里，要一起查 getJieQi()
  const start = Solar.fromYmd(year, 1, 1);
  for (let i = 0; i < 366; i++) {
    const d = start.next(i);
    if (d.getYear() > year) break;
    const lunar = d.getLunar();
    const all = [...lunar.getFestivals(), lunar.getJieQi()].filter(Boolean);
    if (all.some((f) => targets.includes(f) || f.includes(name))) {
      return {
        date: `${d.getYear()}-${pad(d.getMonth())}-${pad(d.getDay())}`,
        lunarLabel: `${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`,
      };
    }
  }
  return null;
}

interface ResolvedFestival {
  year: number;
  hit: FestivalHit;
}

/**
 * 解析节日年份并返回命中结果，buildFestivalContext 与 festival_info 工具共用。
 *
 * - 指定年份 → 用该年（即使用户问的是已过去的年份，也如实返回）
 * - 未指定 → 取最近一次尚未到来的年份（今年已过则顺延到明年）
 *
 * 不传年份时顺延很关键：「距离过年还有几天」默认指**下一次**春节，
 * 若直接返回今年的（可能已过），模型会把「已过去 N 天」错当成「还有 N 天」。
 */
function resolveFestival(
  name: string,
  year: number | null | undefined,
  now: Date,
): ResolvedFestival | null {
  const target = (name ?? '').trim();
  if (!target) return null;

  if (year !== undefined && year !== null) {
    const hit = findFestival(target, year);
    return hit ? { year, hit } : null;
  }

  const today = todayInShanghai(now);
  const thisYear = now.getFullYear();
  const hitThisYear = findFestival(target, thisYear);
  if (hitThisYear && hitThisYear.date >= today) {
    return { year: thisYear, hit: hitThisYear };
  }
  const hitNextYear = findFestival(target, thisYear + 1);
  return hitNextYear ? { year: thisYear + 1, hit: hitNextYear } : null;
}

/**
 * 查询某节日在指定年份的公历日期。
 * @param name 节日名（如「春节」「中秋」）
 * @param year 年份；不传则取最近一次尚未到来的年份
 * @param now 当前时间，便于测试注入
 */
export function getFestivalDate(
  name: string,
  year?: number,
  now: Date = new Date(),
): string {
  const target = (name ?? '').trim();
  if (!target) return '请提供节日名称，如：春节、中秋、端午';

  const resolved = resolveFestival(target, year, now);
  if (resolved) return resolved.hit.date;
  return `未找到「${target}」在 ${year ?? now.getFullYear()} 年的公历日期`;
}

/** 上海时区的今天，YYYY-MM-DD（与 system prompt 的当前时间保持一致） */
function todayInShanghai(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** 两个 YYYY-MM-DD 之间的天数差（to - from），用 UTC 避免时区干扰 */
function daysBetween(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = fromYmd.split('-').map(Number);
  const [ty, tm, td] = toYmd.split('-').map(Number);
  return Math.round(
    (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000,
  );
}

/**
 * 把天数差翻译成自然语言（不含日期本身）。
 *
 * calculator 只能算纯数字表达式、算不了日期差，模型自己把日期换算成
 * 「一年中的第几天」再相减时必然出错（如 90-40=50）。这里在服务端直接
 * 把天数算好，模型和工具两侧都能拿到权威值。
 */
function describeOffset(days: number, today: string): string {
  if (days > 0) return `距离今天（${today}）还有 ${days} 天`;
  if (days === 0) return `就是今天（${today}）`;
  return `已过去 ${-days} 天`;
}

/** 给日期补上「相对今天还有多少天」的说明 */
function appendOffset(date: string, today: string): string {
  return `${date}，${describeOffset(daysBetween(today, date), today)}`;
}

/** 从提问里解析明确年份；没有明确年份返回 null */
function parseExplicitYear(query: string, now: Date): number | null {
  const full = query.match(/(20\d{2})\s*年/);
  if (full) return Number(full[1]);

  const current = now.getFullYear();
  if (/前年/.test(query)) return current - 2;
  if (/去年/.test(query)) return current - 1;
  if (/今年|本年/.test(query)) return current;
  if (/明年/.test(query)) return current + 1;
  if (/后年/.test(query)) return current + 2;

  // 27年 / 26年 这类两位年份
  const short = query.match(/(?:^|[^\d])(\d{2})\s*年/);
  if (short) return 2000 + Number(short[1]);

  return null;
}

/**
 * 按提问生成「权威农历日期」提示，用于注入 system prompt。
 *
 * - 提问里有明确年份（2027年 / 27年 / 明年）→ 用该年份
 * - 没写年份 → 默认最近一次尚未到来的节日（今天已过则取明年）
 * - 没提到已知节日 → 返回空串，不污染 prompt
 */
export function buildFestivalContext(
  query: string,
  now: Date = new Date(),
): string {
  const text = query ?? '';
  if (!text.trim()) return '';

  // 先按长名匹配，再按「lunar 节日名」去重：避免「中秋节」同时命中「中秋」+「中秋节」
  const matched: string[] = [];
  const seen = new Set<string>();
  for (const name of FESTIVAL_NAMES) {
    if (!text.includes(name)) continue;
    const canonical = FESTIVAL_ALIASES[name][0];
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    matched.push(name);
  }
  if (!matched.length) return '';

  const explicitYear = parseExplicitYear(text, now);
  const today = todayInShanghai(now);
  const lines: string[] = [];

  for (const name of matched) {
    const resolved = resolveFestival(name, explicitYear, now);
    if (!resolved) continue;
    // 用规范名展示：「过年」显示成「春节」，避免用户看到的名称和问法不一致
    const canonical = FESTIVAL_ALIASES[name][0];
    lines.push(
      `${resolved.year}年${canonical}：公历 ${appendOffset(resolved.hit.date, today)}（农历${resolved.hit.lunarLabel}）`,
    );
  }

  if (!lines.length) return '';

  const hint =
    explicitYear === null
      ? '用户未指定年份，已按最近一次即将到来的日期计算。'
      : '';
  return `【权威农历日期】
今天：${today}
${lines.join('\n')}
${hint}本轮已算好节日日期与剩余天数：回答节日日期或「还有多少天」时直接使用上面的结果，不要重复调用 festival_info，也不要用 calculator 自行推算日期差，禁止凭记忆猜测或编造其他日期。`;
}

/** festival_info 工具：查询传统节日/农历节日对应的公历日期 */
export const festivalTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'festival_info',
      description:
        '查询传统节日/农历节日的公历日期（春节、中秋、端午、清明、七夕、重阳、腊八、除夕等）。问「春节是哪天」「中秋几号」「春节还有多少天」时使用。返回结果已附带相对今天的剩余天数，直接采用即可。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '节日名，如：春节、中秋、端午' },
          year: {
            type: 'number',
            description:
              '年份；不传则取最近一次即将到来的年份（今年已过则自动顺延到明年）',
          },
        },
        required: ['name'],
      },
    },
  },
  handler: async (args) => {
    const now = new Date();
    const name = typeof args.name === 'string' ? args.name : '';
    const year = args.year ? Number(args.year) : undefined;
    const today = todayInShanghai(now);

    const resolved = resolveFestival(name, year, now);
    // 查询失败时（未找到/缺参数）原样返回提示，不要拼天数
    if (!resolved) return getFestivalDate(name, year, now);

    return `${resolved.year}年${name}：公历 ${resolved.hit.date}，${describeOffset(
      daysBetween(today, resolved.hit.date),
      today,
    )}`;
  },
};
