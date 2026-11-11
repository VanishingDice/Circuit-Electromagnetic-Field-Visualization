/**
 * circuit.js —— 电路模型、直流 MNA 求解、以及「2D 电路图 → 3D 场景」的展开
 *
 * 直流稳态约定（本版）：
 *   导线 / 电感 → 有微小电阻的导体（电感直流等效短路）
 *   电阻        → 导体
 *   电源        → 理想电压源，内部沿本体电势线性上升（这就是 EMF 区）
 *   电容        → 开路，两块极板各自停留在所连节点的电位上（电荷由边界元自洽求出）
 *
 * 之所以给导线也留一点电阻，是为了让沿导线有真实的电位降落：
 * 这样导线表面才会同时有「纵向 E」和「横向 E」，
 * 能量（坡印廷矢量）才会呈现经典的「电池侧面流出 → 电阻侧面流入」。
 */

import { FieldSolver, METER_PER_UNIT } from './field.js';

export const GRID_U = 1;          // 每格的世界单位
export const CX = 5.5, CY = 3.5;  // 网格中心 → 世界原点

export const R_WIRE = 0.02;       // 每段导线电阻 Ω
export const R_COIL = 0.01;       // 电感直流电阻 Ω

export const TYPES = {
  wire:      { label: '导线', unit: '',   min: 0,  max: 0,    def: 0,    color: '#c98b4b' },
  resistor:  { label: '电阻', unit: 'Ω',  min: 1,  max: 2000, def: 100,  color: '#d8cfc0' },
  battery:   { label: '电源', unit: 'V',  min: 0.5, max: 24,  def: 9,    color: '#e06c5a' },
  capacitor: { label: '电容', unit: 'µF', min: 0.1, max: 100, def: 10,   color: '#7fb3d5' },
  inductor:  { label: '电感', unit: 'mH', min: 0.1, max: 100, def: 10,   color: '#b08bd6' },
};

let _id = 1;
export const newId = () => 'e' + (_id++);

export const key = (p) => p[0] + ',' + p[1];

export function worldOf(p) {
  return [(p[0] - CX) * GRID_U, 0, (p[1] - CY) * GRID_U];
}

export function createDefaultCircuit() {
  const els = [];
  const add = (type, a, b, value) => els.push({ id: newId(), type, a, b, value });
  add('battery', [1, 1], [1, 4], 9);      // 负极在下，正极在上
  add('wire', [1, 4], [3, 4]);
  add('resistor', [3, 4], [5, 4], 100);
  add('wire', [5, 4], [6, 4]);
  add('inductor', [6, 4], [7, 4], 10);
  add('wire', [7, 4], [8, 4]);
  add('wire', [8, 4], [8, 1]);
  add('wire', [8, 1], [3, 1]);
  add('wire', [3, 1], [1, 1]);
  add('wire', [3, 4], [3, 3]);
  add('capacitor', [3, 3], [3, 2], 10);
  add('wire', [3, 2], [3, 1]);
  return { elements: els, groundHint: [1, 1] };
}

/* ------------------------------------------------------------------ *
 *  拓扑
 * ------------------------------------------------------------------ */

/** 点 p 是否落在线段 ab 的内部（整数网格上判断共线） */
function strictlyInside(p, a, b) {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  if (cross !== 0) return false;
  const dot = (p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1]);
  const len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  return dot > 0 && dot < len2;
}

/**
 * 把落在某个元件内部的新端点切开，保证「端点相连才是相连」。
 * 返回被切分的元件（新元件会修改传入的数组）。
 */
export function splitAt(circuit, p) {
  const out = [];
  for (const el of circuit.elements) {
    if (el.type === 'capacitor') { out.push(el); continue; }
    if (strictlyInside(p, el.a, el.b)) {
      out.push({ ...el, id: newId(), b: p.slice() });
      out.push({ ...el, id: newId(), a: p.slice(), b: el.b.slice() });
    } else out.push(el);
  }
  circuit.elements = out;
}

/* ------------------------------------------------------------------ *
 *  直流 MNA
 * ------------------------------------------------------------------ */

/** 稠密线性方程组求解（部分主元高斯消元），就地修改 A */
function solveLinear(A, b, n) {
  const w = n; // 行跨距；右端项单独放在 b 里
  for (let col = 0; col < n; col++) {
    let piv = col, best = Math.abs(A[col * w + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(A[r * w + col]);
      if (v > best) { best = v; piv = r; }
    }
    if (best < 1e-14) continue;
    if (piv !== col) {
      for (let k = col; k < w; k++) {
        const t = A[col * w + k]; A[col * w + k] = A[piv * w + k]; A[piv * w + k] = t;
      }
      const t = b[col]; b[col] = b[piv]; b[piv] = t;
    }
    const d = A[col * w + col];
    for (let k = col; k < w; k++) A[col * w + k] /= d;
    b[col] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r * w + col];
      if (!f) continue;
      for (let k = col; k < w; k++) A[r * w + k] -= f * A[col * w + k];
      b[r] -= f * b[col];
    }
  }
  return b;
}

export function conductanceOf(el) {
  switch (el.type) {
    case 'wire': return 1 / R_WIRE;
    case 'inductor': return 1 / R_COIL;
    case 'resistor': return 1 / Math.max(el.value, 1e-3);
    case 'capacitor': return 1e-12;   // 开路（留极小电导保证矩阵不奇异）
    default: return 0;                // battery 用电压源方程
  }
}

/**
 * 解直流工作点。
 * @returns {{ nodeV: Object, elCurrent: Object, nodeList: string[] }}
 *   elCurrent[i] 为元件 id → 电流，方向 a→b 为正
 */
export function solveCircuit(circuit) {
  const nodeSet = new Set();
  for (const el of circuit.elements) { nodeSet.add(key(el.a)); nodeSet.add(key(el.b)); }
  const nodeList = [...nodeSet];
  const idx = new Map(nodeList.map((k, i) => [k, i]));
  const N = nodeList.length;

  // 接地：取最靠左下角的节点
  const ground = nodeList.reduce((best, k) => {
    const [i, j] = k.split(',').map(Number);
    const [bi, bj] = best.split(',').map(Number);
    return (j < bj || (j === bj && i < bi)) ? k : best;
  }, nodeList[0] || '0,0');
  const g = idx.get(ground);

  const sources = circuit.elements.filter((e) => e.type === 'battery');
  const M = sources.length;
  const size = N + M;
  const A = new Float64Array(size * size);
  const b = new Float64Array(size);
  const srcIndex = new Map(sources.map((s, k) => [s.id, N + k]));

  // 导电支路：叠加到 KCL
  for (const el of circuit.elements) {
    if (el.type === 'battery') continue;
    const i1 = idx.get(key(el.a)), i2 = idx.get(key(el.b));
    const gv = conductanceOf(el);
    if (i1 === i2) continue;
    A[i1 * size + i1] += gv; A[i2 * size + i2] += gv;
    A[i1 * size + i2] -= gv; A[i2 * size + i1] -= gv;
  }

  // 电压源：V_b − V_a = E，支路电流 I 方向 a→b
  for (const s of sources) {
    const i1 = idx.get(key(s.a)), i2 = idx.get(key(s.b));
    const k = srcIndex.get(s.id);
    A[i1 * size + k] += 1;   // 节点 a 流出 +I
    A[i2 * size + k] -= 1;   // 节点 b 流入 −I
    A[k * size + i1] -= 1;   // V_b − V_a = E
    A[k * size + i2] += 1;
    b[k] = s.value;
  }

  // 接地行
  for (let c = 0; c < size; c++) A[g * size + c] = 0;
  A[g * size + g] = 1;
  b[g] = 0;

  const x = solveLinear(A, b, size);

  const nodeV = {};
  nodeList.forEach((k, i) => { nodeV[k] = x[i]; });
  const elCurrent = {};
  for (const el of circuit.elements) {
    if (el.type === 'battery') {
      elCurrent[el.id] = x[srcIndex.get(el.id)];
      continue;
    }
    const i1 = idx.get(key(el.a)), i2 = idx.get(key(el.b));
    elCurrent[el.id] = i1 === i2 ? 0 : conductanceOf(el) * (x[i1] - x[i2]);
  }
  return { nodeV, elCurrent, nodeList, ground };
}

/* ------------------------------------------------------------------ *
 *  几何展开
 * ------------------------------------------------------------------ */

// BEM 线段长度：细线近似要求 半径 ≪ 线段长，所以两端一起缩放
const SEG_FACTOR = 12;
const SEG_LEN_MIN = 0.3;
const WIRE_R = 0.05;       // 默认导线半径（世界单位；1 单位 = 1 cm）
const PLATE_HALF = 0.42;   // 电容极板半宽
const PLATE_GAP = 0.34;    // 极板间距
const PLATE_STRIPS = 7;    // 极板用几条平行线电荷近似

function subdivide(p0, p1, maxLen) {
  const d = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  const n = Math.max(1, Math.ceil(d / maxLen));
  const out = [];
  for (let k = 0; k < n; k++) {
    const t0 = k / n, t1 = (k + 1) / n;
    out.push([
      [p0[0] + (p1[0] - p0[0]) * t0, p0[1] + (p1[1] - p0[1]) * t0, p0[2] + (p1[2] - p0[2]) * t0],
      [p0[0] + (p1[0] - p0[0]) * t1, p0[1] + (p1[1] - p0[1]) * t1, p0[2] + (p1[2] - p0[2]) * t1],
    ]);
  }
  return out;
}

const V3 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = V3.len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
};

/** 世界坐标下的轴、上方向、侧方向 */
function frameFor(A, B) {
  const axis = V3.norm(V3.sub(B, A));
  let up = [0, 1, 0];
  if (Math.abs(axis[1]) > 0.9) up = [0, 0, 1];
  const side = V3.norm(V3.cross(up, axis));
  up = V3.norm(V3.cross(axis, side));
  return { axis, up, side, L: V3.len(V3.sub(B, A)) };
}

/**
 * 把一个元件展开成：视觉图元 parts + 场计算的导体线段 segs（米制）。
 */
export function buildScene(circuit, solution, opts = {}) {
  const { nodeV, elCurrent } = solution || solveCircuit(circuit);
  // 画面上的导线半径（可调，只影响几何与「导体内部」的解析场）
  const wireRadius = opts.wireRadius ?? WIRE_R;
  // 边界元用的细线半径：细线近似要求 半径 ≪ 线段长，所以固定得比较细
  const physicsRadius = Math.min(wireRadius, 0.02);
  const SEG_LEN = Math.max(SEG_LEN_MIN, SEG_FACTOR * physicsRadius);
  const parts = [];
  const segs = [];
  const M = METER_PER_UNIT;

  const pushSeg = (p0, p1, pot, cur, eAx = 0) => {
    const a = V3.mul(p0, M), c = V3.mul(p1, M);
    segs.push({ p0: a, p1: c, pot, cur, eAx });
  };

  for (const el of circuit.elements) {
    const A = worldOf(el.a), B = worldOf(el.b);
    const Va = nodeV[key(el.a)] ?? 0;
    const Vb = nodeV[key(el.b)] ?? 0;
    const I = elCurrent[el.id] ?? 0;
    const { axis, up, side, L } = frameFor(A, B);
    if (L < 1e-9) continue;

    // 沿路径把电势线性插值（EMF 区也一样：电源内部电势就是线性上升的）
    const addPath = (pts, pot0, pot1, opts = {}) => {
      let total = 0;
      const cum = [0];
      for (let k = 1; k < pts.length; k++) { total += V3.len(V3.sub(pts[k], pts[k - 1])); cum.push(total); }
      for (let k = 1; k < pts.length; k++) {
        const p0 = pts[k - 1], p1 = pts[k];
        const segLen = cum[k - 1] === cum[k] ? 1 : (cum[k] - cum[k - 1]);
        for (const [q0, q1] of subdivide(p0, p1, SEG_LEN)) {
          const f0 = V3.len(V3.sub(q0, p0)) / segLen;
          const f1 = V3.len(V3.sub(q1, p0)) / segLen;
          const tA = total > 0 ? Math.min(1, (cum[k - 1] + segLen * f0) / total) : 0;
          const tB = total > 0 ? Math.min(1, (cum[k - 1] + segLen * f1) / total) : 0;
          const vA = pot0 + (pot1 - pot0) * tA;
          const vB = pot0 + (pot1 - pot0) * tB;
          const Lm = V3.len(V3.sub(q1, q0)) * M;
          pushSeg(q0, q1, vA, opts.current ?? I, Lm > 1e-12 ? (vA - vB) / Lm : 0);
        }
      }
    };

    switch (el.type) {
      case 'wire': {
        addPath([A, B], Va, Vb);
        parts.push({ kind: 'tube', pts: [A, B], radius: wireRadius, mat: 'copper' });
        break;
      }
      case 'resistor': {
        addPath([A, B], Va, Vb);
        const bodyA = V3.add(A, V3.mul(axis, L * 0.22));
        const bodyB = V3.add(A, V3.mul(axis, L * 0.78));
        parts.push({ kind: 'tube', pts: [A, bodyA], radius: wireRadius, mat: 'copper' });
        parts.push({ kind: 'tube', pts: [bodyB, B], radius: wireRadius, mat: 'copper' });
        parts.push({ kind: 'tube', pts: [bodyA, bodyB], radius: 0.11, mat: 'body' });
        parts.push({ kind: 'label', pos: V3.add(V3.mul(V3.add(bodyA, bodyB), 0.5), V3.mul(up, 0.28)), text: `${fmt(el.value)}Ω` });
        break;
      }
      case 'battery': {
        addPath([A, B], Va, Vb);
        const bodyA = V3.add(A, V3.mul(axis, L * 0.18));
        const bodyB = V3.add(A, V3.mul(axis, L * 0.82));
        parts.push({ kind: 'tube', pts: [A, bodyA], radius: wireRadius, mat: 'copper' });
        parts.push({ kind: 'tube', pts: [bodyB, B], radius: wireRadius, mat: 'copper' });
        parts.push({ kind: 'box', center: V3.mul(V3.add(bodyA, bodyB), 0.5), axis, up, side, size: [V3.len(V3.sub(bodyB, bodyA)), 0.26, 0.52], mat: 'battery' });
        parts.push({ kind: 'box', center: V3.add(bodyB, V3.mul(axis, 0.05)), axis, up, side, size: [0.06, 0.4, 0.4], mat: 'batteryPlus' });
        parts.push({ kind: 'label', pos: V3.add(V3.mul(V3.add(bodyA, bodyB), 0.5), V3.mul(up, 0.42)), text: `${fmt(el.value)}V` });
        break;
      }
      case 'capacitor': {
        const mid = V3.mul(V3.add(A, B), 0.5);
        const half = PLATE_GAP / 2;
        const p1c = V3.add(mid, V3.mul(axis, -half));
        const p2c = V3.add(mid, V3.mul(axis, half));
        addPath([A, p1c], Va, Va, { current: 0 });
        addPath([p2c, B], Vb, Vb, { current: 0 });
        parts.push({ kind: 'tube', pts: [A, p1c], radius: wireRadius, mat: 'copper' });
        parts.push({ kind: 'tube', pts: [p2c, B], radius: wireRadius, mat: 'copper' });
        // 极板：每一块用若干条平行线电荷近似（这样才能解出边缘效应）
        for (const [pc, pot] of [[p1c, Va], [p2c, Vb]]) {
          for (let k = 0; k < PLATE_STRIPS; k++) {
            const off = (k / (PLATE_STRIPS - 1) - 0.5) * 2 * PLATE_HALF * 0.92;
            const c0 = V3.add(pc, V3.mul(up, off));
            const q0 = V3.add(c0, V3.mul(side, -PLATE_HALF));
            const q1 = V3.add(c0, V3.mul(side, PLATE_HALF));
            addPath([q0, q1], pot, pot, { current: 0 });
          }
          parts.push({ kind: 'plate', center: pc, axis, up, side, half: PLATE_HALF, mat: 'plate' });
        }
        parts.push({ kind: 'label', pos: V3.add(mid, V3.mul(up, 0.62)), text: `${fmt(el.value)}µF` });
        break;
      }
      case 'inductor': {
        const t1 = 0.18, t2 = 0.84, turns = 4, rad = 0.2;
        const pts = [A];
        const K = 12 * turns;
        for (let k = 0; k <= K; k++) {
          const t = t1 + (t2 - t1) * (k / K);
          const ang = 2 * Math.PI * turns * (k / K);
          pts.push(V3.add(
            V3.add(A, V3.mul(axis, L * t)),
            V3.add(V3.mul(up, rad * Math.cos(ang)), V3.mul(side, rad * Math.sin(ang)))
          ));
        }
        pts.push(B);
        addPath(pts, Va, Vb);
        parts.push({ kind: 'tube', pts, radius: wireRadius * 0.85, mat: 'coil' });
        parts.push({ kind: 'label', pos: V3.add(V3.add(A, V3.mul(axis, L * 0.5)), V3.mul(up, 0.45)), text: `${fmt(el.value)}mH` });
        break;
      }
    }
  }

  // 节点小球（按电位着色，帮助看清接点）
  for (const k of Object.keys(nodeV)) {
    const [i, j] = k.split(',').map(Number);
    parts.push({ kind: 'node', pos: worldOf([i, j]), pot: nodeV[k] });
  }

  // 场求解器
  const solver = new FieldSolver(physicsRadius * M, wireRadius * M);
  for (const s of segs) solver.add(s.p0, s.p1, s.pot, s.cur, s.eAx);
  solver.build().solve();

  // 场景包络，供相机取景（注意：segments 是米制，这里换回世界单位）
  const bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
  for (const s of segs) {
    for (const p of [s.p0, s.p1]) {
      for (let k = 0; k < 3; k++) {
        const w = p[k] / M;
        bmin[k] = Math.min(bmin[k], w);
        bmax[k] = Math.max(bmax[k], w);
      }
    }
  }

  const empty = !isFinite(bmin[0]);
  const bounds = empty
    ? { min: [-1, 0, -1], max: [1, 0, 1] }
    : { min: bmin, max: bmax };

  return { parts, segs, solver, nodeV, elCurrent, bounds, solution, empty };
}

function fmt(v) {
  if (v === undefined) return '—';
  if (Math.abs(v) >= 100) return String(Math.round(v * 10) / 10);
  return String(Math.round(v * 100) / 100);
}
