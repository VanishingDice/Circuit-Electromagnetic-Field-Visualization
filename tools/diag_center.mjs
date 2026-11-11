/**
 * 检验场是否以导线轴心为中心（有无整体偏移）
 *   node tools/diag_center.mjs
 */
import { createDefaultCircuit, solveCircuit, buildScene, worldOf } from '../js/circuit.js';
import { MU0 } from '../js/field.js';

const c = createDefaultCircuit();
const sol = solveCircuit(c);
const sc = buildScene(c, sol, { wireRadius: 0.05 });
const s = sc.solver;

// 找一根最长的载流直导线
let best = -1, bestL = 0;
for (let k = 0; k < s.n; k++) {
  if (Math.abs(s.cur[k]) < 1e-6) continue;
  if (s.len[k] > bestL) { bestL = s.len[k]; best = k; }
}
const i3 = 3 * best;
const p0 = [s.p0[i3], s.p0[i3 + 1], s.p0[i3 + 2]];
const p1 = [s.p1[i3], s.p1[i3 + 1], s.p1[i3 + 2]];
const L = s.len[best];
const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2];
console.log(`选中线段 #${best}: p0=(${p0.map(v => (v * 1000).toFixed(2)).join(', ')}) mm, L=${(L * 1000).toFixed(2)} mm, I=${(s.cur[best] * 1000).toFixed(1)} mA`);

const u = [(p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L, (p1[2] - p0[2]) / L];
const ref = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
const e1 = (() => {
  const c0 = [u[1] * ref[2] - u[2] * ref[1], u[2] * ref[0] - u[0] * ref[2], u[0] * ref[1] - u[1] * ref[0]];
  const l = Math.hypot(...c0) || 1;
  return c0.map((v) => v / l);
})();
const e2 = [u[1] * e1[2] - u[2] * e1[1], u[2] * e1[0] - u[0] * e1[2], u[0] * e1[1] - u[1] * e1[0]];

const B = [0, 0, 0];
const Bmag = (du, dv, along = 0) => {
  const p = [
    mid[0] + e1[0] * du + e2[0] * dv + u[0] * along,
    mid[1] + e1[1] * du + e2[1] * dv + u[1] * along,
    mid[2] + e1[2] * du + e2[2] * dv + u[2] * along,
  ];
  s.bField(p[0], p[1], p[2], B);
  return Math.hypot(...B);
};

console.log('\n== 轴心处 |B| 应该是 0（磁场绕轴） ==');
for (const r of [0, 0.1, 0.2, 0.4, 0.8]) {
  const rmm = r / 1000;
  console.log(`  沿轴偏移 ${(r * 1000).toFixed(0)} mm 处 |B| = ${Bmag(0, 0, r).toExponential(3)} T`);
}

console.log('\n== 垂直截面上的 |B| 分布（应关于轴心对称，峰值圆环） ==');
for (const rmm of [0.5, 1, 2]) {
  const r = rmm / 1000;
  const vals = [];
  for (let k = 0; k < 8; k++) {
    const th = k / 8 * Math.PI * 2;
    vals.push(Bmag(r * Math.cos(th), r * Math.sin(th)));
  }
  const mn = Math.min(...vals), mx = Math.max(...vals);
  console.log(`  r=${rmm}mm: |B| ∈ [${mn.toExponential(3)}, ${mx.toExponential(3)}]，变化 ${((mx - mn) / mx * 100).toFixed(1)}%`);
}

// 用二分找 |B| 在一条穿过轴心的直线上 的极小值位置，看它是否就在轴心
function findMin(dir) {
  let lo = -0.004, hi = 0.004;
  for (let it = 0; it < 60; it++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    const v1 = Bmag(dir[0] * m1, dir[1] * m1);
    const v2 = Bmag(dir[0] * m2, dir[1] * m2);
    if (v1 < v2) hi = m2; else lo = m1;
  }
  return (lo + hi) / 2;
}
console.log('\n== 极小值位置（应为 0） ==');
console.log(`  沿 e1: ${(findMin([1, 0]) * 1000).toFixed(4)} mm`);
console.log(`  沿 e2: ${(findMin([0, 1]) * 1000).toFixed(4)} mm`);

// 再核对：几何图元里的导线是否与求解器里的线段重合
console.log('\n== 图元 vs 求解线段 ==');
const tubes = sc.parts.filter((p) => p.kind === 'tube' && p.mat === 'copper');
const tubeA = tubes.map((t) => t.pts[0]);
let maxDist = 0;
for (const a of tubeA) {
  // 找最近的线段端点
  let d = Infinity;
  for (let k = 0; k < s.n; k++) {
    const q = [s.p0[3 * k], s.p0[3 * k + 1], s.p0[3 * k + 2]];
    d = Math.min(d, Math.hypot((a[0] * 0.01) - q[0], (a[1] * 0.01) - q[1], (a[2] * 0.01) - q[2]));
  }
  maxDist = Math.max(maxDist, d);
}
console.log(`  图元端点与最近求解线段端点的最大距离 = ${(maxDist * 1000).toFixed(4)} mm`);
