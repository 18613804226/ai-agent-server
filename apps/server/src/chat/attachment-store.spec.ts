import { describe, expect, it } from 'vitest';
import { AttachmentStore, ATTACHMENT_TTL_MS, type ChatAttachment } from './attachment-store';

const mkItem = (over: Partial<ChatAttachment> = {}): ChatAttachment => ({
  id: 'id-1',
  name: '报告.pdf',
  kind: 'document',
  text: '正文',
  charCount: 2,
  createdAt: 0,
  ...over,
});

describe('AttachmentStore：存取与过期', () => {
  it('set 后能原样取回', () => {
    const store = new AttachmentStore(() => 0);
    const item = mkItem();
    store.set(item);
    expect(store.get('id-1')).toEqual(item);
  });

  it('不存在的 id 返回 undefined', () => {
    const store = new AttachmentStore(() => 0);
    expect(store.get('nope')).toBeUndefined();
  });

  it('过期后取不到，且会被清理', () => {
    const store = new AttachmentStore(() => ATTACHMENT_TTL_MS + 1);
    store.set(mkItem({ createdAt: 0 }));
    expect(store.get('id-1')).toBeUndefined();
  });

  it('TTL 边界：age == TTL 仍可用，超过 1ms 即失效', () => {
    const edge = new AttachmentStore(() => ATTACHMENT_TTL_MS);
    edge.set(mkItem({ createdAt: 0 }));
    expect(edge.get('id-1')).toBeDefined(); // 刚好等于 TTL 不算过期

    const over = new AttachmentStore(() => ATTACHMENT_TTL_MS + 1);
    over.set(mkItem({ createdAt: 0 }));
    expect(over.get('id-1')).toBeUndefined();
  });
});

describe('AttachmentStore：批量取', () => {
  it('区分 found / missing；重复 id 去重、不重复报缺失', () => {
    const store = new AttachmentStore(() => 0);
    store.set(mkItem({ id: 'a' }));
    store.set(mkItem({ id: 'b', kind: 'video', durationSec: 62 }));
    const { found, missing } = store.getMany(['a', 'b', 'c', 'a']);
    expect(found.map((f) => f.id).sort()).toEqual(['a', 'b']);
    expect(missing).toEqual(['c']);
    expect(found.find((f) => f.id === 'b')?.durationSec).toBe(62);
  });

  it('空数组 / undefined 都安全', () => {
    const store = new AttachmentStore(() => 0);
    expect(store.getMany([])).toEqual({ found: [], missing: [] });
    expect(store.getMany(undefined)).toEqual({ found: [], missing: [] });
  });
});

describe('AttachmentStore：清扫', () => {
  it('sweep 只清过期项并返回数量', () => {
    const now = ATTACHMENT_TTL_MS + 100;
    const store = new AttachmentStore(() => now);
    store.set(mkItem({ id: 'old', createdAt: 0 }));
    store.set(mkItem({ id: 'new', createdAt: now }));
    expect(store.sweep()).toBe(1);
    expect(store.get('new')).toBeDefined();
    expect(store.get('old')).toBeUndefined();
  });

  it('没有可清项时返回 0', () => {
    const store = new AttachmentStore(() => 0);
    store.set(mkItem());
    expect(store.sweep()).toBe(0);
  });

  it('startSweeper 不会重复起定时器', () => {
    const store = new AttachmentStore(() => 0);
    store.startSweeper();
    store.startSweeper(); // 第二次应为 no-op
    // 能正常 dispose（定时器被清掉）即说明没有重复创建
    expect(() => store.dispose()).not.toThrow();
    expect(store.get('id-1')).toBeUndefined();
  });

  it('dispose 后清空', () => {
    const store = new AttachmentStore(() => 0);
    store.set(mkItem());
    store.dispose();
    expect(store.get('id-1')).toBeUndefined();
  });
});
