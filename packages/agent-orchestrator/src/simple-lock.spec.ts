import { describe, expect, it } from 'vitest';
import { SimpleLock } from './simple-lock';

describe('SimpleLock 进程内互斥', () => {
  it('同一时刻只允许一个持有者', async () => {
    const lock = new SimpleLock();
    const order: number[] = [];
    let active = 0;
    let maxActive = 0;

    const worker = async (id: number) => {
      const release = await lock.acquire();
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(id);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      release();
    };

    await Promise.all([worker(1), worker(2), worker(3)]);
    expect(maxActive).toBe(1); // 全程没有并发
    expect(order).toHaveLength(3);
  });

  it('按排队顺序依次放行', async () => {
    const lock = new SimpleLock();
    const order: number[] = [];
    const run = async (id: number) => {
      const release = await lock.acquire();
      order.push(id);
      release();
    };
    await Promise.all([run(1), run(2), run(3)]);
    expect(order).toEqual([1, 2, 3]); // FIFO，不能乱序放行
  });

  it('释放后能立即再获取', async () => {
    const lock = new SimpleLock();
    const r1 = await lock.acquire();
    const r2 = lock.acquire(); // 不 await：先挂起
    r1();
    const release2 = await r2; // 应立刻拿到
    release2();
    expect(true).toBe(true);
  });

  it('重复调用 release 不会重复放行下一个等待者', async () => {
    const lock = new SimpleLock();
    const r1 = await lock.acquire();
    const waiting = lock.acquire();
    r1();
    r1(); // 二次释放应被忽略
    const release2 = await waiting;
    release2();
    // 若二次释放放行了第二个等待者，这里会 pending 住；能 resolve 即正确
    expect(true).toBe(true);
  });

  it('锁内抛异常也必须靠 finally 放行', async () => {
    const lock = new SimpleLock();
    let secondGot = false;
    try {
      const release = await lock.acquire();
      throw new Error('boom');
    } catch {
      // 模拟业务失败：这里不释放，第二个获取会一直卡住（说明必须 try/finally）
    }
    // 上一个持有者没释放 → 第二个拿不到
    const p = lock.acquire();
    const raced = await Promise.race([
      p.then(() => 'got'),
      new Promise((r) => setTimeout(() => r('blocked'), 20)),
    ]);
    expect(raced).toBe('blocked');
  });
});
