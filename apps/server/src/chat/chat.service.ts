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
  isLiveInfoQuery,
  searchTavily,
} from '@repo/general-agent';
import {
  ATTACHMENT_TTL_MS,
  type AttachmentKind,
} from './attachment-store.js';
import {
  buildSystemPrompt,
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

// ✅ 一次最多 2 张图进模型上下文（当前轮优先，剩余名额从最新历史消息补）
const MAX_MODEL_IMAGES = 2;
// ✅ 单图预算（压缩后长边上限 1280 时实测 1095 token），取整留余量做保守估算
const MODEL_IMAGE_TOKEN_COST = 1200;

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
    if (this.orchestrator.zhipuAvailable) {
      const cfg = this.orchestrator.modelConfig;
      console.log(
        `🧠 [模型分层] GLM 免费层已启用，首选 ${cfg.textSimple} / ${cfg.visionPrimary}；` +
          `复杂 ${cfg.textComplex} → ${cfg.textComplexFallback}；` +
          `专家 ${cfg.textExpert}；兜底 ${cfg.fallback}`,
      );
    } else {
      console.log(
        '🧠 [模型分层] 未配置 GLM_API_KEY，全部请求走 qwen（未开启级联）',
      );
    }
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
    };
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

      const parallelStartTime = Date.now();
      const [
        createdUserMessage,
        relevantDocs,
        historyMessages,
        webSearchResults,
      ] = await Promise.all([
          this.prisma.message.create({
            data: {
              sessionId,
              role: 'user',
              // ✅ 落库用用户原文：只传文件时控制器补的默认指令不能进聊天记录
              content: persistContent ?? userQuery,
              // ✅ 图片 URL 一起落库，历史会话才能还原出图
              images: hasImages ? images : undefined,
              // ✅ 附件只落元数据（名称/类型/字数），原文仍在临时存储里、到期即弃
              attachments: attachmentMeta.length ? attachmentMeta : undefined,
            },
          }),
          isCasualChat || liveInfoQuery
            ? Promise.resolve([] as any[])
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
            ? searchTavily(userQuery, signal).then((r) => {
                onChunk('thought', `🔎 已联网检索：${r.length} 条结果。`);
                return r;
              })
            : Promise.resolve([]),
        ]);
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

      // ✅ 后端预检索为空时不再硬拒答：本轮照常走模型，并打开工具让它自己再搜一次或如实说明。
      //    硬拒答会把「好吧」这类误判和真实的搜索失败一起挡在门外，体验比让模型收尾更差。
      const liveSearchEmpty = liveInfoQuery && webSearchResults.length === 0;

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

      // ✅ 实时查询本轮已有联网结果，只带最近 3 轮对话：既保留「汇率越来越低啊」
      //    这种追问上下文，又避免长历史把首字延迟拉长（之前是整段历史全塞进去）。
      if (liveInfoQuery && historyForModel.length > 6) {
        historyForModel.splice(0, historyForModel.length - 6);
      }

      const MAX_CONTEXT_TOKENS = 800;
      const SIMILARITY_THRESHOLD = 0.45;

      const relevantAndPassingDocs = (relevantDocs as any[]).filter(
        (doc: any) => doc.similarity >= SIMILARITY_THRESHOLD,
      );
      const replySources = [
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

      const webSearchContext = liveInfoQuery
        ? formatWebSearchContext(webSearchResults)
        : '';
      // ✅ 节日/农历日期不靠模型记忆：本轮直接算好，注入 system prompt。
      //    小模型经常「知道有工具但不调用」，给权威结果比提示它调工具更可靠。
      const festivalContext = buildFestivalContext(userQuery);
      // ✅ 实时查询默认不发工具定义：少一轮工具往返、prompt 也更短，首字更快。
      //    只有本轮确实需要天气/计算/农历日期时才开启工具。
      const needsToolsForLiveQuery =
        festivalContext !== '' ||
        /天气|气温|温度|下雨|降雨|风力|湿度|计算|等于|折扣|换算|日期差/.test(
          userQuery,
        );
      // ✅ 本轮已经算好节日日期时，直接把 festival_info 从工具表里拿掉：
      //    模型即使想“再查一次”也没有机会，少一整轮模型往返。
      const toolsForThisTurn = festivalContext
        ? this.tools.filter(
            (tool) => tool.definition.function.name !== 'festival_info',
          )
        : this.tools;
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
      const historySourceLabels = historyForModel
        .filter(
          (m: any) =>
            m.role === 'assistant' &&
            Array.isArray(m.sources) &&
            m.sources.length,
        )
        .flatMap((m: any) =>
          (m.sources as any[]).map((source: any) => {
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

      const systemPrompt = buildSystemPrompt({
        context,
        historySourceSummary,
        webSearchContext,
        festivalContext,
        platform,
        promptProfile: casualTurn ? 'chat' : 'full',
      });

      // ✅ 分配图片名额：当前轮优先，剩余名额从最新的历史消息往前补。
      //   这样「刚才那张红图再帮我看看」能接上，又不会让 token 随对话轮数无限膨胀。
      const currentRefs = (hasImages ? images! : []).slice(0, MAX_MODEL_IMAGES);
      // ✅ 只有本轮也带图（走视觉模型 qwen）时才还原历史图；
      //    纯文本请求会路由到免费层 GLM（仅支持 text），带上 image_url 会 400。
      const slotsForHistory = hasImages
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

      const imageParts = (urls: string[]) =>
        urls.map((dataUrl) => ({
          type: 'image_url',
          image_url: { url: dataUrl },
        }));

      // ✅ 附件正文并入「当前用户消息」（见下方 userMessage 说明），预算里也要按它算 token
      const userText = attachmentContext
        ? `${attachmentContext}\n\n${userQuery}`
        : userQuery;
      const MAX_INPUT_TOKENS = 6000;
      const systemTokens = estimateTokens(systemPrompt);
      const queryTokens = estimateTokens(userText);
      const currentImageUrls = await Promise.all(
        currentRefs.map((ref) => this.imageService.toDataURL(ref)),
      );
      // ✅ 当前轮的图在这里扣；历史图的费用由下面的装配循环按条扣，避免重复计费
      const imageTokens = currentImageUrls.length * MODEL_IMAGE_TOKEN_COST;
      let budget = MAX_INPUT_TOKENS - systemTokens - queryTokens - imageTokens;

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
      // 从最新一条往前装，装不下就停（旧消息直接丢）
      const keptMessages: any[] = [];
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
      }

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

      // ✅ 单轮流式 + 工具循环：全部交给共享编排器
      const messages: any[] = [
        { role: 'system', content: systemPrompt },
        ...keptMessages,
      ];

      // ✅ 选择本轮候选链：含图片走视觉，否则按规则判复杂度决定免费/付费起点
      const complexity = classifyComplexity({
        userQuery,
        hasImages,
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

      // 实时检索的提示已挪到实际搜索的并行阶段（见上方 searchTavily），
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
          // ✅ 实时搜索由后端做；实时查询默认不带工具，避免多一轮工具往返拖慢首字。
          //    天气/计算/节日等确实需要工具的场景仍会开启（见 needsToolsForLiveQuery）；
          //    后端预检索为空时也开启，让模型自己再搜一次或如实说明（见 liveSearchEmpty）。
          includeTools:
            !liveInfoQuery || needsToolsForLiveQuery || liveSearchEmpty,
          // ✅ 按任务分档采样：只作用于免费层 GLM-4.5-Flash，代码 Agent 链路不传
          sampling: zhipuChatSamplingParam(
            liveInfoQuery ? 'live' : groundedTurn ? 'knowledge' : 'casual',
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
            sources: replySources,
          },
        });
        onChunk(
          'sources',
          replySources.map((source) => ({
            ...source,
            usedInThisReply: true,
          })),
        );
      }

      await this.prisma.chatSession.update({
        where: { id: sessionId },
        data: { updatedAt: new Date() },
      });

      return {
        fullReply,
        sources: relevantAndPassingDocs,
        tokens: usedTokens,
        model: usedModel,
        truncated,
        completionTokens,
        finishReason,
        // ✅ 首字延迟 / 总耗时 / 来源数：done 事件展示给面试官
        ttftMs: firstContentAt
          ? firstContentAt - overallStartTime
          : undefined,
        durationMs: Date.now() - overallStartTime,
        sourcesCount: replySources.length,
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
          model: usedModel,
          truncated: false,
          completionTokens: 0,
          finishReason: '',
          ttftMs: undefined,
          durationMs: totalDuration,
          sourcesCount: 0,
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
