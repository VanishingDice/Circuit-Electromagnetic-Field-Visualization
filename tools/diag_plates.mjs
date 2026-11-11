/**
 * 诊断：极板几何 + 删掉电容电感后的电流
 *   node tools/diag_plates.mjs
 */
import { createDefaultCircuit, solveCircuit, buildScene, worldOf } from '../js/circuit.js';
import { MU0 } from '../js/field.js';

const c = createDefaultCircuit();
const sol = solveCircuit(c);
const sc = buildScene(c, sol, { wireRadius: 0.05 });

console.log('== 极板图元 ==');
for (const p of sc.parts) {
  if (p.kind !== 'plate') continue;
  const f = (v) => v.map((x) => x.toFixed(3)).join(', ');
  console.log(`  ${p.mat.padEnd(13)} center=(${f(p.center)})  axis=(${f(p.axis)})  up=(${f(p.up)})  side=(${f(p.side)})  half=${p.half}`);
}

console.log('\n== 极板两两关系 ==');
const plates = sc.parts.filter((p) => p.kind === 'plate');
for (let i = 0; i < plates.length; i++) {
  for (let j = i + 1; j < plates.length; j++) {
    const a = plates[i], b = plates[j];
    const d = [b.center[0] - a.center[0], b.center[1] - a.center[1], b.center[2] - a.center[2]];
    const dist = Math.hypot(...d);
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    // 法向之间的夹角（平行 → |dot|=1）
    const nDot = dot(a.axis, b.axis);
    // 位移是否沿法向
    const along = dist > 0 ? dot(d, a.axis) / dist : 0;
    console.log(`  ${a.mat} ↔ ${b.mat}: 距离 ${dist.toFixed(3)}, 法向·法向 ${nDot.toFixed(3)}, 位移·法向 ${along.toFixed(3)}`);
  }
}

console.log('\n== 删掉电容和电感之后 ==');
const c2 = createDefaultCircuit();
const cap = c2.elements.find((e) => e.type === 'capacitor');
const ind = c2.elements.find((e) => e.type === 'inductor');
c2.elements = c2.elements.filter((e) => e !== cap && e !== ind);
console.log(`  剩余元件 ${c2.elements.length} 个`);
const sol2 = solveCircuit(c2);
const currents2 = Object.entries(sol2.elCurrent);
const maxI = Math.max(...currents2.map(([, v]) => Math.abs(v)));
console.log(`  最大电流 ${maxI.toExponential(3)} A`);
for (const [id, v] of currents2) {
  if (Math.abs(v) > 1e-12) console.log(`    元件 ${id}: ${v.toExponential(3)} A`);
}
const vs = Object.values(sol2.nodeV);
console.log(`  电位 min=${Math.min(...vs).toFixed(3)} max=${Math.max(...vs).toFixed(3)}`);
const sc2 = buildScene(c2, sol2, { wireRadius: 0.05 });
const s2 = sc2.solver;
let maxS = 0, maxB = 0, maxE = 0;
const E = [0, 0, 0], B = [0, 0, 0];
for (let i = 0; i < 500; i++) {
  const p = [(-5 + Math.random() * 9) * 0.01, (Math.random() - 0.5) * 0.05, (-3 + Math.random() * 5) * 0.01];
  s2.eField(p[0], p[1], p[2], E);
  s2.bField(p[0], p[1], p[2], B);
  maxE = Math.max(maxE, Math.hypot(...E));
  maxB = Math.max(maxB, Math.hypot(...B));
  const S = [
    (E[1] * B[2] - E[2] * B[1]) / MU0,
    (E[2] * B[0] - E[0] * B[2]) / MU0,
    (E[0] * B[1] - E[1] * B[0]) / MU0,
  ];
  maxS = Math.max(maxS, Math.hypot(...S));
}
console.log(`  采样：max|E|=${maxE.toExponential(2)} V/m, max|B|=${maxB.toExponential(2)} T, max|S|=${maxS.toExponential(2)} W/m²`);
