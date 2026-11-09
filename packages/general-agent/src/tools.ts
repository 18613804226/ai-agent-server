import axios from 'axios';
import { evaluate } from 'mathjs';
import type { RegisteredTool } from '@repo/agent-orchestrator';
import { festivalTool } from './festival.js';
import {
  formatIndexedWebSearchContext,
  formatWebSearchContext,
  searchWeb,
} from './web-search.js';
import type { SearchSession } from './search-session.js';

async function fetchWeather(cityName: string): Promise<string> {
  try {
    const encodedCity = encodeURIComponent(cityName);
    const res = await axios.get(`https://wttr.in/${encodedCity}?format=j1`, {
      timeout: 4000,
    });
    const current = res.data.current_condition[0];
    return `【实时天气播报 - ${cityName}】：当前气温 ${current.temp_C}℃，天气状况：${current.weatherDesc[0].value}，湿度：${current.humidity}%。`;
  } catch (error) {
    console.error('获取天气接口失败:', error);
    return `【实时天气播报】：暂时无法获取 ${cityName} 的实时天气数据。`;
  }
}

function calc(expression: string): string {
  try {
    const result = evaluate(String(expression));
    return `计算结果：${expression} = ${result}`;
  } catch (e: any) {
    return `表达式无法计算：${e.message ?? ''}。请提醒用户检查算式。`;
  }
}

/** 天气：仅在用户明确问天气时调用 */
export const weatherTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'fetchWeatherInfo',
      description:
        '仅当用户明确询问某个城市或地区的实时天气、气温时调用。不用于：情绪倾诉、闲聊、日期/农历查询、开放式提问；拿不准时不调用。',
      parameters: {
        type: 'object',
        properties: {
          cityName: {
            type: 'string',
            description: '城市名称，如：北京、广州',
          },
        },
        required: ['cityName'],
      },
    },
  },
  handler: async (args) =>
    fetchWeather(typeof args.cityName === 'string' ? args.cityName : '广州'),
};

/** 计算器：任何数值计算都必须使用，禁止模型心算 */
export const calculatorTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'calculator',
      description:
        '仅用于加减乘除、百分比、折扣、单位换算等纯数值计算。只要涉及数值计算就必须使用，禁止心算。不用于：情绪倾诉、闲聊、观点建议、开放式提问。注意：日期差/剩余天数不是数值表达式，本工具算不了，请直接使用 prompt 或 festival_info 已给出的天数。',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: '数学表达式，如 (100+20)*0.85、365*24',
          },
        },
        required: ['expression'],
      },
    },
  },
  handler: async (args) =>
    calc(typeof args.expression === 'string' ? args.expression : ''),
};

/** 联网搜索：依赖最新事实时使用。传 session 时结果同时回流到本轮来源池 */
export function createWebSearchTool(session?: SearchSession): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'web_search',
        description:
          '仅用于用户明确要求查询实时/外部事实（新闻、热搜、股价、汇率、公告等），且该事实无法凭常识回答时调用。不用于：情绪倾诉、闲聊、观点建议、安慰、开放式提问；拿不准时不调用。反例：用户说「今天面试不太顺」→ 不调用本工具。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
          },
          required: ['query'],
        },
      },
    },
    handler: async (args) => {
      const query = typeof args.query === 'string' ? args.query : '';
      try {
        const results = await searchWeb(query);
        if (session) {
          // ✅ 结构化结果先入本轮来源池，再用池子分配的全局编号生成提示词：
          //    正文里的 [n] 才能和末尾 sources 事件的下标对齐（补搜不会与预检索撞号）。
          const indexed = session.add(results, { origin: 'tool', query });
          return formatIndexedWebSearchContext(indexed);
        }
        return formatWebSearchContext(results);
      } catch {
        // ✅ P0 降级：模型主动调用工具时联网失败，不要抛错打断工具循环；
        //    返回一条明确的「无资料」说明，让模型如实回答而不是编造来源。
        return '（本轮联网检索暂不可用，没有可引用的实时资料。请如实说明无法查证，不要编造来源、日期或链接。）';
      }
    },
  };
}

/** 无 session 的共享实例：general agent 与回滚路径，行为与改造前完全一致 */
export const webSearchTool: RegisteredTool = createWebSearchTool();

export { festivalTool };

/** general agent 的完整工具集（含联网搜索） */
export function createGeneralTools(): RegisteredTool[] {
  return [weatherTool, calculatorTool, webSearchTool, festivalTool];
}

/**
 * 聊天主链路的工具集。
 *
 * 后端对「实时查询」会自己跑 web_search 并把结果注入 prompt（省一轮模型往返），
 * 但关键词识别覆盖不到的说法（如「查一下某人」「搜索一下」「帮我查」）后端不会搜，
 * 所以这里仍暴露 `web_search`，让模型在需要时自己搜。
 *
 * 传 session 时模型自己搜到的结果也会回流，末尾照样下发 sources。
 * ⚠️ 每轮新建：ChatService 是单例，session 绝不能跨请求共享。
 */
export function createChatTools(session?: SearchSession): RegisteredTool[] {
  return [
    weatherTool,
    calculatorTool,
    session ? createWebSearchTool(session) : webSearchTool,
    festivalTool,
  ];
}
