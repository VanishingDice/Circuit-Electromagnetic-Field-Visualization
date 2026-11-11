/**
 * slice.js —— 可自由移动 / 旋转的分析截面 + 高精度独立窗口
 *
 * 一个截面状态（中心、法向、尺寸、场类型）同时驱动两个视图：
 *   1. 三维场景里那块半透明切片（跟着电路一起转，能看清它在哪）
 *   2. 单独的高精度窗口（逐行渐进计算，可以拖到另一块屏幕上看）
 *
 * 采样直接复用 FieldSolver 的 eField / bField / phi，和主视图是同一份物理。
 */
import * as THREE from 'three';
import { MU0 } from './field.js';

const W2M = 0.01;
const M2W = 100;
const DEG = Math.PI / 180;

export const FIELDS = {
  phi: { label: 'φ 电势', unit: 'V', kind: 'signed' },
  E: { label: '|E| 电场', unit: 'V/m', kind: 'mag' },
  B: { label: '|B| 磁场', unit: 'T', kind: 'mag' },
  S: { label: '|S| 能流', unit: 'W/m²', kind: 'mag' },
};

/* ---------------- 配色 ---------------- */
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

/* ---------------- 几何小工具 ---------------- */
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function normalFromAngles(yawDeg, pitchDeg) {
  const y = yawDeg * DEG, p = pitchDeg * DEG;
  return [Math.cos(p) * Math.sin(y), Math.sin(p), Math.cos(p) * Math.cos(y)];
}

/** 由法向构造右手正交基 (e1, e2, n) */
function basisFromNormal(n) {
  const up = Math.abs(n[1]) > 0.98 ? [0, 0, 1] : [0, 1, 0];
  const e1 = norm(cross(n, up));
  const e2 = cross(n, e1);
  return [e1, e2];
}

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[i];
}

export function fmtSci(v) {
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

const QUICK = 150;   // 拖动时的快速分辨率
const HI_DEFAULT = 384;

/* ================================================================== */
export class SliceTool {
  constructor(scene3d, dom) {
    this.scene3d = scene3d;
    this.dom = dom;
    this.solver = null;
    this.bounds = null;
    this.conductorR = 0.0005;
    this.gen = 0;
    this.hiRes = HI_DEFAULT;
    this.values = null;
    this.valueN = 0;
    this.norm = null;
    this._timer = null;

    this.state = { offset: 0, yaw: 0, pitch: 90, size: 3.4, field: 'S', visible: false };

    this.group = new THREE.Group();
    this.group.visible = false;
    scene3d.scene.add(this.group);
    this._buildMesh();
    this._bindDom();
  }

  /* ---------------- 三维切片 ---------------- */
  _buildMesh() {
    this.tex = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
    this.tex.needsUpdate = true;
    this.mat = new THREE.MeshBasicMaterial({
      map: this.tex, transparent: true, opacity: 0.62,
      side: THREE.DoubleSide, depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.mesh.renderOrder = 3;
    this.group.add(this.mesh);

    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute([
      -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0, -1, -1, 0,
    ], 3));
    this.border = new THREE.Line(fg, new THREE.LineBasicMaterial({
      color: 0x7ee0ff, transparent: true, opacity: 0.9,
    }));
    this.group.add(this.border);
  }

  setScene({ solver, bounds, conductorR }) {
    this.solver = solver;
    this.bounds = bounds;
    if (conductorR) this.conductorR = conductorR;
    if (!solver || !solver.n) return;
    if (!this._fitted) this.fitToBounds();
    this.update();
  }

  fitToBounds() {
    if (!this.bounds) return;
    const cx = (this.bounds.min[0] + this.bounds.max[0]) / 2;
    const cz = (this.bounds.min[2] + this.bounds.max[2]) / 2;
    this.base = [cx, 0.5, cz];
    const span = Math.max(
      this.bounds.max[0] - this.bounds.min[0],
      this.bounds.max[2] - this.bounds.min[2], 3
    );
    this.state.size = Math.max(1.8, span * 0.55);
    this._fitted = true;
    this.syncInputs();
  }

  get plane() {
    const n = normalFromAngles(this.state.yaw, this.state.pitch);
    const [e1, e2] = basisFromNormal(n);
    const base = this.base || [0, 0, 0];
    const center = [
      base[0] + n[0] * this.state.offset,
      base[1] + n[1] * this.state.offset,
      base[2] + n[2] * this.state.offset,
    ];
    return { center, n, e1, e2, size: this.state.size };
  }

  show(v) {
    this.state.visible = v;
    this.group.visible = v;
    this.dom.win.classList.toggle('hidden', !v);
    if (!v) { this.gen++; return; }
    this.syncInputs();
    this.update();
  }

  /* ---------------- 逐行采样（可中断） ---------------- */
  _computeRow(vals, j, N, plane, field, arrows) {
    const { solver } = this;
    const { center, e1, e2, size } = plane;
    const step = (2 * size) / N;
    const v = -size + (j + 0.5) * step;
    const E = [0, 0, 0], B = [0, 0, 0];
    for (let i = 0; i < N; i++) {
      const u = -size + (i + 0.5) * step;
      const px = (center[0] + e1[0] * u + e2[0] * v) * W2M;
      const py = (center[1] + e1[1] * u + e2[1] * v) * W2M;
      const pz = (center[2] + e1[2] * u + e2[2] * v) * W2M;
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
        const sx = (E[1] * B[2] - E[2] * B[1]) / MU0;
        const sy = (E[2] * B[0] - E[0] * B[2]) / MU0;
        const sz = (E[0] * B[1] - E[1] * B[0]) / MU0;
        val = Math.hypot(sx, sy, sz);
        if (arrows && j % 10 === 5 && i % 10 === 5) arrows.push({ i, j, d: [sx, sy, sz] });
      }
      vals[j * N + i] = isFinite(val) ? val : 0;
    }
  }

  makeNormalizer(vals) {
    const kind = FIELDS[this.state.field].kind;
    if (kind === 'signed') {
      const s = Array.from(vals).sort((a, b) => a - b);
      const lo = percentile(s, 0.01), hi = percentile(s, 0.99);
      const mid = 0.5 * (lo + hi), half = Math.max(0.5 * (hi - lo), 1e-12);
      return {
        kind, lo, hi, mid,
        color: (v) => ramp(DIV, 0.5 + 0.5 * (v - mid) / half),
        level: (f) => mid - half + 2 * half * f,
      };
    }
    const s = Array.from(vals).filter((v) => v > 0).sort((a, b) => a - b);
    const lo = Math.max(percentile(s, 0.02) || 1e-12, 1e-30);
    const hi = Math.max(percentile(s, 0.98) || lo * 10, lo * 10);
    const l0 = Math.log10(lo), l1 = Math.log10(hi);
    return {
      kind, lo, hi,
      color: (v) => ramp(TURBO, v <= 0 ? 0 : Math.min(1, Math.max(0, (Math.log10(Math.max(v, 1e-30)) - l0) / (l1 - l0)))),
      level: (f) => Math.pow(10, l0 + (l1 - l0) * f),
    };
  }

  /* ---------------- 三维视图更新 ---------------- */
  update() {
    if (!this.state.visible) return;
    if (!this.solver || !this.solver.n) return;

    const { center, n, e1, e2, size } = this.plane;
    const m = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(...e1), new THREE.Vector3(...e2), new THREE.Vector3(...n)
    );
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    this.mesh.quaternion.copy(q);
    this.mesh.position.set(...center);
    this.mesh.scale.set(size, size, 1);
    this.border.quaternion.copy(q);
    this.border.position.set(...center);
    this.border.scale.set(size * 1.004, size * 1.004, 1);

    // 三维里的贴图用低分辨率，保证拖动不卡
    const N = 88;
    const vals = new Float32Array(N * N);
    const plane = this.plane;
    for (let j = 0; j < N; j++) this._computeRow(vals, j, N, plane, this.state.field, null);
    const normer = this.makeNormalizer(vals);
    const data = new Uint8Array(N * N * 4);
    for (let k = 0; k < N * N; k++) {
      const c = normer.color(vals[k]);
      data[k * 4] = c[0] * 255;
      data[k * 4 + 1] = c[1] * 255;
      data[k * 4 + 2] = c[2] * 255;
      data[k * 4 + 3] = 255;
    }
    this.tex.dispose();
    this.tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.needsUpdate = true;
    this.mat.map = this.tex;
    this.mat.needsUpdate = true;

    // 高精度窗口：先快后精
    this.startRender(QUICK);
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.startRender(this.hiRes), 320);
  }

  /* ---------------- 高精度窗口 ---------------- */
  startRender(N) {
    if (!this.state.visible || !this.solver || !this.solver.n) return;
    const gen = ++this.gen;
    const plane = this.plane;
    const field = this.state.field;
    const vals = new Float32Array(N * N);
    const arrows = field === 'S' ? [] : null;
    this.dom.res.textContent = `${N}²`;
    this.dom.progress.style.width = '0%';
    this.dom.progressWrap.classList.remove('hidden');

    let j = 0;
    const step = () => {
      if (gen !== this.gen) return;
      const t0 = performance.now();
      while (j < N && performance.now() - t0 < 14) {
        this._computeRow(vals, j, N, plane, field, arrows);
        j++;
      }
      this.dom.progress.style.width = ((j / N) * 100).toFixed(1) + '%';
      if (j < N) { requestAnimationFrame(step); return; }
      this.values = vals;
      this.valueN = N;
      this.norm = this.makeNormalizer(vals);
      this.paint(vals, N, arrows, gen);
    };
    requestAnimationFrame(step);
  }

  paint(vals, N, arrows, gen) {
    if (gen !== this.gen) return;
    const canvas = this.dom.canvas;
    canvas.width = N;
    canvas.height = N;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(N, N);
    const color = this.norm.color;
    for (let j = 0; j < N; j++) {
      const src = j * N;
      const dst = (N - 1 - j) * N * 4;
      for (let i = 0; i < N; i++) {
        const c = color(vals[src + i]);
        const k = dst + i * 4;
        img.data[k] = c[0] * 255;
        img.data[k + 1] = c[1] * 255;
        img.data[k + 2] = c[2] * 255;
        img.data[k + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // 等值线
    const levels = 9;
    ctx.strokeStyle = 'rgba(0,0,0,0.40)';
    ctx.lineWidth = Math.max(1, N / 512);
    ctx.beginPath();
    for (let L = 0; L < levels; L++) {
      const lv = this.norm.level((L + 0.5) / levels);
      for (let j = 0; j < N - 1; j++) {
        for (let i = 0; i < N - 1; i++) {
          const a = vals[j * N + i], b = vals[j * N + i + 1];
          const c2 = vals[(j + 1) * N + i], d = vals[(j + 1) * N + i + 1];
          const seg = [];
          const ip = (p, q, x0, y0, x1, y1) => {
            const f = (lv - p) / (q - p || 1e-30);
            return [x0 + (x1 - x0) * f, y0 + (y1 - y0) * f];
          };
          if ((a - lv) * (b - lv) < 0) seg.push(ip(a, b, i, j, i + 1, j));
          if ((b - lv) * (d - lv) < 0) seg.push(ip(b, d, i + 1, j, i + 1, j + 1));
          if ((d - lv) * (c2 - lv) < 0) seg.push(ip(d, c2, i + 1, j + 1, i, j + 1));
          if ((c2 - lv) * (a - lv) < 0) seg.push(ip(c2, a, i, j + 1, i, j));
          for (let e = 0; e + 1 < seg.length; e += 2) {
            ctx.moveTo(seg[e][0], N - 1 - seg[e][1]);
            ctx.lineTo(seg[e + 1][0], N - 1 - seg[e + 1][1]);
          }
        }
      }
    }
    ctx.stroke();

    // 能流方向
    if (arrows && arrows.length) {
      const plane = this.plane;
      ctx.strokeStyle = 'rgba(255,255,255,0.82)';
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.lineWidth = Math.max(1, N / 700);
      const L = N * 0.017;
      for (const a of arrows) {
        const m = Math.hypot(a.d[0], a.d[1], a.d[2]);
        if (!(m > 0)) continue;
        const du = dot(a.d, plane.e1) / m;
        const dv = dot(a.d, plane.e2) / m;
        const len = Math.hypot(du, dv);
        if (len < 0.12) continue;
        const x = a.i + 0.5, y = N - 1 - (a.j + 0.5);
        const ux = (du / len) * L, uy = (dv / len) * L;
        ctx.beginPath();
        ctx.moveTo(x - ux, y - uy);
        ctx.lineTo(x + ux, y + uy);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x + ux, y + uy, Math.max(1, N / 380), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    this.dom.progressWrap.classList.add('hidden');
    const f = FIELDS[this.state.field];
    const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => {
      const c = this.norm.color(
        this.norm.kind === 'signed'
          ? this.norm.lo + (this.norm.hi - this.norm.lo) * t
          : this.norm.level(t)
      );
      return `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
    });
    this.dom.legend.style.background = `linear-gradient(90deg, ${stops.join(',')})`;
    this.dom.legendLo.textContent = fmtSci(this.norm.lo);
    this.dom.legendHi.textContent = fmtSci(this.norm.hi);
    this.dom.unit.textContent = f.unit;
    this.dom.title.textContent = f.label;
    if (this.popup && !this.popup.closed) this.pushPopup();
  }

  /* ---------------- 独立窗口 ---------------- */
  openPopup() {
    try {
      const w = window.open('', 'emlab-slice', 'width=880,height=980');
      if (!w) return false;
      w.document.write(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
        <title>电磁场实验台 · 截面</title>
        <style>html,body{margin:0;background:#070a0f;color:#dbe6f2;
          font:13px/1.5 'Segoe UI','Microsoft YaHei',sans-serif}
        #t{padding:10px 14px;font-weight:600;color:#9fc6ea}
        #img{display:block;width:100%;image-rendering:auto}
        #lg{padding:8px 14px 16px;color:#7d8fa6;font-size:11.5px}</style></head>
        <body><div id="t"></div><img id="img" alt="section"><div id="lg"></div></body></html>`);
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
        `${FIELDS[this.state.field].label} · ${this.valueN}² 采样 · ${this.state.size.toFixed(2)} 格`;
      popup.document.getElementById('lg').textContent =
        `色标 ${fmtSci(this.norm.lo)} → ${fmtSci(this.norm.hi)} ${FIELDS[this.state.field].unit}`;
    } catch (e) { /* 被跨窗口策略拦掉就算了 */ }
  }

  /* ---------------- 交互 ---------------- */
  setParam(k, v) { this.state[k] = v; this.update(); }

  attachToWire() {
    const solver = this.solver;
    if (!solver || !solver.n) return;
    let best = 0, bestP = -1;
    for (let k = 0; k < solver.n; k++) {
      const p = Math.abs(solver.eAx[k] * solver.cur[k]) * solver.len[k];
      if (p > bestP) { bestP = p; best = k; }
    }
    const i3 = 3 * best;
    const p0 = [solver.p0[i3], solver.p0[i3 + 1], solver.p0[i3 + 2]];
    const p1 = [solver.p1[i3], solver.p1[i3 + 1], solver.p1[i3 + 2]];
    const n = norm([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]);
    this.base = [
      ((p0[0] + p1[0]) / 2) * M2W,
      ((p0[1] + p1[1]) / 2) * M2W,
      ((p0[2] + p1[2]) / 2) * M2W,
    ];
    this.state.offset = 0;
    this.state.size = Math.max(this.conductorR * M2W * 4.5, 0.15);
    this.state.pitch = Math.asin(Math.max(-1, Math.min(1, n[1]))) / DEG;
    this.state.yaw = Math.atan2(n[0], n[2]) / DEG;
    this.syncInputs();
    this.update();
  }

  syncInputs() {
    const s = this.state;
    this.dom.pos.value = String(Math.round(s.offset * 20));
    this.dom.yaw.value = String(Math.round(((s.yaw % 360) + 360) % 360));
    this.dom.pitch.value = String(Math.round(s.pitch));
    this.dom.size.value = String(Math.round(s.size * 10));
    this.dom.offsetLabel.textContent = `${s.offset.toFixed(2)} 格`;
    this.dom.sizeLabel.textContent = `${s.size.toFixed(2)} 格`;
  }

  _bindDom() {
    const d = this.dom;
    d.pos.addEventListener('input', (e) => {
      this.state.offset = +e.target.value / 20;
      d.offsetLabel.textContent = `${this.state.offset.toFixed(2)} 格`;
      this.update();
    });
    d.yaw.addEventListener('input', (e) => { this.state.yaw = +e.target.value; this.update(); });
    d.pitch.addEventListener('input', (e) => { this.state.pitch = +e.target.value; this.update(); });
    d.size.addEventListener('input', (e) => {
      this.state.size = +e.target.value / 10;
      d.sizeLabel.textContent = `${this.state.size.toFixed(2)} 格`;
      this.update();
    });
    d.field.addEventListener('change', (e) => { this.state.field = e.target.value; this.update(); });
    d.axisButtons.forEach((b) => b.addEventListener('click', () => {
      const a = b.dataset.axis;
      if (a === 'x') { this.state.pitch = 0; this.state.yaw = 90; }
      else if (a === 'y') { this.state.pitch = 90; this.state.yaw = 0; }
      else { this.state.pitch = 0; this.state.yaw = 0; }
      d.axisButtons.forEach((x) => x.classList.toggle('active', x === b));
      this.syncInputs();
      this.update();
    }));
    d.wireBtn.addEventListener('click', () => this.attachToWire());
    d.popBtn.addEventListener('click', () => this.openPopup());
    d.closeBtn.addEventListener('click', () => this.show(false));
    d.canvas.addEventListener('mousemove', (e) => this.probe(e));
    d.canvas.addEventListener('mouseleave', () => { d.probe.textContent = ''; });

    // 拖动标题栏移动窗口
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
  }

  probe(e) {
    if (!this.values) return;
    const r = this.dom.canvas.getBoundingClientRect();
    const u = (e.clientX - r.left) / r.width;
    const v = (e.clientY - r.top) / r.height;
    const N = this.valueN;
    const i = Math.min(N - 1, Math.max(0, Math.floor(u * N)));
    const j = Math.min(N - 1, Math.max(0, Math.floor((1 - v) * N)));
    const val = this.values[j * N + i];
    const du = (u * 2 - 1) * this.state.size;
    const dv = (v * 2 - 1) * this.state.size;
    this.dom.probe.textContent =
      `(${du.toFixed(2)}, ${dv.toFixed(2)}) → ${fmtSci(val)} ${FIELDS[this.state.field].unit}`;
  }
}
