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
import { evaluate } from 'mathjs';
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

// ✅ 粗略 token 估算：CJK 每字 ~1 token，英文每 3.5 字符 ~1 token
const estimateTokens = (text: string): number => {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  return Math.ceil(cjk + (text.length - cjk) / 3.5);
};
@Injectable()
export class ChatService {
  private openai: OpenAI;
  private tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
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
    {
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
              description: '数学表达式，如 (100+20)*0.85、 365*24 ',
            },
          },
          required: ['expression'],
        },
      },
    },
  ];

  // ✅ 工具执行器：名字 → 实现
  private async execTool(name: string, args: any): Promise<string> {
    if (name === 'fetchWeatherInfo') {
      return this.fetchWeatherInfoByCity(args.cityName || '广州');
    }
    if (name === 'calculator') {
      try {
        const result = evaluate(String(args.expression || ''));
        return `计算结果：${args.expression} = ${result}`;
      } catch (e: any) {
        return `表达式无法计算：${e.message}。请提醒用户检查算式。`;
      }
    }
    return `未知工具：${name}`;
  }

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
          take: 30,
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

      const MAX_CONTEXT_TOKENS = 1500; // RAG 资料上限，按需要调

      let context = isCasualChat
        ? ''
        : (relevantDocs as any[])
            .map((doc: any) => doc.content)
            .join('\n---\n');

      if (estimateTokens(context) > MAX_CONTEXT_TOKENS) {
        // 超了就从后往前丢文档，保住预算
        const docs = (relevantDocs as any[]).map((d: any) => d.content);
        while (
          docs.length > 1 &&
          estimateTokens(docs.join('\n---\n')) > MAX_CONTEXT_TOKENS
        ) {
          docs.pop();
        }
        context = docs.join('\n---\n');
      }

      const systemPrompt = `你是一个专属的 AI 智能助手。
    - 你的名字叫toto。
    - 当前时间：${new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(
      new Date(),
    )}。涉及"今天/明天/现在/星期几"的问题必须以这个时间为准，禁止自己推测日期。
    - 你是由开发者独立打造的智能助手，能够协助处理各种问题。

    【工具调用规则】：
    1. 只有当用户**明确询问某个城市的天气、气温或空气质量**时，才允许调用 \`fetchWeatherInfo\` 工具。
    2. 如果用户是在进行普通闲聊、询问你的身份、或者讨论技术问题，**严禁调用任何工具**，必须直接进行文字回复！
     
    【参考资料】：
    ${context}`;

      const MAX_INPUT_TOKENS = 6000;
      const systemTokens = estimateTokens(systemPrompt);
      const queryTokens = estimateTokens(userQuery);
      let budget = MAX_INPUT_TOKENS - systemTokens - queryTokens;

      const formattedMessages = historyMessages.map((msg) => {
        const role = ['user', 'assistant', 'system', 'tool'].includes(msg.role)
          ? (msg.role as 'user' | 'assistant' | 'system' | 'tool')
          : 'user';
        return { role, content: msg.content } as any;
      });
      // 从最新一条往前装，装不下就停（旧消息直接丢）
      const keptMessages: any[] = [];
      for (let i = formattedMessages.length - 1; i >= 0; i--) {
        const msg = formattedMessages[i];
        const t = estimateTokens(
          typeof msg.content === 'string' ? msg.content : '',
        );
        if (budget - t < 0) break;
        budget -= t;
        keptMessages.unshift(msg);
      }

      // ✅ 保证 keptMessages 末尾一定是当前用户问题（历史查询可能还没包含它）
      const lastKept = keptMessages[keptMessages.length - 1];
      if (!(lastKept?.role === 'user' && lastKept.content === userQuery)) {
        keptMessages.push({ role: 'user', content: userQuery } as any);
      }

      if (checkAborted && checkAborted()) return;

      // ✅ 日志加在这里
      console.log(
        `🧮 [Token] system=${systemTokens}, query=${queryTokens}, 历史保留 ${keptMessages.length} 条, 剩余预算=${budget}`,
      );

      // ✅ 通用工具循环：模型想调工具就执行，最多 4 轮，然后进入最终流式回答
      const messages: any[] = [
        { role: 'system', content: systemPrompt },
        ...keptMessages,
      ];

      for (let round = 0; round < 4; round++) {
        const tResp = Date.now();
        const resp: any = await this.openai.chat.completions.create({
          model: 'qwen3.8-flash',
          messages,
          tools: this.tools,
          tool_choice: 'auto',
          enable_search: true,
        } as any);
        const choiceMsg = resp.choices?.[0]?.message;
        console.log(
          `⏱️ [性能监控] 第 ${round + 1} 轮决策耗时: ${Date.now() - tResp}ms`,
          { tool_calls: choiceMsg?.tool_calls?.length ?? 0 },
        );

        if (!choiceMsg?.tool_calls?.length) break; // 没有工具要调 → 进入流式

        messages.push(choiceMsg);
        for (const call of choiceMsg.tool_calls) {
          if (checkAborted && checkAborted()) return;
          const fn = call.function || {};
          let result: string;
          try {
            const args = JSON.parse(fn.arguments || '{}');
            result = await this.execTool(fn.name, args);
          } catch (e: any) {
            result = `工具执行出错：${e.message}`;
          }
          messages.push({
            tool_call_id: call.id,
            role: 'tool',
            name: fn.name,
            content: result,
          });
        }
      }

      if (checkAborted && checkAborted()) return;

      const streamStartTime = Date.now();
      let firstTokenTime: number | null = null;

      const stream: any = await this.openai.chat.completions.create({
        model: 'qwen3.8-flash',
        messages,
        stream: true,
        enable_search: true, // ✅
        stream_options: { include_usage: true },
      } as any);

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

      ws.on('error', (err: any) => {
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
