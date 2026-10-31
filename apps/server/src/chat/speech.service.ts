import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import axios from 'axios';
import * as https from 'https';
import WebSocket from 'ws';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { SimpleLock } from '@repo/agent-orchestrator';

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

// ✅ 服务启动时预热 DashScope TTS 连接：发 HEAD 请求建立 TCP+TLS 会话，
//    避免预热时调用生成接口或产生 TTS 费用。
function warmTtsConnection() {
  const apiKey = process.env.DASHSCOPE_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return;
  ttsClient
    .head('https://dashscope.aliyuncs.com/', {
      timeout: 30000,
      validateStatus: () => true,
    })
    .then(() => console.log('🔌 TTS 连接预热完成'))
    .catch((err) => console.warn('🔌 TTS 连接预热失败:', err?.message || err));
}
warmTtsConnection();

// ASR WebSocket 地址：默认全局域名；401/403 时换成业务空间专属：
// wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference
const ASR_WS_URL =
  process.env.DASHSCOPE_WS_URL ||
  'wss://dashscope.aliyuncs.com/api-ws/v1/inference';

/**
 * 语音能力：TTS（文本转语音）与 ASR（语音转文本）。
 * 与聊天编排解耦，chat / attachment 通过方法调用复用。
 */
@Injectable()
export class SpeechService {
  /** ✅ 串行锁：同一进程内 TTS 请求排队，避免并发打爆 DashScope QPS */
  private readonly ttsLock = new SimpleLock();

  async textToSpeech(text: string, voice = 'Nini') {
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

    const release = await this.ttsLock.acquire();
    try {
      const t0 = Date.now();
      let lastError: any = null;
      const maxRetries = 3;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const { data } = await ttsClient.post(
            'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
            {
              // ⚠️ qwen3-tts-instruct-flash 在部分账号/区域不存在（404 Model not exist），
              //    实测可用的是 qwen3-tts-flash；可用 TTS_MODEL 显式覆盖
              model: process.env.TTS_MODEL || 'qwen3-tts-flash',
              input: {
                text: text.slice(0, 300),
                voice,
              },
              parameters: {
                instructions: '语速比正常稍快一点，约1.2倍速，语气自然',
              },
            },
            { headers: { Authorization: `Bearer ${apiKey}` } },
          );

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
        } catch (err: any) {
          lastError = err;
          // ⚠️ 绝不能直接把 AxiosError 交给 console.error：它会展开 config.headers，
          //    把 Authorization 里的 API Key 完整打进日志（已因此泄露过一次）。
          //    只保留状态码 + 服务端错误码 + 文案。
          const status = err?.response?.status;
          const code = err?.response?.data?.code;
          const message = err?.response?.data?.message || err?.message;
          console.error(
            `🔊 TTS 请求失败: status=${status ?? '-'} code=${code ?? '-'} ${message}`,
          );
          const isRateLimit = code === 'Throttling.RateQuota' || status === 429;
          if (!isRateLimit || attempt === maxRetries) {
            // 重试耗尽/非限流错误：把原始 AxiosError 换成可读的 HTTP 异常，
            // 否则前端只拿到 500 Internal Server Error，无从判断原因
            throw new HttpException(
              `TTS 合成失败：${message || '上游服务异常'}`,
              status && status >= 400 && status < 600
                ? (status as HttpStatus)
                : HttpStatus.BAD_GATEWAY,
            );
          }
          const delay = 1200 * Math.pow(2, attempt - 1); // 1.2s, 2.4s, 4.8s
          console.warn(
            `🔊 TTS 限流，${delay}ms 后重试 (第 ${attempt}/${maxRetries} 次)`,
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      throw lastError;
    } finally {
      release();
    }
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
  private async asrByWs(wavPath: string): Promise<string> {
    // ✅ 音频提前异步读一次（内容不会变），避免在 ws 消息回调里做同步 IO 卡住事件循环
    const audio = await readFile(wavPath);
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

  /** 把已转成 wav 的文件转写为文本（供附件模块的视频转写复用） */
  async transcribeWav(wavPath: string): Promise<string> {
    return this.asrByWs(wavPath);
  }

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
      await writeFile(tmpIn, audioBuffer);
      const isWav =
        mimeType.includes('wav') ||
        mimeType.includes('pcm') ||
        mimeType.includes('x-wav');
      const wavPath = isWav ? tmpIn : await this.toWav(tmpIn);

      const text = (await this.asrByWs(wavPath)).trim();

      if (!text) {
        throw new HttpException(
          '识别结果为空',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      return { text };
    } finally {
      // force: true 文件不存在也不报错，不用先 existsSync 再 unlinkSync
      await Promise.all(
        [tmpIn, `${tmpIn}.wav`].map((f) => rm(f, { force: true })),
      );
    }
  }
}
