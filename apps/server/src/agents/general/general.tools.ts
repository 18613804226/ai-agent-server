import axios from 'axios';
import { evaluate } from 'mathjs';
import { formatWebSearchContext, searchTavily } from '../../chat/web-search.js';
import { getFestivalDate } from './festival.js';
import type { RegisteredTool } from '@repo/agent-orchestrator';

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

export const generalTools: RegisteredTool[] = [
  {
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
      fetchWeather(String(args.cityName || '广州')),
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'calculator',
        description:
          '数学计算器。只要问题涉及任何数值计算（加减乘除、百分比、折扣、日期差、单位换算等）必须使用，禁止心算。',
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
    handler: async (args) => calc(String(args.expression || '')),
  },
  {
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
      const results = await searchTavily(String(args.query || ''));
      return formatWebSearchContext(results);
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'festival_info',
        description:
          '查询传统节日/农历节日的公历日期（春节、中秋、端午、清明、七夕、重阳、腊八、除夕等）。问「春节是哪天」「中秋几号」时使用。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '节日名，如：春节、中秋、端午' },
            year: { type: 'number', description: '年份，默认今年' },
          },
          required: ['name'],
        },
      },
    },
    handler: async (args) =>
      getFestivalDate(
        String(args.name || ''),
        args.year ? Number(args.year) : undefined,
      ),
  },
];
