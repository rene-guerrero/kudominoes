/** Fixed-capacity CPU particle system rendered as one THREE.Points draw call. No per-frame allocation. */
import * as THREE from 'three';

const VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
attribute float aSpin;
uniform float uScale;
uniform float uAtten;
uniform float uPx;
varying vec3 vColor;
varying float vAlpha;
varying float vSpin;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float s = aSize * uPx;
  if (uAtten > 0.5) s = aSize * uScale / max(0.1, -mv.z);
  gl_PointSize = s;
  vColor = aColor;
  vAlpha = aAlpha;
  vSpin = aSpin;
}`;

const FRAG = /* glsl */ `
uniform float uShape;
uniform float uOpacity;
varying vec3 vColor;
varying float vAlpha;
varying float vSpin;
void main() {
  if (vAlpha <= 0.001) discard;
  vec2 p = gl_PointCoord - 0.5;
  float a;
  if (uShape < 0.5) {
    float d = length(p);
    a = smoothstep(0.5, 0.05, d);
    gl_FragColor = vec4(vColor * (0.8 + 0.6 * (0.5 - d)), a * vAlpha * uOpacity);
  } else {
    float c = cos(vSpin), s = sin(vSpin);
    vec2 q = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
    float flip = 0.08 + 0.18 * abs(cos(vSpin * 1.7));
    if (abs(q.x) > 0.42 || abs(q.y) > flip) discard;
    float shade = 0.75 + 0.35 * abs(sin(vSpin * 1.7));
    gl_FragColor = vec4(vColor * shade, vAlpha * uOpacity);
  }
}`;

export class Particles {
  readonly points: THREE.Points;
  readonly cap: number;
  limit: number;
  /** quality knobs applied at spawn: size and lifetime multipliers (1 = as requested) */
  sizeMul = 1;
  lifeMul = 1;
  gravity = -9;
  drag = 1.5;
  wobble = 0;
  /** particles never go below floorY + size * floorK (so the soft sprite never cuts into the table) */
  floorY = -Infinity;
  floorK = 0;
  /** kill particles that come back down to the floor instead of resting on it */
  killOnFloor = false;
  private pos: Float32Array;
  private vel: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private spin: Float32Array;
  private spinV: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private size0: Float32Array;
  private phase: Float32Array;
  private cursor = 0;
  private alive = 0;
  private t = 0;
  readonly material: THREE.ShaderMaterial;
  private geo: THREE.BufferGeometry;

  constructor(cap: number, opts: { atten: boolean; shape: 'soft' | 'confetti'; additive?: boolean }) {
    this.cap = cap;
    this.limit = cap;
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 3);
    this.size = new Float32Array(cap);
    this.alpha = new Float32Array(cap);
    this.spin = new Float32Array(cap);
    this.spinV = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.size0 = new Float32Array(cap);
    this.phase = new Float32Array(cap);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSpin', new THREE.BufferAttribute(this.spin, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uScale: { value: 500 },
        uAtten: { value: opts.atten ? 1 : 0 },
        uPx: { value: 1 },
        uShape: { value: opts.shape === 'confetti' ? 1 : 0 },
        uOpacity: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.visible = false;
  }

  get busy(): boolean {
    return this.alive > 0;
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, r: number, g: number, b: number, size: number, life: number, spinV = 0): void {
    if (this.limit <= 0) return;
    size *= this.sizeMul;
    life *= this.lifeMul;
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % Math.min(this.cap, this.limit);
    if (this.life[i] <= 0) this.alive++;
    const i3 = i * 3;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.col[i3] = r;
    this.col[i3 + 1] = g;
    this.col[i3 + 2] = b;
    this.size0[i] = size;
    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.alpha[i] = 1;
    this.spin[i] = Math.random() * 6.28;
    this.spinV[i] = spinV;
    this.phase[i] = Math.random() * 6.28;
    this.points.visible = true;
  }

  update(dt: number): boolean {
    if (this.alive <= 0) {
      this.points.visible = false;
      return false;
    }
    this.t += dt;
    const damp = Math.exp(-this.drag * dt);
    let alive = 0;
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const i3 = i * 3;
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        this.size[i] = 0;
        continue;
      }
      alive++;
      this.vel[i3] *= damp;
      this.vel[i3 + 2] *= damp;
      this.vel[i3 + 1] = this.vel[i3 + 1] * damp + this.gravity * dt;
      if (this.wobble) this.vel[i3] += Math.sin(this.t * 4 + this.phase[i]) * this.wobble * dt;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const minY = this.floorY + this.size[i] * this.floorK;
      if (this.pos[i3 + 1] < minY) {
        this.pos[i3 + 1] = minY;
        if (this.killOnFloor && this.vel[i3 + 1] < 0) {
          this.life[i] = Math.min(this.life[i], 0.06);
        }
        if (this.vel[i3 + 1] < 0) this.vel[i3 + 1] = 0;
      }
      this.spin[i] += this.spinV[i] * dt;
      const k = this.life[i] / this.maxLife[i];
      this.alpha[i] = k < 0.3 ? k / 0.3 : 1;
      this.size[i] = this.size0[i] * (0.6 + 0.4 * k);
    }
    this.alive = alive;
    const a = this.geo.attributes;
    a.position.needsUpdate = true;
    a.aAlpha.needsUpdate = true;
    a.aSize.needsUpdate = true;
    a.aSpin.needsUpdate = true;
    a.aColor.needsUpdate = true;
    return alive > 0;
  }

  clear(): void {
    this.life.fill(0);
    this.alpha.fill(0);
    this.alive = 0;
    this.points.visible = false;
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
  }
}
