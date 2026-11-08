import axios from 'axios';
import { evaluate } from 'mathjs';
import type { RegisteredTool } from '@repo/agent-orchestrator';
import { festivalTool } from './festival.js';
import { formatWebSearchContext, searchTavily } from './web-search.js';

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

/** 联网搜索：依赖最新事实时使用 */
export const webSearchTool: RegisteredTool = {
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
    const results = await searchTavily(query);
    return formatWebSearchContext(results);
  },
};

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
 */
export function createChatTools(): RegisteredTool[] {
  return [weatherTool, calculatorTool, webSearchTool, festivalTool];
}
