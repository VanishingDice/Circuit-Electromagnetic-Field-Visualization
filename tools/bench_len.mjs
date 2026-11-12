// 长度收敛测试：L 增大时 C' 是否趋近无限长解析值
import { FieldSolver } from '../js/field.js';

const EPS0 = 8.8541878128e-12;

function cap(a, d, L, segLen) {
  const fs = new FieldSolver(a);
  const n = Math.max(2, Math.round(L / segLen));
  const h = L / n;
  for (let k = 0; k < n; k++) {
    const z0 = -L / 2 + k * h;
    fs.add([-d / 2, 0, z0], [-d / 2, 0, z0 + h], 0, 0);
    fs.add([d / 2, 0, z0], [d / 2, 0, z0 + h], 0, 0);
  }
  const m = fs._pot.length;
  for (let i = 0; i < m; i++) fs._pot[i] = i < n ? 1 : -1;
  fs.build();
  fs.solve();
  let q = 0;
  for (let i = 0; i < n; i++) q += fs.lam[i] * fs.len[i];
  return q / 2 / L;
}

const a = 2e-4, d = 1e-2;
const analytic = Math.PI * EPS0 / Math.log(d / a);
console.log('解析（无限长）：', analytic.toExponential(4));
console.log('  L(mm)   段长(mm)      C\'          误差');
for (const L of [0.3, 0.6, 1.2, 2.4]) {
  const segLen = Math.max(8 * a, L / 200);
  const c = cap(a, d, L, segLen);
  console.log(
    `  ${String(L * 1000).padStart(5)}  ${(segLen * 1000).toFixed(2).padStart(7)}  ` +
    `${c.toExponential(4)}  ${(((c - analytic) / analytic) * 100).toFixed(1)}%`
  );
}
