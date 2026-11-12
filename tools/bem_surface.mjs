/**
 * 高精度参考解：圆柱表面电荷（环电荷）BEM
 *   每个导体 = 一串半径为 a 的带电圆环（环上电荷均匀，正是理想圆柱的轴对称解）
 *   配置点放在两环之间的圆柱表面上 → 所有核函数都不奇异
 *   对比：解析 C' = πε0/ln(d/a)（无限长双导线）
 *
 *   node tools/bem_surface.mjs
 */
const EPS0 = 8.8541878128e-12;

/* ---- 第一类完全椭圆积分 K(k)，AGM ---- */
function ellipK(k) {
  let a = 1, b = Math.sqrt(Math.max(0, 1 - k * k));
  for (let i = 0; i < 30 && Math.abs(a - b) > 1e-15; i++) {
    const an = 0.5 * (a + b);
    b = Math.sqrt(a * b);
    a = an;
  }
  return Math.PI / (2 * a);
}

/**
 * 圆环（半径 R，总电荷 Q，位于 z=zc）在 (ρ, z) 处的电位
 *   φ = Q/(2π²ε0) · K(k) / sqrt((R+ρ)² + dz²),  k² = 4Rρ/((R+ρ)²+dz²)
 */
function ringPot(R, Q, rho, dz) {
  const A = (R + rho) * (R + rho) + dz * dz;
  const k2 = Math.min(1 - 1e-15, (4 * R * rho) / A);
  return (Q / (2 * Math.PI * Math.PI * EPS0)) * ellipK(Math.sqrt(k2)) / Math.sqrt(A);
}

/** 高斯消元 */
function solveLin(A, b, n) {
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[piv * n + c])) piv = r;
    if (Math.abs(A[piv * n + c]) < 1e-300) throw new Error('奇异矩阵');
    if (piv !== c) {
      for (let k = 0; k < n; k++) { const t = A[c * n + k]; A[c * n + k] = A[piv * n + k]; A[piv * n + k] = t; }
      const t = b[c]; b[c] = b[piv]; b[piv] = t;
    }
    const d = A[c * n + c];
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] / d;
      if (!f) continue;
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r * n + k] * x[k];
    x[r] = s / A[r * n + r];
  }
  return x;
}

/**
 * 两根平行圆柱（半径 a，轴距 d）单位长度电容
 * @param a 半径  d 轴距  L 长度  h 环间距
 */
function pairCap(a, d, L, h) {
  const n = Math.max(4, Math.round(L / h));      // 每根导线的环数
  const N = 2 * n;
  const A = new Float64Array(N * N);
  const b = new Float64Array(N);

  // 环位置 z_k = -L/2 + (k+0.5)h ；配置点 z = -L/2 + (k+1)h
  const ringZ = (k) => -L / 2 + (k + 0.5) * h;
  const colZ = (k) => -L / 2 + (k + 1) * h;

  for (let i = 0; i < n; i++) {
    const zi = colZ(i);
    for (let side = 0; side < 2; side++) {
      const row = i + side * n;
      const xi = side === 0 ? -d / 2 : d / 2;
      for (let s2 = 0; s2 < 2; s2++) {
        const xj = s2 === 0 ? -d / 2 : d / 2;
        for (let j = 0; j < n; j++) {
          const rho = Math.abs(xi - xj);        // 两根轴之间的距离（同轴时 =0）
          // 同轴（同一根导线）时 ρ = a（表面），跨导线时 ρ ≈ d
          const rhoEff = rho < 1e-12 ? a : rho;
          A[row * N + j + s2 * n] = ringPot(a, 1, rhoEff, zi - ringZ(j));
        }
      }
      b[row] = side === 0 ? 1 : -1;
    }
  }

  const Q = solveLin(A, b, N);
  let q = 0;
  for (let j = 0; j < n; j++) q += Q[j];        // + 导线的总电荷
  return q / 2 / L;                              // ΔV = 2V
}

const a = 2e-4, d = 1e-2;
const analytic = Math.PI * EPS0 / Math.log(d / a);
console.log('解析（无限长双导线）C\' =', analytic.toExponential(4), 'F/m\n');
console.log('   L(mm)   h(mm)    环数    C\'           误差');
for (const [L, h] of [[0.3, 0.00125], [0.3, 0.0006], [0.3, 0.0003], [0.6, 0.0006]]) {
  const t0 = Date.now();
  const c = pairCap(a, d, L, h);
  const n = Math.round(L / h);
  console.log(
    `  ${String(L * 1000).padStart(5)}  ${(h * 1000).toFixed(2).padStart(6)}  ${String(n).padStart(5)}  ` +
    `${c.toExponential(4)}  ${(((c - analytic) / analytic) * 100).toFixed(1).padStart(6)}%   (${Date.now() - t0}ms)`
  );
}
