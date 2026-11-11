/**
 * 诊断能流：单个电阻的回路 / 真正的断路
 *   node tools/diag_power.mjs
 */
import { solveCircuit, buildScene, worldOf } from '../js/circuit.js';
import { MU0 } from '../js/field.js';

const newId = (() => { let i = 0; return () => 'e' + (++i); })();

function mk(elements) { return { elements }; }
const el = (type, a, b, value) => ({ id: newId(), type, a, b, value });

function report(circuit, label) {
  const sol = solveCircuit(circuit);
  const sc = buildScene(circuit, sol, { wireRadius: 0.05 });
  const s = sc.solver;
  const currents = Object.values(sol.elCurrent);
  const imax = Math.max(...currents.map(Math.abs));
  console.log(`\n=== ${label} ===`);
  console.log(`  最大电流 ${(imax * 1000).toFixed(3)} mA, 节点数 ${Object.keys(sol.nodeV).length}`);
  const vs = Object.values(sol.nodeV);
  console.log(`  电位范围 ${Math.min(...vs).toFixed(3)} … ${Math.max(...vs).toFixed(3)} V`);
  return { sol, sc, s, imax };
}

/* ---------- 1) 只有电池 + 一个电阻的回路 ---------- */
{
  const c = mk([
    el('battery', [0, 0], [0, 2], 9),
    el('wire', [0, 2], [2, 2]),
    el('resistor', [2, 2], [4, 2], 100),
    el('wire', [4, 2], [4, 0]),
    el('wire', [4, 0], [0, 0]),
  ]);
  const { s, sol, imax } = report(c, '电池 + 100Ω 单电阻回路');
  const R = worldOf([3, 2]);            // 电阻中点
  const cx = R[0] * 0.01, cz = R[2] * 0.01;
  const I = imax;
  const E = [0, 0, 0], B = [0, 0, 0];
  console.log('  绕电阻一圈采样（径向 + 轴向分量，单位 W/m²）');
  for (const rmm of [2, 4, 8]) {
    const r = rmm / 1000;
    const rows = [];
    for (let k = 0; k < 8; k++) {
      const th = k / 8 * Math.PI * 2;
      // 电阻沿 x 轴，所以径向在 y-z 平面
      const py = r * Math.cos(th), pz = cz + r * Math.sin(th);
      s.eField(cx, py, pz, E);
      s.bField(cx, py, pz, B);
      const Sx = (E[1] * B[2] - E[2] * B[1]) / MU0;
      const Sy = (E[2] * B[0] - E[0] * B[2]) / MU0;
      const Sz = (E[0] * B[1] - E[1] * B[0]) / MU0;
      const rhat = [0, Math.cos(th), Math.sin(th)];
      const radial = Sy * rhat[1] + Sz * rhat[2];
      rows.push({ radial, axial: Sx });
    }
    const avgR = rows.reduce((a, b) => a + b.radial, 0) / rows.length;
    const avgA = rows.reduce((a, b) => a + Math.abs(b.axial), 0) / rows.length;
    // 通过半径 r、长度 L 的柱面的总功率 ≈ 2πrL·avgR
    const L = 0.02;
    console.log(`   r=${rmm}mm  平均径向 ${avgR.toFixed(1)}  平均|轴向| ${avgA.toFixed(1)}` +
      `  → 柱面功率 ${(2 * Math.PI * r * L * Math.abs(avgR)).toFixed(3)} W (I²R=${(I * I * 100).toFixed(3)})`);
  }
}

/* ---------- 2) 真正的断路：电池 + 两根断头线 ---------- */
{
  const c = mk([
    el('battery', [0, 0], [0, 2], 9),
    el('wire', [0, 2], [3, 2]),
    el('wire', [0, 0], [3, 0]),
  ]);
  const { s } = report(c, '电池 + 两根断头线（真断路）');
  const E = [0, 0, 0], B = [0, 0, 0];
  let maxS = 0, maxB = 0, maxE = 0;
  for (let i = 0; i < 400; i++) {
    const p = [(-1 + Math.random() * 5) * 0.01, (Math.random() - 0.5) * 0.04, (-1 + Math.random() * 5) * 0.01];
    s.eField(p[0], p[1], p[2], E);
    s.bField(p[0], p[1], p[2], B);
    maxE = Math.max(maxE, Math.hypot(...E));
    maxB = Math.max(maxB, Math.hypot(...B));
    const Sx = (E[1] * B[2] - E[2] * B[1]) / MU0;
    const Sy = (E[2] * B[0] - E[0] * B[2]) / MU0;
    const Sz = (E[0] * B[1] - E[1] * B[0]) / MU0;
    maxS = Math.max(maxS, Math.hypot(Sx, Sy, Sz));
  }
  console.log(`  采样 400 点：max|E|=${maxE.toExponential(2)} V/m, max|B|=${maxB.toExponential(2)} T, max|S|=${maxS.toExponential(2)} W/m²`);
}

/* ---------- 3) 电池 + 电容（开路，但两极板带电） ---------- */
{
  const c = mk([
    el('battery', [0, 0], [0, 2], 9),
    el('wire', [0, 2], [2, 2]),
    el('capacitor', [2, 2], [2, 4], 10),
    el('wire', [2, 4], [4, 4]),
    el('wire', [4, 4], [4, 0]),
    el('wire', [4, 0], [0, 0]),
  ]);
  const { s } = report(c, '电池 + 电容（直流开路，板间有静电场）');
  const E = [0, 0, 0], B = [0, 0, 0];
  let maxS = 0, maxB = 0, maxE = 0;
  for (let i = 0; i < 400; i++) {
    const p = [(-1 + Math.random() * 5) * 0.01, (Math.random() - 0.5) * 0.05, (-1 + Math.random() * 6) * 0.01];
    s.eField(p[0], p[1], p[2], E);
    s.bField(p[0], p[1], p[2], B);
    maxE = Math.max(maxE, Math.hypot(...E));
    maxB = Math.max(maxB, Math.hypot(...B));
    const Sx = (E[1] * B[2] - E[2] * B[1]) / MU0;
    const Sy = (E[2] * B[0] - E[0] * B[2]) / MU0;
    const Sz = (E[0] * B[1] - E[1] * B[0]) / MU0;
    maxS = Math.max(maxS, Math.hypot(Sx, Sy, Sz));
  }
  console.log(`  采样 400 点：max|E|=${maxE.toExponential(2)} V/m, max|B|=${maxB.toExponential(2)} T, max|S|=${maxS.toExponential(2)} W/m²`);
}
