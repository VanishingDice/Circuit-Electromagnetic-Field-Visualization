/**
 * viz.js —— 场的可视化：箭头 / 流线 / 切片 + 等值线
 *
 * 坐标系约定：three.js 场景用「世界单位」(1 单位 ≈ 1 cm)，
 * 而物理计算用米，所以采样时乘/除 0.01。
 */
import * as THREE from 'three';
import { MU0 } from './field.js';

const W2M = 0.01;
const M2W = 100;

// 这些场强以下就当作「零」：否则分位数归一化会把 1e-9 的数值噪音也拉成满色满长度，
// 看起来就像断路也有能流。
const ZERO_FLOOR = { E: 1e-3, B: 1e-12, S: 1e-6, phi: 1e-6 };

/* ---------------- 配色 ---------------- */
const TURBO = [
  [0.02, [0.19, 0.07, 0.23]],
  [0.13, [0.27, 0.28, 0.66]],
  [0.26, [0.28, 0.47, 0.93]],
  [0.39, [0.23, 0.65, 0.99]],
  [0.52, [0.15, 0.83, 0.85]],
  [0.65, [0.19, 0.94, 0.59]],
  [0.78, [0.60, 0.99, 0.30]],
  [0.90, [0.95, 0.85, 0.17]],
  [1.00, [0.99, 0.53, 0.09]],
];

export function turbo(t) {
  t = Math.min(1, Math.max(0, t));
  for (let i = 1; i < TURBO.length; i++) {
    if (t <= TURBO[i][0]) {
      const [t0, c0] = TURBO[i - 1], [t1, c1] = TURBO[i];
      const f = (t - t0) / (t1 - t0 || 1);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return TURBO[TURBO.length - 1][1];
}

const DIVERGING = [
  [0.0, [0.16, 0.40, 0.72]],
  [0.30, [0.36, 0.58, 0.78]],
  [0.5, [0.72, 0.72, 0.72]],
  [0.70, [0.86, 0.56, 0.40]],
  [1.0, [0.80, 0.24, 0.26]],
];

export function diverging(t) {
  t = Math.min(1, Math.max(0, t));
  for (let i = 1; i < DIVERGING.length; i++) {
    if (t <= DIVERGING[i][0]) {
      const [t0, c0] = DIVERGING[i - 1], [t1, c1] = DIVERGING[i];
      const f = (t - t0) / (t1 - t0 || 1);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return DIVERGING[DIVERGING.length - 1][1];
}

/* ---------------- 小工具 ---------------- */
function mergeGeos(geos) {
  const pos = [], nor = [], idx = [];
  let off = 0;
  for (const g of geos) {
    const p = g.getAttribute('position'), n = g.getAttribute('normal');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nor.push(n.getX(i), n.getY(i), n.getZ(i));
    }
    const ind = g.getIndex();
    if (ind) for (let i = 0; i < ind.count; i++) idx.push(ind.getX(i) + off);
    else for (let i = 0; i < p.count; i++) idx.push(i + off);
    off += p.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[i];
}

/** 对数归一化：把 0..∞ 的场强映射到 0..1 */
function makeNorm(values, lo = 0.08, hi = 0.92) {
  const s = [...values].sort((a, b) => a - b);
  const vmin = percentile(s, lo), vmax = percentile(s, hi);
  const l0 = Math.log10(Math.max(vmin, 1e-30)), l1 = Math.log10(Math.max(vmax, 1e-29));
  const span = Math.max(l1 - l0, 1e-6);
  return (v) => {
    if (!(v > 0)) return 0;
    return Math.min(1, Math.max(0, (Math.log10(Math.max(v, 1e-30)) - l0) / span));
  };
}

/* ---------------- 场求值 ---------------- */
export function makeFieldFn(field, solver) {
  const e = [0, 0, 0], b = [0, 0, 0];
  switch (field) {
    case 'E':
      return (x, y, z) => { solver.eField(x, y, z, e); return [e[0], e[1], e[2]]; };
    case 'B':
      return (x, y, z) => { solver.bField(x, y, z, b); return [b[0], b[1], b[2]]; };
    case 'S':
      return (x, y, z) => {
        solver.eField(x, y, z, e);
        solver.bField(x, y, z, b);
        return [
          (e[1] * b[2] - e[2] * b[1]) / MU0,
          (e[2] * b[0] - e[0] * b[2]) / MU0,
          (e[0] * b[1] - e[1] * b[0]) / MU0,
        ];
      };
    case 'phi':
      return (x, y, z) => [solver.phi(x, y, z), 0, 0];
    default:
      return () => [0, 0, 0];
  }
}

/* ---------------- 主类 ---------------- */
export class FieldViz {
  constructor(scene3d) {
    this.scene3d = scene3d;
    this.group = scene3d.fieldGroup;
    this.arrows = null;
    this.lines = null;
    this.marks = null;
    this.slice = null;
    this.contours = null;
    this.lastStats = {};
  }

  dispose() {
    this.scene3d.clearGroup(this.group);
    this.arrows = null;
    this.lines = null;
    this.marks = null;
    this.slice = null;
    this.contours = null;
  }

  box(bounds, margin = 1.1, yUp = 1.7, yDown = 1.1) {
    return {
      min: [bounds.min[0] - margin, -yDown, bounds.min[2] - margin],
      max: [bounds.max[0] + margin, yUp, bounds.max[2] + margin],
    };
  }

  /**
   * @param {object} o
   *   solver, bounds, field, mode, density(0..1), opacity, sliceAxis, slicePos(-1..1), logScale
   */
  update(o) {
    this.dispose();
    this.zero = false;
    const { solver, bounds, field } = o;
    if (!solver || !solver.n) return;
    if (field === 'phi' && o.mode !== 'slice') o = { ...o, mode: 'slice' };
    // o.box 存在时只在指定体块里采样（「截取空间」面板用）
    const box = o.box || this.box(bounds);
    if (o.mode === 'arrows') this.buildArrows(o, box);
    else if (o.mode === 'stream') this.buildStreams(o, box);
    else if (o.mode === 'slice') this.buildSlice(o, box);
  }

  /* ---- 箭头场 ---- */
  buildArrows(o, box) {
    const { solver, field } = o;
    // 体块被压成 0 时 span=0 → s=∞ → 网格循环无限跑（会卡死页面）
    if (!(box.max[0] - box.min[0] > 1e-6) || !(box.max[1] - box.min[1] > 1e-6) ||
        !(box.max[2] - box.min[2] > 1e-6)) { this.zero = true; return; }
    const fn = makeFieldFn(field, solver);
    const span = [
      box.max[0] - box.min[0],
      box.max[1] - box.min[1],
      box.max[2] - box.min[2],
    ];
    const density = o.density ?? 0.5;
    const total = Math.round(120 + density * 1350);
    const vol = span[0] * span[1] * span[2];
    const s = Math.cbrt(total / vol);
    const nx = Math.max(2, Math.round(span[0] * s));
    const ny = Math.max(2, Math.round(span[1] * s));
    const nz = Math.max(2, Math.round(span[2] * s));

    const pts = [];
    const mags = [];
    const dirs = [];
    const tmp = [0, 0, 0];
    for (let i = 0; i < nx; i++) {
      const x = box.min[0] + (i + 0.5) / nx * span[0];
      for (let j = 0; j < ny; j++) {
        const y = box.min[1] + (j + 0.5) / ny * span[1];
        for (let k = 0; k < nz; k++) {
          const z = box.min[2] + (k + 0.5) / nz * span[2];
          // 跳过离导体太近的点（否则箭头被奇异性拉爆）
          // 用「距离/该段导体半径」判断，绝对值 4mm 在小盒子里(吸附导线后只有几毫米)
          // 会把所有采样点都滤掉 → 箭头模式看起来什么都没有
          if (nearestConductorRatio(solver, x * W2M, y * W2M, z * W2M) < 1.35) continue;
          const v = fn(x * W2M, y * W2M, z * W2M);
          const m = Math.hypot(v[0], v[1], v[2]);
          if (!(m > 0) || !isFinite(m)) continue;
          mags.push(m);
          pts.push([x, y, z]);
          dirs.push([v[0] / m, v[1] / m, v[2] / m]);
        }
      }
    }
    if (!mags.length) { this.zero = true; return; }
    if (Math.max(...mags) < (ZERO_FLOOR[field] ?? 0)) { this.zero = true; return; }

    const norm = makeNorm(mags);
    // 砍掉两端：极弱的点方向是噪声，极强的点集中在导体表面会把色标拉爆
    const sorted = [...mags].sort((a, b) => a - b);
    const loCut = percentile(sorted, 0.06);
    const hiCut = percentile(sorted, 0.995);
    const keep = [];
    for (let i = 0; i < mags.length; i++) {
      if (mags[i] >= loCut && mags[i] <= hiCut) keep.push(i);
    }
    const geo = makeArrowGeometry();
    const mat = new THREE.MeshBasicMaterial({ vertexColors: false, transparent: true, opacity: o.opacity ?? 0.9 });
    const mesh = new THREE.InstancedMesh(geo, mat, keep.length);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;   // 实例散在整场，包围球在原点 → 否则会被误剔除

    const dummy = new THREE.Object3D();
    const up = new THREE.Vector3(0, 1, 0);
    const q = new THREE.Quaternion();
    const dir = new THREE.Vector3();
    const color = new THREE.Color();
    // 箭头长度跟着采样盒子走：小盒子里用 0.22 格的箭头会糊满整屏
    const spanMin = Math.min(
      box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]
    );
    const lenBase = Math.max(0.015, Math.min(0.22, spanMin * 0.09));
    for (let n = 0; n < keep.length; n++) {
      const i = keep[n];
      const p = pts[i], d = dirs[i];
      dir.set(d[0], d[1], d[2]);
      q.setFromUnitVectors(up, dir);
      dummy.position.set(p[0], p[1], p[2]);
      dummy.quaternion.copy(q);
      const t = norm(mags[i]);
      const L = lenBase * (0.65 + 0.9 * t);   // 长度也编码强度
      dummy.scale.set(L, L, L);
      dummy.updateMatrix();
      mesh.setMatrixAt(n, dummy.matrix);
      const c = turbo(t);
      color.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
      mesh.setColorAt(n, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.scene3d.applyClipTo(mesh);
    this.group.add(mesh);
    this.arrows = mesh;
    this.lastStats = { count: keep.length, norm, mags };

    // 导体内部的场：E 沿导线、B 绕轴、S 指向轴心
    if (o.interior && field !== 'phi') this.buildInteriorArrows(o, field);
  }

  /* ---- 导体内部的箭头（尺度跟着导体半径走） ---- */
  buildInteriorArrows(o, field) {
    const solver = o.solver;
    const E = [0, 0, 0], B = [0, 0, 0], S = [0, 0, 0];
    const items = [];

    for (let k = 0; k < solver.n; k++) {
      const a = solver.rad ? solver.rad[k] : solver.conductorRadius;
      const L = solver.len[k];
      if (!(a > 0) || !(L > 1e-9)) continue;
      const i3 = 3 * k;
      const p0 = [solver.p0[i3], solver.p0[i3 + 1], solver.p0[i3 + 2]];
      const p1 = [solver.p1[i3], solver.p1[i3 + 1], solver.p1[i3 + 2]];
      const u = [(p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L, (p1[2] - p0[2]) / L];
      const ref = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      let e1 = [
        u[1] * ref[2] - u[2] * ref[1],
        u[2] * ref[0] - u[0] * ref[2],
        u[0] * ref[1] - u[1] * ref[0],
      ];
      const l1 = Math.hypot(e1[0], e1[1], e1[2]) || 1;
      e1 = [e1[0] / l1, e1[1] / l1, e1[2] / l1];
      const e2 = [
        u[1] * e1[2] - u[2] * e1[1],
        u[2] * e1[0] - u[0] * e1[2],
        u[0] * e1[1] - u[1] * e1[0],
      ];

      // 沿轴取几个位置，每个位置在 4 个方位上放箭头（都在导体里）
      const nAlong = Math.max(1, Math.min(3, Math.round(L / (a * 4))));
      for (let q = 0; q < nAlong; q++) {
        const t = (q + 0.5) / nAlong;
        const bx = p0[0] + (p1[0] - p0[0]) * t;
        const by = p0[1] + (p1[1] - p0[1]) * t;
        const bz = p0[2] + (p1[2] - p0[2]) * t;
        for (let az = 0; az < 4; az++) {
          const th = (az / 4) * Math.PI * 2 + k * 0.7;
          const r = a * 0.55;
          const px = bx + e1[0] * Math.cos(th) * r + e2[0] * Math.sin(th) * r;
          const py = by + e1[1] * Math.cos(th) * r + e2[1] * Math.sin(th) * r;
          const pz = bz + e1[2] * Math.cos(th) * r + e2[2] * Math.sin(th) * r;
          solver.eField(px, py, pz, E);
          solver.bField(px, py, pz, B);
          S[0] = (E[1] * B[2] - E[2] * B[1]) / 1.256637061e-6;
          S[1] = (E[2] * B[0] - E[0] * B[2]) / 1.256637061e-6;
          S[2] = (E[0] * B[1] - E[1] * B[0]) / 1.256637061e-6;
          const v = field === 'E' ? E : field === 'B' ? B : S;
          const m = Math.hypot(v[0], v[1], v[2]);
          if (!(m > 0) || !isFinite(m)) continue;
          items.push({
            p: [px * 100, py * 100, pz * 100],
            d: [v[0] / m, v[1] / m, v[2] / m],
            m,
            len: a * 100 * 1.25,
          });
        }
      }
      if (items.length > 2000) break;
    }
    if (!items.length) return;

    const mags = items.map((it) => it.m).sort((x, y) => x - y);
    const l0 = Math.log10(Math.max(mags[0], 1e-30));
    const l1 = Math.log10(Math.max(mags[mags.length - 1], 1e-29));
    const span = Math.max(l1 - l0, 1e-6);

    const geo = makeArrowGeometry();
    const mat = new THREE.MeshBasicMaterial({
      color: 0xff5fd0, transparent: true, opacity: 1.0, depthWrite: false,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, items.length);
    // 实例散布在整个场景里，但几何体的包围球在原点：不关掉视锥剔除，
    // 相机一移开原点整个网格就会被剔除（面板里看不到内部箭头就是这个原因）
    mesh.frustumCulled = false;
    const dummy = new THREE.Object3D();
    const up = new THREE.Vector3(0, 1, 0);
    const qq = new THREE.Quaternion();
    const dir = new THREE.Vector3();
    for (let n = 0; n < items.length; n++) {
      const it = items[n];
      const t = Math.min(1, Math.max(0, (Math.log10(Math.max(it.m, 1e-30)) - l0) / span));
      dir.set(it.d[0], it.d[1], it.d[2]);
      qq.setFromUnitVectors(up, dir);
      dummy.position.set(it.p[0], it.p[1], it.p[2]);
      dummy.quaternion.copy(qq);
      dummy.scale.setScalar(it.len * (0.75 + 0.5 * t));
      dummy.updateMatrix();
      mesh.setMatrixAt(n, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.scene3d.applyClipTo(mesh);
    this.group.add(mesh);
    this.interiorArrows = mesh;
  }

  /* ---- 流线 ---- */
  buildStreams(o, box) {
    const { solver, field } = o;
    if (!(box.max[0] - box.min[0] > 1e-6) || !(box.max[1] - box.min[1] > 1e-6) ||
        !(box.max[2] - box.min[2] > 1e-6)) { this.zero = true; return; }
    const fn = makeFieldFn(field, solver);
    const density = o.density ?? 0.5;
    // 线数要跟着采样范围走：小盒子里还画 40 条会挤成一团
    const span0 = Math.min(
      box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]
    );
    const sizeK = Math.max(0.18, Math.min(1, span0 / 4));
    const nLines = Math.round(
      ((field === 'E' ? 14 : 10) + density * (field === 'E' ? 100 : 68)) * sizeK
    );

    // ---- 等间距撒线（Jobard–Lefer 的思路）----
    // 候选放宽到目标的 5 倍，逐条接受；一条线只有在「离已有线足够远」时才保留。
    // 这样线的疏密由间距 d 决定，而不是由随机撒点碰运气决定。
    const spanMin = Math.min(
      box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]
    );
    const sep0 = Math.max(0.008, spanMin / (16 + density * 54));
    let candidates = this.makeSeeds(solver, box, Math.round(nLines * 8), field, sep0);
    if (o.interior && field !== 'phi') {
      candidates = candidates.concat(this.makeInteriorSeeds(solver, box, Math.round(nLines * 0.35)));
    }

    const sep = sep0;
    // 空间哈希：把已接受的线按 sep 大小的格子存起来，查询 O(1)
    const cellSize = sep;
    const buckets = new Map();
    const keyOf = (x, y, z) =>
      `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)},${Math.floor(z / cellSize)}`;
    const addPoint = (p) => {
      const k = keyOf(p[0], p[1], p[2]);
      let arr = buckets.get(k);
      if (!arr) { arr = []; buckets.set(k, arr); }
      arr.push(p);
    };
    const nearOccupied = (p, radius) => {
      const cx = Math.floor(p[0] / cellSize), cy = Math.floor(p[1] / cellSize), cz = Math.floor(p[2] / cellSize);
      const r2 = radius * radius;
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          for (let k = -1; k <= 1; k++) {
            const arr = buckets.get(`${cx + i},${cy + j},${cz + k}`);
            if (!arr) continue;
            for (let n = 0; n < arr.length; n++) {
              const q = arr[n];
              const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
              if (dx * dx + dy * dy + dz * dz < r2) return true;
            }
          }
        }
      }
      return false;
    };

    const positions = [];
    const colors = [];
    const mags = [];
    const allPts = [];
    const marks = [];
    const tmp = [0, 0, 0];
    const accepted = [];

    for (const sd of candidates) {
      if (accepted.length >= nLines) break;
      const inside = !!(sd && sd.inside);
      const seed = inside ? sd.p : sd;

      // 先看种子点：太挤就直接跳过（便宜，能挡掉大部分候选）
      if (!inside && nearOccupied(seed, sep * 0.85)) continue;

      // 导体外面的场线不穿进导体；导体内部的场线本来就在里面，所以不设终止条件，
      // 步长也要按导体尺度缩小（导线只有 0.5mm，用 0.075 格的步长直接跨出去了）
      // 步数上限压下来：原来一条线能跨 20 多格，横穿整个场景显乱
      const line = inside
        ? integrate(fn, seed, box, (sd.h || 0.004), 600, null)
        : integrate(fn, seed, box, 0.075, field === 'E' ? 260 : 190, solver);
      if (line.length < 8) continue;

      // 再看整条线：如果大半程都贴着已有线，就丢掉（只靠种子点判不够）
      if (!inside) {
        let close = 0, total = 0;
        for (let n = 0; n < line.length; n += 4) {
          total++;
          if (nearOccupied(line[n], sep * 0.62)) close++;
        }
        if (total > 0 && close / total > 0.3) continue;
      }
      const lineMags = [];
      for (const p of line) {
        const v = fn(p[0] * W2M, p[1] * W2M, p[2] * W2M);
        const m = Math.hypot(v[0], v[1], v[2]);
        lineMags.push(m);
        if (m > 0 && isFinite(m)) mags.push(m);
      }
      accepted.push(seed);
      for (let n = 0; n < line.length; n += 2) addPoint(line[n]);
      if (line.length > 1) addPoint(line[line.length - 1]);

      allPts.push({ line, lineMags });

      // 沿线插方向标记：每条线大约 8 个，起点错开，避免所有标记排成一排
      const spacing = Math.max(8, Math.floor(line.length / 4));
      for (let i = spacing; i < line.length - 1; i += spacing) {
        const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
        const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
        const l = Math.hypot(dx, dy, dz);
        if (l < 1e-9) continue;
        marks.push({ p: line[i], d: [dx / l, dy / l, dz / l], m: lineMags[i] });
      }
    }
    if (!mags.length) { this.zero = true; return; }
    if (Math.max(...mags) < (ZERO_FLOOR[field] ?? 0)) { this.zero = true; return; }
    const norm = makeNorm(mags);
    for (const { line, lineMags } of allPts) {
      for (let i = 0; i < line.length - 1; i++) {
        const a = line[i], b = line[i + 1];
        positions.push(a[0], a[1], a[2], b[0], b[1], b[2]);
        const t0 = norm(lineMags[i]), t1 = norm(lineMags[i + 1]);
        const c0 = turbo(t0), c1 = turbo(t1);
        colors.push(c0[0], c0[1], c0[2], c1[0], c1[1], c1[2]);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: (o.opacity ?? 0.95) * 0.85,
      depthWrite: false,
    });
    this.lines = new THREE.LineSegments(geo, mat);
    this.scene3d.applyClipTo(this.lines);
    this.group.add(this.lines);

    // 方向指示箭头（锥体），颜色跟随该点的场强
    if (marks.length) {
      const g2 = makeStreamArrowGeometry();
      const m2 = new THREE.MeshBasicMaterial({ transparent: true, opacity: o.opacity ?? 0.95 });
      const inst = new THREE.InstancedMesh(g2, m2, marks.length);
      const q2 = new THREE.Quaternion();
      const up2 = new THREE.Vector3(0, 1, 0);
      const dv = new THREE.Vector3();
      const dummy2 = new THREE.Object3D();
      const col = new THREE.Color();
      for (let n = 0; n < marks.length; n++) {
        const mk = marks[n];
        dv.set(mk.d[0], mk.d[1], mk.d[2]);
        q2.setFromUnitVectors(up2, dv);
        dummy2.position.set(mk.p[0], mk.p[1], mk.p[2]);
        dummy2.quaternion.copy(q2);
        dummy2.scale.setScalar(1);
        dummy2.updateMatrix();
        inst.setMatrixAt(n, dummy2.matrix);
        const c = turbo(Math.max(0.28, norm(mk.m)));   // 弱场点也别黑成剪影
        col.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
        inst.setColorAt(n, col);
      }
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      this.marks = inst;
      this.scene3d.applyClipTo(inst);
      this.group.add(inst);
    }

    this.lastStats = { lines: allPts.length, marks: marks.length, norm, mags };
  }

  /**
   * 确定性撒种（不再随机）：按导体长度分摊条数，
   * 沿弧长用黄金比、绕轴用黄金角、半径用 Halton 序列 —— 分布均匀且每次重建完全一致。
   */
  makeSeeds(solver, box, n, field, sep = 0) {
    // seedMode = 'uniform' 时在盒内均匀撒点（只用于对比实验）
    if (this.seedMode === 'uniform') {
      const seeds = [];
      const fract = (x) => x - Math.floor(x);
      const span = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
      for (let i = 0; seeds.length < n && i < n * 8; i++) {
        const p = [
          box.min[0] + fract(i * 0.6180339887 + 0.11) * span[0],
          box.min[1] + fract(i * 0.7548776662 + 0.37) * span[1],
          box.min[2] + fract(i * 0.5698402910 + 0.73) * span[2],
        ];
        if (nearestConductorRatio(solver, p[0] * W2M, p[1] * W2M, p[2] * W2M) < 1.3) continue;
        seeds.push(p);
      }
      return seeds;
    }
    const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const fract = (x) => x - Math.floor(x);
    const halton = (i, b) => { let f = 1, r = 0, k = i + 1; while (k > 0) { f /= b; r += f * (k % b); k = Math.floor(k / b); } return r; };
    const PHI = 0.6180339887498949;
    const GOLDEN_ANGLE = 2.399963229728653;

    // 磁场只在载流导体附近有意义；电场则所有带电导体都算
    // 小盒子里大部分导体在盒子外面，从它们身上撒出的种子会被盒子边界全部拒掉，
    // 所以先把候选限制在「盒子附近」的导体上
    const pad = Math.max(0.05, Math.min(
      box.max[0] - box.min[0],
      box.max[1] - box.min[1],
      box.max[2] - box.min[2]
    ) * 0.6);
    const nearBox = (k) => {
      const i3 = 3 * k;
      for (let e = 0; e < 2; e++) {
        const x = (e ? solver.p1[i3] : solver.p0[i3]) * M2W;
        const y = (e ? solver.p1[i3 + 1] : solver.p0[i3 + 1]) * M2W;
        const z = (e ? solver.p1[i3 + 2] : solver.p0[i3 + 2]) * M2W;
        if (x > box.min[0] - pad && x < box.max[0] + pad &&
            y > box.min[1] - pad && y < box.max[1] + pad &&
            z > box.min[2] - pad && z < box.max[2] + pad) return true;
      }
      return false;
    };
    const cand = [];
    const cum = [];
    let total = 0;
    for (let k = 0; k < solver.n; k++) {
      if (field === 'E' || field === 'phi' || Math.abs(solver.cur[k]) > 1e-9) {
        if (!nearBox(k)) continue;
        cand.push(k);
        total += solver.len[k];
        cum.push(total);
      }
    }
    if (!cand.length) {
      for (let k = 0; k < solver.n; k++) {
        cand.push(k);
        total += solver.len[k];
        cum.push(total);
      }
    }
    if (!cand.length || total <= 0) return [];

    // 撒点半径要跟着采样盒子走：吸附到细导线后盒子只有一两毫米，
    // 用固定的 0.2~1 格半径会让种子全部落在盒外（只剩几根线）
    const spanMin = Math.min(
      box.max[0] - box.min[0],
      box.max[1] - box.min[1],
      box.max[2] - box.min[2]
    );
    const rMax = Math.max(0.008, Math.min(1.05, spanMin * 0.42));
    const radii = [0.32, 0.58, 0.8, 1.0];
    const seeds = [];
    let guard = 0;

    for (let i = 0; seeds.length < n && guard < n * 6; i++, guard++) {
      // 按长度分摊：第 i 条种子落在累积长度的 i*φ 处
      const target = fract(i * PHI + 0.1234) * total;
      let ci = 0;
      while (ci < cum.length - 1 && cum[ci] < target) ci++;
      const k = cand[ci];

      // 沿该段的相对位置：另一条无理数序列，避免和选段相关
      const t = fract(i * 0.7548776662466927 + 0.2718);
      const i3 = 3 * k;
      const x0 = solver.p0[i3], y0 = solver.p0[i3 + 1], z0 = solver.p0[i3 + 2];
      const x1 = solver.p1[i3], y1 = solver.p1[i3 + 1], z1 = solver.p1[i3 + 2];
      const base = [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t];
      const dir = norm([x1 - x0, y1 - y0, z1 - z0]);
      const ref = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const e1 = norm(cross(dir, ref));
      const e2 = cross(dir, e1);

      // base 在米制，先换成世界单位，再叠加世界单位下的偏移
      const bx = base[0] * M2W, by = base[1] * M2W, bz = base[2] * M2W;
      // 该段导体的绘制半径（世界单位）
      const radW = (solver.rad ? solver.rad[k] : solver.conductorRadius) * M2W;
      // 上限必须是「盒子放得下」和「导体外面」两者取小：
      // 吸附到细导线后盒子只有一两毫米，如果沿用固定的 0.2~1 格半径，
      // 种子会全部落在盒外或者贴着导体被拒 → 只剩几条线
      const hi = Math.max(radW * 1.6, Math.min(rMax, radW * 12));
      // 半径下限至少和「线间距」一个量级：否则细到线圈那种小半径导体，
      // 一圈圈挤在一起，看起来就是一团乱麻
      const lo = Math.min(hi * 0.92, Math.max(radW * 1.5, sep * 0.55));
      let r;
      if (field === 'E') {
        r = lo + (hi - lo) * halton(i, 3);
      } else {
        const f = radii[Math.floor(halton(i, 5) * radii.length) % radii.length];
        r = lo + (hi - lo) * f;
      }
      const th = i * GOLDEN_ANGLE;
      const ca = Math.cos(th) * r, sa = Math.sin(th) * r;
      const p = [
        bx + e1[0] * ca + e2[0] * sa,
        by + e1[1] * ca + e2[1] * sa,
        bz + e1[2] * ca + e2[2] * sa,
      ];

      if (p[0] < box.min[0] || p[0] > box.max[0]) continue;
      if (p[1] < box.min[1] || p[1] > box.max[1]) continue;
      if (p[2] < box.min[2] || p[2] > box.max[2]) continue;
      if (nearestConductorRatio(solver, p[0] * W2M, p[1] * W2M, p[2] * W2M) < 1.2) continue;
      seeds.push(p);
    }
    return seeds;
  }

  /** 在导体内部撒种（半径小于该段导体自己的半径），用来画导体内部的场线 */
  makeInteriorSeeds(solver, box, n) {
    const fract = (x) => x - Math.floor(x);
    const halton = (i, b) => { let f = 1, r = 0, k = i + 1; while (k > 0) { f /= b; r += f * (k % b); k = Math.floor(k / b); } return r; };
    const GOLDEN_ANGLE = 2.399963229728653;
    const out = [];
    for (let i = 0; i < n; i++) {
      const k = Math.floor(fract(i * 0.6180339887498949 + 0.317) * solver.n);
      const a = solver.rad ? solver.rad[k] : solver.conductorRadius;
      const L = solver.len[k];
      if (!(a > 0) || !(L > 1e-9)) continue;
      const i3 = 3 * k;
      const p0 = [solver.p0[i3], solver.p0[i3 + 1], solver.p0[i3 + 2]];
      const p1 = [solver.p1[i3], solver.p1[i3 + 1], solver.p1[i3 + 2]];
      const u = [(p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L, (p1[2] - p0[2]) / L];
      const ref = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      let e1 = [
        u[1] * ref[2] - u[2] * ref[1],
        u[2] * ref[0] - u[0] * ref[2],
        u[0] * ref[1] - u[1] * ref[0],
      ];
      const l1 = Math.hypot(e1[0], e1[1], e1[2]) || 1;
      e1 = [e1[0] / l1, e1[1] / l1, e1[2] / l1];
      const e2 = [
        u[1] * e1[2] - u[2] * e1[1],
        u[2] * e1[0] - u[0] * e1[2],
        u[0] * e1[1] - u[1] * e1[0],
      ];
      const t = fract(i * 0.7548776662466927 + 0.21);
      const bx = p0[0] + (p1[0] - p0[0]) * t;
      const by = p0[1] + (p1[1] - p0[1]) * t;
      const bz = p0[2] + (p1[2] - p0[2]) * t;
      const rr = a * (0.25 + 0.5 * halton(i, 7));
      const th = i * GOLDEN_ANGLE;
      const pw = [
        (bx + e1[0] * Math.cos(th) * rr + e2[0] * Math.sin(th) * rr) * M2W,
        (by + e1[1] * Math.cos(th) * rr + e2[1] * Math.sin(th) * rr) * M2W,
        (bz + e1[2] * Math.cos(th) * rr + e2[2] * Math.sin(th) * rr) * M2W,
      ];
      if (pw[0] < box.min[0] || pw[0] > box.max[0]) continue;
      if (pw[1] < box.min[1] || pw[1] > box.max[1]) continue;
      if (pw[2] < box.min[2] || pw[2] > box.max[2]) continue;
      out.push({ p: pw, inside: true, h: a * M2W * 0.35 });
    }
    return out;
  }

  /* ---- 切片热图 + 等值线 ---- */
  buildSlice(o, box) {
    const { solver, field } = o;
    const axis = o.sliceAxis ?? 'y';
    const t = (o.slicePos ?? 0) * 0.5 + 0.5; // -1..1 → 0..1
    const span = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
    const planeAt = (k) => box.min[k] + span[k] * t;
    const pos = { x: planeAt(0), y: planeAt(1), z: planeAt(2) };

    const N = Math.round(72 + (o.density ?? 0.5) * 112);
    // (u,v) → 世界坐标
    const map = (u, v) => {
      if (axis === 'x') return [pos.x, box.min[1] + v * span[1], box.min[2] + u * span[2]];
      if (axis === 'y') return [box.min[0] + u * span[0], pos.y, box.min[2] + v * span[2]];
      return [box.min[0] + u * span[0], box.min[1] + v * span[1], pos.z];
    };

    const vals = new Float32Array(N * N);
    const fn = makeFieldFn(field, solver);
    const magsSorted = [];
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const u = (i + 0.5) / N, v = (j + 0.5) / N;
        const p = map(u, v);
        let val;
        if (field === 'phi') val = solver.phi(p[0] * W2M, p[1] * W2M, p[2] * W2M);
        else {
          const w = fn(p[0] * W2M, p[1] * W2M, p[2] * W2M);
          val = Math.hypot(w[0], w[1], w[2]);
          if (isFinite(val)) magsSorted.push(val);
        }
        vals[j * N + i] = isFinite(val) ? val : 0;
      }
    }

    // 全零就直接跳过
    let maxAbs = 0;
    for (let k = 0; k < vals.length; k++) {
      const v = Math.abs(vals[k]);
      if (v > maxAbs) maxAbs = v;
    }
    if (maxAbs < (ZERO_FLOOR[field] ?? 0)) { this.zero = true; return; }

    // 归一化
    let toColor, levelOf;
    if (field === 'phi') {
      const s = [...vals].sort((a, b) => a - b);
      const lo = percentile(s, 0.01), hi = percentile(s, 0.99);
      const mid = 0.5 * (lo + hi), half = Math.max(0.5 * (hi - lo), 1e-9);
      toColor = (v) => diverging(0.5 + 0.5 * (v - mid) / half);
      levelOf = (frac) => mid - half + 2 * half * frac;
    } else {
      const norm = makeNorm(magsSorted);
      toColor = (v) => turbo(norm(v));
      const s = magsSorted.sort((a, b) => a - b);
      const vmin = percentile(s, 0.05), vmax = percentile(s, 0.95);
      const l0 = Math.log10(Math.max(vmin, 1e-30)), l1 = Math.log10(Math.max(vmax, 1e-29));
      levelOf = (frac) => Math.pow(10, l0 + (l1 - l0) * Math.min(Math.max(frac, 0), 1));
    }

    // 纹理
    const data = new Uint8Array(N * N * 4);
    const valRange = field === 'phi'
      ? (() => { const s = [...vals].sort((a, b) => a - b); return [percentile(s, 0.01), percentile(s, 0.99)]; })()
      : [percentile([...magsSorted].sort((a, b) => a - b), 0.0), percentile([...magsSorted].sort((a, b) => a - b), 1.0)];
    const [lo, hi] = valRange;
    const inv = hi - lo || 1;
    for (let k = 0; k < N * N; k++) {
      const c = toColor(vals[k]);
      // 把基于归一化的颜色也做一层淡出，避免边缘「实心」
      data[k * 4] = Math.round(c[0] * 255);
      data[k * 4 + 1] = Math.round(c[1] * 255);
      data[k * 4 + 2] = Math.round(c[2] * 255);
      data[k * 4 + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;

    // 平面几何
    const c00 = map(0, 0), c10 = map(1, 0), c11 = map(1, 1), c01 = map(0, 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      ...c00, ...c10, ...c11, ...c01,
    ], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: o.opacity ?? 0.72,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.slice = new THREE.Mesh(g, mat);
    this.slice.renderOrder = 1;
    this.scene3d.applyClipTo(this.slice);
    this.group.add(this.slice);

    // 等值线（marching squares）
    const levels = 9;
    const segsPos = [];
    const offset = 0.006 * (axis === 'x' ? 1 : 1);
    const bump = axis === 'x' ? [offset, 0, 0] : axis === 'y' ? [0, offset, 0] : [0, 0, offset];
    for (let L = 0; L < levels; L++) {
      const lv = levelOf((L + 0.5) / levels);
      for (let j = 0; j < N - 1; j++) {
        for (let i = 0; i < N - 1; i++) {
          const v00 = vals[j * N + i], v10 = vals[j * N + i + 1];
          const v01 = vals[(j + 1) * N + i], v11 = vals[(j + 1) * N + i + 1];
          const edges = [];
          const interp = (a, b, ua, va, ub, vb) => {
            const f = (lv - a) / (b - a || 1e-30);
            return [ua + (ub - ua) * f, va + (vb - va) * f];
          };
          const u0 = i / (N - 1), u1 = (i + 1) / (N - 1);
          const v0 = j / (N - 1), v1 = (j + 1) / (N - 1);
          if ((v00 - lv) * (v10 - lv) < 0) edges.push(interp(v00, v10, u0, v0, u1, v0));
          if ((v10 - lv) * (v11 - lv) < 0) edges.push(interp(v10, v11, u1, v0, u1, v1));
          if ((v11 - lv) * (v01 - lv) < 0) edges.push(interp(v11, v01, u1, v1, u0, v1));
          if ((v01 - lv) * (v00 - lv) < 0) edges.push(interp(v01, v00, u0, v1, u0, v0));
          for (let e = 0; e + 1 < edges.length; e += 2) {
            const a = map(edges[e][0], edges[e][1]);
            const b = map(edges[e + 1][0], edges[e + 1][1]);
            segsPos.push(a[0] + bump[0], a[1] + bump[1], a[2] + bump[2]);
            segsPos.push(b[0] + bump[0], b[1] + bump[1], b[2] + bump[2]);
          }
        }
      }
    }
    if (segsPos.length) {
      const cg = new THREE.BufferGeometry();
      cg.setAttribute('position', new THREE.Float32BufferAttribute(segsPos, 3));
      this.contours = new THREE.LineSegments(cg, new THREE.LineBasicMaterial({
        color: 0x000000, transparent: true, opacity: 0.55,
      }));
      this.contours.renderOrder = 2;
      this.scene3d.applyClipTo(this.contours);
      this.group.add(this.contours);
    }
    this.lastStats = { N };
  }
}

/* ---------------- 几何/积分 ---------------- */
function makeArrowGeometry() {
  // 细长箭头：杆和头的半径都压小，远景才不会糊成一片
  const shaft = new THREE.CylinderGeometry(0.022, 0.022, 0.62, 6, 1, false);
  shaft.translate(0, 0.31, 0);
  const head = new THREE.ConeGeometry(0.058, 0.38, 8);
  head.translate(0, 0.62 + 0.19, 0);
  const g = mergeGeos([shaft, head]);
  g.translate(0, -0.5, 0);
  return g;
}

function makeStreamArrowGeometry() {
  const g = new THREE.ConeGeometry(0.019, 0.072, 5, 1, true);
  g.translate(0, 0.036, 0);
  return g;
}

function nearestConductor(solver, x, y, z) {
  let best = Infinity;
  for (let k = 0; k < solver.n; k++) {
    const x0 = solver.p0[3 * k], y0 = solver.p0[3 * k + 1], z0 = solver.p0[3 * k + 2];
    const dx = solver.p1[3 * k] - x0, dy = solver.p1[3 * k + 1] - y0, dz = solver.p1[3 * k + 2] - z0;
    const l2 = dx * dx + dy * dy + dz * dz;
    let tt = l2 > 0 ? ((x - x0) * dx + (y - y0) * dy + (z - z0) * dz) / l2 : 0;
    tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
    const px = x - (x0 + dx * tt), py = y - (y0 + dy * tt), pz = z - (z0 + dz * tt);
    const d = Math.sqrt(px * px + py * py + pz * pz);
    if (d < best) best = d;
  }
  return best;
}

/** 距离 / 该段导体自己的半径：<1 表示在导体内部 */
function nearestConductorRatio(solver, x, y, z) {
  let best = Infinity;
  const rad = solver.rad;
  for (let k = 0; k < solver.n; k++) {
    const x0 = solver.p0[3 * k], y0 = solver.p0[3 * k + 1], z0 = solver.p0[3 * k + 2];
    const dx = solver.p1[3 * k] - x0, dy = solver.p1[3 * k + 1] - y0, dz = solver.p1[3 * k + 2] - z0;
    const l2 = dx * dx + dy * dy + dz * dz;
    let tt = l2 > 0 ? ((x - x0) * dx + (y - y0) * dy + (z - z0) * dz) / l2 : 0;
    tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
    const px = x - (x0 + dx * tt), py = y - (y0 + dy * tt), pz = z - (z0 + dz * tt);
    const r = Math.sqrt(px * px + py * py + pz * pz) / (rad ? rad[k] : 0.0005);
    if (r < best) best = r;
  }
  return best;
}

/** RK4 双向积分一条流线，返回世界坐标点列 */
function integrate(fn, seed, box, h, maxSteps, stopSolver = null, stopR = 0) {
  const out = [];
  const fwd = trace(fn, seed, box, h, maxSteps, 1, stopSolver, stopR);
  const bwd = trace(fn, seed, box, h, maxSteps, -1, stopSolver, stopR).slice(1).reverse();
  for (const p of bwd) out.push(p);
  out.push(seed);
  for (const p of fwd) out.push(p);
  return out;
}

function trace(fn, seed, box, h, maxSteps, sign, stopSolver = null, stopR = 0) {
  const pts = [];
  let x = seed[0], y = seed[1], z = seed[2];
  const inside = (p) => p[0] > box.min[0] && p[0] < box.max[0] &&
    p[1] > box.min[1] && p[1] < box.max[1] && p[2] > box.min[2] && p[2] < box.max[2];
  const dir = (px, py, pz) => {
    const v = fn(px * W2M, py * W2M, pz * W2M);
    const m = Math.hypot(v[0], v[1], v[2]);
    if (!(m > 0) || !isFinite(m)) return null;
    return [(v[0] / m) * sign, (v[1] / m) * sign, (v[2] / m) * sign];
  };
  for (let step = 0; step < maxSteps; step++) {
    const k1 = dir(x, y, z);
    if (!k1) break;
    const k2 = dir(x + h * 0.5 * k1[0], y + h * 0.5 * k1[1], z + h * 0.5 * k1[2]);
    if (!k2) break;
    const k3 = dir(x + h * 0.5 * k2[0], y + h * 0.5 * k2[1], z + h * 0.5 * k2[2]);
    if (!k3) break;
    const k4 = dir(x + h * k3[0], y + h * k3[1], z + h * k3[2]);
    if (!k4) break;
    x += (h / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
    y += (h / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
    z += (h / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
    pts.push([x, y, z]);
    if (!inside([x, y, z])) break;
    // 场线终结在导体表面
    if (stopSolver && step % 2 === 0 && nearestConductorRatio(stopSolver, x * W2M, y * W2M, z * W2M) < 1.2) break;
    // 闭合的场线（磁场常见）回到起点附近就停，避免绕圈刷点
    if (step > 24) {
      const d2 = (x - seed[0]) ** 2 + (y - seed[1]) ** 2 + (z - seed[2]) ** 2;
      if (d2 < 0.02) break;
    }
  }
  return pts;
}


