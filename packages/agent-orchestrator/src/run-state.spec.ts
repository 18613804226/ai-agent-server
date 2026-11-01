import { describe, expect, it } from 'vitest';
import { nextRunState } from './run-state.js';

describe('nextRunState', () => {
  it('idle → running', () => {
    expect(nextRunState('idle', 'start')).toBe('running');
  });

  it('running → paused → running', () => {
    expect(nextRunState('running', 'pause')).toBe('paused');
    expect(nextRunState('paused', 'resume')).toBe('running');
  });

  it('running → done / failed / cancelled', () => {
    expect(nextRunState('running', 'finish')).toBe('done');
    expect(nextRunState('running', 'fail')).toBe('failed');
    expect(nextRunState('running', 'cancel')).toBe('cancelled');
    expect(nextRunState('running', 'abort')).toBe('cancelled');
  });

  it('非法转移保持原状态', () => {
    expect(nextRunState('idle', 'pause')).toBe('idle');
    expect(nextRunState('done', 'finish')).toBe('done');
    expect(nextRunState('paused', 'finish')).toBe('paused');
  });
});
