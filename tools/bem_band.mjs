/**
 * 圆柱带表面电荷 BEM（可落地的高精度方案原型）
 *   - 导体 = 一串圆柱带（半径 a，长 h），每带 σ 均匀（轴对称 ⇒ 对直线段是精确的）
 *   - 配置点在带表面中点
 *   - 自项：沿带积分环核（1/|dz| 的对数奇点用分片高斯处理）
 *   - 互项：同样的环核积分
 *   - 成本：每根导线 L/(2a) 个未知数
 *
 *   node tools/bem_band.mjs
 */
const EPS0 = 8.8541878128e-12;

function ellipK(k) {
  let a = 1, b = Math.sqrt(Math.max(0, 1 - k * k));
  for (let i = 0; i < 40 && Math.abs(a - b) > 1e-15; i++) {
    const an = 0.5 * (a + b);
    b = Math.sqrt(a * b);
    a = an;
  }
  return Math.PI / (2 * a);
}

/** 半径 R 的圆环（线电荷密度 λ）在 (ρ,z) 处单位长度的电位贡献 */
function ringPotPerLen(R, rho, dz) {
  const A = (R + rho) * (R + rho) + dz * dz;
  const k2 = Math.min(1 - 1e-16, (4 * R * rho) / A);
  return (1 / (2 * Math.PI * Math.PI * EPS0)) * ellipK(Math.sqrt(k2)) / Math.sqrt(A);
}

/* 16 点高斯-勒让德 */
const GAUSS16 = (() => {
  const x = [], w = [];
  const n = 16;
  for (let i = 0; i < n; i++) {
    let z = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5));
    let p0, p1, p2;
    for (let it = 0; it < 30; it++) {
      p0 = 1; p1 = z;
      for (let j = 2; j <= n; j++) { const p3 = ((2 * j - 1) * z * p1 - (j - 1) * p0) / j; p0 = p1; p1 = p3; }
      p2 = (n * (z * p1 - p0)) / (z * z - 1);
      const dz = p1 / p2;
      z -= dz;
      if (Math.abs(dz) < 1e-15) break;
    }
    x.push(z);
    w.push(2 / ((1 - z * z) * p2 * p2));
  }
  return { x, w };
})();

/**
 * 一个圆柱带（中心 zc，长 h，半径 a，表面电荷密度 σ）在表面点 (a, z) 的电位
 * 分成 8 个子区间做 16 点高斯（对数奇点在 z≈zc 处）
 */
function bandPot(a, h, sigma, z, zc) {
  const PANELS = 8;
  const half = h / 2;
  let sum = 0;
  for (let p = 0; p < PANELS; p++) {
    const t0 = -half + (2 * half * p) / PANELS;
    const t1 = -half + (2 * half * (p + 1)) / PANELS;
    const mid = 0.5 * (t0 + t1), hr = 0.5 * (t1 - t0);
    for (let g = 0; g < 16; g++) {
      const dz = zc + mid + hr * GAUSS16.x[g] - z;
      sum += GAUSS16.w[g] * hr * ringPotPerLen(a, a, dz);
    }
  }
  return sigma * 2 * Math.PI * a * sum;   // σ·(2πa dz) = 环的线电荷
}

function solveLin(A, b, n) {
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[piv * n + c])) piv = r;
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

function pairCap(a, d, L, h) {
  const n = Math.max(4, Math.round(L / h));
  const N = 2 * n;
  const A = new Float64Array(N * N);
  const b = new Float64Array(N);
  const bandZ = (k) => -L / 2 + (k + 0.5) * h;

  for (let i = 0; i < n; i++) {
    const zc = bandZ(i);
    for (let side = 0; side < 2; side++) {
      const row = i + side * n;
      for (let s2 = 0; s2 < 2; s2++) {
        for (let j = 0; j < n; j++) {
          if (side === s2) {
            // 同一根导线：ρ = a（自身表面，含自项 dz=0 附近）
            A[row * N + j + s2 * n] = bandPot(a, h, 1, zc, bandZ(j));
          } else {
            // 另一根导线：ρ ≈ d，核光滑，直接中点近似
            A[row * N + j + s2 * n] = bandPot(a, h, 1, zc, bandZ(j) + (d === 0 ? 0 : 0)) * 0 +
              (2 * Math.PI * a) * ringPotPerLen(a, d, zc - bandZ(j)) * h;
          }
        }
      }
      b[row] = side === 0 ? 1 : -1;
    }
  }
  const Q = solveLin(A, b, N);
  let q = 0;
  for (let j = 0; j < n; j++) q += Q[j] * 2 * Math.PI * a * h;   // σ → 总电荷
  return q / 2 / L;
}

const a = 2e-4, d = 1e-2, L = 0.3;
const analytic = Math.PI * EPS0 / Math.log(d / a);
console.log('解析 C\' =', analytic.toExponential(4), '\n');
console.log('   h(mm)   带数    C\'           误差      耗时');
for (const h of [0.004, 0.002, 0.001, 0.0005]) {
  const t0 = Date.now();
  const c = pairCap(a, d, L, h);
  console.log(
    `  ${(h * 1000).toFixed(2).padStart(6)}  ${String(Math.round(L / h)).padStart(5)}  ` +
    `${c.toExponential(4)}  ${(((c - analytic) / analytic) * 100).toFixed(1).padStart(6)}%  ${Date.now() - t0}ms`
  );
}
