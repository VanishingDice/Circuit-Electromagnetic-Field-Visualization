/**
 * field.js —— 场的物理核心
 *
 * 三个基本核（都已用 Python 数值积分验证，见 tools/verify_math.py）：
 *   1. 线电荷的电势      φ  = kλ·ln((r1+r2+L)/(r1+r2−L))
 *   2. 线电荷的电场      E  = 2kλL·(â+b̂)/((r1+r2)²−L²)          （= −∇φ）
 *   3. 有限长直电流的 B  B  = μ0I/4π · (a×b)·(ra+rb)/(ra·rb·(ra·rb+a·b))
 *
 * 电场/电势用边界元（MoM）求：把导体离散成线段，每段电荷 λ 未知，
 * 令各段中点电势等于导体电势，解稠密方程组 A·λ = V。
 * 再用「总电荷为零」定出整体电位零点（孤立电路必然净电荷为零），
 * 这样远场按偶极子衰减，不会被一个假的单极子主导。
 *
 * 所有长度单位为米。世界坐标 1 格 = 0.01 m（见 METER_PER_UNIT）。
 */

export const KE = 1 / (4 * Math.PI * 8.8541878128e-12); // 1/4πε0
export const MU0 = 4 * Math.PI * 1e-7;
export const METER_PER_UNIT = 0.01;

export class FieldSolver {
  /**
   * @param {number} wireRadius 边界元细线半径（决定自项与近场截断）
   * @param {number} [conductorRadius] 导体圆柱半径（决定「内部」范围与内部解析场）
   *   两者分开是因为细线近似要求 半径 ≪ 线段长；画面上的导线可以画得更粗，
   *   但边界元仍按细线求解。
   */
  constructor(wireRadius = 0.0002, conductorRadius = wireRadius) {
    this.wireRadius = wireRadius;
    this.conductorRadius = conductorRadius;
    this._p0 = [];
    this._p1 = [];
    this._pot = [];
    this._cur = [];
    this._eAx = [];
    this.n = 0;
  }

  /**
   * 加入一条导体线段（米制坐标）。
   * @param {number[]} p0 起点
   * @param {number[]} p1 终点
   * @param {number} potential 该段电势
   * @param {number} current 分到该段的电流（方向 p0→p1 为正）
   * @param {number} eAxial 导体内部的纵向电场 E = −∂φ/∂l（V/m），方向上 p0→p1 为正
   */
  add(p0, p1, potential, current = 0, eAxial = 0) {
    this._p0.push(p0[0], p0[1], p0[2]);
    this._p1.push(p1[0], p1[1], p1[2]);
    this._pot.push(potential);
    this._cur.push(current);
    this._eAx.push(eAxial);
  }

  /** 把收集到的线段整理成定长数组 */
  build() {
    const n = this._pot.length;
    this.n = n;
    this.p0 = Float64Array.from(this._p0);
    this.p1 = Float64Array.from(this._p1);
    this.vpot = Float64Array.from(this._pot);
    this.cur = Float64Array.from(this._cur);
    this.eAx = Float64Array.from(this._eAx);
    this.len = new Float64Array(n);
    this.mid = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x0 = this.p0[3 * i], y0 = this.p0[3 * i + 1], z0 = this.p0[3 * i + 2];
      const x1 = this.p1[3 * i], y1 = this.p1[3 * i + 1], z1 = this.p1[3 * i + 2];
      this.len[i] = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
      this.mid[3 * i] = 0.5 * (x0 + x1);
      this.mid[3 * i + 1] = 0.5 * (y0 + y1);
      this.mid[3 * i + 2] = 0.5 * (z0 + z1);
    }
    this.lam = new Float64Array(n);
    return this;
  }

  /** 边界元求解电荷分布 */
  solve() {
    const n = this.n;
    if (n === 0) return this;
    const A = new Float64Array(n * (n + 2)); // 两列右端：V 和 1
    const { p0, p1, len, mid, vpot } = this;
    const a0 = this.wireRadius;

    for (let i = 0; i < n; i++) {
      const mx = mid[3 * i], my = mid[3 * i + 1], mz = mid[3 * i + 2];
      const row = i * (n + 2);
      for (let j = 0; j < n; j++) {
        let kern;
        if (i === j) {
          const L = len[j] || 1e-9;
          // thin-wire 自项：ln(2L/a) − 1
          kern = Math.log((2 * L) / a0) - 1;
        } else {
          const x0 = p0[3 * j], y0 = p0[3 * j + 1], z0 = p0[3 * j + 2];
          const x1 = p1[3 * j], y1 = p1[3 * j + 1], z1 = p1[3 * j + 2];
          const r1 = Math.hypot(mx - x0, my - y0, mz - z0);
          const r2 = Math.hypot(mx - x1, my - y1, mz - z1);
          const L = len[j] || 1e-9;
          const s = r1 + r2;
          const den = s - L;
          kern = den > 1e-12 ? Math.log((s + L) / den) : Math.log((2 * s) / 1e-12);
        }
        A[row + j] = KE * kern;
      }
      A[row + n] = vpot[i];   // 右端 1：真实电势
      A[row + n + 1] = 1;     // 右端 2：全体电位平移 +1 时的响应
    }

    // 两个右端一起做高斯消元
    this._gauss(A, n, 2);

    const lam0 = new Float64Array(n);
    const lam1 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const row = i * (n + 2);
      lam0[i] = A[row + n];
      lam1[i] = A[row + n + 1];
    }

    // 净电荷 = Σ λ_i·L_i 必须为 0（孤立电路），用整体电位平移 c 来满足
    let q0 = 0, q1 = 0;
    for (let i = 0; i < n; i++) {
      q0 += lam0[i] * len[i];
      q1 += lam1[i] * len[i];
    }
    const c = Math.abs(q1) > 1e-30 ? -q0 / q1 : 0;
    for (let i = 0; i < n; i++) this.lam[i] = lam0[i] + c * lam1[i];
    this.netCharge = q0 + c * q1;
    this.potShift = c;
    return this;
  }

  /** 带部分主元的高斯消元，就地求解 A·X = B（B 有 m 列，位于第 n..n+m-1 列） */
  _gauss(A, n, m) {
    const w = n + m;
    for (let col = 0; col < n; col++) {
      let piv = col, best = Math.abs(A[col * w + col]);
      for (let r = col + 1; r < n; r++) {
        const v = Math.abs(A[r * w + col]);
        if (v > best) { best = v; piv = r; }
      }
      if (best < 1e-300) continue;
      if (piv !== col) {
        for (let k = col; k < w; k++) {
          const t = A[col * w + k];
          A[col * w + k] = A[piv * w + k];
          A[piv * w + k] = t;
        }
      }
      const d = A[col * w + col];
      for (let k = col; k < w; k++) A[col * w + k] /= d;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = A[r * w + col];
        if (f === 0) continue;
        for (let k = col; k < w; k++) A[r * w + k] -= f * A[col * w + k];
      }
    }
  }

  /** 电势（V） */
  phi(px, py, pz) {
    let s = 0;
    const p0 = this.p0, p1 = this.p1, len = this.len, lam = this.lam, n = this.n;
    for (let i = 0; i < n; i++) {
      const L = len[i];
      if (!L) continue;
      const i3 = 3 * i;
      let dx = px - p0[i3], dy = py - p0[i3 + 1], dz = pz - p0[i3 + 2];
      const r1 = Math.sqrt(dx * dx + dy * dy + dz * dz);
      dx = px - p1[i3]; dy = py - p1[i3 + 1]; dz = pz - p1[i3 + 2];
      const r2 = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const st = r1 + r2;
      const den = st - L;
      if (den > 1e-12) s += lam[i] * Math.log((st + L) / den);
      else s += lam[i] * Math.log((2 * st) / 1e-12);
    }
    return KE * s;
  }

  /**
   * 判断点是否落在某根导体内部（半径为 wireRadius 的圆柱）。
   * 若是，直接给出导体内部的解析场：
   *   内部 E 沿导线方向 = −∂φ/∂l（由电阻/电源决定），
   *   内部 B 绕轴、大小 = μ0·I·r/(2πa²)，
   * 于是 S = E×B 会指向轴心——这就是导线自身发热的能量来源。
   * @returns {boolean} 是否在导体内部
   */
  interior(px, py, pz, outE, outB) {
    const a = this.conductorRadius;
    const { p0, p1, len, cur, eAx, n } = this;
    for (let i = 0; i < n; i++) {
      const L = len[i];
      if (L < 1e-12) continue;
      const i3 = 3 * i;
      const ux = (p1[i3] - p0[i3]) / L, uy = (p1[i3 + 1] - p0[i3 + 1]) / L, uz = (p1[i3 + 2] - p0[i3 + 2]) / L;
      const wx = px - p0[i3], wy = py - p0[i3 + 1], wz = pz - p0[i3 + 2];
      const t = wx * ux + wy * uy + wz * uz;
      // 端点稍微放宽，避免相邻线段接缝处漏判
      if (t < -a || t > L + a) continue;
      const rx = wx - ux * t, ry = wy - uy * t, rz = wz - uz * t;
      const r2 = rx * rx + ry * ry + rz * rz;
      if (r2 >= a * a) continue;

      // E：沿导线方向
      outE[0] = ux * eAx[i];
      outE[1] = uy * eAx[i];
      outE[2] = uz * eAx[i];
      // B = μ0·I/(2πa²) · (û × r_perp)
      const k = cur[i] / (2 * Math.PI * a * a); // 乘 MU0 前
      outB[0] = MU0 * k * (uy * rz - uz * ry);
      outB[1] = MU0 * k * (uz * rx - ux * rz);
      outB[2] = MU0 * k * (ux * ry - uy * rx);
      return true;
    }
    return false;
  }

  /** 电场（V/m），写入 out */
  eField(px, py, pz, out) {
    if (this.interior(px, py, pz, out, this._tmpB || (this._tmpB = [0, 0, 0]))) {
      this._insideFlag = true;
      return out;
    }
    this._insideFlag = false;
    let ex = 0, ey = 0, ez = 0;
    const p0 = this.p0, p1 = this.p1, len = this.len, lam = this.lam, n = this.n;
    const minDenBase = this.wireRadius * 4;
    for (let i = 0; i < n; i++) {
      const L = len[i];
      if (!L) continue;
      const i3 = 3 * i;
      const ax = px - p0[i3], ay = py - p0[i3 + 1], az = pz - p0[i3 + 2];
      const bx = px - p1[i3], by = py - p1[i3 + 1], bz = pz - p1[i3 + 2];
      let r1 = Math.sqrt(ax * ax + ay * ay + az * az);
      let r2 = Math.sqrt(bx * bx + by * by + bz * bz);
      if (r1 < 1e-9) r1 = 1e-9;
      if (r2 < 1e-9) r2 = 1e-9;
      const s = r1 + r2;
      let den = s * s - L * L;
      // 贴近线段时数值上会趋 0，用导线半径兜底（物理上本来就发散）
      const minDen = minDenBase * L;
      if (den < minDen) den = minDen;
      const f = (2 * KE * lam[i] * L) / den;
      ex += f * (ax / r1 + bx / r2);
      ey += f * (ay / r1 + by / r2);
      ez += f * (az / r1 + bz / r2);
    }
    out[0] = ex; out[1] = ey; out[2] = ez;
    return out;
  }

  /** 磁感应强度（T），写入 out */
  bField(px, py, pz, out) {
    if (this.interior(px, py, pz, this._tmpE || (this._tmpE = [0, 0, 0]), out)) {
      this._insideFlag = true;
      return out;
    }
    this._insideFlag = false;
    let bx = 0, by = 0, bz = 0;
    const p0 = this.p0, p1 = this.p1, cur = this.cur, len = this.len, n = this.n;
    const c = MU0 / (4 * Math.PI);
    for (let i = 0; i < n; i++) {
      const I = cur[i];
      if (!I || !len[i]) continue;
      const i3 = 3 * i;
      // a = P1 − r, b = P2 − r
      const ax = p0[i3] - px, ay = p0[i3 + 1] - py, az = p0[i3 + 2] - pz;
      const bvx = p1[i3] - px, bvy = p1[i3 + 1] - py, bvz = p1[i3 + 2] - pz;
      let ra = Math.sqrt(ax * ax + ay * ay + az * az);
      let rb = Math.sqrt(bvx * bvx + bvy * bvy + bvz * bvz);
      if (ra < 1e-9) ra = 1e-9;
      if (rb < 1e-9) rb = 1e-9;
      const dot = ax * bvx + ay * bvy + az * bvz;
      const den = ra * rb * (ra * rb + dot);
      if (den < 1e-30) continue;
      const f = (c * I * (ra + rb)) / den;
      bx += f * (ay * bvz - az * bvy);
      by += f * (az * bvx - ax * bvz);
      bz += f * (ax * bvy - ay * bvx);
    }
    out[0] = bx; out[1] = by; out[2] = bz;
    return out;
  }
}

/** 自检：把内部公式和解析极限对比（可在控制台调用 runSelfTest()） */
export function runSelfTest() {
  const logs = [];
  const f = new FieldSolver(0.0002);

  // 1) 单段长导线：中部附近 B 应趋近无限长导线值
  {
    const fs = new FieldSolver(0.0002).build();
    fs.add([0, 0, 0], [40, 0, 0], 0, 1);
    fs.build();
    const out = [0, 0, 0];
    fs.bField(20, 0.004, 0, out);
    const expect = MU0 * 1 / (2 * Math.PI * 0.004);
    logs.push(`B 无限长极限: ${(Math.abs(out[2] / expect - 1)).toExponential(2)}（<1e-2 通过）`);
  }

  // 2) 均匀线电荷的 E 与 −∇φ 一致
  {
    const fs = new FieldSolver(0.0002);
    fs.add([0, 0, 0], [0.01, 0.003, 0], 0, 0);
    fs.build();
    fs.lam[0] = 1e-10;
    const p = [0.004, 0.006, 0.002];
    const e = [0, 0, 0];
    fs.eField(p[0], p[1], p[2], e);
    const h = 1e-7;
    const g = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const q = p.slice(); q[k] += h;
      const q2 = p.slice(); q2[k] -= h;
      g[k] = -(fs.phi(q[0], q[1], q[2]) - fs.phi(q2[0], q2[1], q2[2])) / (2 * h);
    }
    const err = Math.hypot(e[0] - g[0], e[1] - g[1], e[2] - g[2]) / Math.hypot(g[0], g[1], g[2]);
    logs.push(`E = −∇φ 一致性: ${err.toExponential(2)}（<1e-5 通过）`);
  }

  // 3) 净电荷应为零
  {
    const fs = new FieldSolver(0.0002);
    // 一段导体 + 两端不同电位
    const pts = [[0, 0, 0], [0.02, 0, 0]];
    for (let k = 0; k < 8; k++) {
      const t0 = k / 8, t1 = (k + 1) / 8;
      fs.add([pts[0][0] + t0 * 0.02, 0, 0], [pts[0][0] + t1 * 0.02, 0, 0], t0 * 3, 0);
    }
    fs.build().solve();
    logs.push(`净电荷: ${fs.netCharge.toExponential(2)} C（应接近 0）`);
  }
  return logs;
}
