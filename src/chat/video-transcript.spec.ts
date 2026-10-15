import { describe, expect, it } from 'vitest';
import { VideoNoAudioError, VideoTooLongError } from './video-transcript';

describe('video-transcript：错误类型', () => {
  it('超时长错误带上实际时长与上限，便于前端提示', () => {
    const e = new VideoTooLongError(732.4, 600);
    expect(e.message).toContain('732');
    expect(e.message).toContain('600');
    expect(e.durationSec).toBe(732.4);
    expect(e.maxSec).toBe(600);
    expect(e).toBeInstanceOf(Error);
  });

  it('无音轨错误说明 v1 的能力边界', () => {
    const e = new VideoNoAudioError();
    expect(e.message).toContain('没有音轨');
    expect(e).toBeInstanceOf(Error);
  });
});
