/**
 * 电池两端外侧的场：+ 端子与 − 端子是否镜像？
 *   node tools/diag_battery_ends.mjs
 */
import { createSimpleLoop, solveCircuit, buildScene } from '../js/circuit.js';

const c = createSimpleLoop();
const sol = solveCircuit(c);
const sc = buildScene(c, sol, { wireRadius: 0.05 });
const s = sc.solver;
const E = [0, 0, 0], B = [0, 0, 0];

console.log('电池：a=(1,1) b=(1,4)，即 z=-25mm → z=+5mm，V(b)-V(a)=+9V');
console.log('  → b 端（z=+5mm，上方）是 + 极，a 端（z=-25mm，下方）是 − 极\n');

// 上引线：顶线 (1,4)-(8,4)，沿 x；从端子往右
console.log('【+ 端子外】顶线沿线 E∥（导线沿 +x，电流也沿 +x）');
for (const xmm of [-43, -35, -25, -15, -5]) {
  const p = [xmm / 1000, 0.002, 0.005];
  s.eField(p[0], p[1], p[2], E);
  console.log(`  x=${String(xmm).padStart(4)}mm  E∥=${E[0].toExponential(2).padStart(10)} V/m  ${E[0] < 0 ? '←逆电流（源特征）' : '→顺电流（负载特征）'}`);
}

// 下引线：底线 (1,1)-(8,1)，沿 x，z=-25mm；电流方向是从右往左（−x）
console.log('\n【− 端子外】底线沿线 E∥（导线沿 x，但电流沿 −x）');
for (const xmm of [-43, -35, -25, -15, -5]) {
  const p = [xmm / 1000, 0.002, -0.025];
  s.eField(p[0], p[1], p[2], E);
  // 电流沿 −x，所以「逆电流」= E∥ > 0
  console.log(`  x=${String(xmm).padStart(4)}mm  E∥=${E[0].toExponential(2).padStart(10)} V/m  ${E[0] > 0 ? '逆电流（源特征）' : '顺电流（负载特征）'}`);
}

// 电池本体两端内侧
console.log('\n【电池内部】沿 z 的 E∥（电流沿 +z）');
for (const zmm of [-24, -20, -16, -12, -8, -4, 0]) {
  const p = [-0.045, 0.002, zmm / 1000];
  s.eField(p[0], p[1], p[2], E);
  console.log(`  z=${String(zmm).padStart(4)}mm  E_z=${E[2].toExponential(2).padStart(10)} V/m  ${E[2] < 0 ? '←逆电流（源特征）' : '→顺电流'}`);
}

// 端子附近的场强集中度
console.log('\n端子/节点处的场强（看是否有拐角电荷集中）:');
for (const [label, p] of [
  ['+ 端子旁 (z=+7mm)', [-0.045, 0.002, 0.007]],
  ['+ 端的顶线 (x=-40mm)', [-0.040, 0.002, 0.005]],
  ['顶线中段 (x=-10mm)', [-0.010, 0.002, 0.005]],
]) {
  s.eField(p[0], p[1], p[2], E);
  console.log(`  ${label.padEnd(22)} |E| = ${Math.hypot(...E).toExponential(2)} V/m`);
}
