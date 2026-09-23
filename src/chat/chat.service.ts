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

  // 1. 创建新对话会话
  async createSession(title = '新对话') {
    return this.prisma.chatSession.create({
      data: { title },
    });
  }

  // 2. 获取所有会话列表
  async getSessions() {
    return this.prisma.chatSession.findMany({
      orderBy: { updatedAt: 'desc' },
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
    onChunk: (type: 'thought' | 'content' | 'error', text: string) => void, // 💡 改为支持类型区分的回调函数
    checkAborted?: () => boolean, // 💡 1. 接收中断检查函数
  ) {
    try {
      // 如果刚发起请求前端就断了，直接返回
      if (checkAborted && checkAborted()) return;

      // 💡 1. 必须【严格串行】：先将当前用户的问题写入数据库，确保数据库里有这条记录！
      await this.prisma.message.create({
        data: {
          sessionId,
          role: 'user',
          content: userQuery,
        },
      });

      if (checkAborted && checkAborted()) return;

      // 💡 核心提速：将写数据库、向量检索、查历史消息合并为并发执行，不再串行阻塞！
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

      if (checkAborted && checkAborted()) return;

      const session = await this.prisma.chatSession.findUnique({
        where: { id: sessionId },
      });
      if (!session) {
        throw new NotFoundException(`ChatSession not found: ${sessionId}`);
      }

      //  闲聊判定与 RAG 上下文组装
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

    【核心输出格式绝对要求】：
    你的完整回复必须包含两个部分，缺一不可：
    1. 思考过程：必须以 \`<think>\` 开头，以 \`</think>\` 结尾，在其中详细分析用户的意图、检索相关的知识点、并规划回答步骤。
    思考过程：1. 先看用户提问了什么，2. 再看用户之前的问题和回答，3. 最后看相关资料，4. 确定回答思路，5. 最后输出回答。
    2. 正式回答：紧跟在 \`</think>\` 标签之后，输出面向用户的最终 Markdown 正文。
    
    【示例格式】：
    <think>
    用户询问了...，我需要从...方面进行解答，注意要保持...
    </think>
    这里是最终的正式回答正文...

    【工具调用规则】：
    1. 只有当用户**明确询问某个城市的天气、气温或空气质量**时，才允许调用 \`fetchWeatherInfo\` 工具。
    2. 如果用户是在进行普通闲聊、询问你的身份、或者讨论技术问题，**严禁调用任何工具**，必须直接进行文字回复！
     
    【参考资料】：
    ${context}`;

      // const historyMessages = await this.prisma.message.findMany({
      //   where: { sessionId },
      //   orderBy: { createdAt: 'asc' },
      //   take: 10,
      // });

      const formattedMessages = historyMessages.map((msg) => {
        // 💡 过滤掉非法 role，防止数据库脏数据导致大模型 400 报错
        const role = ['user', 'assistant', 'system', 'tool'].includes(msg.role)
          ? (msg.role as 'user' | 'assistant' | 'system' | 'tool')
          : 'user';

        return {
          role,
          content: msg.content,
        } as any;
      });
      // 💡【就是这里】：确保传给大模型的最后一条消息的 role 绝对是 user
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
      // 💡 1. 简单判断用户意图是否包含天气相关的词汇，如果不包含，直接不给它工具
      const isAskingWeather = /天气|气温|温度|下雨|空气质量|几度/.test(
        userQuery,
      );
      // E. 第一轮对话：不直接流式，先让大模型判断是否需要调用 Tool
      // 💡 1. 组装并加固第一轮对话的消息列表，确保最后一条绝对是 user
      const firstRoundMessages = [
        { role: 'system', content: systemPrompt },
        ...formattedMessages.filter((m: any) => m.role !== 'system'), // 过滤掉可能存在的 system
      ];

      // 强行检查末尾：如果不是 user，说明数据库历史或切片有问题，强制补上一条当前的提问
      if (
        firstRoundMessages.length === 0 ||
        firstRoundMessages[firstRoundMessages.length - 1].role !== 'user'
      ) {
        firstRoundMessages.push({
          role: 'user',
          content: userQuery,
        } as any);
      }

      // 💡 核心优化：如果是闲聊或非天气查询，直接跳过第一轮工具决策，省去 3~5 秒白白等待的时间！
      let initialResponse: any = null;

      if (isAskingWeather) {
        // 只有涉及天气时，才让大模型做第一轮工具决策
        const openaiOptions: any = {
          model: 'qwen3.8-flash',
          messages: firstRoundMessages,
          tools: this.weatherTools,
          tool_choice: 'auto',
        };
        initialResponse =
          await this.openai.chat.completions.create(openaiOptions);
      }
      // 💡 加上 ?. 安全防护，如果跳过了第一轮，给个默认空对象
      const responseMessage = initialResponse?.choices?.[0]?.message || {};
      // 2. 强行拼装最终发给大模型的数组：system -> 历史消息 -> 当前用户的最新提问 (确保最后一条永远是 user)
      const messagesToSend: any[] = [
        { role: 'system', content: systemPrompt },
        ...formattedMessages,
        { role: 'user', content: userQuery }, // 💡 铁律：最后一条必须是 user
      ];

      let weatherContext = '';

      if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
        messagesToSend.push(responseMessage);

        for (const rawToolCall of responseMessage.tool_calls) {
          if (checkAborted && checkAborted()) return; // 工具调用期间也检查中断
          const toolCall = rawToolCall as any;
          if (toolCall.function.name === 'fetchWeatherInfo') {
            const args = JSON.parse(toolCall.function.arguments || '{}');
            const cityName = args.cityName || '广州';

            weatherContext = await this.fetchWeatherInfoByCity(cityName);

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

      // G. 第二轮对话：携带工具结果，开启 stream: true 输出
      const stream = await this.openai.chat.completions.create({
        model: 'qwen3.8-max-0902',
        messages: messagesToSend,
        stream: true,
      });

      let rawFullReply = '';
      let rawThoughtReply = ''; // 💡 记录思考过程
      let inThinkTag = false; // 💡 标记当前是否处于 think 标签内

      for await (const chunk of stream) {
        if (checkAborted && checkAborted()) {
          console.log('检测到用户中断，强行跳出大模型流生成。');
          break;
        }

        const deltaContent = chunk.choices[0]?.delta?.content || '';
        if (!deltaContent) continue;

        rawFullReply += deltaContent;

        // 💡 逐字/逐块精准切分 <think> 和普通文本
        let currentIdx = 0;
        while (currentIdx < deltaContent.length) {
          if (inThinkTag) {
            const endIdx = deltaContent.indexOf('</think>', currentIdx);
            if (endIdx !== -1) {
              // 找到了结束标签
              const thoughtPart = deltaContent.substring(currentIdx, endIdx);
              if (thoughtPart) {
                rawThoughtReply += thoughtPart;
                onChunk('thought', thoughtPart);
              }
              inThinkTag = false;
              currentIdx = endIdx + 8; // 跳过 '</think>'
            } else {
              // 整个 chunk 都在思考中
              const thoughtPart = deltaContent.substring(currentIdx);
              rawThoughtReply += thoughtPart;
              onChunk('thought', thoughtPart);
              break;
            }
          } else {
            const startIdx = deltaContent.indexOf('<think>', currentIdx);
            if (startIdx !== -1) {
              // 标签前的是普通内容
              const contentPart = deltaContent.substring(currentIdx, startIdx);
              if (contentPart) {
                onChunk('content', contentPart);
              }
              inThinkTag = true;
              currentIdx = startIdx + 7; // 跳过 '<think>'
            } else {
              // 整个 chunk 都是普通内容
              const contentPart = deltaContent.substring(currentIdx);
              if (contentPart) {
                onChunk('content', contentPart);
              }
              break;
            }
          }
        }
      }

      const finalCleanReply = rawFullReply
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
        .replace(/<\/?think>/g, '')
        .replace(/<\/?tool_call>/g, '')
        .trimStart();

      // 只有在生成了有效内容、且不是被强行中断产生空文本的情况下才入库
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

      return {
        fullReply: finalCleanReply,
        sources: relevantDocs,
      };
    } catch (error: any) {
      console.error('sendMessageStream 执行出错:', error);

      //  核心兜底：一旦出错（如欠费、网络断开等），通过 onChunk 把错误信息推送给前端！
      const errorMsg =
        error.message || '服务器开小差了，请检查后端配置或账户余额';
      try {
        onChunk('error', errorMsg); // 告诉前端出错了
      } catch (err) {
        // 防止回调本身报错
      }

      // 向上抛出或直接返回，确保后端流能够安全关闭
      throw error;
    }
  }
}
