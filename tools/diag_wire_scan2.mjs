/**
 * 规范做法：绕导线一圈做方位平均，得到「穿过圆柱面的净能流」
 *   node tools/diag_wire_scan2.mjs
 */
import { createSimpleLoop, solveCircuit, buildScene } from '../js/circuit.js';
import { MU0 } from '../js/field.js';

const c = createSimpleLoop();
const sol = solveCircuit(c);
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

/**
 * 在点 mid 处、垂直于轴 axis 的平面上，半径 r 绕一圈做平均。
 * 返回 { radial: 平均 S·r̂（正=向外）, axial: 平均 S·â }
 */
function ring(mid, axis, r, n = 16) {
  const a = axis, l = Math.hypot(...a);
  const u = a.map((v) => v / l);
  const ref = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let e1 = [u[1] * ref[2] - u[2] * ref[1], u[2] * ref[0] - u[0] * ref[2], u[0] * ref[1] - u[1] * ref[0]];
  const l1 = Math.hypot(...e1) || 1;
  e1 = e1.map((v) => v / l1);
  const e2 = [u[1] * e1[2] - u[2] * e1[1], u[2] * e1[0] - u[0] * e1[2], u[0] * e1[1] - u[1] * e1[0]];
  let rad = 0, ax = 0, cnt = 0;
  for (let k = 0; k < n; k++) {
    const th = (k / n) * Math.PI * 2;
    const dir = [
      e1[0] * Math.cos(th) + e2[0] * Math.sin(th),
      e1[1] * Math.cos(th) + e2[1] * Math.sin(th),
      e1[2] * Math.cos(th) + e2[2] * Math.sin(th),
    ];
    const p = [mid[0] + dir[0] * r, mid[1] + dir[1] * r, mid[2] + dir[2] * r];
    const S = Sat(p);
    if (!S.every(isFinite)) continue;
    rad += S[0] * dir[0] + S[1] * dir[1] + S[2] * dir[2];
    ax += S[0] * u[0] + S[1] * u[1] + S[2] * u[2];
    cnt++;
  }
  return { radial: rad / cnt, axial: ax / cnt };
}

// 顶线：沿 x，z = 0.5，从电池(x=-4.5) 到右端(x=2.5)
console.log('顶线（沿 x，z=0.5），绕圈半径 2mm：');
console.log('   x(mm)   径向 S·r̂          轴向 S·â');
for (let xmm = -43; xmm <= 24; xmm += 4) {
  const x = xmm / 1000;   // mm → 米
  const { radial, axial } = ring([x, 0, 0.005], [1, 0, 0], 0.002);
  const tag = radial > 0 ? '向外' : '向内';
  console.log(`  ${String(xmm).padStart(5)}   ${radial.toExponential(2).padStart(11)} ${tag}   ${axial.toExponential(2).padStart(11)}`);
}

// 电池本体：沿 z 的竖线，从 (1,1) 到 (1,4)，world x=-4.5, z=-2.5..0.5
console.log('\n电池本体（沿 z 的竖线），绕圈半径 2mm：');
console.log('   z(mm)   径向 S·r̂          轴向 S·â');
for (let zmm = -23; zmm <= 3; zmm += 4) {
  const z = zmm / 1000;   // mm → 米
  const { radial, axial } = ring([-0.045, 0, z], [0, 0, 1], 0.002);
  const tag = radial > 0 ? '向外' : '向内';
  console.log(`  ${String(zmm).padStart(5)}   ${radial.toExponential(2).padStart(11)} ${tag}   ${axial.toExponential(2).padStart(11)}`);
}
