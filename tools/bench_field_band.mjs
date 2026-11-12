// 双导线电容基准（修正版：两根导线的线段分开加入，不交错）
import { FieldSolver } from '../js/field.js';

const EPS0 = 8.8541878128e-12;

function cap(model, a, d, L, segLen) {
  const fs = new FieldSolver(a, a, { model });
  const n = Math.max(2, Math.round(L / segLen));
  const h = L / n;
  // 先加完整根 + 导线，再加 − 导线（顺序影响下标，不能交错）
  for (let k = 0; k < n; k++) {
    const z0 = -L / 2 + k * h;
    fs.add([-d / 2, 0, z0], [-d / 2, 0, z0 + h], 1, 0, 0, a);
  }
  for (let k = 0; k < n; k++) {
    const z0 = -L / 2 + k * h;
    fs.add([d / 2, 0, z0], [d / 2, 0, z0 + h], -1, 0, 0, a);
  }
  fs.build();
  const t0 = Date.now();
  fs.solve();
  const ms = Date.now() - t0;
  let q = 0;
  for (let i = 0; i < n; i++) q += fs.lam[i] * fs.len[i];   // 只加 + 导线
  return { C: q / 2 / L, ms };
}

for (const [a, d, L] of [[2e-4, 1e-2, 0.3], [5e-4, 1e-2, 0.3]]) {
  const analytic = Math.PI * EPS0 / Math.log(d / a);
  console.log(`\n=== a=${(a * 1000).toFixed(2)}mm  d=${(d * 1000).toFixed(0)}mm  L=${(L * 1000).toFixed(0)}mm ===`);
  console.log(`  解析（无限长）C' = ${analytic.toExponential(4)}`);
  console.log('  model  段长(mm)    C\'            误差       耗时');
  for (const model of ['wire', 'band']) {
    for (const seg of [0.012, 0.006, 0.003, 0.0016]) {
      if (seg < 4 * a) continue;
      const r = cap(model, a, d, L, seg);
      console.log(
        `  ${model.padEnd(5)}  ${(seg * 1000).toFixed(2).padStart(6)}   ` +
        `${r.C.toExponential(4)}  ${(((r.C - analytic) / analytic) * 100).toFixed(1).padStart(6)}%   ${String(r.ms).padStart(4)} ms`
      );
    }
  }
}
