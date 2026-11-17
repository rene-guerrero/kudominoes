/**
 * Automatic graphics quality.
 *
 * 1. Device tier (first launch, or whenever auto mode has no stored decision): cheap signals first —
 *    the WebGL renderer string, navigator.deviceMemory / hardwareConcurrency, physical screen pixels —
 *    and a ~150 ms CPU micro-benchmark only when those are inconclusive.
 * 2. Runtime adaptation (auto mode only): the renderer reports frame timing about once per second
 *    while it animates (TableViewOptions.onFrameStats); sustained slow frames step the level down one
 *    notch (high → medium → low). Never up within a session; the lowered level is stored, so the next
 *    launch starts there.
 */
import type { AppSettings, FrameStats, Quality } from '../contracts';

// ───────────────────────── device tier ─────────────────────────

export interface DeviceSignals {
  /** navigator.deviceMemory (GB, coarse; Chromium only) */
  memoryGb?: number;
  /** navigator.hardwareConcurrency */
  cores?: number;
  /** physical screen pixels (width × height × dpr²) */
  screenPx?: number;
  /** unmasked WebGL renderer string, when available */
  renderer?: string;
  /** WebGL only works with a major performance caveat (software rendering) */
  softwareGl?: boolean;
  /** no WebGL at all */
  noGl?: boolean;
  mobile?: boolean;
}

export interface TierDecision {
  level: Quality;
  /** false = the signals alone could not decide; `level` is a guess (run the benchmark) */
  conclusive: boolean;
  reason: string;
}

/** What the GPU name says about the device, or null when it says nothing useful. */
export function classifyGpu(renderer: string | undefined): Quality | null {
  if (!renderer) return null;
  const r = renderer.toLowerCase();
  // software rasterizers
  if (/swiftshader|llvmpipe|softpipe|software|basic render|lavapipe/.test(r)) return 'low';
  // Mali: Utgard (4xx), old Midgard (T6xx/T7xx/T8xx), entry Bifrost/Valhall (G31/G51/G52/G57 MC1-2)
  if (/mali-?4\d\d/.test(r) || /mali-?t[678]\d\d/.test(r) || /mali-?g(31|51)\b/.test(r)) return 'low';
  if (/mali-?g(52|57|68|610|615)\b/.test(r)) return 'medium';
  if (/mali-?g\d+/.test(r) || /immortalis/.test(r)) return 'high';
  // Adreno 3xx/4xx/5xx = low end (530/540 were 2016-17 flagships: medium); 6xx: 610-616 medium; 618+ high
  const adreno = r.match(/adreno[^\d]*(\d{3})/);
  if (adreno) {
    const n = Number(adreno[1]);
    if (n < 500) return 'low';
    if (n < 600) return n >= 530 ? 'medium' : 'low';
    if (n < 618) return 'medium';
    return 'high';
  }
  // PowerVR Rogue GE8xxx (GE8100/8300/8320/8322) and older SGX = low; other PowerVR = medium
  if (/powervr/.test(r)) return /ge8\d{3}|sgx|gx6\d{3}/.test(r) ? 'low' : 'medium';
  if (/apple (gpu|m\d)/.test(r)) return 'high';
  // desktop GPUs
  if (/nvidia|geforce|quadro|rtx|radeon|amd|arc\b|iris xe|apple m/.test(r)) return 'high';
  if (/intel/.test(r)) return /uhd|iris/.test(r) ? 'high' : 'medium';
  return null;
}

/** Decide from the cheap signals. `conclusive: false` means "run the benchmark". */
export function decideTier(s: DeviceSignals): TierDecision {
  const gpu = classifyGpu(s.renderer);
  const mem = s.memoryGb;
  const cores = s.cores;
  if (s.noGl) return { level: 'low', conclusive: true, reason: 'no WebGL' };
  if (s.softwareGl) return { level: 'low', conclusive: true, reason: 'software WebGL' };
  if (gpu === 'low') return { level: 'low', conclusive: true, reason: `low-end GPU (${s.renderer})` };
  if (mem !== undefined && mem <= 2) return { level: 'low', conclusive: true, reason: `${mem} GB memory` };
  if (s.mobile && cores !== undefined && cores <= 4) return { level: 'low', conclusive: true, reason: `${cores} cores (mobile)` };
  // a mid GPU pushing a very dense screen is a low-tier experience on a small-memory phone
  const dense = (s.screenPx ?? 0) > 3_000_000;
  if (gpu === 'medium') {
    if (mem !== undefined && mem <= 3) return { level: 'low', conclusive: true, reason: `mid GPU + ${mem} GB memory` };
    return { level: 'medium', conclusive: true, reason: `mid GPU (${s.renderer})` };
  }
  if (gpu === 'high') {
    if (s.mobile && mem !== undefined && mem <= 4) return { level: 'medium', conclusive: true, reason: `strong GPU, ${mem} GB memory (mobile)` };
    if (s.mobile && dense && (mem === undefined || mem < 8)) return { level: 'medium', conclusive: true, reason: 'strong GPU, dense screen (mobile)' };
    return { level: 'high', conclusive: true, reason: `strong GPU (${s.renderer})` };
  }
  // unknown GPU: a guess from memory / cores, to be confirmed by the benchmark
  const guess: Quality = s.mobile ? 'medium' : (mem ?? 8) >= 8 && (cores ?? 8) >= 8 ? 'high' : 'medium';
  return { level: guess, conclusive: false, reason: 'unknown GPU' };
}

/**
 * Score of the micro-benchmark relative to a reference desktop (≈1.0 on a recent desktop CPU; cheap
 * Cortex-A53 phones land around 0.08-0.15).
 */
export function tierFromBenchmark(score: number, guess: Quality): Quality {
  if (score < 0.2) return 'low';
  if (score < 0.5) return 'medium';
  return guess === 'high' ? 'high' : score >= 0.7 ? 'high' : 'medium';
}

/** iterations per ms of the benchmark kernel on the reference desktop (measured once, see microBenchmark) */
const BENCH_REF = 190;

/** ~`ms` of float math + small array work on the main thread; returns a score (≈1 = reference desktop). */
export function microBenchmark(ms = 150): number {
  const arr = new Float64Array(256);
  let acc = 0;
  let iters = 0;
  const t0 = performance.now();
  let now = t0;
  while (now - t0 < ms) {
    for (let k = 0; k < 20; k++) {
      // one "iteration": a little transform math and a small array pass, like a frame's bookkeeping
      for (let i = 0; i < 64; i++) {
        const x = Math.sin(i * 0.37 + acc) * Math.cos(i * 0.11);
        arr[(i * 7 + iters) & 255] = x * 1.0001 + arr[i] * 0.5;
        acc += x;
      }
      iters++;
    }
    now = performance.now();
  }
  if (!Number.isFinite(acc)) iters = 0; // keep `acc` alive
  return iters / (now - t0) / BENCH_REF;
}

/** Read the device signals (no side effects beyond a throwaway WebGL context). */
export function gatherSignals(): DeviceSignals {
  const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { mobile?: boolean } };
  const dpr = window.devicePixelRatio || 1;
  const s: DeviceSignals = {
    memoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : undefined,
    cores: typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency > 0 ? nav.hardwareConcurrency : undefined,
    screenPx: Math.round((screen.width || innerWidth) * (screen.height || innerHeight) * dpr * dpr),
    mobile: nav.userAgentData?.mobile ?? /Android|iPhone|iPad|Mobile/i.test(nav.userAgent),
  };
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    let gl = canvas.getContext('webgl', { failIfMajorPerformanceCaveat: true }) as WebGLRenderingContext | null;
    if (!gl) {
      gl = canvas.getContext('webgl') as WebGLRenderingContext | null;
      if (gl) s.softwareGl = true;
      else s.noGl = true;
    }
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      if (typeof r === 'string' && r && !/^webkit webgl$/i.test(r)) s.renderer = r;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    /* no WebGL info: other signals decide */
  }
  return s;
}

/** The full first-launch detection (signals, then the benchmark only if needed). */
export function detectQuality(): { level: Quality; reason: string } {
  const sig = gatherSignals();
  const d = decideTier(sig);
  if (d.conclusive) return { level: d.level, reason: d.reason };
  const score = microBenchmark(150);
  return { level: tierFromBenchmark(score, d.level), reason: `${d.reason}; benchmark ${score.toFixed(2)}` };
}

// ───────────────────────── settings glue ─────────────────────────

/**
 * Make `quality` consistent with the mode: in auto mode it is the stored auto decision (detected now
 * if there is none). Manual mode is left alone. Returns the same object when nothing changed.
 */
export function resolveQuality(s: AppSettings, detect: () => { level: Quality; reason: string } = detectQuality): AppSettings {
  if (s.qualityMode === 'manual') return s;
  let auto = s.autoQuality;
  if (!auto) {
    const d = detect();
    auto = d.level;
    if (import.meta.env?.DEV) console.info(`[kudominoes] auto quality: ${auto} (${d.reason})`);
  }
  if (s.qualityMode === 'auto' && s.autoQuality === auto && s.quality === auto) return s;
  return { ...s, qualityMode: 'auto', autoQuality: auto, quality: auto };
}

// ───────────────────────── runtime step-down ─────────────────────────

const LOWER: Record<Quality, Quality | null> = { high: 'medium', medium: 'low', low: null };

export interface GovernorOptions {
  /** a sample is "slow" above this average frame time (ms) */
  badMs: number;
  /** a sample is "fine" below this (between the two = no change: hysteresis) */
  goodMs: number;
  /** consecutive slow samples needed to step down */
  samples: number;
  /** samples with fewer frames than this are ignored (too short to judge) */
  minFrames: number;
  /** samples ignored right after a step-down (let the new level settle) */
  cooldown: number;
}

export const GOVERNOR_DEFAULTS: GovernorOptions = { badMs: 28, goodMs: 24, samples: 3, minFrames: 8, cooldown: 3 };

/**
 * Feed it the renderer's frame stats; it answers with a lower level when frames have been slow for a
 * sustained stretch, otherwise null. It never answers with a higher level.
 */
export class QualityGovernor {
  private bad = 0;
  private skip = 0;
  private o: GovernorOptions;

  constructor(opts: Partial<GovernorOptions> = {}) {
    this.o = { ...GOVERNOR_DEFAULTS, ...opts };
  }

  /** forget the streak (e.g. the level was changed by hand) */
  reset(): void {
    this.bad = 0;
    this.skip = 0;
  }

  feed(stats: FrameStats, current: Quality): Quality | null {
    const next = LOWER[current];
    if (!next) return null;
    // a sample taken under another level (before setQuality took effect) says nothing about this one
    if (stats.quality !== current) {
      this.bad = 0;
      return null;
    }
    if (this.skip > 0) {
      this.skip--;
      return null;
    }
    if (!(stats.frames >= this.o.minFrames) || !Number.isFinite(stats.avgFrameMs)) return null;
    if (stats.avgFrameMs > this.o.badMs) this.bad++;
    else if (stats.avgFrameMs < this.o.goodMs) this.bad = 0;
    if (this.bad < this.o.samples) return null;
    this.bad = 0;
    this.skip = this.o.cooldown;
    return next;
  }
}
