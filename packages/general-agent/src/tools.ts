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
        '当用户明确询问某个城市或地区的实时天气、气温情况时调用。只在问天气时用。',
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
        '数学计算器，用于加减乘除、百分比、折扣、单位换算等纯数值计算。只要涉及数值计算就必须使用，禁止心算。注意：日期差/剩余天数不是数值表达式，本工具算不了，请直接使用 prompt 或 festival_info 已给出的天数。',
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
        '搜索实时网页信息（新闻、热搜、股价、汇率等）。当用户的问题依赖最新事实时使用。',
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
 * 聊天主链路（后端已自己跑 web_search，把结果注入 prompt）只需要
 * 天气/计算/节日，不需要模型再调一次 web_search。
 */
export function createChatTools(): RegisteredTool[] {
  return [weatherTool, calculatorTool, festivalTool];
}
