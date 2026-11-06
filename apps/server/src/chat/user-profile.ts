/**
 * 用户画像：只记「用户明确要求记住」的四类偏好。
 *
 * 设计约束（刻意收窄，避免模型自由记忆）：
 * - 必须显式声明（「记住…」「以后…」「统一用…」），模型不得自行推断；
 * - 只认白名单类型：称呼 / 输出格式 / 语言 / 单位，事实类内容一律不记；
 * - 本地正则抽取，不调模型：零延迟、零成本、行为可预测、可单测；
 * - 同类型覆盖、最多 5 条；用户可随时查看与清空。
 */

/** 允许持久化的偏好类型（新增类型必须同时改这里） */
export type UserPreferenceType = '称呼' | '输出格式' | '语言' | '单位';

export interface UserPreference {
  type: UserPreferenceType;
  value: string;
  /** ISO 时间戳，便于前端展示「什么时候记住的」 */
  updatedAt: string;
}

/** 最多保留几条偏好；同类型覆盖，所以上限就是白名单类型数 */
export const MAX_USER_PREFERENCES = 4;

const ALLOWED_TYPES = new Set<string>([
  '称呼',
  '输出格式',
  '语言',
  '单位',
]);

/** 显式声明句式：没有这些词就什么都不记 */
const EXPLICIT = /(记住|记一下|以后|今后|默认|请一直|统一用|一律)/;

/** 否定前缀：用户说「别用列表」时不要记成「输出格式：列表」 */
const NEGATION = /(别|不要|不用|避免|禁止|不喜欢|讨厌)/;

const RULES: Array<{ type: UserPreferenceType; pattern: RegExp }> = [
  {
    // 叫我小明 / 称呼我小王 / 喊我老李
    type: '称呼',
    pattern: /(?:叫我|称呼我(?:为|叫)?|喊我)\s*([A-Za-z一-龥][A-Za-z0-9一-龥_-]{0,11})/,
  },
  {
    // 用要点式回答 / 以后用表格 / 默认分点输出
    type: '输出格式',
    pattern:
      /(?:用|采用|以)\s*(要点式|要点|表格|分点|列表|简洁|简明|详细)(?:方式)?(?:回答|回复|输出|呈现|来答)?/,
  },
  {
    // 用中文回答 / 以后回复用英文
    type: '语言',
    pattern: /(?:用|回答用|回复用)\s*(中文|英文|中英文)(?:回答|回复|输出)?/,
  },
  {
    // 统一用摄氏度 / 以后用斤
    type: '单位',
    pattern:
      /(?:用|统一用)\s*(摄氏度|华氏度|米|厘米|千克|公斤|斤)(?:回答|输出|来回答|来算)?/,
  },
];

/**
 * 从一条用户消息里抽取显式声明的偏好。
 * 命中不了白名单就返回空数组——宁可少记，也不要记错。
 */
export function extractUserPreferences(
  text: string,
  now: Date = new Date(),
): UserPreference[] {
  if (!text || !EXPLICIT.test(text)) return [];
  const found: UserPreference[] = [];
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    const value = (match[1] ?? '').trim();
    if (!value) continue;
    // 「不要用英文」这种否定句不记，避免把反向偏好记成正向偏好
    const before = text.slice(Math.max(0, match.index - 8), match.index);
    if (NEGATION.test(before)) continue;
    found.push({
      type: rule.type,
      value,
      updatedAt: now.toISOString(),
    });
  }
  return found;
}

/**
 * 合并偏好：同类型以新的为准，最多保留 MAX_USER_PREFERENCES 条。
 */
export function mergeUserPreferences(
  current: UserPreference[],
  incoming: UserPreference[],
): UserPreference[] {
  const byType = new Map<UserPreferenceType, UserPreference>();
  for (const item of [...current, ...incoming]) {
    byType.set(item.type, item);
  }
  return [...byType.values()].slice(0, MAX_USER_PREFERENCES);
}

/**
 * 把数据库里的 JSON 读成安全的偏好列表：字段缺失、类型不对、未知类型一律丢弃。
 */
export function parseUserPreferences(raw: unknown): UserPreference[] {
  if (!Array.isArray(raw)) return [];
  const out: UserPreference[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const record = item as {
      type?: unknown;
      value?: unknown;
      updatedAt?: unknown;
    };
    if (typeof record.type !== 'string') continue;
    if (!ALLOWED_TYPES.has(record.type)) continue;
    if (typeof record.value !== 'string') continue;
    const value = record.value.trim();
    if (!value) continue;
    out.push({
      type: record.type as UserPreferenceType,
      value: value.slice(0, 40),
      updatedAt:
        typeof record.updatedAt === 'string'
          ? record.updatedAt
          : new Date().toISOString(),
    });
  }
  return out.slice(0, MAX_USER_PREFERENCES);
}

/**
 * 渲染成注入 system prompt 的「【用户偏好】」正文。
 */
export function formatUserPreferences(prefs: UserPreference[]): string {
  return prefs.map((item) => `- ${item.type}：${item.value}`).join('\n');
}
