/**
 * 电容充电时，能流是否「都往中间指」
 *   node tools/diag_cap_flux.mjs
 */
import { solveTransient, createTransient, buildScene, worldOf } from '../js/circuit.js';
import { MU0 } from '../js/field.js';

const newId = (() => { let i = 0; return () => 'e' + (++i); })();
const el = (type, a, b, value) => ({ id: newId(), type, a, b, value });

// 电池 → 上导线 → 电阻 → 电容 → 下导线，串联
const c = {
  elements: [
    el('battery', [0, 0], [0, 3], 9),
    el('wire', [0, 3], [2, 3]),
    el('resistor', [2, 3], [4, 3], 100),
    el('capacitor', [4, 3], [4, 0], 10),
    el('wire', [4, 0], [0, 0]),
  ],
};
const sol0 = solveTransient(c, createTransient(c), 2e-6);   // 第一拍
const dt = 2e-6;
const st = createTransient(c);
let sol = null;
for (let i = 0; i < 200; i++) sol = solveTransient(c, st, dt);   // 0.4 ms，电容在充电

const sc = buildScene(c, sol, { wireRadius: 0.05 });
const s = sc.solver;
const E = [0, 0, 0], B = [0, 0, 0];
const Sat = (p) => {
  s.eField(p[0], p[1], p[2], E);
  s.bField(p[0], p[1], p[2], B);
  return [(E[1] * B[2] - E[2] * B[1]) / MU0,
          (E[2] * B[0] - E[0] * B[2]) / MU0,
          (E[0] * B[1] - E[1] * B[0]) / MU0];
};

// 电池也检查一下：源应该「净流出」
const bat = c.elements.find((e) => e.type === 'battery');
{
  const A2 = worldOf(bat.a), B2 = worldOf(bat.b);
  const m2 = [(A2[0] + B2[0]) / 2 * 0.01, 0, (A2[1] + B2[1]) / 2 * 0.01];
  const I2 = sol.elCurrent[bat.id];
  let sum = 0, cnt = 0;
  for (let k = 0; k < 12; k++) {
    const th = (k / 12) * Math.PI * 2;
    for (let zz = -0.01; zz <= 0.01; zz += 0.0067) {
      const p = [m2[0] + Math.cos(th) * 0.006, Math.sin(th) * 0.006, m2[2] + zz];
      const S = Sat(p);
      sum += S[0] * Math.cos(th) + S[1] * Math.sin(th);
      cnt++;
    }
  }
  const f = sum / cnt * (2 * Math.PI * 0.006) * 0.02;
  console.log(`\n电池：电流 ${(I2 * 1000).toFixed(2)} mA，包围电池的侧面净外流 = ${f.toExponential(2)} W ${f > 0 ? '（流出 ✓ 源）' : '（流入 ✗）'}`);
  // 内部箭头方向（显示导体内部时看到的就是这个）
  const E3 = [0, 0, 0], B3 = [0, 0, 0];
  s.eField(m2[0], 0.0003, m2[2], E3);
  s.bField(m2[0], 0.0003, m2[2], B3);
  const S3 = [(E3[1] * B3[2] - E3[2] * B3[1]) / MU0,
              (E3[2] * B3[0] - E3[0] * B3[2]) / MU0,
              (E3[0] * B3[1] - E3[1] * B3[0]) / MU0];
  console.log(`  电池内部 S 的径向（y）分量 = ${S3[1].toExponential(2)} ${S3[1] > 0 ? '向外' : '向内'}`);
}

const cap = c.elements.find((e) => e.type === 'capacitor');
const A = worldOf(cap.a), Bp = worldOf(cap.b);
const mid = [(A[0] + Bp[0]) / 2 * 0.01, 0, (A[1] + Bp[1]) / 2 * 0.01];
const IC = sol.elCurrent[cap.id];
const VC = (sol.nodeV[cap.a.join(',')] - sol.nodeV[cap.b.join(',')]);
console.log(`电容电压 ${VC.toFixed(3)} V，电流 ${(IC * 1000).toFixed(3)} mA`);
console.log(`充电功率 P = V·I = ${(VC * IC * 1000).toFixed(3)} mW（正 = 在储能）`);

// 绕电容画一个圆柱面（轴 = 电容轴 = z），看净流入
function ringFlux(r, halfLen) {
  let sum = 0, cnt = 0;
  for (let k = 0; k < 12; k++) {
    const th = (k / 12) * Math.PI * 2;
    // 侧面
    for (let zz = -halfLen; zz <= halfLen; zz += halfLen / 3) {
      const p = [mid[0] + Math.cos(th) * r, Math.sin(th) * r, mid[2] + zz];
      const S = Sat(p);
      const n = [Math.cos(th), Math.sin(th), 0];
      sum += S[0] * n[0] + S[1] * n[1] + S[2] * n[2];
      cnt++;
    }
  }
  const dA = (2 * Math.PI * r) * (halfLen / 3);
  return sum / cnt * dA;
}

console.log('\n包围电容的圆柱侧面上的净外流（负 = 能量往里进）：');
for (const [r, hl] of [[0.004, 0.008], [0.008, 0.012], [0.015, 0.02]]) {
  const f = ringFlux(r, hl);
  console.log(`  半径 ${(r * 1000).toFixed(0)}mm 高 ${(hl * 2 * 1000).toFixed(0)}mm  →  ${f.toExponential(2)} W  ${f < 0 ? '（流入 ✓）' : '（流出 ✗）'}`);
}

// 电容两侧（沿导线方向）的 S 指向
console.log('\n电容上下两侧的能流方向（相对电容中心）：');
for (const dz of [-0.01, -0.006, 0.006, 0.01]) {
  const p = [mid[0] + 0.004, 0, mid[2] + dz];
  const S = Sat(p);
  const rad = [p[0] - mid[0], 0, p[2] - mid[2]];
  const rl = Math.hypot(...rad) || 1;
  const dot = (S[0] * rad[0] + S[2] * rad[2]) / rl;
  console.log(`  z=${(dz * 1000).toFixed(0)}mm  径向分量 S·r̂ = ${dot.toExponential(2)}  ${dot < 0 ? '指向电容 ✓' : '背离电容'}`);
}
