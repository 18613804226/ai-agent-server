/**
 * 主链路（apps/server 的 chat prompt）与 general-agent 共用的提示词片段。
 *
 * 这两处以前各写一份工具规则，改一边忘一边，措辞已经漂移（calculator 强制、
 * 闲聊不搜的边界、角标编号上限）。这里只放「两边都成立、且必须一字不差」
 * 的条目；专属内容（后端预检索语义、知识库参考资料、附件、历史来源状态）
 * 留在各自文件里。
 *
 * 约定：每条规则不带序号，由调用方用 formatRuleList 统一编号，
 * 这样增删条目不会让手写序号错位。
 */

/** 数值计算 / 天气 / 农历的调用边界 */
export const TOOL_ROUTING_RULES: readonly string[] = [
  '数值计算（含单位换算）调用 `calculator`，禁止心算；但「距离某节日还有多少天」是日期差，不是数值表达式，直接用【权威农历日期】里已给出的天数，不要用 `calculator` 自行推算。',
  '天气问题调用 `fetchWeatherInfo`。传统节日/农历日期问题：若本轮已给出【权威农历日期】，直接使用该结果（含剩余天数），不要重复调用 `festival_info`；未给出时才调用 `festival_info`，禁止用 `fetchWeatherInfo` 查日期。',
];

/** 能直接答就别调工具：减少多余的模型往返 */
export const TOOL_MINIMALITY_RULE =
  '工具只在与问题直接相关时调用；能直接回答就不要为了调用而调用，减少多余的模型往返。';

/** 闲聊 / 情绪倾诉不联网；拿不准就不搜 */
export const CASUAL_TURN_RULE =
  '普通闲聊、身份问题、情绪倾诉（如「今天面试不太顺」「算了不聊了」）直接回答，不要为了搜索而搜索；拿不准该不该搜时，默认不搜。只有用户明确要求查证，或问题指向一个具体、可验证的外部对象时才搜。';

/** 联网引用的角标规范；正文里怎么展示链接按端各自补充 */
export const WEB_CITATION_RULE =
  '回答实时信息时，每个事实后面用 [1]、[2] 这类数字角标标注来源，编号对应本轮检索结果里的 [序号]，且不得超出本轮结果条数；不得编造来源或链接。';

/** 把规则片段编号成 `1. …` 的多行文本 */
export function formatRuleList(rules: readonly string[]): string {
  return rules.map((rule, index) => `${index + 1}. ${rule}`).join('\n');
}
