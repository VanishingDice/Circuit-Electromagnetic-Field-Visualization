/**
 * 沿顶线看 E∥、E_r、B、以及它们决定的 S 分量
 *   node tools/diag_efield_along.mjs
 */
import { createSimpleLoop, solveCircuit, buildScene } from '../js/circuit.js';
import { MU0 } from '../js/field.js';

const c = createSimpleLoop();
const sol = solveCircuit(c);
const sc = buildScene(c, sol, { wireRadius: 0.05 });
const s = sc.solver;
const E = [0, 0, 0], B = [0, 0, 0];

console.log('节点电位：');
for (const k of Object.keys(sol.nodeV).sort()) {
  if (k.startsWith('1,') || k.startsWith('8,') || k.startsWith('3,4')) {
    console.log(`  V(${k}) = ${sol.nodeV[k].toFixed(3)} V`);
  }
}

console.log('\n顶线（沿 x，z=+5mm）上方 2mm 处的场：');
console.log('  x(mm)   E∥(V/m)    E_r(V/m)   B(T)        S_r(W/m²)    S∥(W/m²)');
for (let xmm = -43; xmm <= 21; xmm += 4) {
  const x = xmm / 1000;
  // 取导线正上方 2mm：y=+2mm（垂直于电路平面）
  const p = [x, 0.002, 0.005];
  s.eField(p[0], p[1], p[2], E);
  s.bField(p[0], p[1], p[2], B);
  const S = [(E[1] * B[2] - E[2] * B[1]) / MU0,
             (E[2] * B[0] - E[0] * B[2]) / MU0,
             (E[0] * B[1] - E[1] * B[0]) / MU0];
  // 导线沿 x；径向 = +y
  console.log(`  ${String(xmm).padStart(5)}   ${E[0].toExponential(2).padStart(9)}  ${E[1].toExponential(2).padStart(9)}  ${Math.hypot(...B).toExponential(2).padStart(9)}  ${S[1].toExponential(2).padStart(11)}  ${S[0].toExponential(2).padStart(11)}`);
}

console.log('\n对照：沿电池本体（x=-45mm，z 变化）右侧 2mm 处：');
console.log('  z(mm)   E_z(V/m)    E_x(V/m)   B(T)        S_x(W/m²)    S_z(W/m²)');
for (let zmm = -23; zmm <= 3; zmm += 4) {
  const z = zmm / 1000;
  const p = [-0.045 + 0.002, 0, z];
  s.eField(p[0], p[1], p[2], E);
  s.bField(p[0], p[1], p[2], B);
  const S = [(E[1] * B[2] - E[2] * B[1]) / MU0,
             (E[2] * B[0] - E[0] * B[2]) / MU0,
             (E[0] * B[1] - E[1] * B[0]) / MU0];
  console.log(`  ${String(zmm).padStart(5)}   ${E[2].toExponential(2).padStart(9)}  ${E[0].toExponential(2).padStart(9)}  ${Math.hypot(...B).toExponential(2).padStart(9)}  ${S[0].toExponential(2).padStart(11)}  ${S[2].toExponential(2).padStart(11)}`);
}
