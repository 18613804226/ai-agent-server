import { randomUUID } from 'node:crypto';

export interface Artifact {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * 本轮 artifact 存储：大结果存句柄，模型用 read_artifact 取全文。
 * 避免把大文件全文塞进上下文，同时保留按需读取的能力。
 */
export class ArtifactStore {
  private readonly items = new Map<string, Artifact>();

  create(content: string, metadata?: Record<string, unknown>): string {
    const id = randomUUID();
    this.items.set(id, { id, content, metadata });
    return id;
  }

  get(id: string): string | undefined {
    return this.items.get(id)?.content;
  }

  peek(id: string): Artifact | undefined {
    return this.items.get(id);
  }

  has(id: string): boolean {
    return this.items.has(id);
  }
}
