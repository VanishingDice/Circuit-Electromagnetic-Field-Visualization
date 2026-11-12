/**
 * 用坡印廷定理检验：包围电阻的闭合曲面上 ∫S·n̂ dA 是否等于 I²R
 *   node tools/diag_flux.mjs
 */
import { solveCircuit, buildScene, worldOf } from '../js/circuit.js';
import { MU0 } from '../js/field.js';

const newId = (() => { let i = 0; return () => 'e' + (++i); })();
const el = (type, a, b, value) => ({ id: newId(), type, a, b, value });

const c = {
  elements: [
    el('battery', [0, 0], [0, 2], 9),
    el('wire', [0, 2], [2, 2]),
    el('resistor', [2, 2], [4, 2], 100),
    el('wire', [4, 2], [4, 0]),
    el('wire', [4, 0], [0, 0]),
  ],
};
const sol = solveCircuit(c);
const KERNEL = process.argv[2] === 'band' ? 'band' : 'wire';
const sc = buildScene(c, sol, { wireRadius: 0.05, kernel: KERNEL });
console.log('核函数:', KERNEL);
const s = sc.solver;
const I = Math.abs(sol.elCurrent[c.elements[2].id]);
const P = I * I * 100;

// 电阻沿 x 轴，从 world x=-3.5 到 -1.5（z=... 见 worldOf）
const A = worldOf([2, 2]), Bp = worldOf([4, 2]);
const x0 = Math.min(A[0], Bp[0]) * 0.01, x1 = Math.max(A[0], Bp[0]) * 0.01;
const zc = A[2] * 0.01, yc = 0;
console.log(`电阻：x ${(x0 * 1000).toFixed(1)} … ${(x1 * 1000).toFixed(1)} mm, z=${(zc * 1000).toFixed(1)} mm`);
console.log(`I = ${(I * 1000).toFixed(2)} mA,  I²R = ${P.toFixed(4)} W`);

const E = [0, 0, 0], B = [0, 0, 0];
function S_at(x, y, z) {
  s.eField(x, y, z, E);
  s.bField(x, y, z, B);
  return [
    (E[1] * B[2] - E[2] * B[1]) / MU0,
    (E[2] * B[0] - E[0] * B[2]) / MU0,
    (E[0] * B[1] - E[1] * B[0]) / MU0,
  ];
}

// 包围电阻的长方体：稍微放大
function fluxBox(rmm, ext) {
  const r = rmm / 1000;
  const xa = x0 - ext, xb = x1 + ext;
  const ny = 12, nz = 12, nx = 12;
  let flux = 0;
  // ±y 面（法向 ±y）
  for (let i = 0; i < nx; i++) {
    for (let k = 0; k < nz; k++) {
      const x = xa + (xb - xa) * (i + 0.5) / nx;
      const z = zc - r + 2 * r * (k + 0.5) / nz;
      const dA = ((xb - xa) / nx) * (2 * r / nz);
      const S1 = S_at(x, r, z), S2 = S_at(x, -r, z);
      flux += S1[1] * dA - S2[1] * dA;
    }
  }
  // ±z 面
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const x = xa + (xb - xa) * (i + 0.5) / nx;
      const y = -r + 2 * r * (j + 0.5) / ny;
      const dA = ((xb - xa) / nx) * (2 * r / ny);
      const S1 = S_at(x, y, zc + r), S2 = S_at(x, y, zc - r);
      flux += S1[2] * dA - S2[2] * dA;
    }
  }
  // ±x 端面
  for (let j = 0; j < ny; j++) {
    for (let k = 0; k < nz; k++) {
      const y = -r + 2 * r * (j + 0.5) / ny;
      const z = zc - r + 2 * r * (k + 0.5) / nz;
      const dA = (2 * r / ny) * (2 * r / nz);
      const S1 = S_at(xb, y, z), S2 = S_at(xa, y, z);
      flux += S1[0] * dA - S2[0] * dA;
    }
  }
  return flux;
}

console.log('\n包围盒（法向外流为正；内部耗散应使净流入为正，即 flux = −P）：');
for (const [rmm, ext] of [[3, 2], [6, 3], [10, 4]]) {
  const f = fluxBox(rmm, ext * 0.001);
  console.log(`  半径 ${rmm}mm, 端面外扩 ${ext}mm → ∫S·n̂ dA = ${f.toFixed(4)} W` +
    `  (应 ≈ ${(-P).toFixed(4)} W，误差 ${(Math.abs(-f - P) / P * 100).toFixed(0)}%)`);
}

