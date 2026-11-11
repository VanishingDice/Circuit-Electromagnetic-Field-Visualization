/**
 * 诊断：① 电阻附近场在什么半径处突变 ② 电阻周围的能流指向
 *   node tools/diag_resistor.mjs
 */
import { createDefaultCircuit, solveCircuit, buildScene, worldOf } from '../js/circuit.js';
import { MU0 } from '../js/field.js';

const c = createDefaultCircuit();
const sol = solveCircuit(c);
const sc = buildScene(c, sol, { wireRadius: 0.05 });
const s = sc.solver;

// 找一根沿 x 方向的普通导线（半径 0.5mm）
let bodyK = -1, bestDot = 0;
for (let k = 0; k < s.n; k++) {
  if (Math.abs(s.cur[k]) < 1e-6) continue;
  if (Math.abs(s.rad[k] - 0.0005) > 1e-6) continue;
  const dx = s.p1[3 * k] - s.p0[3 * k], dz = s.p1[3 * k + 2] - s.p0[3 * k + 2];
  const L = Math.hypot(dx, dz) || 1;
  if (Math.abs(dx) / L > bestDot) { bestDot = Math.abs(dx) / L; bodyK = k; }
}
const i3 = 3 * bodyK;
const p0 = [s.p0[i3], s.p0[i3 + 1], s.p0[i3 + 2]];
const p1 = [s.p1[i3], s.p1[i3 + 1], s.p1[i3 + 2]];
const L = s.len[bodyK];
const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2];
console.log(`电阻本体段 #${bodyK}: L=${(L * 1000).toFixed(2)} mm，物理/显示半径 ${(s.rad[bodyK] * 1000).toFixed(2)} mm`);
console.log(`边界元细线半径 = ${(s.wireRadius * 1000).toFixed(2)} mm`);

// ---------- ① 沿径向扫描 |E|，看有没有台阶 ----------
const E = [0, 0, 0];
console.log('\n① 从轴心向外扫 |E|（沿 +y）:');
let prev = null;
for (let rmm = 0.2; rmm <= 4.0; rmm += 0.1) {
  const r = rmm / 1000;
  s.eField(mid[0], mid[1] + r, mid[2], E);
  const mag = Math.hypot(...E);
  if (prev !== null && Math.abs(Math.log(mag / prev)) > 0.35) {
    console.log(`   ⚠ r=${rmm.toFixed(1)} mm 处跳变 ${prev.toFixed(2)} → ${mag.toFixed(2)} V/m（×${(mag / prev).toFixed(2)}）`);
  }
  prev = mag;
}
console.log('  （只打印跳变超过 1.4 倍的位置）');

// ---------- ② 电阻周围的能流方向 ----------
const B = [0, 0, 0];
const Sat = (p) => {
  s.eField(p[0], p[1], p[2], E);
  s.bField(p[0], p[1], p[2], B);
  return [
    (E[1] * B[2] - E[2] * B[1]) / MU0,
    (E[2] * B[0] - E[0] * B[2]) / MU0,
    (E[0] * B[1] - E[1] * B[0]) / MU0,
  ];
};
const u = [(p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L, (p1[2] - p0[2]) / L];
console.log('\n② 沿电阻长度方向（轴向 x）在半径 2mm 处采样 S：');
console.log('   位置(沿轴 mm)   S_axial(W/m²)   S_径向(W/m²)   角度(偏离径向)');
for (let t = -0.3; t <= 1.31; t += 0.2) {
  // 沿整个电阻（含引线）取点
  const px = mid[0] + u[0] * t * L, py = mid[1] + 0.002, pz = mid[2] + u[2] * t * L;
  const S = Sat([px, py, pz]);
  const axial = S[0] * u[0] + S[2] * u[2];
  const radial = S[1];      // +y 是径向向外
  const ang = Math.atan2(axial, -radial) * 180 / Math.PI;
  console.log(`   ${(t * L * 1000).toFixed(1).padStart(8)}      ${axial.toFixed(1).padStart(9)}      ${radial.toFixed(1).padStart(9)}      ${ang.toFixed(0).padStart(5)}°`);
}
console.log('   （角度 0° = 纯向内，±90° = 纯轴向，>90° = 向外）');
