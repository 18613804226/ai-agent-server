import { Solar } from 'lunar-javascript';

/**
 * 传统节日/农历节日 → 公历日期。
 *
 * 春节、中秋等农历节日的公历日期每年不同（如 2025 春节 1/29、2026 春节 2/17），
 * 模型训练数据给不出准确值，必须靠计算。这里用 lunar-javascript 遍历该年每一天的
 * 农历节日，命中即返回公历日期。
 */

/** 常见别名 → lunar 库返回的节日名 */
const FESTIVAL_ALIASES: Record<string, string[]> = {
  春节: ['春节'],
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

/**
 * 查询某节日在指定年份的公历日期。
 * @param name 节日名（如「春节」「中秋」）
 * @param year 年份，默认今年
 */
export function getFestivalDate(name: string, year?: number): string {
  const target = (name ?? '').trim();
  if (!target) return '请提供节日名称，如：春节、中秋、端午';

  const y = year ?? new Date().getFullYear();
  const targets = FESTIVAL_ALIASES[target] ?? [target];

  // 遍历该年每一天，检查农历节日/节气是否命中
  // （清明、冬至等属于「节气」，不在 getFestivals() 里，要一起查 getJieQi()）
  const start = Solar.fromYmd(y, 1, 1);
  for (let i = 0; i < 366; i++) {
    const d = start.next(i);
    if (d.getYear() > y) break;
    const lunar = d.getLunar();
    const all = [...lunar.getFestivals(), lunar.getJieQi()].filter(Boolean);
    if (all.some((f) => targets.includes(f) || f.includes(target))) {
      return `${d.getYear()}-${String(d.getMonth()).padStart(2, '0')}-${String(
        d.getDay(),
      ).padStart(2, '0')}`;
    }
  }
  return `未找到「${target}」在 ${y} 年的公历日期`;
}
