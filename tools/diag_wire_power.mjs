/**
 * 导线自己消耗多少能流？和电源放出的能流比
 *   node tools/diag_wire_power.mjs
 */
import { createDefaultCircuit, solveCircuit, buildScene } from '../js/circuit.js';
import { MU0 } from '../js/field.js';

const c = createDefaultCircuit();
const sol = solveCircuit(c);
const sc = buildScene(c, sol, { wireRadius: 0.05 });
const s = sc.solver;

let pWire = 0, pRes = 0, pBat = 0;
for (const el of c.elements) {
  const I = sol.elCurrent[el.id] ?? 0;
  const Va = sol.nodeV[el.a.join(',')] ?? 0;
  const Vb = sol.nodeV[el.b.join(',')] ?? 0;
  const P = (Va - Vb) * I;
  if (el.type === 'wire') pWire += P;
  else if (el.type === 'resistor') pRes += P;
  else if (el.type === 'battery') pBat -= P;
}
const I0 = Math.abs(sol.elCurrent[c.elements[0].id] ?? 0);
console.log(`总电流 ${(I0 * 1000).toFixed(2)} mA`);
console.log(`全部导线耗散  ${pWire.toFixed(6)} W  （占电阻的 ${(pWire / Math.abs(pRes) * 100).toFixed(2)}%）`);
console.log(`电阻耗散      ${pRes.toFixed(4)} W`);
console.log(`电源输出      ${pBat.toFixed(4)} W`);
console.log(`校验：电源 − 电阻 − 导线 = ${(pBat - Math.abs(pRes) - pWire).toExponential(2)} W`);

const E = [0, 0, 0], B = [0, 0, 0];
function probeSegment(k, r, label) {
  const i3 = 3 * k;
  const p0 = [s.p0[i3], s.p0[i3 + 1], s.p0[i3 + 2]];
  const p1 = [s.p1[i3], s.p1[i3 + 1], s.p1[i3 + 2]];
  const L = s.len[k];
  const u = [(p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L, (p1[2] - p0[2]) / L];
  const ref = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let e1 = [u[1] * ref[2] - u[2] * ref[1], u[2] * ref[0] - u[0] * ref[2], u[0] * ref[1] - u[1] * ref[0]];
  const l1 = Math.hypot(...e1) || 1;
  e1 = e1.map((v) => v / l1);
  const e2 = [u[1] * e1[2] - u[2] * e1[1], u[2] * e1[0] - u[0] * e1[2], u[0] * e1[1] - u[1] * e1[0]];
  const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2];
  let sum = 0, cnt = 0;
  for (let a = 0; a < 8; a++) {
    const th = a / 8 * Math.PI * 2;
    const p = [
      mid[0] + e1[0] * Math.cos(th) * r + e2[0] * Math.sin(th) * r,
      mid[1] + e1[1] * Math.cos(th) * r + e2[1] * Math.sin(th) * r,
      mid[2] + e1[2] * Math.cos(th) * r + e2[2] * Math.sin(th) * r,
    ];
    s.eField(p[0], p[1], p[2], E);
    s.bField(p[0], p[1], p[2], B);
    const S = [(E[1] * B[2] - E[2] * B[1]) / MU0,
               (E[2] * B[0] - E[0] * B[2]) / MU0,
               (E[0] * B[1] - E[1] * B[0]) / MU0];
    if (!S.every(isFinite)) continue;
    const rad = [p[0] - mid[0], p[1] - mid[1], p[2] - mid[2]];
    const rl = Math.hypot(...rad) || 1;
    sum += (S[0] * rad[0] + S[1] * rad[1] + S[2] * rad[2]) / rl;
    cnt++;
  }
  console.log(`  ${label}: 平均 S·r̂ = ${(sum / Math.max(cnt, 1)).toExponential(2)}  ${sum > 0 ? '向外' : '向内'}`);
}

console.log('\n距导线轴 2mm、绕一圈的平均径向能流：');
// 找电池本体的段（两端电压差最大的那几段）
let bIdx = -1, bd = 0;
for (let k = 0; k < s.n; k++) {
  const dv = Math.abs(s.volt ? 0 : 0);
}
// 用「电流相同、位于电池位置」的段：取离电池中点最近的段
const bat = c.elements.find((e) => e.type === 'battery');
const bx = ((bat.a[0] + bat.b[0]) / 2 - 5.5) * 0.01;
const bz = ((bat.a[1] + bat.b[1]) / 2 - 3.5) * 0.01;
let best = -1, bd2 = Infinity;
for (let k = 0; k < s.n; k++) {
  const d = Math.hypot(s.p0[3 * k] - bx, s.p0[3 * k + 2] - bz);
  if (d < bd2) { bd2 = d; best = k; }
}
probeSegment(best, 0.002, '电池处导线     ');

// 顶线中段：找最长的水平段
let far = -1, fl = 0;
for (let k = 0; k < s.n; k++) {
  if (Math.abs(s.cur[k]) < 1e-9) continue;
  const dx = Math.abs(s.p1[3 * k] - s.p0[3 * k]);
  if (dx > fl && Math.hypot(s.p0[3 * k] - bx, s.p0[3 * k + 2] - bz) > 0.03) { fl = dx; far = k; }
}
probeSegment(far, 0.002, '顶线中段（远离电源）');
