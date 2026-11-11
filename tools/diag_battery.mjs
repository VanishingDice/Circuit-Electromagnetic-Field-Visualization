/**
 * 验证：电源附近 S 向外的物理含义
 *   node tools/diag_battery.mjs
 */
import { createSimpleLoop, solveCircuit, buildScene } from '../js/circuit.js';
import { MU0 } from '../js/field.js';

const c = createSimpleLoop();
const sol = solveCircuit(c);
const sc = buildScene(c, sol, { wireRadius: 0.05 });
const s = sc.solver;

// 找电池本体（两片极板之间的那段），取其中点
let bi = -1;
for (const el of c.elements) if (el.type === 'battery') bi = el;
console.log('电池 I =', (sol.elCurrent[bi.id] * 1000).toFixed(2), 'mA');

const E = [0, 0, 0], B = [0, 0, 0];
const Sat = (p) => {
  s.eField(p[0], p[1], p[2], E);
  s.bField(p[0], p[1], p[2], B);
  return [
    (E[1] * B[2] - E[2] * B[1]) / MU0,
    (E[2] * B[0] - E[0] * B[2]) / MU0,
    (E[0] * B[1] - E[1] * B[0]) / MU0,
  ];
};

// 电池段：找 eAx 最大（电压源内部）的段
let best = -1, bestV = 0;
for (let k = 0; k < s.n; k++) {
  const dv = Math.abs(s.pot0 ? 0 : 0);
}
// 直接用电池元件两端坐标求中点
const A = [0, 0, 0], Bp = [0, 0, 0];
const mid = [
  (bi.a[0] - 5.5) * 0.01,
  0,
  (bi.a[1] - 3.5) * 0.01,
];
const midB = [(bi.b[0] - 5.5) * 0.01, 0, (bi.b[1] - 3.5) * 0.01];
const bc = [(mid[0] + midB[0]) / 2, 0, (mid[2] + midB[2]) / 2];
const axis = [midB[0] - mid[0], 0, midB[2] - mid[2]];
const L = Math.hypot(axis[0], axis[2]);
const u = [axis[0] / L, 0, axis[2] / L];
const e1 = [u[2], 0, -u[0]];   // 垂直于轴、在平面内
console.log(`电池中点 (${(bc[0] * 100).toFixed(2)}, ${(bc[2] * 100).toFixed(2)}) mm，长度 ${(L * 1000).toFixed(1)} mm`);

console.log('\n距电池轴 2mm 处、绕一圈 8 个方位的 S 径向分量（正 = 向外）:');
let sum = 0;
for (let k = 0; k < 8; k++) {
  const th = k / 8 * Math.PI * 2;
  const r = 0.002;
  const p = [bc[0] + (e1[0] * Math.cos(th) + 0 * Math.sin(th)) * r + 0,
             0.002,
             bc[2] + (e1[2] * Math.cos(th)) * r];
  // 更简单：在垂直于轴的平面内取点（用 y 和 e1 两个方向）
  const p2 = [bc[0] + e1[0] * Math.cos(th) * r,
              Math.sin(th) * r,
              bc[2] + e1[2] * Math.cos(th) * r];
  const S = Sat(p2);
  // 径向单位向量（相对轴）
  const rad = [p2[0] - bc[0], p2[1], p2[2] - bc[2]];
  const rl = Math.hypot(...rad) || 1;
  const dot = (S[0] * rad[0] + S[1] * rad[1] + S[2] * rad[2]) / rl;
  sum += dot;
  console.log(`  θ=${(th * 180 / Math.PI).toFixed(0).padStart(3)}°  S·r̂ = ${dot.toExponential(2)}  ${dot > 0 ? '向外' : '向内'}`);
}
console.log(`\n平均 S·r̂ = ${(sum / 8).toExponential(2)}  →  ${sum > 0 ? '整体向外（电池在放能）' : '整体向内'}`);

// 对比：电阻表面
console.log('\n对照：电阻表面同样采样');
for (const el of c.elements) {
  if (el.type !== 'resistor') continue;
  const a = [(el.a[0] - 5.5) * 0.01, 0, (el.a[1] - 3.5) * 0.01];
  const b = [(el.b[0] - 5.5) * 0.01, 0, (el.b[1] - 3.5) * 0.01];
  const rc = [(a[0] + b[0]) / 2, 0, (a[2] + b[2]) / 2];
  let ssum = 0;
  for (let k = 0; k < 8; k++) {
    const th = k / 8 * Math.PI * 2;
    const r = 0.002;
    const p = [rc[0], Math.sin(th) * r, rc[2] + Math.cos(th) * r];
    const S = Sat(p);
    const rad = [0, p[1], p[2] - rc[2]];
    const rl = Math.hypot(...rad) || 1;
    ssum += (S[0] * rad[0] + S[1] * rad[1] + S[2] * rad[2]) / rl;
  }
  console.log(`  电阻平均 S·r̂ = ${(ssum / 8).toExponential(2)} → ${ssum < 0 ? '整体向内（吸收能量）' : '整体向外'}`);
}
