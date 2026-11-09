import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { VectorService } from '../vector/vector.service.js';
import { createDefaultModelClients } from '../agent/model-clients.js';
import { createOrchestrator } from '../agent/orchestrator.factory.js';
import {
  AgentOrchestrator,
  classifyComplexity,
  displayModelName,
  formatRoutingThought,
  isAttachmentRefusal,
  resolveModelCandidates,
  zhipuChatSamplingParam,
  type ContentGate,
  type RegisteredTool,
} from '@repo/agent-orchestrator';
import {
  buildFestivalContext,
  createChatTools,
  formatWebSearchContext,
  isEmotionalTurn,
  isLiveInfoQuery,
  searchWeb,
  SearchSession,
  type WebSearchResult,
  type WebSource,
} from '@repo/general-agent';
import {
  ATTACHMENT_TTL_MS,
  type AttachmentKind,
} from './attachment-store.js';
import {
  buildAttachmentDigest,
  buildConversationDigest,
  buildSystemPrompt,
  buildWebSearchFallbackContext,
  createAppReplyFormatter,
  estimateTokens,
  formatAppReply,
  friendlyChatError,
  isAppPlatform,
} from './chat-prompt.js';
import { ImageService } from './image.service.js';
import { AttachmentService } from './attachment.service.js';
import { SpeechService } from './speech.service.js';
import {
  DEMO_FALLBACK,
  demoReplayEvents,
  demoReplayMode,
  findDemoReplay,
  type DemoReplayEntry,
} from './demo-replay.js';
import {
  extractUserPreferences,
  formatUserPreferences,
  mergeUserPreferences,
  parseUserPreferences,
  type UserPreference,
} from './user-profile.js';

// ✅ 一次最多 2 张图进模型上下文（当前轮优先，剩余名额从最新历史消息补）
const MAX_MODEL_IMAGES = 2;
// ✅ 单图预算（压缩后长边上限 1280 时实测 1095 token），取整留余量做保守估算
const MODEL_IMAGE_TOKEN_COST = 1200;
// ✅ 滚动摘要上限与预算预留：两段摘要都是本地提取、不调模型，但要给 system prompt 留 token
const DIGEST_MAX_CHARS = 300;
const ATTACHMENT_DIGEST_MAX_CHARS = 400;
const DIGEST_TOKEN_RESERVE = 760;
// ✅ 初始上下文窗口：与编排器工具循环预算同源（见 orchestrator.factory.ts）
const DEFAULT_MAX_INPUT_TOKENS = 6000;
function readMaxInputTokens(): number {
  const value = Number(process.env.CHAT_MAX_INPUT_TOKENS);
  return Number.isFinite(value) && value >= 1000
    ? Math.min(100_000, Math.floor(value))
    : DEFAULT_MAX_INPUT_TOKENS;
}
// ✅ 实时查询保留的历史消息条数（默认 6 轮），长会话由 token 预算兜底
const DEFAULT_LIVE_HISTORY_MESSAGES = 12;
// ✅ 指代类追问复用上一轮 RAG 结果，省掉重复 embedding + 向量检索
const RAG_CACHE_TTL_MS = 5 * 60 * 1000;
const RAG_FOLLOWUP_HINT =
  /刚才|前面|上面|再说|展开|详细|继续|这点|那段|上述|第一点|第二点/;
/** 预检索结果少于这个数就保留 web_search，让模型有机会换词补搜 */
const MIN_WEB_RESULTS = 3;

/**
 * 用户画像开关：默认开启，但只记「用户明确要求记住」的白名单四类偏好。
 * 设 CHAT_USER_PROFILE=off 即完全不记、不注入。
 */
function userProfileEnabled(): boolean {
  return (process.env.CHAT_USER_PROFILE ?? 'on').toLowerCase() !== 'off';
}

/**
 * 联网来源统一通道开关：默认开启。
 * 设 CHAT_SEARCH_SESSION=off 一键回退到「只有后端预检索才下发 sources」的旧行为，
 * 用于线上出问题时不必回滚代码即可止血。
 */
function searchSessionEnabled(): boolean {
  return (process.env.CHAT_SEARCH_SESSION ?? 'on').toLowerCase() !== 'off';
}
// ✅ 纯文本追问历史图的指代词：命中后强制走视觉档并还原历史图
const HISTORY_IMAGE_HINT =
  /刚才(那|这)?张图|之前(那|的)?图|上(一)?张图|上面(那|的)?图|这张图|那张图|图(片)?里|图(片)?上/;

/** 流式回调：文本类传 content，结构化事件传对象，sources 传数组 */
export type StreamEmit = (
  type:
    | 'thought'
    | 'content'
    | 'error'
    | 'sources'
    | 'tool_call'
    | 'tool_result',
  payload: string | any[] | Record<string, unknown>,
) => void;

@Injectable()
export class ChatService {
  /** 聊天附件：解析、落盘、预览、删除、清扫 */
  private readonly attachmentService: AttachmentService;
  /** 语音：TTS + ASR（视频附件转写需要） */
  private readonly speechService: SpeechService;
  /** 共享编排器：模型级联 + 工具循环 */
  private readonly orchestrator: AgentOrchestrator;
  /** 图片上传/压缩/安全校验/孤儿清扫 */
  private readonly imageService: ImageService;
  /** 本 agent 注册的工具集（与 general agent 共用同一份实现） */
  private readonly tools: RegisteredTool[] = createChatTools();
  /** 会话内 RAG 结果缓存：指代类追问直接复用，TTL 到期自动失效 */
  private readonly ragCache = new Map<string, { docs: any[]; at: number }>();

  constructor(
    private prisma: PrismaService,
    private vectorService: VectorService,
    /** 全进程共享的编排器（由 AgentModule 提供）；测试模块未提供时用默认环境配置 */
    @Optional() orchestrator?: AgentOrchestrator,
    /** 图片服务（由 ChatModule 提供）；测试可不传，用默认实例 */
    @Optional() imageService?: ImageService,
    /** 附件服务（由 ChatModule 提供）；测试可不传，用默认实例 */
    @Optional() attachmentService?: AttachmentService,
    /** 语音服务（由 ChatModule 提供）；测试可不传，用默认实例 */
    @Optional() speechService?: SpeechService,
  ) {
    this.orchestrator =
      orchestrator ?? createOrchestrator(createDefaultModelClients());
    this.imageService = imageService ?? new ImageService(this.prisma);
    this.attachmentService =
      attachmentService ?? new AttachmentService(this.prisma);
    this.speechService = speechService ?? new SpeechService();
    // 视频转写需要 ASR，附件模块不直接依赖语音实现，由这里注入回调
    this.attachmentService.setAsrRunner((wavPath) =>
      this.speechService.transcribeWav(wavPath),
    );
    const cfg = this.orchestrator.modelConfig;
    console.log(
      `🧠 [模型分层] 档位：视觉 ${cfg.visionPrimary} / 简单 ${cfg.textSimple} / ` +
        `复杂 ${cfg.textComplex} → ${cfg.textComplexFallback} / ` +
        `专家 ${cfg.textExpert} / 兜底 ${cfg.fallback}`,
    );
    console.log(
      cfg.priorityModel
        ? `🧠 [模型分层] 全局首选（不参与评分，插到所有档位链首）：${cfg.priorityModel}`
        : '🧠 [模型分层] 未启用全局首选模型，按评分档位路由',
    );
    console.log(
      this.orchestrator.zhipuAvailable
        ? '🧠 [模型分层] GLM 免费层已启用'
        : '🧠 [模型分层] 未配置 GLM_API_KEY，glm-* 候选自动剔除',
    );
  }

  /**
   * 离线回放：按预录事件把工具链 + 正文重新推一遍。
   * 持久化单独包 try/catch —— 现场连数据库一起挂了，也要能把流程演示完。
   */
  private async playDemoReplay(params: {
    sessionId: string;
    userQuery: string;
    persistContent?: string;
    entry: DemoReplayEntry;
    onChunk: StreamEmit;
    startTime: number;
    /** 主链路已经落过 user 消息时传 false，避免重复写一条 */
    persistUser: boolean;
    reason?: string;
  }) {
    const {
      sessionId,
      userQuery,
      persistContent,
      entry,
      onChunk,
      startTime,
      persistUser,
      reason,
    } = params;

    if (persistUser) {
      try {
        await this.prisma.message.create({
          data: {
            sessionId,
            role: 'user',
            content: persistContent ?? userQuery,
          },
        });
      } catch {
        // 回放不依赖数据库
      }
    }

    if (reason) onChunk('thought', reason);
    for (const [type, payload] of demoReplayEvents(entry)) {
      onChunk(type, payload);
    }
    if (entry.sources.length) onChunk('sources', entry.sources);

    try {
      await this.prisma.message.create({
        data: {
          sessionId,
          role: 'assistant',
          content: entry.reply,
          // Prisma JSON 字段要求 InputJsonValue，回放数据在这里收窄
          sources: entry.sources as any,
        },
      });
      await this.prisma.chatSession.update({
        where: { id: sessionId },
        data: { updatedAt: new Date() },
      });
    } catch {
      // 回放不依赖数据库
    }

    return {
      fullReply: entry.reply,
      sources: entry.sources,
      tokens: 0,
      model: 'demo-replay',
      truncated: false,
      completionTokens: 0,
      finishReason: 'stop',
      ttftMs: 0,
      durationMs: Date.now() - startTime,
      sourcesCount: entry.sources.length,
      historyKept: 0,
      historyDropped: 0,
      digestUsed: false,
    };
  }

  /** 读取该设备已保存的用户画像；失败一律当「没有偏好」，绝不阻断主链路 */
  async getUserPreferences(deviceId?: string): Promise<UserPreference[]> {
    if (!deviceId) return [];
    if (!userProfileEnabled()) return [];
    try {
      const device = await this.prisma.device.findUnique({
        where: { id: deviceId },
        select: { preferences: true },
      });
      return parseUserPreferences(device?.preferences);
    } catch {
      return [];
    }
  }

  /** 清空该设备的用户画像（用户随时可以「忘掉我」） */
  async clearUserPreferences(deviceId?: string): Promise<void> {
    if (!deviceId) return;
    try {
      await this.prisma.device.update({
        where: { id: deviceId },
        data: { preferences: [] },
      });
    } catch (err) {
      console.warn('[画像] 清空失败：', err);
    }
  }

  /** 写回用户画像；失败只记日志，不影响本轮回答 */
  private async saveUserPreferences(
    deviceId: string | undefined,
    prefs: UserPreference[],
  ): Promise<void> {
    if (!deviceId || !prefs.length) return;
    try {
      await this.prisma.device.update({
        where: { id: deviceId },
        // ✅ Prisma 的 Json 字段要求 InputJsonValue，这里存的是我们自己的窄结构
        data: { preferences: prefs as any },
      });
    } catch (err) {
      console.warn('[画像] 写入失败：', err);
    }
  }

  //  核心：支持 Function Calling 与流式（Streaming）输出的对话方法
  //  signal：客户端断开时 abort，会立刻掐断上游大模型请求（否则模型还在烧 token）
  async sendMessageStream(
    sessionId: string,
    userQuery: string,
    onChunk: StreamEmit,
    images?: string[],
    signal?: AbortSignal,
    fileIds?: string[],
    attachmentIds?: string[],
    /** 随本条消息直传、已当场解析好的附件（单步流：文件和消息同一个请求） */
    inlineAttachments?: Array<{
      name: string;
      kind: AttachmentKind;
      text: string;
      durationSec?: number;
    }>,
    /**
     * 落库到 Message.content 的原文（默认 = userQuery）。
     * 「只传文件、没输问题」时，控制器会补一句默认指令喂给模型，
     * 但**不该把这句系统补的话写进聊天记录** —— 传这个字段存用户原始输入（可能为空）。
     */
    persistContent?: string,
    /**
     * 客户端平台：APP 端启用移动端专用提示词 + 排版兜底清洗。
     * 放末尾可选位，不影响现有调用方。
     */
    platform?: string,
    /**
     * 设备 ID：用于读写该设备的用户画像（只存用户明确要求记住的白名单偏好）。
     */
    deviceId?: string,
  ) {
    const overallStartTime = Date.now();
    const aborted = () => signal?.aborted === true;
    let usedModel = ''; // 实际所用模型（函数级作用域，catch 兜底返回也要用）

    try {
      if (aborted()) return;

      // ✅ 先校验图片来源：不可信就直接失败，别把注定发不出去的消息写进库
      const hasImages = Array.isArray(images) && images.length > 0;
      if (hasImages) {
        for (const ref of images!) {
          if (!this.imageService.classifyImageRef(ref)) {
            throw new BadRequestException(
              '图片来源不被信任：只允许本站已上传的图片（/uploads/），或 IMAGE_FETCH_ALLOWLIST 白名单内的地址',
            );
          }
        }
      }

      // ✅ 强制回放模式：完全不请求模型，现场断网 / 余额不足也能走完整流程
      if (demoReplayMode() === 'forced') {
        return this.playDemoReplay({
          sessionId,
          userQuery,
          persistContent,
          entry: findDemoReplay(userQuery) ?? DEMO_FALLBACK,
          onChunk,
          startTime: overallStartTime,
          persistUser: true,
        });
      }

      // ✅ 闲聊不查 RAG，省掉一次 embedding 调用 + 向量检索
      const isCasualChat = /你的名字|你是谁|你好|在干嘛|hi|hello/.test(
        userQuery,
      );
      const liveInfoQuery = isLiveInfoQuery(userQuery);
      // ✅ 本轮联网结果的唯一事实来源。per-request 创建：ChatService 是单例，
      //    绝不能挂到 this.tools 或模块作用域，否则并发会把 A 的来源串到 B。
      const searchSession = searchSessionEnabled()
        ? new SearchSession()
        : undefined;

      // 附件先取出来：既要在落库时记元数据，也要拼进 prompt
      // （内联附件 = 随本条消息直传的；attachmentIds = 先上传后引用的）
      const {
        context: attachmentContext,
        used: usedAttachments,
        missing: missingAttachments,
      } = this.attachmentService.buildAttachmentContext(
        attachmentIds,
        inlineAttachments,
      );
      const attachmentMeta = usedAttachments.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        charCount: a.charCount,
        durationSec: a.durationSec,
        // ✅ 只落 300 字要点：原文仍在临时存储里、到期即弃，但下一轮追问能接上
        summary: a.text.replace(/\s+/g, ' ').trim().slice(0, 300),
        // 原始文件已落盘，历史消息靠这两个字段回看/重新提问
        fileRef: a.fileRef,
        url: a.fileRef ? `/chat/attachments/${a.fileRef}` : undefined,
      }));
      if (missingAttachments.length) {
        console.warn(
          `📎 附件已过期或不存在: ${missingAttachments.join(',')}（附件仅保留 ${ATTACHMENT_TTL_MS / 60000} 分钟）`,
        );
      }
      if (attachmentContext) {
//         console.log(`📎 附件已注入本轮上下文: ${attachmentContext.length} 字`);
      }

      // ✅ 指代类追问（「刚才那点再说清楚一点」）直接复用上一轮命中，
      //    结果高度重合却要重跑一次 embedding + 向量检索，白花延迟和 token。
      const ragKey = `${sessionId}:${(fileIds ?? []).slice().sort().join(',')}`;
      const cachedRag = this.ragCache.get(ragKey);
      const reuseRag =
        !isCasualChat &&
        !liveInfoQuery &&
        RAG_FOLLOWUP_HINT.test(userQuery) &&
        userQuery.length <= 30 &&
        !!cachedRag &&
        Date.now() - cachedRag.at < RAG_CACHE_TTL_MS;

      const parallelStartTime = Date.now();
      const [
        createdUserMessage,
        relevantDocs,
        historyMessages,
        webSearchOutcome,
        userPreferences,
      ] = await Promise.all([
          this.prisma.message.create({
            data: {
              sessionId,
              role: 'user',
              // ✅ 落库用用户原文：只传文件时控制器补的默认指令不能进聊天记录
              content: persistContent ?? userQuery,
              // ✅ 图片 URL 一起落库，历史会话才能还原出图
              images: hasImages ? images : undefined,
              attachments: attachmentMeta.length ? attachmentMeta : undefined,
            },
          }),
          reuseRag || isCasualChat || liveInfoQuery
            ? Promise.resolve(
                (reuseRag ? cachedRag!.docs : []) as any[],
              )
            : fileIds && fileIds.length
              ? this.vectorService
                  .searchSimilarByFile(userQuery, fileIds, 3)
                  .then((results) => {
//                     console.log(
//                       '🔍 [RAG-byFile]',
//                       JSON.stringify(
//                         results.map((r: any) => ({
//                           similarity: r.similarity,
//                           content: (r.content || '').slice(0, 80),
//                         })),
//                       ),
//                     );
                    return results;
                  })
              : this.vectorService
                  .searchSimilar(userQuery, 3)
                  .then((results) => {
//                     console.log(
//                       '🔍 [RAG]',
//                       JSON.stringify(
//                         results.map((r: any) => ({
//                           similarity: r.similarity,
//                           content: (r.content || '').slice(0, 80),
//                         })),
//                       ),
//                     );
                    return results;
                  }),
          this.prisma.message.findMany({
            where: { sessionId },
            // ✅ 取最近 30 条（原来 asc 取的是最旧 30 条，长会话下最近上下文全丢）
            orderBy: { createdAt: 'desc' },
            take: 30,
          }),
          liveInfoQuery
            ? searchWeb(userQuery, signal)
                .then((r) => {
                  onChunk('thought', `🔎 已联网检索：${r.length} 条结果。`);
                  // ✅ 预检索同样入池：与模型补搜共用一套全局编号，末尾 sources 同源
                  searchSession?.add(r, { origin: 'prefetch', query: userQuery });
                  return {
                    results: r,
                    status: (r.length ? 'ok' : 'empty') as 'ok' | 'empty',
                  };
                })
                // ✅ P0 降级：联网 API 超时/限流/欠费不该拖垮整轮对话。
                //    以前这个 Promise 在 Promise.all 里 reject，会直接跳到 demo-replay
                //    兜底（用户问实时信息却收到一段预录答案）或推一帧 error 就结束。
                //    status=error 与「没搜到」分开，prompt 才能给出真实的失败说明。
                .catch(() => {
                  if (!aborted()) {
                    onChunk(
                      'thought',
                      '⚠️ 联网检索暂不可用，以下回答未包含实时信息。',
                    );
                  }
                  return {
                    results: [] as WebSearchResult[],
                    status: 'error' as const,
                  };
                })
            : Promise.resolve({
                results: [] as WebSearchResult[],
                status: 'not-run' as const,
              }),
          // ✅ 读该设备的用户画像（只读；失败就当没有，不影响主链路）
          deviceId
            ? this.getUserPreferences(deviceId)
            : Promise.resolve([] as UserPreference[]),
        ]);
      const webSearchResults = webSearchOutcome.results;
      const webSearchStatus = webSearchOutcome.status;
      if (reuseRag) {
        onChunk('thought', '📚 沿用上一轮检索到的知识库资料。');
      } else if (!isCasualChat && !liveInfoQuery && relevantDocs.length) {
        // 顺手清掉过期项，避免长跑进程里 Map 无限增长
        for (const [key, value] of this.ragCache) {
          if (Date.now() - value.at >= RAG_CACHE_TTL_MS) {
            this.ragCache.delete(key);
          }
        }
        this.ragCache.set(ragKey, {
          docs: relevantDocs as any[],
          at: Date.now(),
        });
      }
      // ✅ 用户画像：只有用户显式说「记住…/以后…/统一用…」才记，且只认白名单四类；
      //    不调模型、不猜意图，记错了可以随时清空。
      const declaredPreferences = userProfileEnabled()
        ? extractUserPreferences(userQuery)
        : [];
      const effectivePreferences = declaredPreferences.length
        ? mergeUserPreferences(userPreferences, declaredPreferences)
        : userPreferences;
      if (declaredPreferences.length) {
        void this.saveUserPreferences(deviceId, effectivePreferences);
        onChunk(
          'thought',
          `🧠 已记住偏好：${declaredPreferences
            .map((item) => `${item.type}=${item.value}`)
            .join('、')}`,
        );
      }
      const parallelDuration = Date.now() - parallelStartTime;
//       console.log(
//         `⏱️ [性能监控] 数据库写入 + 向量库检索(${relevantDocs.length}条) + 历史消息查询，总耗时: ${parallelDuration}ms`,
//       );

      if (aborted()) return;

      const session = await this.prisma.chatSession.findUnique({
        where: { id: sessionId },
      });
      if (!session) {
        throw new NotFoundException(`ChatSession not found: ${sessionId}`);
      }

      // ✅ 预检索为空/失败时不硬拒答：本轮照常走模型，工具表里保留 web_search
      //    让模型换词再搜一次或如实说明；硬拒答会把误判和真实失败一起挡在门外。

      // ✅ 反转回时间正序，再从最旧一条开始装上下文
      historyMessages.reverse();
      // ✅ 历史查询与落库是并发的，可能已经把本轮 user 消息读回来；按 id 去掉，
      //    避免同一条问题在上下文里出现两次（带附件时 content 不同，不能只比文本）。
      // ⚠️ 只传文件的用户消息 content 为空，glm 收到空 content 会直接 400。
      //    历史里这类空消息直接丢弃（它对应的助手回复仍有内容，上下文不受影响）。
      const createdMessageId = (createdUserMessage as any)?.id;
      const historyForModel = historyMessages
        .filter((m: any) => !createdMessageId || m.id !== createdMessageId)
        .filter((m: any) =>
          typeof m.content === 'string' ? m.content.trim() !== '' : true,
        );

      // ✅ 来源状态按裁剪前的完整历史算，避免更早回答引用过的停用文档被漏掉。
      const historyForSources = historyForModel.slice();
      // ✅ 被窗口裁掉的旧消息留作「此前对话要点」，避免长会话里约束被一次性忘光。
      const trimmedForDigest: Array<{ role: string; content: string }> = [];
      // ✅ 实时查询窗口可配（默认 6 轮）；下面还有 6000 token 预算兜底，不必硬砍到 3 轮。
      const envLimit = Number(process.env.CHAT_LIVE_HISTORY_MESSAGES);
      const liveHistoryLimit =
        Number.isFinite(envLimit) && envLimit >= 6
          ? Math.min(30, Math.floor(envLimit))
          : DEFAULT_LIVE_HISTORY_MESSAGES;
      if (liveInfoQuery && historyForModel.length > liveHistoryLimit) {
        trimmedForDigest.push(
          ...historyForModel
            .splice(0, historyForModel.length - liveHistoryLimit)
            .map((m: any) => ({
              role: typeof m.role === 'string' ? m.role : 'user',
              content: typeof m.content === 'string' ? m.content : '',
            })),
        );
      }

      const MAX_CONTEXT_TOKENS = 800;
      const SIMILARITY_THRESHOLD = 0.45;

      const relevantAndPassingDocs = (relevantDocs as any[]).filter(
        (doc: any) => doc.similarity >= SIMILARITY_THRESHOLD,
      );
      // ✅ 联网结果在模型出第一个字之前就在服务端手里：把 URL 结构化下发，
      //    不再依赖模型把链接写进正文（APP 窄屏上会被折成好几行，且不可点）。
      //    kind 用来和知识库来源区分，老客户端忽略新字段也不会崩。
      //    这是「回滚开关关闭」时的旧算法；session 开启时由来源池统一供给。
      const fallbackWebSources: WebSource[] = webSearchResults
        .filter((result) => typeof result?.url === 'string' && !!result.url)
        .slice(0, 10)
        .map((result, index) => ({
          kind: 'web' as const,
          index: index + 1,
          title: result.title || '联网来源',
          url: result.url,
          ...(result.publishedDate
            ? { publishedDate: result.publishedDate }
            : {}),
        }));
      const docSources: any[] = [
        ...new Map(
          relevantAndPassingDocs
            .filter((doc: any) => typeof doc.metadata?.fileId === 'string')
            .map((doc: any) => [
              doc.metadata.fileId,
              {
                fileId: doc.metadata.fileId,
                fileName: doc.metadata.fileName || '知识库',
              },
            ]),
        ).values(),
      ];
      /**
       * ⚠️ 必须延迟到流结束后求值：模型中途调 web_search 会往 session 追加结果，
       *    提前展开成静态数组就会把补搜来源漏掉（旧实现正是这样丢掉 sources 的）。
       *    落库、sources 事件、sourcesCount 全部走这一个函数，保证三者同源。
       */
      const replySources = (): any[] => [
        ...docSources,
        ...(searchSession ? searchSession.list() : fallbackWebSources),
      ];
      const hasRelevantDocs =
        !isCasualChat && relevantAndPassingDocs.length > 0;

      let context =
        isCasualChat || !hasRelevantDocs
          ? ''
          : relevantAndPassingDocs
              .map(
                (doc: any) =>
                  `【来源：${doc.metadata?.fileName || '知识库'}】\n${doc.content}`,
              )
              .join('\n---\n');

      const contextTokens = estimateTokens(context);
//       console.log(
//         `📚 [RAG] context 长度: ${contextTokens} tokens (limit: ${MAX_CONTEXT_TOKENS})，docs: ${relevantAndPassingDocs.length}/${relevantDocs.length}`,
//       );

      if (contextTokens > MAX_CONTEXT_TOKENS) {
        const sep = '\n---\n';
        while (
          estimateTokens(context) > MAX_CONTEXT_TOKENS &&
          context.length > 0
        ) {
          const lastSep = context.lastIndexOf(sep);
          context = lastSep > 0 ? context.slice(0, lastSep) : '';
        }
//         console.log(`📚 [RAG] 截断后: ${estimateTokens(context)} tokens`);
      }

      // ✅ 区分「根本没搜 / 搜了没结果 / 服务失败」：以前三者都回落成
      //    「本轮未执行联网搜索」，与事实不符，模型会被推着反复想调工具。
      const webSearchContext =
        liveInfoQuery && webSearchResults.length
          ? formatWebSearchContext(webSearchResults)
          : liveInfoQuery
            ? buildWebSearchFallbackContext(webSearchStatus, userQuery)
            : '';
      // ✅ 节日/农历日期不靠模型记忆：本轮直接算好，注入 system prompt。
      //    小模型经常「知道有工具但不调用」，给权威结果比提示它调工具更可靠。
      const festivalContext = buildFestivalContext(userQuery);
      // ✅ 本轮是否需要天气/计算/农历等专用工具（闲聊档判定仍用它）
      const needsToolsForLiveQuery =
        festivalContext !== '' ||
        /天气|气温|温度|下雨|降雨|风力|湿度|计算|等于|折扣|换算|日期差/.test(
          userQuery,
        );
      // ✅ 不再用 includeTools:false 关掉整个工具箱：
      //    预检索结果足够时只摘掉 web_search（天气/计算器/节日照常可用，也省一轮补搜往返），
      //    结果不足（含空/失败）时保留 web_search，让模型换词补搜。
      const webSearchScarce =
        liveInfoQuery && webSearchResults.length < MIN_WEB_RESULTS;
      const excludeWebSearch = liveInfoQuery && !webSearchScarce;
      // ✅ session 模式下每轮新建工具集，让 web_search 的结果回流到本轮来源池；
      //    开关关闭时复用共享实例。
      const baseTools = searchSession
        ? createChatTools(searchSession)
        : this.tools;
      const toolsForThisTurn = baseTools.filter((tool) => {
        const name = tool.definition.function.name;
        // 本轮已算好节日日期时摘掉 festival_info，模型没机会再查一次
        if (festivalContext && name === 'festival_info') return false;
        if (excludeWebSearch && name === 'web_search') return false;
        return true;
      });
      const historySourceIds = [
        ...new Set(
          historyForModel.flatMap((message: any) =>
            Array.isArray(message.sources)
              ? message.sources
                  .map((source: any) => source?.fileId)
                  .filter(
                    (fileId: unknown): fileId is string =>
                      typeof fileId === 'string',
                  )
              : [],
          ),
        ),
      ];
      const historySourceFiles = historySourceIds.length
        ? await this.prisma.knowledgeFile.findMany({
            where: { id: { in: historySourceIds } },
            select: { id: true, enabled: true },
          })
        : [];
      const historySourceEnabled = new Map(
        historySourceFiles.map((file) => [file.id, file.enabled]),
      );
      // ✅ 历史来源状态改为「系统提示里统一说明」：不再逐条拼进历史回答正文。
      //    原实现把 `【历史回答来源：…】` 追加到每条历史 assistant 消息后，
      //    模型会模仿这个格式，把它原样吐进本轮回答（线上已复现），污染聊天记录。
      const historySourceLabels = historyForSources
        .filter(
          (m: any) =>
            m.role === 'assistant' &&
            Array.isArray(m.sources) &&
            m.sources.length,
        )
        .flatMap((m: any) =>
          (m.sources as any[])
            // ✅ 联网来源没有 fileId，不能拿知识库文件的启用状态去标注它
            .filter((source: any) => typeof source?.fileId === 'string')
            .map((source: any) => {
              const enabled = historySourceEnabled.get(source?.fileId);
              const status =
                enabled === undefined
                  ? '文档已删除'
                  : enabled
                    ? '当前启用，但本轮未重新检索'
                    : '当前已停用';
              return `${source?.fileName || '知识库'}（${status}）`;
            }),
        );
      const historySourceSummary = historySourceLabels.length
        ? [...new Set(historySourceLabels)].join('、')
        : '此前对话未引用知识库资料。';
      const isApp = isAppPlatform(platform);
      // APP 端流式增量清洗器：只在 APP 端创建，其它端输出保持逐字不变
      const appReplyFormatter = isApp ? createAppReplyFormatter() : undefined;

      // ✅ 闲聊增强档：本轮没有资料/附件/联网结果/工具需求时，额外前置口语直给要求；
      //    工具 / 附件 / 引用规则两档共用同一份文本，Demo 的工具调用展示不受影响。
      const casualTurn =
        !liveInfoQuery &&
        !context &&
        !webSearchContext &&
        !festivalContext &&
        !needsToolsForLiveQuery &&
        (usedAttachments?.length ?? 0) === 0 &&
        // 历史里引用过知识库来源时不叠加闲聊语气，避免把严谨追问带成闲聊口吻
        historySourceLabels.length === 0 &&
        !hasImages;
      // ✅ 本轮是否基于给定资料作答：决定采样用「严谨档」还是「活泼档」
      const groundedTurn = !!context || (usedAttachments?.length ?? 0) > 0;
      // ✅ 纯倾诉轮次额外走「松弛」的情绪档：复用 casualTurn 的排除条件，
      //    资料/附件/联网/图片轮次一律不进这一档
      const emotionalTurn = casualTurn && isEmotionalTurn(userQuery);

      // ✅ 历史附件要点按裁剪前的完整历史算，附件原文到期后仍能承接追问
      const attachmentDigest = buildAttachmentDigest(
        historyForSources,
        ATTACHMENT_DIGEST_MAX_CHARS,
      );
      const promptNow = new Date();
      const promptParts = {
        context,
        historySourceSummary,
        webSearchContext,
        festivalContext,
        platform,
        promptProfile: casualTurn ? ('chat' as const) : ('full' as const),
        now: promptNow,
        attachmentDigest,
        userProfile: formatUserPreferences(effectivePreferences),
      };
      // 预算按不含摘要的基准 prompt 算，摘要开销单独预留（见 DIGEST_TOKEN_RESERVE）
      const baseSystemPrompt = buildSystemPrompt(promptParts);

      // ✅ 分配图片名额：当前轮优先，剩余名额从最新的历史消息往前补。
      const currentRefs = (hasImages ? images! : []).slice(0, MAX_MODEL_IMAGES);
      // ✅ 纯文本追问历史图（「刚才那张图里的字」）时也要走视觉档并还原历史图，
      //    否则会路由到只支持 text 的免费层 GLM，模型完全看不到图只能瞎答。
      const hasHistoryImages = historyForModel.some(
        (m: any) => Array.isArray(m.images) && m.images.length > 0,
      );
      let needsHistoryImages =
        !hasImages && hasHistoryImages && HISTORY_IMAGE_HINT.test(userQuery);
      const slotsForHistory =
        hasImages || needsHistoryImages
          ? Math.max(0, MAX_MODEL_IMAGES - currentRefs.length)
          : 0;
      const historyImageRefs: string[] = [];
      for (let i = historyForModel.length - 1; i >= 0; i--) {
        if (historyImageRefs.length >= slotsForHistory) break;
        const prev = historyForModel[i].images;
        if (!Array.isArray(prev)) continue;
        for (const ref of prev) {
          if (historyImageRefs.length >= slotsForHistory) break;
          if (typeof ref === 'string' && !currentRefs.includes(ref)) {
            historyImageRefs.push(ref);
          }
        }
      }
      // 历史图可能已被清理或来源变不可信，单张失败就跳过，不影响整轮
      const historyImageUrls = new Map<string, string>();
      await Promise.all(
        historyImageRefs.map(async (ref) => {
          try {
            historyImageUrls.set(ref, await this.imageService.toDataURL(ref));
          } catch {
            /* 跳过这张 */
          }
        }),
      );
      // 一张历史图都没取到时别白走视觉档
      if (needsHistoryImages && historyImageUrls.size === 0) {
        needsHistoryImages = false;
      }

      const imageParts = (urls: string[]) =>
        urls.map((dataUrl) => ({
          type: 'image_url',
          image_url: { url: dataUrl },
        }));

      // ✅ 附件正文并入「当前用户消息」（见下方 userMessage 说明），预算里也要按它算 token
      const userText = attachmentContext
        ? `${attachmentContext}\n\n${userQuery}`
        : userQuery;
      const MAX_INPUT_TOKENS = readMaxInputTokens();
      const systemTokens = estimateTokens(baseSystemPrompt);
      const queryTokens = estimateTokens(userText);
      const currentImageUrls = await Promise.all(
        currentRefs.map((ref) => this.imageService.toDataURL(ref)),
      );
      // ✅ 当前轮的图在这里扣；历史图的费用由下面的装配循环按条扣，避免重复计费
      const imageTokens = currentImageUrls.length * MODEL_IMAGE_TOKEN_COST;
      // 摘要要占 system prompt，固定预留一小段预算；本地生成，不额外请求模型
      let budget =
        MAX_INPUT_TOKENS -
        systemTokens -
        queryTokens -
        imageTokens -
        DIGEST_TOKEN_RESERVE;

      const formattedMessages = historyForModel.map((msg: any) => {
        const role = ['user', 'assistant', 'system', 'tool'].includes(msg.role)
          ? (msg.role as 'user' | 'assistant' | 'system' | 'tool')
          : 'user';
        // ✅ 历史里带图且抢到名额的消息，还原成多模态，让模型记得之前看过的图
        if (role === 'user' && Array.isArray(msg.images)) {
          const urls = (msg.images as string[])
            .filter((ref) => historyImageUrls.has(ref))
            .map((ref) => historyImageUrls.get(ref)!);
          if (urls.length) {
            return {
              role,
              content: [
                { type: 'text', text: msg.content },
                ...imageParts(urls),
              ],
            } as any;
          }
        }
        // ⚠️ 不要往历史消息正文里拼「历史回答来源」标注：模型会模仿该格式并原样输出，
        //    污染聊天记录（线上已复现）。来源状态改由 system prompt 统一说明。
        return {
          role,
          content: msg.content ?? '',
        } as any;
      });
      // 从最新一条往前装，装不下就停；被丢掉的部分压成「此前对话要点」
      const keptMessages: any[] = [];
      let firstKeptIndex = formattedMessages.length;
      for (let i = formattedMessages.length - 1; i >= 0; i--) {
        const msg = formattedMessages[i];
        const parts = Array.isArray(msg.content) ? msg.content : null;
        const imageCount = parts
          ? parts.filter((p: any) => p.type === 'image_url').length
          : 0;
        const text = parts
          ? parts
              .filter((p: any) => p.type === 'text')
              .map((p: any) => p.text)
              .join('')
          : String(msg.content ?? '');
        // ✅ 图片也要算钱，否则 estimateTokens 返回 0，预算永远扣不动
        const t = estimateTokens(text) + imageCount * MODEL_IMAGE_TOKEN_COST;
        if (budget - t < 0) break;
        budget -= t;
        keptMessages.unshift(msg);
        firstKeptIndex = i;
      }
      const budgetDropped = historyForModel.slice(0, firstKeptIndex);

      // ✅ 附件正文放进「当前用户消息」而不是系统提示：默认指令是「请概括上面的内容。」，
      //    只有把附件放在用户轮里，模型才会把它当作「上面的内容」来总结。放 system 里时，
      //    模型会去总结历史对话（实测：会话里有过旧附件讨论时，模型会复述旧附件、忽略本轮新附件）。
      //    userText 已在上面（预算计算处）定义。
      const userMessage: any = currentImageUrls.length
        ? {
            role: 'user',
            content: [
              { type: 'text', text: userText },
              ...imageParts(currentImageUrls),
            ],
          }
        : { role: 'user', content: userText };

      // ✅ 保证 keptMessages 末尾是当前用户问题（带图的多模态版本）
      //   历史查询与上面的写入是并发的，可能已经把这条读进来了 → 原地替换而不是追加，避免重复发两条
      const lastKept = keptMessages[keptMessages.length - 1];
      const isCurrentUserMsg =
        lastKept?.role === 'user' && lastKept.content === userQuery;
      if (isCurrentUserMsg) {
        keptMessages[keptMessages.length - 1] = userMessage;
      } else {
        keptMessages.push(userMessage);
      }

      if (aborted()) return;

      // ✅ 日志加在这里
//       console.log(
//         `🧮 [Token] system=${systemTokens}, query=${queryTokens}, 历史保留 ${keptMessages.length} 条, 剩余预算=${budget}`,
//       );

      // ✅ 被窗口/预算裁掉的旧消息压成本地摘要，注入 system prompt 承接上下文；
      //    不调模型、不加首字延迟；没有裁剪时模板与原来一字不差。
      const droppedForDigest = [
        ...trimmedForDigest,
        ...budgetDropped.map((m: any) => ({
          role: typeof m.role === 'string' ? m.role : 'user',
          content: typeof m.content === 'string' ? m.content : '',
        })),
      ];
      const conversationDigest = buildConversationDigest(
        droppedForDigest,
        DIGEST_MAX_CHARS,
      );
      const systemPrompt = buildSystemPrompt({
        ...promptParts,
        conversationDigest,
      });

      // ✅ 单轮流式 + 工具循环：全部交给共享编排器
      const messages: any[] = [
        { role: 'system', content: systemPrompt },
        ...keptMessages,
      ];

      // ✅ 选择本轮候选链：含图片（含纯文本追历史图）走视觉，否则按复杂度决定起点
      const complexity = classifyComplexity({
        userQuery,
        hasImages: hasImages || needsHistoryImages,
        liveInfo: liveInfoQuery,
        threshold: this.orchestrator.modelConfig.threshold,
        expertThreshold: this.orchestrator.modelConfig.expertThreshold,
      });
      const candidates = resolveModelCandidates(
        complexity,
        this.orchestrator.modelConfig,
        { zhipuAvailable: this.orchestrator.zhipuAvailable },
      );

      // ✅ 把路由决策推给前端思考流：用户能直接看到"为什么选了这个模型"。
      //    APP 端同样展示，面试 Demo 要完整呈现模型分层；工具调用 / 联网检索 /
      //    附件解析 / 降级提示也一律原样保留。
      if (this.orchestrator.showRoutingThought && candidates.length) {
        onChunk(
          'thought',
          formatRoutingThought(
            complexity,
            candidates,
            this.orchestrator.modelConfig,
          ),
        );
      }

      // 实时检索的提示已挪到实际搜索的并行阶段（见上方 searchWeb），
      // 这里不再补一条「调用 web_search」——那是后端预检索，不是模型的工具调用。

      // ✅ 免费层 GLM 对「上传的附件」有拒答反射（见 isAttachmentRefusal）：
      //    含附件时先把开头一小段内容"扣住"，命中拒答就换 qwen 重试本轮。
      const guardRefusal =
        (usedAttachments?.length ?? 0) > 0 &&
        !hasImages &&
        candidates[0]?.provider === 'zhipu';
      const gate: ContentGate | undefined = guardRefusal
        ? {
            enabled: true,
            threshold: 120,
            isRefusal: isAttachmentRefusal,
            nextCandidates: (current) => {
              const next = current.filter((c) => c.provider !== 'zhipu');
              return next.length ? next : null;
            },
          }
        : undefined;

      const shortTool = (s: string, n = 60) =>
        s.length > n ? `${s.slice(0, n).trimEnd()}…` : s;
      /** 工具入参可能很长（附件正文等），只给展示用的摘要 */
      const summarizeArgs = (args: unknown): string => {
        if (args == null) return '';
        try {
          const s = typeof args === 'string' ? args : JSON.stringify(args);
          return shortTool(s, 500);
        } catch {
          return '';
        }
      };
      const inferToolStatus = (result: string): string => {
        if (result.startsWith('用户拒绝执行')) return 'denied';
        if (result.startsWith('【重复调用】')) return 'cached';
        if (result.startsWith('工具参数错误')) return 'error';
        return 'success';
      };

      let fullReply = '';
      let usedTokens = 0;
      let truncated = false;
      let completionTokens = 0;
      let finishReason = '';
      /** 首个真正出字的时刻，用于算首字延迟 */
      let firstContentAt: number | undefined;
      /** tool_call.index → 收到调用的时间戳，用于估算工具展示耗时 */
      const toolCallStartedAt = new Map<number, number>();

      for await (const ev of this.orchestrator.run(
        {
          messages,
          tools: toolsForThisTurn,
          candidates,
          maxToolRounds: 4,
          // ✅ 工具定义常驻（orchestrator 默认 includeTools=true）：实时轮只从工具表里
          //    摘掉 web_search，天气/计算器等仍可用；结果不足时才保留补搜能力。
          // ✅ 按任务分档采样：只作用于免费层 GLM-4.5-Flash，代码 Agent 链路不传
          //    情绪档优先级最高，且只在 casualTurn 允许的纯闲聊轮次生效
          sampling: zhipuChatSamplingParam(
            emotionalTurn
              ? 'emotional'
              : liveInfoQuery
                ? 'live'
                : groundedTurn
                  ? 'knowledge'
                  : 'casual',
          ),
          signal,
        },
        gate,
      )) {
        if (aborted()) break;
        switch (ev.type) {
          case 'thought':
            onChunk('thought', ev.content ?? '');
            break;
          case 'content': {
            const raw = ev.content ?? '';
            if (!appReplyFormatter) {
              if (raw) firstContentAt ??= Date.now();
              onChunk('content', raw);
            } else {
              // 逐 chunk 压空行；跨 chunk 的连续换行由 formatter 内部合并
              const text = appReplyFormatter(raw);
              if (text) {
                firstContentAt ??= Date.now();
                onChunk('content', text);
              }
            }
            break;
          }
          case 'tool_call': {
            const index = ev.index ?? 0;
            toolCallStartedAt.set(index, Date.now());
            // ✅ 保留原有文本提示，老版 APP 展示不受影响
            onChunk('thought', `🔧 调用 ${ev.name}`);
            // ✅ 同时推结构化事件：工具名 + 入参摘要 + 序号
            onChunk('tool_call', {
              name: ev.name ?? '',
              args: summarizeArgs(ev.args),
              index,
            });
            break;
          }
          case 'tool_result': {
            const raw = ev.result ?? '';
            const index = ev.index ?? 0;
            const startedAt = toolCallStartedAt.get(index);
            toolCallStartedAt.delete(index);
            onChunk('thought', `↩️ ${ev.name}：${shortTool(raw)}`);
            // ✅ 结构化结果：预览 + 原长 + 耗时 + 状态，前端可渲染可展开卡片
            onChunk('tool_result', {
              name: ev.name ?? '',
              index,
              result: shortTool(raw, 200),
              resultLength: raw.length,
              durationMs: startedAt ? Date.now() - startedAt : null,
              status: inferToolStatus(raw),
            });
            break;
          }
          case 'error':
            onChunk('error', ev.content ?? '');
            break;
          case 'done':
            // APP 端落库/返回的全文也做一次完整清洗，与流式看到的保持一致
            fullReply = appReplyFormatter
              ? formatAppReply(ev.fullReply ?? '')
              : (ev.fullReply ?? '');
            usedModel = ev.model ?? '';
            usedTokens = ev.tokens ?? 0;
            truncated = ev.truncated === true;
            completionTokens = ev.completionTokens ?? 0;
            finishReason = ev.finishReason ?? '';
            break;
        }
      }

      // ✅ 流式清洗器收尾：丢掉尾部空白/结尾裸链接，但把以 Markdown 图片结尾的
      //    正常内容补回来（助手消息的图片只能存在 content 里，吞了历史就不回显了）。
      //    必须在 done 之前推：done 由 controller 在本方法返回后才发。
      const tail = appReplyFormatter?.flush();
      if (tail) {
        firstContentAt ??= Date.now();
        onChunk('content', tail);
      }

      // APP 端不推这条内部警告；工具调用相关的 thought 不受影响
      if (truncated && !isApp) {
        onChunk('thought', '⚠️ 回答达到长度上限，内容可能被截断。');
      }

      if (fullReply) {
        await this.prisma.message.create({
          data: {
            sessionId,
            role: 'assistant',
            content: fullReply,
            sources: replySources(),
          },
        });
        // ✅ 只有正文里真正出现的 [n] 才算被引用；知识库来源沿用「有资料即标注」的旧行为
        const citedNumbers = new Set<number>();
        for (const match of fullReply.matchAll(/\[(\d{1,2})\]/g)) {
          citedNumbers.add(Number(match[1]));
        }
        onChunk(
          'sources',
          replySources().map((source) => ({
            ...source,
            usedInThisReply:
              typeof source.index === 'number'
                ? citedNumbers.has(source.index)
                : true,
          })),
        );
        // ✅ 打点：区分预检索 / 模型补搜各贡献了多少来源，便于灰度观察与排障
        if (searchSession && searchSession.size > 0) {
          console.log(
            `[web-search][session] ${JSON.stringify({
              ...searchSession.stats(),
              total: searchSession.size,
            })}`,
          );
        }
      }

      await this.prisma.chatSession.update({
        where: { id: sessionId },
        data: { updatedAt: new Date() },
      });

      return {
        fullReply,
        sources: relevantAndPassingDocs,
        tokens: usedTokens,
        // done 事件的模型徽标在 APP 底部一行，完整 Model-Id 会被截成省略号
        model: displayModelName(usedModel),
        truncated,
        completionTokens,
        finishReason,
        // ✅ 首字延迟 / 总耗时 / 来源数：done 事件展示给面试官
        ttftMs: firstContentAt
          ? firstContentAt - overallStartTime
          : undefined,
        durationMs: Date.now() - overallStartTime,
        sourcesCount: replySources().length,
        // ✅ 记忆可观测：本轮实际带了多少历史、裁掉多少、有没有启用摘要
        historyKept: keptMessages.length,
        historyDropped: droppedForDigest.length,
        digestUsed: conversationDigest.length > 0,
      };
    } catch (error: any) {
      const totalDuration = Date.now() - overallStartTime;

      // ✅ 客户端主动断开不是错误：上游请求被 abort 会抛 APIUserAbortError，
      //    这里安静收尾即可，别给前端推 error 事件（连接已经没了，推了也没人收）
      if (
        aborted() ||
        error?.name === 'AbortError' ||
        error?.name === 'APIUserAbortError'
      ) {
//         console.log(
//           `⏹️ [性能监控] 客户端已断开，提前结束（累计 ${totalDuration}ms）`,
//         );
        return {
          fullReply: '',
          sources: [],
          tokens: 0,
          // done 事件的模型徽标在 APP 底部一行，完整 Model-Id 会被截成省略号
          model: displayModelName(usedModel),
          truncated: false,
          completionTokens: 0,
          finishReason: '',
          ttftMs: undefined,
          durationMs: totalDuration,
          sourcesCount: 0,
          historyKept: 0,
          historyDropped: 0,
          digestUsed: false,
        };
      }

      console.error('sendMessageStream 执行出错:', error);
//       console.log(`❌ [性能监控] 请求异常中断，累计耗时: ${totalDuration}ms`);

      // ✅ 离线回放兜底：模型/网络类故障才回放，参数校验这类客户端错误照常报错。
      //    user 消息在主链路开头已落库，这里不再重复写。
      const isClientError =
        error?.status === 400 || error?.getStatus?.() === 400;
      if (demoReplayMode() !== 'off' && !isClientError) {
        console.warn(
          `🎬 [demo-replay] 上游失败，切换离线回放: ${error?.message || ''}`,
        );
        try {
          return await this.playDemoReplay({
            sessionId,
            userQuery,
            persistContent,
            entry: findDemoReplay(userQuery) ?? DEMO_FALLBACK,
            onChunk,
            startTime: overallStartTime,
            persistUser: false,
            reason: '⚠️ 模型服务暂时不可用，已切换演示回放，下面的流程照常展示。',
          });
        } catch (replayError) {
          console.error('🎬 [demo-replay] 回放失败:', replayError);
        }
      }

      // ✅ 收敛成可展示文案：内部错误原文只进日志，不进聊天区
      const errorMsg = friendlyChatError(error?.message ?? '');
      try {
        onChunk('error', errorMsg);
      } catch {}

      throw error;
    }
  }
}
