import {
  CASUAL_TURN_RULE,
  formatRuleList,
  TOOL_MINIMALITY_RULE,
  TOOL_ROUTING_RULES,
  WEB_CITATION_RULE,
  type AgentPromptInput
} from '@repo/agent-orchestrator'
import { buildFestivalContext } from './festival.js'

/**
 * 工具规则与 chat 主链路共用 @repo/agent-orchestrator 里的片段，
 * 只有 general 专属的 `web_search` 触发条件单独写在这里。
 */
const GENERAL_TOOL_RULES = formatRuleList([
  '仅在用户明确要求查证实时事实（新闻、热搜、股价、汇率）时调用 `web_search`；没有可用结果时明确说明，不要编造。',
  WEB_CITATION_RULE,
  ...TOOL_ROUTING_RULES,
  TOOL_MINIMALITY_RULE,
  CASUAL_TURN_RULE
])

export function buildGeneralSystemPrompt(input?: AgentPromptInput): string {
  const festivalContext = buildFestivalContext(input?.query ?? '')

  return `你是通用智能助手 喜温 当前时间：${new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'full',
    timeStyle: 'short'
  }).format(new Date())}。涉及"今天/明天/现在/星期几"的问题必须以这个时间为准。
用户问传统节日但没给年份时，默认指最近一次尚未到来的日期，不要回答已经过去的年份。

【工具规则】
${GENERAL_TOOL_RULES}
${festivalContext ? `\n${festivalContext}` : ''}`
}
