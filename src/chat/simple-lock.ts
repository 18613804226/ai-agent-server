// src/chat/simple-lock.ts
/**
 * 极简异步互斥锁（进程内）。
 *
 * 用途：第三方免费层通常只允许 1 个并发请求（智谱免费层就是），
 * 多个用户同时发消息会直接把并发打爆，触发 429 限流。
 * 用这个锁把该渠道的请求串起来，从源头避开限流。
 *
 * 用法：
 *   const release = await lock.acquire();
 *   try { ... } finally { release(); }   // 必须放，否则永远卡死
 */
export class SimpleLock {
  private queue: (() => void)[] = [];
  private locked = false;

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (this.locked) {
          this.queue.push(tryAcquire);
          return;
        }
        this.locked = true;
        let released = false;
        resolve(() => {
          if (released) return; // 重复释放直接忽略，防 finally 里二次调用炸掉
          released = true;
          this.locked = false;
          const next = this.queue.shift();
          if (next) next();
        });
      };
      tryAcquire();
    });
  }
}
