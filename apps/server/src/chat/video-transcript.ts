// src/chat/video-transcript.ts
/**
 * 视频解析（v1：只做音轨转写，不做抽帧）。
 *
 * 流程：ffprobe 取时长 → 校验上限 → 抽音轨转 16k 单声道 wav → 交给 ASR 转写。
 * ASR 用回调注入，避免本模块反向依赖 ChatService / DashScope 凭据。
 */
import { extname } from 'path';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

export class VideoTooLongError extends Error {
  constructor(
    readonly durationSec: number,
    readonly maxSec: number,
  ) {
    super(
      `视频时长 ${Math.round(durationSec)} 秒，超过上限 ${maxSec} 秒`,
    );
    this.name = 'VideoTooLongError';
  }
}

export class VideoNoAudioError extends Error {
  constructor() {
    super('该视频没有音轨，无法转写（v1 仅支持音轨转文字，抽帧解析在 v2）');
    this.name = 'VideoNoAudioError';
  }
}

export interface VideoTranscribeResult {
  text: string;
  durationSec: number;
}

function probeDuration(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(path, (err, data) => {
      if (err) return reject(err);
      const d = Number(data?.format?.duration);
      resolve(Number.isFinite(d) ? d : 0);
    });
  });
}

/** 只抽音频、丢视频轨，顺手压成 ASR 友好的 16k 单声道 pcm_s16le */
function extractAudioToWav(input: string, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .noVideo()
      .audioChannels(1)
      .audioFrequency(16000)
      .audioCodec('pcm_s16le')
      .format('wav')
      .save(out)
      .on('end', () => resolve())
      .on('error', reject);
  });
}

export async function transcribeVideoAudio(
  buffer: Buffer,
  originalName: string,
  opts: {
    maxDurationSec: number;
    asr: (wavPath: string) => Promise<string>;
  },
): Promise<VideoTranscribeResult> {
  const dir = await mkdtemp(join(tmpdir(), 'chat-video-'));
  const ext = extname(originalName || '').toLowerCase() || '.mp4';
  const videoPath = join(dir, `${randomUUID()}${ext}`);
  const wavPath = `${videoPath}.wav`;

  try {
    await writeFile(videoPath, buffer);

    const durationSec = await probeDuration(videoPath);
    // 取不到时长（损坏文件）时按 0 处理并放行，交给后续 ffmpeg 报错
    if (durationSec > opts.maxDurationSec) {
      throw new VideoTooLongError(durationSec, opts.maxDurationSec);
    }

    let wavSize = 0;
    try {
      await extractAudioToWav(videoPath, wavPath);
      wavSize = (await stat(wavPath)).size;
    } catch (e: any) {
      // ffmpeg 对「没有任何音频流」的报错文案：Output file #0 does not contain any stream
      const msg = String(e?.message || '');
      if (/does not contain any stream|Invalid data found|no audio/i.test(msg)) {
        throw new VideoNoAudioError();
      }
      throw e;
    }
    // 抽出来的 wav 只有 44 字节说明是空音频头，等同于没有音轨
    if (wavSize <= 44) throw new VideoNoAudioError();

    const text = (await opts.asr(wavPath)).trim();
    return { text, durationSec };
  } finally {
    // 无论成败都删掉临时目录：视频动辄几十 MB，不能留在 tmp 里
    await rm(dir, { recursive: true, force: true });
  }
}
