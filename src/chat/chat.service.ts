import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { VectorService } from '../vector/vector.service.js';
import OpenAI from 'openai';
import axios from 'axios';

@Injectable()
export class ChatService {
  private openai: OpenAI;
  private weatherTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: 'function',
      function: {
        name: 'fetchWeatherInfo',
        description:
          '当用户明确询问某个城市或地区的实时天气、气温情况时调用此函数。如果用户说不想查天气或聊别的，切勿调用。',
        parameters: {
          type: 'object',
          properties: {
            cityName: {
              type: 'string',
              description: '城市名称，例如：北京、广州、Maluku等。',
            },
          },
          required: ['cityName'],
        },
      },
    },
  ];

  constructor(
    private prisma: PrismaService,
    private vectorService: VectorService,
  ) {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || '',
      baseURL: process.env.OPENAI_BASE_URL || '',
    });
  }

  // 创建新对话会话
  async createSession(title?: string) {
    // 1. 设置最大限制数量
    const MAX_SESSIONS = 20;

    // 2. 查询当前所有的会话，按创建时间正序排序（最旧的在最前面）
    const existingSessions = await this.prisma.chatSession.findMany({
      orderBy: { createdAt: 'asc' },
    });

    // 3. 如果会话数量已经达到了 20 个（或更多）
    if (existingSessions.length >= MAX_SESSIONS) {
      // 找到最旧的那一个会话
      const oldestSession = existingSessions[0];

      // 💡 在数据库中将其删除（Prisma 开启了级联删除的话，它下面的 message 也会一起删掉；
      // 如果没开启级联，建议先删 message 再删 session，或者在 schema 里配置 onDelete: Cascade）
      await this.prisma.chatSession.delete({
        where: { id: oldestSession.id },
      });
    }

    // 4. 腾出位置后，再正常创建新会话
    return this.prisma.chatSession.create({
      data: {
        title: title || '',
      },
    });
  }
  // 后端 Service / Controller 中
  async updateSessionTitle(id: string, title: string) {
    return this.prisma.chatSession.update({
      where: { id },
      data: { title },
    });
  }
  // chat.service.ts
  async deleteSession(id: string) {
    return this.prisma.chatSession.delete({
      where: { id },
    });
  }

  //  获取所有会话列表
  async getSessions() {
    return this.prisma.chatSession.findMany({
      orderBy: { updatedAt: 'desc' },
    });
  }
  // chat.service.ts
  async getSessionDetail(id: string) {
    return this.prisma.chatSession.findUnique({
      where: { id },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' }, // 让历史消息按时间正序排列
        },
      },
    });
  }
  // 辅助函数：根据城市名获取天气
  private async fetchWeatherInfoByCity(cityName: string): Promise<string> {
    try {
      const encodedCity = encodeURIComponent(cityName);
      const res = await axios.get(`https://wttr.in/${encodedCity}?format=j1`, {
        timeout: 4000,
      });

      const current = res.data.current_condition[0];
      const tempC = current.temp_C;
      const desc = current.weatherDesc[0].value;
      const humidity = current.humidity;

      return `【实时天气播报 - ${cityName}】：当前气温 ${tempC}℃，天气状况：${desc}，湿度：${humidity}%。`;
    } catch (error) {
      console.error('获取天气接口失败:', error);
      return `【实时天气播报】：暂时无法获取 ${cityName} 的实时天气数据。`;
    }
  }

  //  核心：支持 Function Calling 与流式（Streaming）输出的对话方法
  async sendMessageStream(
    sessionId: string,
    userQuery: string,
    onChunk: (type: 'thought' | 'content' | 'error', text: string) => void,
    checkAborted?: () => boolean,
  ) {
    const overallStartTime = Date.now(); // 💡 记录整体总耗时起点
    try {
      if (checkAborted && checkAborted()) return;

      // 💡 记录并行任务（写库、向量检索、查历史）耗时
      const parallelStartTime = Date.now();
      const [, relevantDocs, historyMessages] = await Promise.all([
        this.prisma.message.create({
          data: {
            sessionId,
            role: 'user',
            content: userQuery,
          },
        }),
        this.vectorService.searchSimilar(userQuery, 3),
        this.prisma.message.findMany({
          where: { sessionId },
          orderBy: { createdAt: 'asc' },
          take: 10,
        }),
      ]);
      const parallelDuration = Date.now() - parallelStartTime;
      console.log(
        `⏱️ [性能监控] 数据库写入 + 向量库检索(${relevantDocs}条) + 历史消息查询，总耗时: ${parallelDuration}ms`,
      );

      if (checkAborted && checkAborted()) return;

      const session = await this.prisma.chatSession.findUnique({
        where: { id: sessionId },
      });
      if (!session) {
        throw new NotFoundException(`ChatSession not found: ${sessionId}`);
      }

      const isCasualChat = /你的名字|你是谁|你好|在干嘛|hi|hello/.test(
        userQuery,
      );
      const context = isCasualChat
        ? ''
        : (relevantDocs as any[])
            .map((doc: any) => doc.content)
            .join('\n---\n');

      const systemPrompt = `你是一个专属的 AI 智能助手。
    - 你的名字叫toto。
    - 你是由开发者独立打造的智能助手，能够协助处理各种问题。

    【工具调用规则】：
    1. 只有当用户**明确询问某个城市的天气、气温或空气质量**时，才允许调用 \`fetchWeatherInfo\` 工具。
    2. 如果用户是在进行普通闲聊、询问你的身份、或者讨论技术问题，**严禁调用任何工具**，必须直接进行文字回复！
     
    【参考资料】：
    ${context}`;
      // 【核心输出格式绝对要求】：
      // 你的完整回复必须包含两个部分，缺一不可：
      // 1. 思考过程：必须以 \`<think>\` 开头，以 \`</think>\` 结尾，在其中详细分析用户的意图、检索相关的知识点、并规划回答步骤。
      // 思考过程：1. 先看用户提问了什么，2. 再看用户之前的问题和回答，3. 最后看相关资料，4. 确定回答思路，5. 最后输出回答。
      // 2. 正式回答：紧跟在 \`</think>\` 标签之后，输出面向用户的最终 Markdown 正文。

      // 【示例格式】：
      // <think>
      // 用户询问了...，我需要从...方面进行解答，注意要保持...
      // </think>
      // 这里是最终的正式回答正文...
      const formattedMessages = historyMessages.map((msg) => {
        const role = ['user', 'assistant', 'system', 'tool'].includes(msg.role)
          ? (msg.role as 'user' | 'assistant' | 'system' | 'tool')
          : 'user';

        return {
          role,
          content: msg.content,
        } as any;
      });

      if (
        formattedMessages.length === 0 ||
        formattedMessages[formattedMessages.length - 1].role !== 'user'
      ) {
        formattedMessages.push({
          role: 'user',
          content: userQuery,
        } as any);
      }
      if (checkAborted && checkAborted()) return;

      const isAskingWeather = /天气|气温|温度|下雨|空气质量|几度/.test(
        userQuery,
      );

      const firstRoundMessages = [
        { role: 'system', content: systemPrompt },
        ...formattedMessages.filter((m: any) => m.role !== 'system'),
      ];

      if (
        firstRoundMessages.length === 0 ||
        firstRoundMessages[firstRoundMessages.length - 1].role !== 'user'
      ) {
        firstRoundMessages.push({
          role: 'user',
          content: userQuery,
        } as any);
      }

      let initialResponse: any = null;

      if (isAskingWeather) {
        const toolStartTime = Date.now();
        const openaiOptions: any = {
          model: 'qwen3.8-flash',
          messages: firstRoundMessages,
          tools: this.weatherTools,
          tool_choice: 'auto',
        };
        initialResponse =
          await this.openai.chat.completions.create(openaiOptions);
        console.log(
          `⏱️ [性能监控] 第一轮工具决策耗时: ${Date.now() - toolStartTime}ms`,
          {
            usage: initialResponse.usage, // 打印第一轮 Token 用量
          },
        );
      }

      const responseMessage = initialResponse?.choices?.[0]?.message || {};
      const messagesToSend: any[] = [
        { role: 'system', content: systemPrompt },
        ...formattedMessages,
        { role: 'user', content: userQuery },
      ];

      let weatherContext = '';

      if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
        messagesToSend.push(responseMessage);

        for (const rawToolCall of responseMessage.tool_calls) {
          if (checkAborted && checkAborted()) return;
          const toolCall = rawToolCall as any;
          if (toolCall.function.name === 'fetchWeatherInfo') {
            const args = JSON.parse(toolCall.function.arguments || '{}');
            const cityName = args.cityName || '广州';

            const apiStartTime = Date.now();
            weatherContext = await this.fetchWeatherInfoByCity(cityName);
            console.log(
              `⏱️ [性能监控] 外部天气 API 接口请求耗时: ${Date.now() - apiStartTime}ms`,
            );

            messagesToSend.push({
              tool_call_id: toolCall.id,
              role: 'tool',
              name: 'fetchWeatherInfo',
              content: weatherContext,
            });
          }
        }
      }

      if (checkAborted && checkAborted()) return;

      // G. 第二轮对话（流式生成）
      const streamStartTime = Date.now();
      let firstTokenTime: number | null = null; // 💡 记录首字延迟 (TTFT)

      const stream = await this.openai.chat.completions.create({
        model: 'qwen3.8-flash',
        messages: messagesToSend,
        stream: true,
        stream_options: { include_usage: true }, // 💡 开启后部分兼容的 OpenAI 接口会在最后一个 chunk 返回 usage
      });

      let rawFullReply = '';
      let rawThoughtReply = '';
      // let inThinkTag = false;

      for await (const chunk of stream) {
        if (checkAborted && checkAborted()) {
          console.log('检测到用户中断，强行跳出大模型流生成。');
          break;
        }

        if (!firstTokenTime) {
          firstTokenTime = Date.now();
        }

        // 🔍 【后端全网大模型格式大搜救】
        // 1. 兼容 OpenAI 标准 delta，以及直接把字段挂在 chunk 根目录下的情况
        const delta =
          (chunk as any).choices?.[0]?.delta || (chunk as any).message || {};

        // 2. 嗅探各种可能的“思考/推理”字段名（覆盖 DeepSeek、Claude、通义千问等各种变体）
        const reasoningContent =
          delta.reasoning_content ||
          delta.reasoning ||
          delta.thought ||
          (chunk as any).reasoning_content ||
          (chunk as any).thought ||
          (chunk as any).reasoning ||
          '';

        // 3. 嗅探各种可能的“正文回答”字段名
        const textContent =
          delta.content ||
          delta.text ||
          delta.message ||
          (chunk as any).content ||
          (chunk as any).text ||
          (typeof chunk === 'string' ? chunk : '');

        if (!textContent && !reasoningContent) continue;

        // 分发给前端
        if (reasoningContent) {
          onChunk('thought', reasoningContent);
        }
        // 💡 核心修复：在这里把流式碎片累加起来！
        if (reasoningContent) {
          rawThoughtReply += reasoningContent;
          onChunk('thought', reasoningContent);
        }
        if (textContent) {
          rawFullReply += textContent; // 👈 累加正文
          onChunk('content', textContent);
        }
      }

      const streamDuration = Date.now() - streamStartTime;
      console.log(
        `⏱️ [性能监控] 大模型流式输出纯生成耗时: ${streamDuration}ms`,
      );

      const finalCleanReply = rawFullReply
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
        .replace(/<\/?think>/g, '')
        .replace(/<\/?tool_call>/g, '')
        .trimStart();

      if (finalCleanReply) {
        await this.prisma.message.create({
          data: {
            sessionId,
            role: 'assistant',
            content: finalCleanReply,
          },
        });
      }

      await this.prisma.chatSession.update({
        where: { id: sessionId },
        data: { updatedAt: new Date() },
      });

      const totalDuration = Date.now() - overallStartTime;
      console.log(
        `🚀 [性能监控] 请求完整生命周期总耗时: ${totalDuration}ms\n-----------------------------------------`,
      );

      return {
        fullReply: finalCleanReply,
        sources: relevantDocs,
      };
    } catch (error: any) {
      console.error('sendMessageStream 执行出错:', error);
      const totalDuration = Date.now() - overallStartTime;
      console.log(`❌ [性能监控] 请求异常中断，累计耗时: ${totalDuration}ms`);

      const errorMsg =
        error.message || '服务器开小差了，请检查后端配置或账户余额';
      try {
        onChunk('error', errorMsg);
      } catch (err) {}

      throw error;
    }
  }
}
