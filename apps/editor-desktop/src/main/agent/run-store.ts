import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { RunCheckpoint, RunState } from '@repo/agent-orchestrator';

export type { RunCheckpoint, RunState };

/**
 * 断点续跑的状态机：
 *   idle → running → paused → running → done
 *                     ↘ cancelled
 *   running → done / failed / cancelled
 *
 * 检查点持久化到 userData/agent-run.json，重启后可继续。
 */
export class RunStore {
  private readonly filePath = join(app.getPath('userData'), 'agent-run.json');
  private checkpoint: RunCheckpoint | null = null;

  constructor() {
    this.checkpoint = this.load();
  }

  get(): RunCheckpoint | null {
    return this.checkpoint;
  }

  set(next: RunCheckpoint): void {
    this.checkpoint = next;
    this.save();
  }

  clear(): void {
    this.checkpoint = null;
    this.save();
  }

  private load(): RunCheckpoint | null {
    if (!existsSync(this.filePath)) return null;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!raw || typeof raw !== 'object' || !raw.id) return null;
      return raw as RunCheckpoint;
    } catch {
      return null;
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.checkpoint, null, 2), 'utf8');
  }
}
