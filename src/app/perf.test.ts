import { describe, expect, it } from 'vitest';
import type { AppSettings, FrameStats, Quality } from '../contracts';
import { classifyGpu, decideTier, QualityGovernor, resolveQuality, tierFromBenchmark } from './perf';

describe('classifyGpu', () => {
  it('flags low-end and software renderers', () => {
    for (const r of ['Mali-400 MP', 'Mali-T720', 'Mali-T830 MP2', 'Mali-G31 MC2', 'Adreno (TM) 306', 'Adreno (TM) 405', 'Adreno (TM) 506', 'PowerVR Rogue GE8320', 'Google SwiftShader', 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', 'llvmpipe (LLVM 15.0.7, 256 bits)'])
      expect(classifyGpu(r), r).toBe('low');
  });
  it('rates mid and strong GPUs', () => {
    expect(classifyGpu('Adreno (TM) 540')).toBe('medium');
    expect(classifyGpu('Adreno (TM) 610')).toBe('medium');
    expect(classifyGpu('Mali-G57 MC2')).toBe('medium');
    expect(classifyGpu('Adreno (TM) 660')).toBe('high');
    expect(classifyGpu('Mali-G78 MP14')).toBe('high');
    expect(classifyGpu('Apple GPU')).toBe('high');
    expect(classifyGpu('ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('high');
  });
  it('says nothing about unknown or missing strings', () => {
    expect(classifyGpu(undefined)).toBeNull();
    expect(classifyGpu('Some Future GPU')).toBeNull();
  });
});

describe('decideTier', () => {
  it('a cheap phone is low from any one strong signal', () => {
    expect(decideTier({ renderer: 'Mali-T720', memoryGb: 4, cores: 8, mobile: true })).toMatchObject({ level: 'low', conclusive: true });
    expect(decideTier({ memoryGb: 2, cores: 8, mobile: true })).toMatchObject({ level: 'low', conclusive: true });
    expect(decideTier({ memoryGb: 4, cores: 4, mobile: true })).toMatchObject({ level: 'low', conclusive: true });
    expect(decideTier({ softwareGl: true, memoryGb: 8, cores: 8 })).toMatchObject({ level: 'low', conclusive: true });
    expect(decideTier({ noGl: true })).toMatchObject({ level: 'low', conclusive: true });
  });
  it('mid GPU = medium, but low with little memory', () => {
    expect(decideTier({ renderer: 'Adreno (TM) 610', memoryGb: 4, cores: 8, mobile: true }).level).toBe('medium');
    expect(decideTier({ renderer: 'Mali-G52 MC2', memoryGb: 3, cores: 8, mobile: true }).level).toBe('low');
  });
  it('strong GPU = high on desktop, medium on a small-memory phone', () => {
    expect(decideTier({ renderer: 'ANGLE (NVIDIA GeForce RTX 3060)', memoryGb: 8, cores: 12, mobile: false }).level).toBe('high');
    expect(decideTier({ renderer: 'Adreno (TM) 650', memoryGb: 4, cores: 8, mobile: true }).level).toBe('medium');
    expect(decideTier({ renderer: 'Adreno (TM) 650', memoryGb: 8, cores: 8, mobile: true }).level).toBe('high');
  });
  it('unknown GPU is inconclusive (benchmark decides)', () => {
    const d = decideTier({ memoryGb: 4, cores: 8, mobile: true });
    expect(d.conclusive).toBe(false);
    expect(tierFromBenchmark(0.1, d.level)).toBe('low');
    expect(tierFromBenchmark(0.35, d.level)).toBe('medium');
    expect(tierFromBenchmark(0.9, 'medium')).toBe('high');
    expect(tierFromBenchmark(0.6, 'high')).toBe('high');
  });
});

const st = (avgFrameMs: number, quality: Quality, frames = 30): FrameStats => ({ avgFrameMs, frames, quality });

describe('QualityGovernor', () => {
  it('steps down one level after 3 consecutive slow samples', () => {
    const g = new QualityGovernor();
    expect(g.feed(st(40, 'high'), 'high')).toBeNull();
    expect(g.feed(st(40, 'high'), 'high')).toBeNull();
    expect(g.feed(st(40, 'high'), 'high')).toBe('medium');
  });
  it('a fine sample resets the streak; the hysteresis band keeps it', () => {
    const g = new QualityGovernor();
    g.feed(st(40, 'medium'), 'medium');
    g.feed(st(40, 'medium'), 'medium');
    g.feed(st(16, 'medium'), 'medium'); // fine: reset
    g.feed(st(40, 'medium'), 'medium');
    g.feed(st(26, 'medium'), 'medium'); // between 24 and 28: neither
    expect(g.feed(st(40, 'medium'), 'medium')).toBeNull();
    expect(g.feed(st(40, 'medium'), 'medium')).toBe('low');
  });
  it('ignores short samples, stale-level samples, and never goes below low or up', () => {
    const g = new QualityGovernor();
    for (let i = 0; i < 5; i++) expect(g.feed(st(80, 'high', 3), 'high')).toBeNull();
    for (let i = 0; i < 5; i++) expect(g.feed(st(80, 'high'), 'medium')).toBeNull();
    for (let i = 0; i < 10; i++) expect(g.feed(st(80, 'low'), 'low')).toBeNull();
    for (let i = 0; i < 10; i++) expect(g.feed(st(5, 'medium'), 'medium')).toBeNull();
  });
  it('waits a few samples after a step before judging the new level', () => {
    const g = new QualityGovernor();
    for (let i = 0; i < 3; i++) g.feed(st(50, 'high'), 'high');
    const out: (Quality | null)[] = [];
    for (let i = 0; i < 6; i++) out.push(g.feed(st(50, 'medium'), 'medium'));
    expect(out).toEqual([null, null, null, null, null, 'low']);
  });
});

describe('resolveQuality', () => {
  const base = { language: 'es', quality: 'high', sound: true, music: false, vibration: true, animationSpeed: 'normal', playerName: '', rules: {} } as AppSettings;
  const detect = () => ({ level: 'low' as Quality, reason: 'test' });
  it('auto (or missing mode) without a decision detects and stores it', () => {
    const s = resolveQuality({ ...base }, detect);
    expect(s).toMatchObject({ qualityMode: 'auto', autoQuality: 'low', quality: 'low' });
  });
  it('auto with a stored decision uses it without detecting', () => {
    const s = resolveQuality({ ...base, qualityMode: 'auto', autoQuality: 'medium' }, () => {
      throw new Error('should not detect');
    });
    expect(s.quality).toBe('medium');
  });
  it('manual is left alone', () => {
    const m = { ...base, qualityMode: 'manual' as const, quality: 'high' as Quality, autoQuality: 'low' as Quality };
    expect(resolveQuality(m, detect)).toBe(m);
  });
});
