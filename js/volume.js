/**
 * volume.js —— 「截空间」：框选一块体积，在独立窗口里做高精度体渲染
 *
 * 流程：
 *   1. 在电路里选一个立方体区域（中心 + 尺寸可调），三维场景里用线框标出来
 *   2. 在这块空间里采一个 N³ 的标量网格（|S| / |E| / |B| / φ），逐层渐进计算
 *   3. 用沿视线方向的射线步进对它做体渲染（或最大强度投影），逐行渐进出图
 *   4. 结果同步到独立窗口，可以拖到第二块屏幕上看
 */
import * as THREE from 'three';
import { MU0 } from './field.js';
import { FIELDS } from './slice.js';

const W2M = 0.01;
const DEG = Math.PI / 180;

const TURBO = [
  [0.02, [0.19, 0.07, 0.23]], [0.13, [0.27, 0.28, 0.66]], [0.26, [0.28, 0.47, 0.93]],
  [0.39, [0.23, 0.65, 0.99]], [0.52, [0.15, 0.83, 0.85]], [0.65, [0.19, 0.94, 0.59]],
  [0.78, [0.60, 0.99, 0.30]], [0.90, [0.95, 0.85, 0.17]], [1.00, [0.99, 0.53, 0.09]],
];
const DIV = [
  [0.0, [0.18, 0.36, 0.72]], [0.3, [0.36, 0.58, 0.82]], [0.5, [0.80, 0.80, 0.80]],
  [0.7, [0.86, 0.56, 0.40]], [1.0, [0.78, 0.20, 0.24]],
];

function ramp(stops, t) {
  t = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
      const f = Math.max(0, Math.min(1, (t - t0) / (t1 - t0 || 1)));
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return stops[stops.length - 1][1];
}

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[i];
}

export function fmt(v) {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a < 1e-9) return (v * 1e12).toFixed(2) + 'p';
  if (a < 1e-6) return (v * 1e9).toFixed(2) + 'n';
  if (a < 1e-3) return (v * 1e6).toFixed(2) + 'µ';
  if (a < 1) return (v * 1e3).toFixed(2) + 'm';
  if (a < 1e3) return v.toFixed(2);
  if (a < 1e6) return (v / 1e3).toFixed(2) + 'k';
  return (v / 1e6).toFixed(2) + 'M';
}

const RES_OPTIONS = [48, 64, 96];

export class VolumeTool {
  constructor(scene3d, dom) {
    this.scene3d = scene3d;
    this.dom = dom;
    this.solver = null;
    this.bounds = null;

    this.state = {
      cx: 0, cy: 0.4, cz: 0,     // 中心（相对电路中心的世界偏移）
      half: 2.6,                 // 半边长
      field: 'S',
      mode: 'volume',            // volume | mip
      res: 64,                   // 网格分辨率
      imgRes: 360,               // 成像分辨率
      yaw: 32, pitch: 46,        // 视角
      gain: 1.0,                 // 不透明度增益
      thresh: 0.5,               // 只显示 t 超过这个值的部分，避免整团雾
      visible: false,
    };

    this.grid = null;
    this.gridN = 0;
    this.norm = null;
    this.genGrid = 0;
    this.genImg = 0;

    // 三维里的区域线框
    this.group = new THREE.Group();
    this.group.visible = false;
    scene3d.scene.add(this.group);
    this._buildBox();
    this._bindDom();
  }

  _buildBox() {
    this.edgeMat = new THREE.LineBasicMaterial({ color: 0x7ee0ff, transparent: true, opacity: 0.38 });
    this.faceMat = new THREE.MeshBasicMaterial({
      color: 0x58c4ff, transparent: true, opacity: 0.03,
      side: THREE.DoubleSide, depthWrite: false,
    });
    this.box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.faceMat);
    this.box.renderOrder = 2;
    this.edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), this.edgeMat);
    this.group.add(this.box, this.edges);
    this._boxKey = '';
  }

  setScene({ solver, bounds }) {
    this.solver = solver;
    this.bounds = bounds;
    if (!solver || !solver.n) return;
    if (!this._fitted) {
      const cx = (bounds.min[0] + bounds.max[0]) / 2;
      const cz = (bounds.min[2] + bounds.max[2]) / 2;
      this._base = [cx, 0, cz];
      const span = Math.max(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2], 3);
      this.state.half = Math.max(1.4, span * 0.55);
      this._fitted = true;
      this.syncInputs();
    }
    this.update();
  }

  show(v) {
    this.state.visible = v;
    this.group.visible = v;
    this.dom.win.classList.toggle('hidden', !v);
    if (!v) { this.genGrid++; this.genImg++; return; }
    this.syncInputs();
    this.update();
  }

  get center() {
    const b = this._base || [0, 0, 0];
    return [b[0] + this.state.cx, b[1] + this.state.cy, b[2] + this.state.cz];
  }

  /* ---------------- 三维线框 ---------------- */
  update() {
    if (!this.state.visible || !this.solver) return;
    const c = this.center, h = this.state.half;
    const key = h.toFixed(3);
    if (key !== this._boxKey) {
      this.box.geometry.dispose();
      this.edges.geometry.dispose();
      const g = new THREE.BoxGeometry(2 * h, 2 * h, 2 * h);
      this.box.geometry = g;
      this.edges.geometry = new THREE.EdgesGeometry(g);
      this._boxKey = key;
    }
    this.box.position.set(...c);
    this.edges.position.set(...c);
    this.startGrid();
  }

  /* ---------------- 1) 采网格 ---------------- */
  startGrid() {
    const N = this.state.res;
    const gen = ++this.genGrid;
    const c = this.center, h = this.state.half;
    const vals = new Float32Array(N * N * N);
    this.dom.progressWrap.classList.remove('hidden');
    this.dom.progress.style.width = '0%';
    this.dom.res.textContent = `${N}³`;

    let k = 0;
    const step = () => {
      if (gen !== this.genGrid) return;
      const t0 = performance.now();
      while (k < N && performance.now() - t0 < 14) {
        this._gridSlice(vals, k, N, c, h);
        k++;
      }
      this.dom.progress.style.width = ((k / N) * 100).toFixed(0) + '%';
      if (k < N) { requestAnimationFrame(step); return; }
      this.grid = vals;
      this.gridN = N;
      this.norm = this._makeNorm(vals);
      this.startRender();
    };
    requestAnimationFrame(step);
  }

  _gridSlice(vals, k, N, c, h) {
    const { solver } = this;
    const field = this.state.field;
    const E = [0, 0, 0], B = [0, 0, 0];
    const nn = N * N;
    const stepW = (2 * h) / N;
    const z = c[2] - h + (k + 0.5) * stepW;
    for (let j = 0; j < N; j++) {
      const y = c[1] - h + (j + 0.5) * stepW;
      const row = k * nn + j * N;
      for (let i = 0; i < N; i++) {
        const x = c[0] - h + (i + 0.5) * stepW;
        const px = x * W2M, py = y * W2M, pz = z * W2M;
        let val;
        if (field === 'phi') {
          val = solver.phi(px, py, pz);
        } else if (field === 'E') {
          solver.eField(px, py, pz, E);
          val = Math.hypot(E[0], E[1], E[2]);
        } else if (field === 'B') {
          solver.bField(px, py, pz, B);
          val = Math.hypot(B[0], B[1], B[2]);
        } else {
          solver.eField(px, py, pz, E);
          solver.bField(px, py, pz, B);
          val = Math.hypot(
            (E[1] * B[2] - E[2] * B[1]) / MU0,
            (E[2] * B[0] - E[0] * B[2]) / MU0,
            (E[0] * B[1] - E[1] * B[0]) / MU0
          );
        }
        vals[row + i] = isFinite(val) ? val : 0;
      }
    }
  }

  _makeNorm(vals) {
    const kind = FIELDS[this.state.field].kind;
    if (kind === 'signed') {
      const s = Array.from(vals).sort((a, b) => a - b);
      const lo = percentile(s, 0.01), hi = percentile(s, 0.99);
      const mid = 0.5 * (lo + hi), half = Math.max(0.5 * (hi - lo), 1e-12);
      return {
        kind, lo, hi,
        t: (v) => Math.min(1, Math.max(0, 0.5 + 0.5 * (v - mid) / half)),
        color: (v) => ramp(DIV, Math.min(1, Math.max(0, 0.5 + 0.5 * (v - mid) / half))),
      };
    }
    const s = Array.from(vals).filter((v) => v > 0).sort((a, b) => a - b);
    const lo = Math.max(percentile(s, 0.01) || 1e-12, 1e-30);
    const hi = Math.max(percentile(s, 0.995) || lo * 10, lo * 10);
    const l0 = Math.log10(lo), l1 = Math.log10(hi);
    const t = (v) => (v <= 0 ? 0 : Math.min(1, Math.max(0, (Math.log10(Math.max(v, 1e-30)) - l0) / (l1 - l0))));
    return { kind, lo, hi, t, color: (v) => ramp(TURBO, t(v)) };
  }

  /* ---------------- 2) 体渲染 ---------------- */
  startRender() {
    if (!this.state.visible || !this.grid) return;
    const gen = ++this.genImg;
    const N = this.gridN;
    const I = Math.round(this.state.imgRes);
    const img = new Uint8ClampedArray(I * I * 4);
    this.dom.progressWrap.classList.remove('hidden');
    this.dom.progress.style.width = '0%';

    const cam = this._camera(I);
    let y = 0;
    const step = () => {
      if (gen !== this.genImg) return;
      const t0 = performance.now();
      while (y < I && performance.now() - t0 < 14) {
        this._marchRow(img, y, I, cam, N);
        y++;
      }
      this.dom.progress.style.width = ((y / I) * 100).toFixed(0) + '%';
      if (y < I) { requestAnimationFrame(step); return; }
      this._paint(img, I);
    };
    requestAnimationFrame(step);
  }

  _camera(I) {
    const yaw = this.state.yaw * DEG, pitch = this.state.pitch * DEG;
    // 视线方向（从相机指向场景）
    const d = [-Math.cos(pitch) * Math.sin(yaw), -Math.sin(pitch), -Math.cos(pitch) * Math.cos(yaw)];
    const up0 = Math.abs(d[1]) > 0.98 ? [0, 0, 1] : [0, 1, 0];
    const right = norm(cross(d, up0));
    const up = cross(right, d);
    const h = this.state.half;
    const c = this.center;
    const D = h * 2.2;                    // 从盒外开始
    const steps = Math.max(48, Math.round(this.gridN * 1.4));
    const dt = (2 * D) / steps;
    return { d, right, up, c, h, D, steps, dt, I };
  }

  _marchRow(img, y, I, cam, N) {
    const { d, right, up, c, h, D, steps, dt } = cam;
    const grid = this.grid;
    const normer = this.norm;
    const gain = this.state.gain;
    const thresh = this.state.thresh;
    const invThresh = 1 / Math.max(0.05, 1 - thresh);
    const mip = this.state.mode === 'mip';
    const nn = N * N;

    for (let x = 0; x < I; x++) {
      // 正交投影：像素 → 平面坐标
      const u = ((x + 0.5) / I * 2 - 1) * h;
      const v = (1 - (y + 0.5) / I * 2) * h;
      let ox = c[0] + right[0] * u + up[0] * v - d[0] * D;
      let oy = c[1] + right[1] * u + up[1] * v - d[1] * D;
      let oz = c[2] + right[2] * u + up[2] * v - d[2] * D;

      let cr = 0, cg = 0, cb = 0, A = 0, best = 0;

      for (let s = 0; s < steps; s++) {
        const px = ox + d[0] * s * dt;
        const py = oy + d[1] * s * dt;
        const pz = oz + d[2] * s * dt;
        // 世界 → 网格坐标
        const gx = (px - (c[0] - h)) / (2 * h) * (N - 1);
        const gy = (py - (c[1] - h)) / (2 * h) * (N - 1);
        const gz = (pz - (c[2] - h)) / (2 * h) * (N - 1);
        if (gx < 0 || gy < 0 || gz < 0 || gx > N - 1.001 || gy > N - 1.001 || gz > N - 1.001) continue;

        const ix = gx | 0, iy = gy | 0, iz = gz | 0;
        const fx = gx - ix, fy = gy - iy, fz = gz - iz;
        const b = iz * nn + iy * N + ix;
        const s0 = b, s1 = b + 1;
        const s2 = b + N, s3 = b + N + 1;
        const s4 = b + nn, s5 = b + nn + 1;
        const s6 = b + nn + N, s7 = b + nn + N + 1;
        const c00 = grid[s0] + (grid[s1] - grid[s0]) * fx;
        const c01 = grid[s2] + (grid[s3] - grid[s2]) * fx;
        const c10 = grid[s4] + (grid[s5] - grid[s4]) * fx;
        const c11 = grid[s6] + (grid[s7] - grid[s6]) * fx;
        const c0 = c00 + (c01 - c00) * fy;
        const c1 = c10 + (c11 - c10) * fy;
        const val = c0 + (c1 - c0) * fz;

        const t = normer.t(val);
        if (mip) {
          if (t > best) best = t;
        } else {
          const tt = (t - thresh) * invThresh;
          if (tt <= 0) continue;
          const col = normer.color(val);
          const a = Math.min(0.85, gain * 0.42 * Math.pow(tt, 1.5));
          const w = (1 - A);
          cr += w * a * col[0];
          cg += w * a * col[1];
          cb += w * a * col[2];
          A += w * a;
          if (A > 0.98) break;
        }
      }

      const o = (y * I + x) * 4;
      if (mip) {
        if (best > 0) {
          const col = normer.color(normer.kind === 'signed'
            ? (best * 2 - 1)   // 反归一化不精确也没关系，这里只求视觉
            : Math.pow(10, Math.log10(Math.max(normer.lo, 1e-30)) + best * (Math.log10(Math.max(normer.hi, 1e-29)) - Math.log10(Math.max(normer.lo, 1e-30)))));
          img[o] = col[0] * 255;
          img[o + 1] = col[1] * 255;
          img[o + 2] = col[2] * 255;
          img[o + 3] = 255 * Math.min(1, 0.15 + best * 1.1);
        } else {
          img[o + 3] = 0;
        }
      } else {
        img[o] = cr * 255;
        img[o + 1] = cg * 255;
        img[o + 2] = cb * 255;
        img[o + 3] = A * 255;
      }
    }
  }

  /* ---------------- 3) 出图 ---------------- */
  _paint(img, I) {
    const canvas = this.dom.canvas;
    canvas.width = I;
    canvas.height = I;
    const ctx = canvas.getContext('2d');
    // 先铺黑底，再把带 alpha 的体积结果叠上去
    ctx.fillStyle = '#04070b';
    ctx.fillRect(0, 0, I, I);
    const tmp = document.createElement('canvas');
    tmp.width = I; tmp.height = I;
    tmp.getContext('2d').putImageData(new ImageData(img, I, I), 0, 0);
    ctx.drawImage(tmp, 0, 0);

    this.dom.progressWrap.classList.add('hidden');
    const f = FIELDS[this.state.field];
    const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => {
      const v = this.norm.kind === 'signed'
        ? this.norm.lo + (this.norm.hi - this.norm.lo) * t
        : Math.pow(10, Math.log10(Math.max(this.norm.lo, 1e-30)) + t * (Math.log10(Math.max(this.norm.hi, 1e-29)) - Math.log10(Math.max(this.norm.lo, 1e-30))));
      const c = this.norm.color(v);
      return `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
    });
    this.dom.legend.style.background = `linear-gradient(90deg, ${stops.join(',')})`;
    this.dom.legendLo.textContent = fmt(this.norm.lo);
    this.dom.legendHi.textContent = fmt(this.norm.hi);
    this.dom.unit.textContent = f.unit;
    this.dom.title.textContent = `${f.label}${this.state.mode === 'mip' ? ' · MIP' : ' · 体渲染'}`;
    this.dom.res.textContent = `${this.gridN}³ → ${I}²`;
    if (this.popup && !this.popup.closed) this.pushPopup();
  }

  /* ---------------- 4) 独立窗口 ---------------- */
  openPopup() {
    try {
      const w = window.open('', 'emlab-volume', 'width=900,height=1000');
      if (!w) return false;
      w.document.write(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
        <title>电磁场实验台 · 空间</title>
        <style>html,body{margin:0;background:#04070b;color:#dbe6f2;
          font:13px/1.5 'Segoe UI','Microsoft YaHei',sans-serif}
        #t{padding:10px 14px;font-weight:600;color:#9fc6ea}
        #img{display:block;width:100%;background:#04070b}
        #lg{padding:8px 14px 16px;color:#7d8fa6;font-size:11.5px}
        #bar{height:8px;margin:0 14px;border-radius:4px}</style></head>
        <body><div id="t"></div><img id="img" alt="volume">
        <div id="bar"></div><div id="lg"></div></body></html>`);
      w.document.close();
      this.popup = w;
      this.pushPopup();
      return true;
    } catch (e) {
      console.warn('独立窗口打开失败', e);
      return false;
    }
  }

  pushPopup() {
    const { popup } = this;
    if (!popup || popup.closed) return;
    try {
      popup.document.getElementById('img').src = this.dom.canvas.toDataURL('image/png');
      popup.document.getElementById('t').textContent =
        `${FIELDS[this.state.field].label} · ${this.state.mode === 'mip' ? '最大投影' : '体渲染'} · ${this.gridN}³ → ${this.state.imgRes}²`;
      popup.document.getElementById('bar').style.background = this.dom.legend.style.background;
      popup.document.getElementById('lg').textContent =
        `色标 ${fmt(this.norm.lo)} → ${fmt(this.norm.hi)} ${FIELDS[this.state.field].unit} · 区域 ${(this.state.half * 2).toFixed(2)} 格`;
    } catch (e) { /* 被拦掉就算了 */ }
  }

  /* ---------------- 交互 ---------------- */
  syncInputs() {
    const s = this.state;
    this.dom.cx.value = String(Math.round(s.cx * 20));
    this.dom.cy.value = String(Math.round(s.cy * 20));
    this.dom.cz.value = String(Math.round(s.cz * 20));
    this.dom.half.value = String(Math.round(s.half * 10));
    this.dom.yaw.value = String(s.yaw);
    this.dom.pitch.value = String(s.pitch);
    this.dom.gain.value = String(Math.round(s.gain * 100));
    if (this.dom.resSel) this.dom.resSel.value = String(s.res);
    if (this.dom.field) this.dom.field.value = s.field;
    if (this.dom.mode) this.dom.mode.value = s.mode;
    this.dom.thresh.value = String(Math.round(s.thresh * 100));
    this.dom.threshLabel.textContent = s.thresh.toFixed(2);
    this.dom.halfLabel.textContent = `${(s.half * 2).toFixed(2)} 格`;
  }

  _bindDom() {
    const d = this.dom;
    const onChange = () => { this.syncInputs(); this.update(); };
    d.cx.addEventListener('input', (e) => { this.state.cx = +e.target.value / 20; this.dom.cxLabel.textContent = this.state.cx.toFixed(2); onChange(); });
    d.cy.addEventListener('input', (e) => { this.state.cy = +e.target.value / 20; this.dom.cyLabel.textContent = this.state.cy.toFixed(2); onChange(); });
    d.cz.addEventListener('input', (e) => { this.state.cz = +e.target.value / 20; this.dom.czLabel.textContent = this.state.cz.toFixed(2); onChange(); });
    d.half.addEventListener('input', (e) => { this.state.half = +e.target.value / 10; onChange(); });
    // 视角只影响成像，不用重算网格
    d.yaw.addEventListener('input', (e) => { this.state.yaw = +e.target.value; this.startRender(); });
    d.pitch.addEventListener('input', (e) => { this.state.pitch = +e.target.value; this.startRender(); });
    d.gain.addEventListener('input', (e) => { this.state.gain = +e.target.value / 100; this.startRender(); });
    d.thresh.addEventListener('input', (e) => {
      this.state.thresh = +e.target.value / 100;
      d.threshLabel.textContent = this.state.thresh.toFixed(2);
      this.startRender();
    });
    d.field.addEventListener('change', (e) => { this.state.field = e.target.value; this.update(); });
    d.mode.addEventListener('change', (e) => { this.state.mode = e.target.value; this.startRender(); });
    d.resSel.addEventListener('change', (e) => {
      this.state.res = +e.target.value;
      this.state.imgRes = Math.min(512, Math.round(220 + this.state.res * 2.6));
      this.update();
    });
    d.popBtn.addEventListener('click', () => this.openPopup());
    d.closeBtn.addEventListener('click', () => this.show(false));
    d.reBtn.addEventListener('click', () => this.update());

    let drag = null;
    d.head.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT') return;
      drag = { x: e.clientX, y: e.clientY, l: d.win.offsetLeft, t: d.win.offsetTop };
      d.head.setPointerCapture(e.pointerId);
    });
    d.head.addEventListener('pointermove', (e) => {
      if (!drag) return;
      d.win.style.left = drag.l + (e.clientX - drag.x) + 'px';
      d.win.style.top = drag.t + (e.clientY - drag.y) + 'px';
      d.win.style.right = 'auto';
    });
    d.head.addEventListener('pointerup', () => { drag = null; });

    // 在图上拖动 = 旋转视角
    let rot = null;
    d.canvas.addEventListener('pointerdown', (e) => {
      rot = { x: e.clientX, y: e.clientY, yaw: this.state.yaw, pitch: this.state.pitch };
      d.canvas.setPointerCapture(e.pointerId);
    });
    d.canvas.addEventListener('pointermove', (e) => {
      if (!rot) return;
      this.state.yaw = (rot.yaw - (e.clientX - rot.x) * 0.5 + 360) % 360;
      this.state.pitch = Math.max(-85, Math.min(85, rot.pitch + (e.clientY - rot.y) * 0.5));
      d.yaw.value = String(Math.round(this.state.yaw));
      d.pitch.value = String(Math.round(this.state.pitch));
      this.startRender();
    });
    d.canvas.addEventListener('pointerup', () => { rot = null; });
  }
}

function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
