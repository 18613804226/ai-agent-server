/**
 * 超时与空闲检测工具。
 *
 * 编排器里所有“可能永远不返回”的边界都走这里：
 * - 模型建连（provider 卡住）
 * - 流式 chunk 之间的空闲（建连成功但不再吐字）
 * - 工具 handler（工具内部卡死）
 *
 * 超时错误统一用 TimeoutError + code=ETIMEDOUT，便于上层判定是否降级。
 */
export class TimeoutError extends Error {
  readonly code = 'ETIMEDOUT';

  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const err = new Error('请求已取消');
  err.name = 'AbortError';
  return err;
}

/** 给 Promise 加超时/中断；timeoutMs <= 0 表示不超时 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  message: string,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function cleanup() {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    function finish(fn: () => void) {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    }

    function onAbort() {
      finish(() => reject(abortError(signal)));
    }

    timer = setTimeout(
      () => finish(() => reject(new TimeoutError(message))),
      timeoutMs,
    );
    timer.unref?.();

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

/**
 * 给异步流加“空闲超时”：两个 chunk 之间超过 timeoutMs 没有数据就中止。
 * 注意不是总时长超时——长回答只要持续吐字就不会被判超时。
 */
export async function* withIdleTimeout<T>(
  iterable: AsyncIterable<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onTimeout?: () => void,
): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  let done = false;

  try {
    while (!done) {
      if (signal?.aborted) return;

      let next: IteratorResult<T>;
      try {
        next = await withTimeout(
          iterator.next(),
          timeoutMs,
          signal,
          `模型流空闲超时（${timeoutMs}ms 未收到数据）`,
        );
      } catch (error) {
        onTimeout?.();
        // 客户端主动取消不算超时：安静结束，保持原有“中断不报错”的语义
        if (signal?.aborted) return;
        throw error;
      }

      if (next.done) {
        done = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!done) {
      // 不 await：底层流可能不响应 return，abort 已由 onTimeout 触发
      void iterator.return?.().catch(() => {});
    }
  }
}
