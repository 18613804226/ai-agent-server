import {
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { VectorService } from '../vector/vector.service.js';
import OpenAI from 'openai';
import axios from 'axios';
import * as https from 'https';
import WebSocket from 'ws';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ✅ 模块顶层：整个进程只建一次，所有 TTS 请求复用这套连接
const dashscopeAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60_000,
  maxSockets: 10,
});

const ttsClient = axios.create({
  timeout: 60_000,
  httpsAgent: dashscopeAgent,
});

ffmpeg.setFfmpegPath(ffmpegPath as string);

// ASR WebSocket 地址：默认全局域名；401/403 时换成业务空间专属：
// wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference
const ASR_WS_URL =
  process.env.DASHSCOPE_WS_URL ||
  'wss://dashscope.aliyuncs.com/api-ws/v1/inference';

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
    const MAX_SESSIONS = 20;
    const existingSessions = await this.prisma.chatSession.findMany({
      orderBy: { createdAt: 'asc' },
    });
    if (existingSessions.length >= MAX_SESSIONS) {
      const oldestSession = existingSessions[0];
      await this.prisma.chatSession.delete({
        where: { id: oldestSession.id },
      });
    }
    return this.prisma.chatSession.create({
      data: { title: title || '' },
    });
  }

  async updateSessionTitle(id: string, title: string) {
    return this.prisma.chatSession.update({ where: { id }, data: { title } });
  }

  async deleteSession(id: string) {
    return this.prisma.chatSession.delete({ where: { id } });
  }

  async getSessions() {
    return this.prisma.chatSession.findMany({
      orderBy: { updatedAt: 'desc' },
    });
  }

  async getSessionDetail(id: string) {
    return this.prisma.chatSession.findUnique({
      where: { id },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
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
    const overallStartTime = Date.now();
    try {
      if (checkAborted && checkAborted()) return;

      const parallelStartTime = Date.now();
      const [, relevantDocs, historyMessages] = await Promise.all([
        this.prisma.message.create({
          data: { sessionId, role: 'user', content: userQuery },
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

      const formattedMessages = historyMessages.map((msg) => {
        const role = ['user', 'assistant', 'system', 'tool'].includes(msg.role)
          ? (msg.role as 'user' | 'assistant' | 'system' | 'tool')
          : 'user';
        return { role, content: msg.content } as any;
      });

      if (
        formattedMessages.length === 0 ||
        formattedMessages[formattedMessages.length - 1].role !== 'user'
      ) {
        formattedMessages.push({ role: 'user', content: userQuery } as any);
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
        firstRoundMessages.push({ role: 'user', content: userQuery } as any);
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
          { usage: initialResponse.usage },
        );
      }

      const responseMessage = initialResponse?.choices?.[0]?.message || {};
      const messagesToSend: any[] = [
        { role: 'system', content: systemPrompt },
        ...formattedMessages,
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

      const streamStartTime = Date.now();
      let firstTokenTime: number | null = null;

      const stream = await this.openai.chat.completions.create({
        model: 'qwen3.8-flash',
        messages: messagesToSend,
        stream: true,
        stream_options: { include_usage: true },
      });

      let rawFullReply = '';
      let rawThoughtReply = '';

      for await (const chunk of stream) {
        if (checkAborted && checkAborted()) {
          console.log('检测到用户中断，强行跳出大模型流生成。');
          break;
        }

        if (!firstTokenTime) {
          firstTokenTime = Date.now();
        }

        const delta =
          (chunk as any).choices?.[0]?.delta || (chunk as any).message || {};

        const reasoningContent =
          delta.reasoning_content ||
          delta.reasoning ||
          delta.thought ||
          (chunk as any).reasoning_content ||
          (chunk as any).thought ||
          (chunk as any).reasoning ||
          '';

        const textContent =
          delta.content ||
          delta.text ||
          delta.message ||
          (chunk as any).content ||
          (chunk as any).text ||
          (typeof chunk === 'string' ? chunk : '');

        if (!textContent && !reasoningContent) continue;

        if (reasoningContent) {
          rawThoughtReply += reasoningContent;
          onChunk('thought', reasoningContent);
        }

        if (textContent) {
          rawFullReply += textContent;
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
          data: { sessionId, role: 'assistant', content: finalCleanReply },
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

      return { fullReply: finalCleanReply, sources: relevantDocs };
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

  // -----------
  async textToSpeech(text: string, voice = 'longanwen_v3') {
    if (!text?.trim() || !/[\p{Script=Han}A-Za-z0-9]/u.test(text)) {
      throw new HttpException('文本内容无法朗读', HttpStatus.BAD_REQUEST);
    }

    const apiKey = process.env.DASHSCOPE_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new HttpException(
        '未配置 DASHSCOPE_API_KEY 或 OPENAI_API_KEY',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const t0 = Date.now();
    const { data } = await ttsClient.post(
      'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
      {
        model: 'cosyvoice-v3-flash',
        input: {
          text: text.slice(0, 2000),
          voice,
          format: 'mp3',
          sample_rate: 22050,
          speech_rate: 1.2,
        },
      },
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    console.log('🔊 TTS 首字节延迟:', Date.now() - t0, 'ms');

    const audioUrl =
      data?.output?.audio?.url ||
      data?.output?.audio_url ||
      data?.output?.url ||
      data?.audio_url ||
      data?.url;

    if (!audioUrl) {
      throw new HttpException(
        'TTS 未返回音频地址: ' + JSON.stringify(data).slice(0, 200),
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return { url: audioUrl };
  }

  // ✅ 非 wav 音频统一转码成 16k 单声道 pcm wav（ASR 的要求）
  private async toWav(inputPath: string): Promise<string> {
    const out = `${inputPath}.wav`;
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .audioChannels(1)
        .audioFrequency(16000)
        .audioCodec('pcm_s16le')
        .format('wav')
        .save(out)
        .on('end', () => resolve())
        .on('error', reject);
    });
    return out;
  }

  // ✅ 通过 WebSocket 调 qwen-audio-3.1-asr-flash-message（直连 DashScope，无需公网 URL）
  private asrByWs(wavPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const apiKey =
        process.env.DASHSCOPE_API_KEY || process.env.OPENAI_API_KEY || '';
      const taskId = [...Array(32)]
        .map(() => Math.floor(Math.random() * 16).toString(16))
        .join('');
      const ws = new WebSocket(ASR_WS_URL, {
        headers: { Authorization: `bearer ${apiKey}` },
      });
      let text = '';
      let settled = false;
      const done = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };

      const timer = setTimeout(() => {
        ws.terminate();
        done(() => reject(new Error('ASR 超时')));
      }, 30000);

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            header: {
              action: 'run-task',
              task_id: taskId,
              streaming: 'duplex',
            },
            payload: {
              task_group: 'audio',
              task: 'asr',
              function: 'recognition',
              model: 'qwen-audio-3.1-asr-flash-message',
              parameters: { format: 'wav', sample_rate: 16000 },
              input: {},
            },
          }),
        );
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return; // 非 JSON 帧（音频回包等），忽略
        }
        const event = msg.header?.event;
        if (event === 'task-started') {
          const audio = readFileSync(wavPath);
          for (let i = 0; i < audio.length; i += 32768) {
            ws.send(audio.subarray(i, i + 32768));
          }
          ws.send(
            JSON.stringify({
              header: {
                action: 'finish-task',
                task_id: taskId,
                streaming: 'duplex',
              },
              payload: { input: {} },
            }),
          );
        } else if (event === 'result-generated') {
          text += msg.payload?.output?.sentence?.text ?? '';
        } else if (event === 'task-finished') {
          clearTimeout(timer);
          ws.close();
          done(() => resolve(text));
        } else if (event === 'task-failed') {
          clearTimeout(timer);
          ws.close();
          done(() =>
            reject(new Error(msg.header?.error_message || 'ASR 失败')),
          );
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timer);
        done(() => reject(err));
      });
    });
  }

  // chat.service.ts
  async speechToText(audioBuffer: Buffer, mimeType: string) {
    const apiKey = process.env.DASHSCOPE_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new HttpException(
        '未配置 API Key',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const tmpIn = join(tmpdir(), `asr-${Date.now()}`);
    const t0 = Date.now();
    try {
      writeFileSync(tmpIn, audioBuffer);
      const isWav =
        mimeType.includes('wav') ||
        mimeType.includes('pcm') ||
        mimeType.includes('x-wav');
      const wavPath = isWav ? tmpIn : await this.toWav(tmpIn);

      const text = (await this.asrByWs(wavPath)).trim();
      console.log('🎙️ ASR 耗时:', Date.now() - t0, 'ms');

      if (!text) {
        throw new HttpException(
          '识别结果为空',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      return { text };
    } finally {
      for (const f of [tmpIn, `${tmpIn}.wav`]) {
        if (existsSync(f)) {
          try {
            unlinkSync(f);
          } catch {}
        }
      }
    }
  }
}
