/**
 * 精度基准：双平行导线电容 vs 解析解
 *   解析：两根半径 a、间距 d（轴向）、长度远大于 d 时
 *        C' = π ε0 / ln(d/a)      [F/m]
 *   node tools/bench_cap.mjs
 */
import { FieldSolver } from '../js/field.js';

const EPS0 = 8.8541878128e-12;
const KE = 1 / (4 * Math.PI * EPS0);

/**
 * 用现有细线 BEM 算：两根平行导线，电位 ±V，求单位长度电容。
 * @param a  导线半径（米）
 * @param d  两轴间距（米）
 * @param L  长度（米）
 * @param segLen 分段长度（米）
 */
function thinWireCap(a, d, L, segLen) {
  const fs = new FieldSolver(a);
  const n = Math.max(2, Math.round(L / segLen));
  const h = L / n;
  // + 导线（沿 z），电位 +V
  for (let k = 0; k < n; k++) {
    const z0 = -L / 2 + k * h;
    fs.add([-d / 2, 0, z0], [-d / 2, 0, z0 + h], 0, 0);
    fs.add([d / 2, 0, z0], [d / 2, 0, z0 + h], 0, 0);
  }
  // 手动设定电位：+V / −V（用 vpot 直接改）
  const m = fs._pot.length;
  for (let i = 0; i < m; i++) fs._pot[i] = i < n ? 1 : -1;
  fs.build();
  fs.solve();
  let q = 0;
  for (let i = 0; i < n; i++) q += fs.lam[i] * fs.len[i];
  return { C: q / 2 / L, note: `n=${n}, 段长 ${(h * 1000).toFixed(2)}mm` };  // V=1V → Q=C·ΔV, ΔV=2
}

const cases = [
  { a: 0.0002, d: 0.01, L: 0.3 },
  { a: 0.0001, d: 0.01, L: 0.3 },
];

for (const c of cases) {
  const dEff = c.d;
  const analytic = Math.PI * EPS0 / Math.log(dEff / c.a);
  console.log(`\n=== a=${(c.a * 1000).toFixed(2)}mm, d=${(c.d * 1000).toFixed(1)}mm, L=${(c.L * 1000).toFixed(0)}mm ===`);
  console.log(`  解析 C' = ${analytic.toExponential(4)} F/m`);
  for (const segLen of [0.012, 0.006, 0.003, 0.0016]) {
    if (segLen > c.L / 4 || segLen < 8 * c.a) continue;   // 细线近似要求 ℓ ≫ a
    const r = thinWireCap(c.a, c.d, c.L, segLen);
    const err = (r.C - analytic) / analytic * 100;
    console.log(`  细线 BEM ${r.note.padEnd(22)} C'=${r.C.toExponential(4)} 误差 ${err.toFixed(1).padStart(6)}%`);
  }
}
