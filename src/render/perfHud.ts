/**
 * Dev-only perf readout (`?perf=1`, only referenced behind `import.meta.env.DEV`, so it never reaches
 * the production bundle). Shows, once per second: average frame interval and CPU work per rendered
 * frame, draw calls, triangles and a rough GPU texture + framebuffer memory estimate. The latest
 * sample is also kept on `window.__perf` (and the history in `window.__perfLog`) for scripted runs.
 */
import * as THREE from 'three';

export interface PerfSample {
  quality: string;
  fps: number;
  avgFrameMs: number;
  avgWorkMs: number;
  maxWorkMs: number;
  calls: number;
  tris: number;
  texMB: number;
  fbMB: number;
  pr: number;
  buf: string;
}

export class PerfHud {
  private el: HTMLDivElement;
  private t0 = 0;
  private prev = 0;
  private n = 0;
  private sumInt = 0;
  private sumWork = 0;
  private maxWork = 0;
  private calls = 0;
  private tris = 0;
  private log: PerfSample[] = [];
  /** running totals for scripted A/B runs (window.__perfTot) */
  private tot = { frames: 0, intervalMs: 0, workMs: 0 };

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.style.cssText =
      'position:absolute;left:4px;bottom:4px;z-index:50;pointer-events:none;font:11px/1.3 monospace;color:#cfe;background:rgba(0,0,0,.55);padding:3px 5px;border-radius:4px;white-space:pre';
    container.appendChild(this.el);
    (window as unknown as { __perfLog: PerfSample[] }).__perfLog = this.log;
    (window as unknown as { __perfTot: unknown }).__perfTot = this.tot;
  }

  /** call after each rendered frame with the frame timestamp and the CPU ms spent in update+render */
  frame(now: number, workMs: number, r: THREE.WebGLRenderer, quality: string, scenes: THREE.Object3D[], aa: boolean): void {
    const info = r.info.render;
    this.calls = info.calls;
    this.tris = info.triangles;
    if (this.prev > 0 && now - this.prev < 250) {
      this.sumInt += now - this.prev;
      this.sumWork += workMs;
      if (workMs > this.maxWork) this.maxWork = workMs;
      this.n++;
      this.tot.frames++;
      this.tot.intervalMs += now - this.prev;
      this.tot.workMs += workMs;
    }
    this.prev = now;
    if (this.t0 === 0) this.t0 = now;
    if (now - this.t0 < 1000) return;
    this.t0 = now;
    if (this.n === 0) return;
    const tex = new Set<THREE.Texture>();
    for (const sc of scenes)
      sc.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (!m) return;
        for (const k of ['map', 'alphaMap', 'envMap', 'normalMap']) {
          const t = (m as unknown as Record<string, THREE.Texture | null>)[k];
          if (t && t.isTexture) tex.add(t);
        }
      });
    let bytes = 0;
    for (const t of tex) {
      const img = t.image as { width?: number; height?: number } | undefined;
      if (!img || !img.width || !img.height) continue;
      bytes += img.width * img.height * 4 * (t.generateMipmaps && t.minFilter !== THREE.LinearFilter ? 4 / 3 : 1);
    }
    const sz = r.getDrawingBufferSize(new THREE.Vector2());
    // colour + depth/stencil (x4 samples when multisampled) + the resolved colour buffer
    const fb = sz.x * sz.y * 4 * (aa ? 4 * 2 + 1 : 2);
    const s: PerfSample = {
      quality,
      fps: Math.round((1000 * this.n) / this.sumInt),
      avgFrameMs: +(this.sumInt / this.n).toFixed(1),
      avgWorkMs: +(this.sumWork / this.n).toFixed(2),
      maxWorkMs: +this.maxWork.toFixed(1),
      calls: this.calls,
      tris: this.tris,
      texMB: +(bytes / 1048576).toFixed(1),
      fbMB: +(fb / 1048576).toFixed(1),
      pr: +r.getPixelRatio().toFixed(2),
      buf: `${sz.x}x${sz.y}`,
    };
    (window as unknown as { __perf: PerfSample }).__perf = s;
    this.log.push(s);
    if (this.log.length > 600) this.log.shift();
    this.el.textContent =
      `${quality} ${s.fps}fps ${s.avgFrameMs}ms work ${s.avgWorkMs}/${s.maxWorkMs}ms\n` +
      `calls ${s.calls} tris ${s.tris} tex ${s.texMB}MB fb ${s.fbMB}MB pr ${s.pr} ${s.buf}`;
    this.n = 0;
    this.sumInt = 0;
    this.sumWork = 0;
    this.maxWork = 0;
  }

  dispose(): void {
    this.el.remove();
  }
}
