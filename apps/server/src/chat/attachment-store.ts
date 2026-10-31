// src/chat/attachment-store.ts
/**
 * 聊天附件的临时存储（进程内）。
 *
 * 关键约束：**只存内存、绝不写向量库**。附件解析结果仅供当轮对话使用，
 * 到期即弃，避免把用户临时发的文档污染成永久知识库数据。
 */

export type AttachmentKind = 'document' | 'video';

export interface ChatAttachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  /** 解析出的文本（文档正文 / 视频音轨转写） */
  text: string;
  charCount: number;
  /** 视频时长（秒），文档为 undefined */
  durationSec?: number;
  /**
   * 落盘后的文件名（files/chat-attachments/ 下，`<uuid>.<ext>`）。
   * 带有它说明原始文件可回看/可重新解析；内存条目过期后靠它从磁盘复活。
   */
  fileRef?: string;
  createdAt: number;
}

/** 附件存活时长（毫秒）：够用户围绕同一份文件追问几轮，又不长期占内存 */
export const ATTACHMENT_TTL_MS = 30 * 60 * 1000;

/** 兜底清扫间隔：即使没有新上传也能把过期条目收掉 */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export class AttachmentStore {
  private readonly map = new Map<string, ChatAttachment>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  startSweeper(): void {
    if (this.sweepTimer) return;
    // unref：别让定时器拖着进程不退出
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  set(attachment: ChatAttachment): void {
    this.map.set(attachment.id, attachment);
  }

  get(id: string): ChatAttachment | undefined {
    const item = this.map.get(id);
    if (!item) return undefined;
    if (this.isExpired(item)) {
      this.map.delete(id);
      return undefined;
    }
    return item;
  }

  isExpired(item: ChatAttachment): boolean {
    return this.now() - item.createdAt > ATTACHMENT_TTL_MS;
  }

  /** 取多个；无效/过期的 id 原样返回，让调用方能提示用户重新上传。
   *  自动去重：同一附件只注入一次，避免重复占用 token 预算。 */
  getMany(ids?: string[]): {
    found: ChatAttachment[];
    missing: string[];
  } {
    const found: ChatAttachment[] = [];
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const id of ids ?? []) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const item = this.get(id);
      if (item) found.push(item);
      else missing.push(id);
    }
    return { found, missing };
  }

  sweep(): number {
    let removed = 0;
    for (const [id, item] of this.map) {
      if (this.isExpired(item)) {
        this.map.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** 仅测试用：清空并停掉定时器 */
  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.map.clear();
  }
}
