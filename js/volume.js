/**
 * volume.js —— 「截空间」：框选一块体积，体渲染 / 最大强度投影
 *
 * 结构：
 *   VolumeTool   持有状态（中心、三轴尺寸、场、模式、阈值…）和 N³ 标量网格
 *   VolumeView   一个显示视图 = 一块画布 + 一整套控件；view.hi 决定渲染精度倍率
 *
 * 页内面板是 hi=1 的视图（小、快），「独立窗口」里是 hi≈1.7 的视图（大、细），
 * 两者共用同一份网格和同一套渲染代码 —— 除了精度，行为完全一致。
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

const POPUP_CSS = `
html,body{margin:0;background:#04070b;color:#dbe6f2;
  font:13px/1.5 'Segoe UI','Microsoft YaHei',sans-serif}
.popwrap{width:100%;max-width:920px;margin:0 auto;padding:0 14px 18px;box-sizing:border-box}
.sw-head{display:flex;align-items:center;justify-content:space-between;padding:12px 2px 10px;
  border-bottom:1px solid #16202c}
.sw-title{font-size:13px;color:#7d8fa6}
.sw-title b{color:#9fc6ea;font-weight:600}
.sw-btns button{padding:3px 9px;font-size:11px;border-radius:7px;
  border:1px solid #1d2836;background:#0f1620;color:#7d8fa6;cursor:pointer}
.sw-canvas{position:relative;margin-top:10px;background:#04070b;border-radius:8px;overflow:hidden}
.sw-canvas canvas{display:block;width:100%;height:auto;aspect-ratio:1/1}
.sw-res{position:absolute;right:8px;top:6px;font-size:10px;color:rgba(220,235,250,0.55);
  background:rgba(4,8,12,0.55);padding:1px 6px;border-radius:6px}
.sw-progress-wrap{position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(255,255,255,0.08)}
.sw-progress-wrap.hidden{display:none}
.sw-progress{height:100%;width:0;background:#58c4ff;transition:width .05s linear}
.sw-legend{margin-top:8px}
.sw-bar{height:8px;border-radius:5px;background:#16202c}
.sw-scale{display:flex;justify-content:space-between;font-size:10px;color:#64768b;margin-top:3px}
.sw-unit{font-size:10px;color:#47586c;text-align:right}
.sw-ctl{display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;margin-top:10px}
.sw-ctl label{display:flex;flex-direction:column;gap:2px;font-size:11px;color:#7d8fa6}
.sw-ctl label>span{display:flex;justify-content:space-between}
.sw-ctl i{color:#9fc6ea;font-style:normal;font-variant-numeric:tabular-nums}
.sw-foot{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}
.sw-foot select{flex:1 1 110px;padding:5px 7px;font-size:11.5px;background:#0c141d;color:#9fc6ea;
  border:1px solid #1d2836;border-radius:7px}
.sw-foot .ghost{padding:5px 10px;font-size:11.5px;border:1px solid #1d2836;background:#0f1620;
  color:#7d8fa6;border-radius:7px;cursor:pointer}
.sw-probe{font-size:10.5px;color:#6f8298}
input[type=range]{-webkit-appearance:none;appearance:none;height:3px;background:#22303f;
  border-radius:2px;outline:none;width:100%}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:13px;height:13px;
  border-radius:50%;background:#58c4ff;border:2px solid #0b121a;cursor:pointer}
`;

/* ================================================================== */
/** 一个显示视图：画布 + 一整套控件。页内面板和独立窗口各一个。 */
class VolumeView {
  constructor(tool, root, { hi = 1, isPopup = false } = {}) {
    this.tool = tool;
    this.root = root;
    this.hi = hi;
    this.isPopup = isPopup;
    this.gen = 0;
    const q = (id) => root.querySelector('[id="' + id + '"]');
    this.el = {
      head: q('vw-head'), title: q('vw-title'), canvas: q('vw-canvas'), res: q('vw-res'),
      progress: q('vw-progress'), progressWrap: q('vw-progress-wrap'),
      legend: q('vw-legend'), lo: q('vw-lo'), hi: q('vw-hi'), unit: q('vw-unit'),
      cx: q('vw-cx'), cy: q('vw-cy'), cz: q('vw-cz'),
      sx: q('vw-sx'), sy: q('vw-sy'), sz: q('vw-sz'),
      cxLabel: q('vw-cx-label'), cyLabel: q('vw-cy-label'), czLabel: q('vw-cz-label'),
      sxLabel: q('vw-sx-label'), syLabel: q('vw-sy-label'), szLabel: q('vw-sz-label'),
      yaw: q('vw-yaw'), pitch: q('vw-pitch'), gain: q('vw-gain'),
      thresh: q('vw-thresh'), threshLabel: q('vw-thresh-label'),
      field: q('vw-field'), mode: q('vw-mode'), resSel: q('vw-res-sel'),
      popBtn: q('vw-pop'), closeBtn: q('vw-close'), reBtn: q('vw-re'),
      probe: q('vw-probe'),
    };
    this.bind();
  }

  get imgRes() {
    return Math.max(120, Math.round(this.tool.state.imgRes * this.hi));
  }

  render() { this.tool.renderView(this); }

  sync() {
    const s = this.tool.state, e = this.el;
    const set = (k, v) => { if (e[k] && e[k].value !== String(v)) e[k].value = String(v); };
    set('cx', Math.round(s.cx * 20));
    set('cy', Math.round(s.cy * 20));
    set('cz', Math.round(s.cz * 20));
    set('sx', Math.round(s.sx * 10));
    set('sy', Math.round(s.sy * 10));
    set('sz', Math.round(s.sz * 10));
    set('yaw', Math.round(s.yaw));
    set('pitch', Math.round(s.pitch));
    set('gain', Math.round(s.gain * 100));
    set('thresh', Math.round(s.thresh * 100));
    if (e.cxLabel) e.cxLabel.textContent = s.cx.toFixed(2);
    if (e.cyLabel) e.cyLabel.textContent = s.cy.toFixed(2);
    if (e.czLabel) e.czLabel.textContent = s.cz.toFixed(2);
    if (e.sxLabel) e.sxLabel.textContent = (s.sx * 2).toFixed(2);
    if (e.syLabel) e.syLabel.textContent = (s.sy * 2).toFixed(2);
    if (e.szLabel) e.szLabel.textContent = (s.sz * 2).toFixed(2);
    if (e.threshLabel) e.threshLabel.textContent = s.thresh.toFixed(2);
    if (e.field) e.field.value = s.field;
    if (e.mode) e.mode.value = s.mode;
    if (e.resSel) e.resSel.value = String(s.res);
  }

  bind() {
    const t = this.tool, e = this.el, s = t.state;
    const onCenter = (axis, label) => (ev) => {
      s[axis] = +ev.target.value / 20;
      if (e[label]) e[label].textContent = s[axis].toFixed(2);
      t.recompute();
    };
    if (e.cx) e.cx.addEventListener('input', onCenter('cx', 'cxLabel'));
    if (e.cy) e.cy.addEventListener('input', onCenter('cy', 'cyLabel'));
    if (e.cz) e.cz.addEventListener('input', onCenter('cz', 'czLabel'));

    const onSize = (axis, label) => (ev) => {
      s[axis] = +ev.target.value / 10;
      if (e[label]) e[label].textContent = (s[axis] * 2).toFixed(2);
      t.recompute();
    };
    if (e.sx) e.sx.addEventListener('input', onSize('sx', 'sxLabel'));
    if (e.sy) e.sy.addEventListener('input', onSize('sy', 'syLabel'));
    if (e.sz) e.sz.addEventListener('input', onSize('sz', 'szLabel'));

    // 视角 / 不透明度 / 阈值只影响成像，不重采网格
    if (e.yaw) e.yaw.addEventListener('input', (ev) => { s.yaw = +ev.target.value; t.refreshAll(); });
    if (e.pitch) e.pitch.addEventListener('input', (ev) => { s.pitch = +ev.target.value; t.refreshAll(); });
    if (e.gain) e.gain.addEventListener('input', (ev) => { s.gain = +ev.target.value / 100; t.refreshAll(); });
    if (e.thresh) e.thresh.addEventListener('input', (ev) => {
      s.thresh = +ev.target.value / 100;
      if (e.threshLabel) e.threshLabel.textContent = s.thresh.toFixed(2);
      t.refreshAll();
    });
    if (e.field) e.field.addEventListener('change', (ev) => { s.field = ev.target.value; t.recompute(); });
    if (e.mode) e.mode.addEventListener('change', (ev) => { s.mode = ev.target.value; t.refreshAll(); });
    if (e.resSel) e.resSel.addEventListener('change', (ev) => {
      s.res = +ev.target.value;
      s.imgRes = Math.min(520, Math.round(220 + s.res * 2.6));
      t.recompute();
    });
    if (e.reBtn) e.reBtn.addEventListener('click', () => t.recompute());

    if (e.popBtn && !this.isPopup) e.popBtn.addEventListener('click', () => t.openPopup());
    if (e.closeBtn) {
      if (this.isPopup) e.closeBtn.addEventListener('click', () => window.close());
      else e.closeBtn.addEventListener('click', () => t.show(false));
    }

    // 画布上拖动 = 旋转视角
    if (e.canvas) {
      let rot = null;
      e.canvas.addEventListener('pointerdown', (ev) => {
        rot = { x: ev.clientX, y: ev.clientY, yaw: s.yaw, pitch: s.pitch };
        e.canvas.setPointerCapture(ev.pointerId);
      });
      e.canvas.addEventListener('pointermove', (ev) => {
        if (!rot) return;
        s.yaw = (rot.yaw - (ev.clientX - rot.x) * 0.5 + 360) % 360;
        s.pitch = Math.max(-85, Math.min(85, rot.pitch + (ev.clientY - rot.y) * 0.5));
        t.syncViews();
        t.refreshAll();
      });
      e.canvas.addEventListener('pointerup', () => { rot = null; });
    }

    // 页内面板可以拖动标题栏
    if (e.head && !this.isPopup) {
      let drag = null;
      e.head.addEventListener('pointerdown', (ev) => {
        if (ev.target.tagName === 'BUTTON' || ev.target.tagName === 'SELECT') return;
        drag = { x: ev.clientX, y: ev.clientY, l: this.root.offsetLeft, t: this.root.offsetTop };
        e.head.setPointerCapture(ev.pointerId);
      });
      e.head.addEventListener('pointermove', (ev) => {
        if (!drag) return;
        this.root.style.left = drag.l + (ev.clientX - drag.x) + 'px';
        this.root.style.top = drag.t + (ev.clientY - drag.y) + 'px';
        this.root.style.right = 'auto';
      });
      e.head.addEventListener('pointerup', () => { drag = null; });
    }
  }
}

/* ================================================================== */
export class VolumeTool {
  constructor(scene3d, winEl) {
    this.scene3d = scene3d;
    this.winEl = winEl;
    this.solver = null;
    this.bounds = null;
    this.views = [];
    this.popup = null;

    this.state = {
      cx: 0, cy: 0.4, cz: 0,        // 中心（相对电路中心的偏移）
      sx: 2.6, sy: 2.6, sz: 2.6,    // 三轴半边长 —— 长宽高可以分别调
      field: 'S',
      mode: 'volume',
      res: 64,
      imgRes: 386,
      yaw: 32, pitch: 46,
      gain: 1.0,
      thresh: 0.5,
      visible: false,
    };

    this.grid = null;
    this.gridN = 0;
    this.norm = null;
    this.genGrid = 0;

    this.group = new THREE.Group();
    this.group.visible = false;
    scene3d.scene.add(this.group);
    this._buildBox();

    this.mainView = new VolumeView(this, winEl, { hi: 1 });
    this.views.push(this.mainView);
  }

  /* ---------------- 三维线框 ---------------- */
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
      const bcx = (bounds.min[0] + bounds.max[0]) / 2;
      const bcz = (bounds.min[2] + bounds.max[2]) / 2;
      this._base = [bcx, 0, bcz];
      const span = Math.max(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2], 3);
      this.state.sx = this.state.sz = Math.max(1.4, span * 0.55);
      this.state.sy = Math.max(1.2, span * 0.4);
      this._fitted = true;
      this.syncViews();
    }
    this.update();
  }

  show(v) {
    this.state.visible = v;
    this.group.visible = v;
    this.winEl.classList.toggle('hidden', !v);
    if (!v) { this.genGrid++; for (const view of this.views) view.gen++; return; }
    this.syncViews();
    this.update();
  }

  get center() {
    const b = this._base || [0, 0, 0];
    return [b[0] + this.state.cx, b[1] + this.state.cy, b[2] + this.state.cz];
  }

  syncViews() { for (const v of this.views) v.sync(); }

  /* ---------------- 三维线框尺寸 ---------------- */
  update() {
    if (!this.state.visible || !this.solver) return;
    const { sx, sy, sz } = this.state;
    const key = `${sx.toFixed(2)}|${sy.toFixed(2)}|${sz.toFixed(2)}`;
    if (key !== this._boxKey) {
      this.box.geometry.dispose();
      this.edges.geometry.dispose();
      const g = new THREE.BoxGeometry(2 * sx, 2 * sy, 2 * sz);
      this.box.geometry = g;
      this.edges.geometry = new THREE.EdgesGeometry(g);
      this._boxKey = key;
    }
    const c = this.center;
    this.box.position.set(...c);
    this.edges.position.set(...c);
    this.recompute();
  }

  /* ---------------- 1) 采网格 ---------------- */
  recompute() {
    if (!this.state.visible || !this.solver) return;
    const N = this.state.res;
    const gen = ++this.genGrid;
    const c = this.center;
    const { sx, sy, sz } = this.state;
    const vals = new Float32Array(N * N * N);

    for (const view of this.views) {
      if (view.el.progressWrap) view.el.progressWrap.classList.remove('hidden');
      if (view.el.progress) view.el.progress.style.width = '0%';
    }

    let k = 0;
    const step = () => {
      if (gen !== this.genGrid) return;
      const t0 = performance.now();
      while (k < N && performance.now() - t0 < 14) {
        this._gridSlice(vals, k, N, c, sx, sy, sz);
        k++;
      }
      for (const view of this.views) {
        if (view.el.progress) view.el.progress.style.width = ((k / N) * 100).toFixed(0) + '%';
      }
      if (k < N) { requestAnimationFrame(step); return; }
      this.grid = vals;
      this.gridN = N;
      this.norm = this._makeNorm(vals);
      this.refreshAll();
    };
    requestAnimationFrame(step);
  }

  _gridSlice(vals, k, N, c, sx, sy, sz) {
    const { solver } = this;
    const field = this.state.field;
    const E = [0, 0, 0], B = [0, 0, 0];
    const nn = N * N;
    const dx = (2 * sx) / N, dy = (2 * sy) / N, dz = (2 * sz) / N;
    const z = c[2] - sz + (k + 0.5) * dz;
    for (let j = 0; j < N; j++) {
      const y = c[1] - sy + (j + 0.5) * dy;
      const row = k * nn + j * N;
      for (let i = 0; i < N; i++) {
        const x = c[0] - sx + (i + 0.5) * dx;
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

  refreshAll() { for (const v of this.views) this.renderView(v); }

  /* ---------------- 2) 体渲染（每个视图各自一份精度） ---------------- */
  renderView(view) {
    if (!this.state.visible || !this.grid) return;
    const gen = ++view.gen;
    const N = this.gridN;
    const I = view.imgRes;
    const img = new Uint8ClampedArray(I * I * 4);
    if (view.el.progressWrap) view.el.progressWrap.classList.remove('hidden');
    if (view.el.res) view.el.res.textContent = `${N}³ → ${I}²`;

    const cam = this._camera(I, view);
    let y = 0;
    const step = () => {
      if (gen !== view.gen) return;
      const t0 = performance.now();
      while (y < I && performance.now() - t0 < 14) {
        this._marchRow(img, y, I, cam, N);
        y++;
      }
      if (view.el.progress) view.el.progress.style.width = ((y / I) * 100).toFixed(0) + '%';
      if (y < I) { requestAnimationFrame(step); return; }
      this._paint(view, img, I);
    };
    requestAnimationFrame(step);
  }

  _camera(I, view) {
    const yaw = this.state.yaw * DEG, pitch = this.state.pitch * DEG;
    const d = [-Math.cos(pitch) * Math.sin(yaw), -Math.sin(pitch), -Math.cos(pitch) * Math.cos(yaw)];
    const up0 = Math.abs(d[1]) > 0.98 ? [0, 0, 1] : [0, 1, 0];
    const right = norm(cross(d, up0));
    const up = cross(right, d);
    const { sx, sy, sz } = this.state;
    const c = this.center;
    const hImg = Math.max(sx, sy, sz) * 1.12;         // 成像半宽
    const D = (sx + sy + sz) * 1.15;                  // 从盒外开始
    const steps = Math.max(48, Math.round(this.gridN * 1.4 * Math.min(1.6, view.hi)));
    const dt = (2 * D) / steps;
    return { d, right, up, c, hImg, D, steps, dt, sx, sy, sz };
  }

  _marchRow(img, y, I, cam, N) {
    const { d, right, up, c, hImg, D, steps, dt, sx, sy, sz } = cam;
    const grid = this.grid;
    const normer = this.norm;
    const gain = this.state.gain;
    const thresh = this.state.thresh;
    const invThresh = 1 / Math.max(0.05, 1 - thresh);
    const mip = this.state.mode === 'mip';
    const nn = N * N;
    const x0 = c[0] - sx, y0 = c[1] - sy, z0 = c[2] - sz;
    const ix2 = (N - 1) / (2 * sx), iy2 = (N - 1) / (2 * sy), iz2 = (N - 1) / (2 * sz);
    const lim = N - 1.001;

    for (let x = 0; x < I; x++) {
      const u = ((x + 0.5) / I * 2 - 1) * hImg;
      const v = (1 - (y + 0.5) / I * 2) * hImg;
      const ox = c[0] + right[0] * u + up[0] * v - d[0] * D;
      const oy = c[1] + right[1] * u + up[1] * v - d[1] * D;
      const oz = c[2] + right[2] * u + up[2] * v - d[2] * D;

      let cr = 0, cg = 0, cb = 0, A = 0, best = 0;

      for (let s = 0; s < steps; s++) {
        const px = ox + d[0] * s * dt;
        const py = oy + d[1] * s * dt;
        const pz = oz + d[2] * s * dt;
        const gx = (px - x0) * ix2, gy = (py - y0) * iy2, gz = (pz - z0) * iz2;
        if (gx < 0 || gy < 0 || gz < 0 || gx > lim || gy > lim || gz > lim) continue;

        const bx = gx | 0, by = gy | 0, bz = gz | 0;
        const fx = gx - bx, fy = gy - by, fz = gz - bz;
        const b = bz * nn + by * N + bx;
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
          const vv = normer.kind === 'signed'
            ? normer.lo + (normer.hi - normer.lo) * best
            : Math.pow(10, Math.log10(Math.max(normer.lo, 1e-30)) +
                best * (Math.log10(Math.max(normer.hi, 1e-29)) - Math.log10(Math.max(normer.lo, 1e-30))));
          const col = normer.color(vv);
          img[o] = col[0] * 255;
          img[o + 1] = col[1] * 255;
          img[o + 2] = col[2] * 255;
          img[o + 3] = 255 * Math.min(1, 0.15 + best * 1.1);
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
  _paint(view, img, I) {
    const canvas = view.el.canvas;
    if (!canvas) return;
    canvas.width = I;
    canvas.height = I;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#04070b';
    ctx.fillRect(0, 0, I, I);
    const tmp = document.createElement('canvas');
    tmp.width = I; tmp.height = I;
    tmp.getContext('2d').putImageData(new ImageData(img, I, I), 0, 0);
    ctx.drawImage(tmp, 0, 0);

    if (view.el.progressWrap) view.el.progressWrap.classList.add('hidden');
    const f = FIELDS[this.state.field];
    const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => {
      const v = this.norm.kind === 'signed'
        ? this.norm.lo + (this.norm.hi - this.norm.lo) * t
        : Math.pow(10, Math.log10(Math.max(this.norm.lo, 1e-30)) +
            t * (Math.log10(Math.max(this.norm.hi, 1e-29)) - Math.log10(Math.max(this.norm.lo, 1e-30))));
      const c = this.norm.color(v);
      return `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
    });
    if (view.el.legend) view.el.legend.style.background = `linear-gradient(90deg, ${stops.join(',')})`;
    if (view.el.lo) view.el.lo.textContent = fmt(this.norm.lo);
    if (view.el.hi) view.el.hi.textContent = fmt(this.norm.hi);
    if (view.el.unit) view.el.unit.textContent = f.unit;
    if (view.el.title) view.el.title.textContent = `${f.label}${this.state.mode === 'mip' ? ' · MIP' : ' · 体渲染'}`;
    if (view.el.res) view.el.res.textContent = `${this.gridN}³ → ${I}²`;
  }

  /* ---------------- 4) 独立窗口：同一套 UI，更高精度 ---------------- */
  openPopup() {
    try {
      const w = window.open('', 'emlab-volume', 'width=980,height=1060');
      if (!w) return false;
      w.document.write(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
        <title>电磁场实验台 · 空间</title><style>${POPUP_CSS}</style></head>
        <body><div class="popwrap" id="pop-root">${this.winEl.innerHTML}</div></body></html>`);
      w.document.close();
      this.popup = w;
      const root = w.document.getElementById('pop-root');
      const popView = new VolumeView(this, root, { hi: 1.7, isPopup: true });
      if (!popView.el.canvas) {
        console.warn('独立窗口里没找到画布节点');
        w.close();
        return false;
      }
      const popBtn = root.querySelector('[id="vw-pop"]');
      if (popBtn) popBtn.remove();
      this.views = this.views.filter((v) => !v.isPopup);
      this.views.push(popView);
      popView.sync();
      popView.render();
      w.addEventListener('beforeunload', () => {
        this.views = this.views.filter((v) => v !== popView);
      });
      return true;
    } catch (e) {
      console.warn('独立窗口打开失败', e);
      return false;
    }
  }
}

function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
