// packages/agent-orchestrator/src/simple-lock.ts
/**
 * 极简异步互斥锁（进程内）。
 *
 * 用途：第三方免费层通常只允许 1 个并发请求（智谱免费层就是），
 * 多个用户同时发消息会直接把并发打爆，触发 429 限流。
 * 用这个锁把该渠道的请求串起来，从源头避开限流。
 *
 * 用法：
 *   const release = await lock.acquire();          // 不超时，一直等
 *   const release = await lock.acquire(30_000);    // 最多等 30s
 *   try { ... } finally { release(); }             // 必须放，否则永远卡死
 */
export class SimpleLock {
  private queue: Array<() => void> = [];
  private locked = false;

  /**
   * @param timeoutMs 等待超时；<= 0 表示一直等
   */
  acquire(timeoutMs = 0): Promise<() => void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let released = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const release = () => {
        if (released) return; // 重复释放直接忽略，防 finally 里二次调用炸掉
        released = true;
        this.locked = false;
        const next = this.queue.shift();
        if (next) next();
      };

      const grant = () => {
        if (settled) return; // 已经超时，不能再放行
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(release);
      };

      if (!this.locked) {
        this.locked = true;
        grant();
        return;
      }

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const index = this.queue.indexOf(grant);
          if (index >= 0) this.queue.splice(index, 1);
          const error = new Error(`等待并发锁超时（${timeoutMs}ms）`);
          error.name = 'TimeoutError';
          (error as any).code = 'ETIMEDOUT';
          reject(error);
        }, timeoutMs);
        timer.unref?.();
      }

      this.queue.push(grant);
    });
  }
}
