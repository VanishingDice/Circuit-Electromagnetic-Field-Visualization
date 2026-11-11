/**
 * 核心自检（Node 直接跑，不依赖浏览器）
 *   node tools/test_core.mjs
 * 检查：MNA 工作点是否合理、场的量级、以及坡印廷矢量的方向（能量从电池流向电阻）。
 */
import { createDefaultCircuit, solveCircuit, buildScene, worldOf, key } from '../js/circuit.js';
import { MU0, KE } from '../js/field.js';

let fails = 0;
const ok = (cond, msg, extra = '') => {
  if (!cond) { fails++; console.log(`  ✗ ${msg} ${extra}`); }
  else console.log(`  ✓ ${msg} ${extra}`);
};
const close = (a, b, rel = 0.02) => Math.abs(a - b) <= rel * Math.max(Math.abs(b), 1e-30);

const c = createDefaultCircuit();
const sol = solveCircuit(c);
console.log('== MNA 工作点 ==');
const V = sol.nodeV;
for (const k of Object.keys(V).sort()) console.log(`  V(${k}) = ${V[k].toFixed(4)} V`);
const elV = Object.values(sol.elCurrent);
const elBattery = c.elements.find((e) => e.type === 'battery');
const elR = c.elements.find((e) => e.type === 'resistor');
const IB = sol.elCurrent[elBattery.id];
const IR = sol.elCurrent[elR.id];
console.log(`  电池电流 = ${IB.toFixed(5)} A, 电阻电流 = ${IR.toFixed(5)} A`);
ok(close(IB, 0.09, 0.05), '电池电流 ≈ 9/(100+小) A', `实际 ${IB.toFixed(5)}`);
ok(close(Math.abs(IR), Math.abs(IB), 1e-6), '串联电流处处相等');

const scene = buildScene(c, sol);
const { solver } = scene;
console.log('== 边界元 ==');
console.log(`  导体线段数 = ${solver.n}`);
ok(solver.n > 50, '导体离散数量合理');
ok(Math.abs(solver.netCharge) < 1e-14, '净电荷 ≈ 0', `${solver.netCharge.toExponential(2)} C`);
ok(solver.potShift !== undefined && isFinite(solver.potShift), '电位零点已标定');

console.log('== 场的量级 ==');
const tmp = [0, 0, 0];
// 导线周围 B：取底部导线 (3,1)-(1,1) 上方 5 mm
{
  const a = worldOf([3, 1]);
  const p = [a[0] * 0.01, 0.005, a[2] * 0.01];
  solver.bField(p[0], p[1], p[2], tmp);
  const B = Math.hypot(...tmp);
  const expect = (MU0 * Math.abs(IB)) / (2 * Math.PI * 0.005);
  console.log(`  |B| 导线附近 = ${B.toExponential(3)} T（无限长估算 ${expect.toExponential(3)}）`);
  ok(B > 0.2 * expect && B < 5 * expect, 'B 量级与无限长导线估算同阶');
}
// 电阻表面 E 的量级
{
  const a = worldOf([4, 4]);
  const p = [a[0] * 0.01, 0.004, a[2] * 0.01];
  solver.eField(p[0], p[1], p[2], tmp);
  console.log(`  |E| 电阻上方 = ${Math.hypot(...tmp).toFixed(2)} V/m`);
  ok(Math.hypot(...tmp) > 1, 'E 不为零');
}

console.log('== 坡印廷矢量方向（关键物理）==');
{
  // 电阻轴沿 x，所以「径向」是 ±y / ±z；取正上方 +y 的采样点
  const mid = worldOf([4, 4]);           // 电阻轴心（世界单位）
  const cx = mid[0] * 0.01, cz = mid[2] * 0.01;
  const rOut = 0.0035;                    // 距轴 3.5 mm
  const p = [cx, rOut, cz];
  const E = solver.eField(p[0], p[1], p[2], [0, 0, 0]);
  const B = solver.bField(p[0], p[1], p[2], [0, 0, 0]);
  const S = [(E[1] * B[2] - E[2] * B[1]) / MU0, (E[2] * B[0] - E[0] * B[2]) / MU0, (E[0] * B[1] - E[1] * B[0]) / MU0];
  const P = Math.abs(IR) ** 2 * elR.value;
  const area = 2 * Math.PI * rOut * 0.02;
  console.log(`  E = [${E.map((v) => v.toFixed(1)).join(', ')}] V/m`);
  console.log(`  B = [${B.map((v) => v.toExponential(2)).join(', ')}] T`);
  console.log(`  S = [${S.map((v) => v.toFixed(1)).join(', ')}] W/m²`);
  console.log(`  径向分量 S·r̂ = ${S[1].toFixed(1)} W/m²（应为负 = 流入导体）`);
  console.log(`  电阻耗散 ${P.toFixed(3)} W → 通过该柱面平均能流 ${(P / area).toFixed(1)} W/m²`);
  ok(S[1] < 0, '电阻外侧的能流指向导体内部');
}
{
  // 电池侧面：S 应指向外侧（能量从电池流出）
  const mid = worldOf([1, 3]);
  const p = [mid[0] * 0.01 + 0.006, 0, mid[2] * 0.01];
  const E = solver.eField(p[0], p[1], p[2], [0, 0, 0]);
  const B = solver.bField(p[0], p[1], p[2], [0, 0, 0]);
  const Sx = (E[1] * B[2] - E[2] * B[1]) / MU0;
  console.log(`  电池侧面的 S_x = ${Sx.toFixed(1)} W/m²（应为正 = 向外）`);
  ok(Sx > 0, '电池外侧能流向外（电池在供能）');
}

console.log('== 导体内部的场（剖面功能的基础）==');
{
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const normalize = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

  // 找电阻上一段（|E∥| 最大的一定是电阻，而不是电池的 -300）
  let best = -1, bestAbs = 0;
  for (let k = 0; k < solver.n; k++) {
    const a = Math.abs(solver.eAx[k]);
    if (a > bestAbs) { bestAbs = a; best = k; }
  }
  ok(best >= 0, '存在内部纵向电场最大的段（电阻）');
  const eAx = solver.eAx[best];
  const expectE = Math.abs(IR) * elR.value / 0.02;   // 100Ω 摊在 2 格 = 2 cm 上
  console.log(`  内部 E∥ = ${eAx.toFixed(1)} V/m，I·R/L = ${expectE.toFixed(1)} V/m`);
  ok(Math.abs(Math.abs(eAx) / expectE - 1) < 0.02, 'E∥ 与 I·R/L 一致');

  // 在导线内部取一点：B 应 = μ0·I·r/(2πa²)，S 应指向轴心
  const a = 0.0005;      // 画面导线半径 0.5 mm
  const sc2 = buildScene(c, sol, { wireRadius: 0.05 });
  const s2 = sc2.solver;
  let k2 = -1, bestAbs2 = 0;
  for (let k = 0; k < s2.n; k++) {
    const a = Math.abs(s2.eAx[k]);
    if (a > bestAbs2) { bestAbs2 = a; k2 = k; }
  }
  const i3 = 3 * k2;
  const p0 = [s2.p0[i3], s2.p0[i3 + 1], s2.p0[i3 + 2]];
  const p1 = [s2.p1[i3], s2.p1[i3 + 1], s2.p1[i3 + 2]];
  const L = s2.len[k2];
  const u = [(p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L, (p1[2] - p0[2]) / L];
  const ref = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const e1 = normalize(cross(u, ref));
  const r = a * 0.6;
  const p = [0, 0, 0];
  for (let i = 0; i < 3; i++) p[i] = 0.5 * (p0[i] + p1[i]) + e1[i] * r;
  const E = [0, 0, 0], B = [0, 0, 0];
  const inside = s2.interior(p[0], p[1], p[2], E, B);
  ok(inside, '探针点被判为落在导体内部');
  const Bexpect = (MU0 * Math.abs(s2.cur[k2]) * r) / (2 * Math.PI * a * a);
  const Bgot = Math.hypot(...B);
  console.log(`  内部 B = ${Bgot.toExponential(3)} T，μ0·I·r/(2πa²) = ${Bexpect.toExponential(3)} T`);
  ok(Math.abs(Bgot / Bexpect - 1) < 1e-6, '内部 B 与解析式一致');
  s2.eField(p[0], p[1], p[2], E);
  s2.bField(p[0], p[1], p[2], B);
  const S = [(E[1] * B[2] - E[2] * B[1]) / MU0, (E[2] * B[0] - E[0] * B[2]) / MU0, (E[0] * B[1] - E[1] * B[0]) / MU0];
  const radial = S[0] * e1[0] + S[1] * e1[1] + S[2] * e1[2];
  console.log(`  内部 S·r̂ = ${radial.toFixed(2)} W/m²（电阻段应为负 = 指向轴心）`);
  ok(radial < 0, '电阻导体内部的能流指向轴心');
}

console.log('== 坡印廷定理：包围电阻的闭合曲面 ∫S·n̂ dA ≈ −I²R ==');
{
  // 单回路：电池 + 100Ω
  let id = 0;
  const el = (type, a, b, value) => ({ id: 'x' + (++id), type, a, b, value });
  const cc = {
    elements: [
      el('battery', [0, 0], [0, 2], 9),
      el('wire', [0, 2], [2, 2]),
      el('resistor', [2, 2], [4, 2], 100),
      el('wire', [4, 2], [4, 0]),
      el('wire', [4, 0], [0, 0]),
    ],
  };
  const sol2 = solveCircuit(cc);
  const sc2 = buildScene(cc, sol2, { wireRadius: 0.05 });
  const s3 = sc2.solver;
  const I2 = Math.abs(sol2.elCurrent[cc.elements[2].id]);
  const P2 = I2 * I2 * 100;

  const A2 = worldOf([2, 2]), B2 = worldOf([4, 2]);
  const x0 = Math.min(A2[0], B2[0]) * 0.01, x1 = Math.max(A2[0], B2[0]) * 0.01;
  const zc = A2[2] * 0.01;
  const E3 = [0, 0, 0], B3 = [0, 0, 0];
  const Sat = (x, y, z) => {
    s3.eField(x, y, z, E3);
    s3.bField(x, y, z, B3);
    return [
      (E3[1] * B3[2] - E3[2] * B3[1]) / MU0,
      (E3[2] * B3[0] - E3[0] * B3[2]) / MU0,
      (E3[0] * B3[1] - E3[1] * B3[0]) / MU0,
    ];
  };
  const N = 10, r = 0.003, ext = 0.002;
  const xa = x0 - ext, xb = x1 + ext;
  let flux = 0;
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < N; k++) {
      const x = xa + (xb - xa) * (i + 0.5) / N;
      const dz = 2 * r * (k + 0.5) / N;
      const dA = ((xb - xa) / N) * (2 * r / N);
      flux += Sat(x, r, zc - r + dz)[1] * dA - Sat(x, -r, zc - r + dz)[1] * dA;
      const y = -r + dz;
      flux += Sat(x, y, zc + r)[2] * dA - Sat(x, y, zc - r)[2] * dA;
    }
  }
  for (let j = 0; j < N; j++) {
    for (let k = 0; k < N; k++) {
      const y = -r + 2 * r * (j + 0.5) / N;
      const z = zc - r + 2 * r * (k + 0.5) / N;
      const dA = (2 * r / N) * (2 * r / N);
      flux += Sat(xb, y, z)[0] * dA - Sat(xa, y, z)[0] * dA;
    }
  }
  console.log(`  ∫S·n̂ dA = ${flux.toFixed(3)} W，−I²R = ${(-P2).toFixed(3)} W`);
  ok(flux < 0, '净能流指向电阻内部（外法向为负）');
  ok(Math.abs(flux + P2) / P2 < 0.45, '闭合曲面通量 ≈ I²R（误差 <45%）',
    `${(Math.abs(flux + P2) / P2 * 100).toFixed(0)}%`);
}

console.log('== 真断路：没有电流就没有能流 ==');
{
  let id = 0;
  const el = (type, a, b, value) => ({ id: 'y' + (++id), type, a, b, value });
  const open = {
    elements: [
      el('battery', [0, 0], [0, 2], 9),
      el('wire', [0, 2], [3, 2]),
      el('wire', [0, 0], [3, 0]),
    ],
  };
  const so = solveCircuit(open);
  const sco = buildScene(open, so, { wireRadius: 0.05 });
  const so3 = sco.solver;
  let maxI = 0, maxS = 0;
  for (const v of Object.values(so.elCurrent)) maxI = Math.max(maxI, Math.abs(v));
  const E4 = [0, 0, 0], B4 = [0, 0, 0];
  for (let i = 0; i < 300; i++) {
    const p = [(-1 + Math.random() * 5) * 0.01, (Math.random() - 0.5) * 0.04, (-1 + Math.random() * 5) * 0.01];
    so3.eField(p[0], p[1], p[2], E4);
    so3.bField(p[0], p[1], p[2], B4);
    const S = [
      (E4[1] * B4[2] - E4[2] * B4[1]) / MU0,
      (E4[2] * B4[0] - E4[0] * B4[2]) / MU0,
      (E4[0] * B4[1] - E4[1] * B4[0]) / MU0,
    ];
    maxS = Math.max(maxS, Math.hypot(...S));
  }
  console.log(`  断路时最大电流 ${maxI.toExponential(1)} A，最大 |S| ${maxS.toExponential(1)} W/m²`);
  ok(maxI < 1e-9, '真断路没有电流');
  ok(maxS < 1e-9, '没有电流时 S = 0');
}

console.log(fails === 0 ? '\n全部通过 ✅' : `\n${fails} 项失败 ❌`);
process.exit(fails === 0 ? 0 : 1);

