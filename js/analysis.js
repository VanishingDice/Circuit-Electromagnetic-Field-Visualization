/**
 * analysis.js —— 剖面分析：在垂直于某段导线的截面上画场
 *
 * 这是唯一能看清「导线内部」的地方：
 *   内部 E 沿着导线（由电阻/电源决定），内部 B 绕轴、随半径线性增大，
 *   于是 S = E×B 指向轴心——导体自身的发热就是这么来的。
 * 截面上把 |S| 画成热图，再用箭头标出方向。
 */
import { MU0 } from './field.js';

const W2M = 0.01;

export class AnalysisCard {
  constructor(el, { onCycle } = {}) {
    this.el = el;
    this.canvas = el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.onCycle = onCycle || (() => {});
    this.solver = null;
    this.radius = 0.0005;
    this.segIndex = -1;
    this.candidates = [];
    el.querySelector('.an-cycle')?.addEventListener('click', () => this.cycle());
    this.infoEl = el.querySelector('.an-info');
    this.statsEl = el.querySelector('.an-stats');
  }

  setData({ solver, radius }) {
    this.solver = solver;
    this.radius = radius;
    this.candidates = [];
    for (let k = 0; k < solver.n; k++) {
      const L = solver.len[k];
      const p = Math.abs(solver.eAx[k] * solver.cur[k]) * L;  // 该段功率
      if (L > 1e-6) this.candidates.push({ k, score: p });
    }
    this.candidates.sort((a, b) => b.score - a.score);
    if (this.segIndex < 0 || this.segIndex >= solver.n) this.segIndex = this.candidates[0]?.k ?? 0;
    this.render();
  }

  cycle() {
    if (!this.candidates.length) return;
    const idx = this.candidates.findIndex((c) => c.k === this.segIndex);
    this.segIndex = this.candidates[(idx + 1) % this.candidates.length].k;
    this.render();
  }

  render() {
    const s = this.solver;
    if (!s || !s.n) return;
    const k = this.segIndex;
    const a = this.radius;
    const size = this.canvas.width;
    const R = a * 5.2;          // 视野半宽：导线半径的 5 倍
    const N = 128;

    // 截面基向量
    const i3 = 3 * k;
    const p0 = [s.p0[i3], s.p0[i3 + 1], s.p0[i3 + 2]];
    const p1 = [s.p1[i3], s.p1[i3 + 1], s.p1[i3 + 2]];
    const L = s.len[k] || 1e-9;
    const u = [(p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L, (p1[2] - p0[2]) / L];
    const ref = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const e1 = norm(cross(u, ref));
    const e2 = cross(u, e1);
    const mid = [0.5 * (p0[0] + p1[0]), 0.5 * (p0[1] + p1[1]), 0.5 * (p0[2] + p1[2])];

    // 采样 |S|
    const E = [0, 0, 0], B = [0, 0, 0];
    const vals = new Float32Array(N * N);
    const mags = [];
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const s1 = ((i + 0.5) / N * 2 - 1) * R;
        const s2 = ((j + 0.5) / N * 2 - 1) * R;
        const px = mid[0] + e1[0] * s1 + e2[0] * s2;
        const py = mid[1] + e1[1] * s1 + e2[1] * s2;
        const pz = mid[2] + e1[2] * s1 + e2[2] * s2;
        s.eField(px, py, pz, E);
        s.bField(px, py, pz, B);
        const sx = (E[1] * B[2] - E[2] * B[1]) / MU0;
        const sy = (E[2] * B[0] - E[0] * B[2]) / MU0;
        const sz = (E[0] * B[1] - E[1] * B[0]) / MU0;
        const m = Math.hypot(sx, sy, sz);
        vals[j * N + i] = isFinite(m) ? m : 0;
        if (m > 0 && isFinite(m)) mags.push(m);
      }
    }
    mags.sort((x, y) => x - y);
    const lo = mags[Math.floor(mags.length * 0.02)] || 1e-6;
    const hi = mags[Math.floor(mags.length * 0.98)] || lo * 100;
    const l0 = Math.log10(lo), l1 = Math.log10(Math.max(hi, lo * 10));
    const tOf = (v) => (v <= 0 ? 0 : Math.min(1, Math.max(0, (Math.log10(v) - l0) / (l1 - l0))));

    // 画热图
    const img = this.ctx.createImageData(N, N);
    for (let p = 0; p < N * N; p++) {
      const c = turbo(tOf(vals[p]));
      img.data[p * 4] = c[0] * 255;
      img.data[p * 4 + 1] = c[1] * 255;
      img.data[p * 4 + 2] = c[2] * 255;
      img.data[p * 4 + 3] = 255;
    }
    const off = document.createElement('canvas');
    off.width = N; off.height = N;
    off.getContext('2d').putImageData(img, 0, 0);

    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, size, size);

    // 导线轮廓
    const cx = size / 2, cy = size / 2;
    const pxPerM = size / (2 * R);
    ctx.beginPath();
    ctx.arc(cx, cy, a * pxPerM, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, a * pxPerM * 1.0, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(120,200,255,0.35)';
    ctx.lineWidth = 5;
    ctx.stroke();

    // S 方向箭头
    const step = 10;
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 1;
    for (let j = step; j < N - step; j += step) {
      for (let i = step; i < N - step; i += step) {
        const s1 = ((i + 0.5) / N * 2 - 1) * R;
        const s2 = ((j + 0.5) / N * 2 - 1) * R;
        const px = mid[0] + e1[0] * s1 + e2[0] * s2;
        const py = mid[1] + e1[1] * s1 + e2[1] * s2;
        const pz = mid[2] + e1[2] * s1 + e2[2] * s2;
        s.eField(px, py, pz, E);
        s.bField(px, py, pz, B);
        const S = [
          (E[1] * B[2] - E[2] * B[1]) / MU0,
          (E[2] * B[0] - E[0] * B[2]) / MU0,
          (E[0] * B[1] - E[1] * B[0]) / MU0,
        ];
        const m = Math.hypot(S[0], S[1], S[2]);
        if (!(m > 0)) continue;
        // 投影到截面基底
        const dx = (S[0] * e1[0] + S[1] * e1[1] + S[2] * e1[2]) / m;
        const dy = (S[0] * e2[0] + S[1] * e2[1] + S[2] * e2[2]) / m;
        const len = Math.hypot(dx, dy);
        if (len < 0.15) continue;    // 几乎垂直截面，画了也看不出
        const x = (i + 0.5) / N * size, y = (j + 0.5) / N * size;
        const ux = (dx / len) * 5, uy = (dy / len) * 5;
        ctx.beginPath();
        ctx.moveTo(x - ux, y - uy);
        ctx.lineTo(x + ux, y + uy);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x + ux, y + uy, 1.4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.fill();
      }
    }

    // 文字
    ctx.fillStyle = 'rgba(230,240,250,0.9)';
    ctx.font = '600 11px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    // 内部 S 的径向分量符号：-eAx·I > 0 表示朝外
    const outward = -this.solver.eAx[k] * this.solver.cur[k] > 0;
    ctx.fillText(outward ? '内部 S 朝外（电源）' : '内部 S 朝轴心（耗散）', 8, size - 10);
    ctx.textAlign = 'right';
    ctx.fillText(`${(R * 1000).toFixed(2)} mm`, size - 8, size - 10);

    this.drawStats({ k, a, u, mid, E, B, vals, l0, l1, outward });
  }

  drawStats({ k, a, u, mid, E, B, vals, outward }) {
    const s = this.solver;
    const I = s.cur[k];
    const eAx = s.eAx[k];
    const Bsurf = (MU0 * Math.abs(I)) / (2 * Math.PI * a);
    const Ssurf = Math.abs(eAx) * Bsurf / MU0;
    const P = eAx * I * s.len[k];             // 正=耗散，负=供能
    const dir = outward ? '向外（供能）' : '指向轴心（耗散）';
    this.infoEl.innerHTML =
      `<b>${(s.len[k] * 1000).toFixed(1)} mm</b> 导线 · ` +
      `I <b>${(I * 1000).toFixed(1)}</b> mA · a <b>${(a * 1000).toFixed(2)}</b> mm`;
    this.statsEl.innerHTML =
      `内部 E∥ = <b>${eAx.toFixed(1)}</b> V/m<br>` +
      `表面 B = <b>${(Bsurf * 1e6).toFixed(2)}</b> µT<br>` +
      `表面 S = <b>${fmtSI(Ssurf)}</b> W/m² ${dir}<br>` +
      (P >= 0 ? `本段耗散 = <b>${fmtSI(P)}</b> W` : `本段输出 = <b>${fmtSI(-P)}</b> W`);
    // 画布左下角的注解跟着方向变
    this.dirLabel = dir;
  }
}

/* ---------------- 工具 ---------------- */
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }

export function fmtSI(v) {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a < 1e-6) return (v * 1e9).toFixed(2) + 'n';
  if (a < 1e-3) return (v * 1e6).toFixed(2) + 'µ';
  if (a < 1) return (v * 1e3).toFixed(2) + 'm';
  if (a < 1e3) return v.toFixed(2);
  if (a < 1e6) return (v / 1e3).toFixed(2) + 'k';
  return (v / 1e6).toFixed(2) + 'M';
}

const TURBO = [
  [0.02, [0.19, 0.07, 0.23]],
  [0.13, [0.27, 0.28, 0.66]],
  [0.26, [0.28, 0.47, 0.93]],
  [0.39, [0.23, 0.65, 0.99]],
  [0.52, [0.15, 0.83, 0.85]],
  [0.65, [0.19, 0.94, 0.59]],
  [0.78, [0.60, 0.99, 0.30]],
  [0.90, [0.95, 0.85, 0.17]],
  [1.00, [0.99, 0.53, 0.09]],
];

export function turbo(t) {
  t = Math.min(1, Math.max(0, t));
  for (let i = 1; i < TURBO.length; i++) {
    if (t <= TURBO[i][0]) {
      const [t0, c0] = TURBO[i - 1], [t1, c1] = TURBO[i];
      const f = (t - t0) / (t1 - t0 || 1);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return TURBO[TURBO.length - 1][1];
}
