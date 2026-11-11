/**
 * slicepane.js —— 左侧下半栏的「截取空间」
 *
 * 它和主视图用的是**同一套渲染代码**（Scene3D + FieldViz、同样的场与显示模式），
 * 区别只有两点：
 *   1. 采样只在选定的长方体里做（o.box），同样的箭头/流线数量落在更小的体积里 → 更密
 *   2. 六个裁剪平面把这个体块之外的一切都切掉
 *
 * 所以它看到的就是「主视图的放大版」，而不是另一套渲染。
 */
import * as THREE from 'three';
import { Scene3D } from './scene.js';
import { FieldViz } from './viz.js';

export class SlicePane {
  constructor(container) {
    this.scene = new Scene3D(container);
    // 体块放大后相机要能退得更远；也能推到很近看细节
    this.scene.controls.minDistance = 0.05;
    this.scene.controls.maxDistance = 400;
    this.viz = new FieldViz(this.scene);

    this.solver = null;
    this.bounds = null;
    this.parts = null;
    this.base = [0, 0, 0];

    // 体块状态（相对电路中心的偏移 + 三轴半边长，单位=格）
    this.box = { cx: 0, cy: 0.35, cz: 0, sx: 2.4, sy: 1.5, sz: 2.4 };
    this._fitted = false;
    this._timer = null;
    this._last = null;
    this.outlines = [];
  }

  /** 面板自己的线框（主视图那边由 BoxGizmo 负责，可以单独隐藏） */
  attachOutline() {
    const g = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    const m = new THREE.LineBasicMaterial({ color: 0x7ee0ff, transparent: true, opacity: 0.35 });
    this.outlinePane = new THREE.LineSegments(g, m);
    this.outlinePane.userData.noClip = true;
    this.scene.scene.add(this.outlinePane);
    this.outlines = [this.outlinePane];
    this.syncOutline();
  }

  syncOutline() {
    const b = this.worldBox;
    const w = b.max[0] - b.min[0], h = b.max[1] - b.min[1], d = b.max[2] - b.min[2];
    for (const o of this.outlines) {
      o.position.set(b.center[0], b.center[1], b.center[2]);
      o.scale.set(w, h, d);
    }
  }

  /** 由世界坐标 min/max 反推体块参数（给主视图的拖拽框用） */
  setWorldBox(min, max) {
    const base = this.base;
    const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const L = this.locks || {};
    this.box.cx = L.x ? this.box.cx : c[0] - base[0];
    this.box.cy = L.y ? this.box.cy : c[1] - base[1];
    this.box.cz = L.z ? this.box.cz : c[2] - base[2];
    this.box.sx = Math.max(0.004, (max[0] - min[0]) / 2);
    this.box.sy = Math.max(0.004, (max[1] - min[1]) / 2);
    this.box.sz = Math.max(0.004, (max[2] - min[2]) / 2);
    this.applyBoxChange();
  }

  /* ---------------- 体块 <-> 世界 ---------------- */
  get worldBox() {
    const b = this.box, base = this.base;
    const c = [base[0] + b.cx, base[1] + b.cy, base[2] + b.cz];
    return {
      center: c,
      min: [c[0] - b.sx, c[1] - b.sy, c[2] - b.sz],
      max: [c[0] + b.sx, c[1] + b.sy, c[2] + b.sz],
    };
  }

  static planesFor(box) {
    const p = (nx, ny, nz, c) => new THREE.Plane(new THREE.Vector3(nx, ny, nz), c);
    return [
      p(1, 0, 0, -box.min[0]), p(-1, 0, 0, box.max[0]),
      p(0, 1, 0, -box.min[1]), p(0, -1, 0, box.max[1]),
      p(0, 0, 1, -box.min[2]), p(0, 0, -1, box.max[2]),
    ];
  }

  /* ---------------- 场景 ---------------- */
  /** 锁定的中心轴：锁定后拖动截取框不会改这一轴 */
  setLocks(l) { this.locks = { x: !!(l && l.x), y: !!(l && l.y), z: !!(l && l.z) }; }

  setScene({ solver, bounds, parts, colorByPotential, conductorR }) {
    this.solver = solver;
    this.bounds = bounds;
    this.parts = parts;
    if (conductorR) this.conductorR = conductorR;
    if (!solver || !solver.n) return;
    this.base = [
      (bounds.min[0] + bounds.max[0]) / 2,
      0,
      (bounds.min[2] + bounds.max[2]) / 2,
    ];
    if (!this._fitted) {
      this._fitted = true;
      this._fittedOnce = true;
      // 初始位置 = 吸附到发热最大的那根导线（比铺满整个电路好用）
      this.snapToWire();
      this._framed = false;
    }
    const box = this.worldBox;
    this.scene.setClipPlanes(SlicePane.planesFor(box));
    this.scene.setSolver(solver);
    this.scene.setCircuit(parts, bounds, { colorByPotential, frame: false });
    this.scene.applyClipTo(this.scene.circuitGroup);
    this.syncOutline();
    if (!this._framed) { this.frame(); this._framed = true; }
  }

  /** 只改体块：重设裁剪面 + 重算可视化 */
  setBox(patch) {
    const L = this.locks || {};
    const p = { ...patch };
    if (L.x) delete p.cx;
    if (L.y) delete p.cy;
    if (L.z) delete p.cz;
    Object.assign(this.box, p);
    this.applyBoxChange();
  }

  applyBoxChange() {
    const box = this.worldBox;
    const c = box.center;
    // 体块移动时，相机和观察点一起平移 → 画面里看到的是「框在动、视角不动」；
    // 而轨道旋转仍然以体块中心为轴心
    if (this._lastC) {
      const dx = c[0] - this._lastC[0], dy = c[1] - this._lastC[1], dz = c[2] - this._lastC[2];
      const cam = this.scene.camera;
      cam.position.x += dx; cam.position.y += dy; cam.position.z += dz;
    }
    this._lastC = c;
    this.scene.controls.target.set(c[0], c[1], c[2]);
    this.scene.setClipPlanes(SlicePane.planesFor(box));
    this.scene.applyClipTo(this.scene.circuitGroup);
    this.syncOutline();
    this.requestUpdate();
  }

  /** 把相机对准体块，并让体块铺满画框（按投影后的宽高算距离，比包围球准得多） */
  frame() {
    const box = this.worldBox;
    const c = box.center;
    const cam = this.scene.camera;

    // 方位角与主视图一致，方便左右对照
    const dir = (() => { const d = [0.5, 0.78, 0.72]; const l = Math.hypot(...d); return d.map((v) => v / l); })();
    const right = (() => {
      const r = [-dir[2], 0, dir[0]];           // dir × up(0,1,0)
      const l = Math.hypot(...r) || 1;
      return r.map((v) => v / l);
    })();
    const up = [
      right[1] * dir[2] - right[2] * dir[1],
      right[2] * dir[0] - right[0] * dir[2],
      right[0] * dir[1] - right[1] * dir[0],
    ];

    // 八个角点投影到相机平面
    let W = 0, H = 0, Z = 0;
    for (let i = 0; i < 8; i++) {
      const p = [
        (i & 1 ? box.max[0] : box.min[0]) - c[0],
        (i & 2 ? box.max[1] : box.min[1]) - c[1],
        (i & 4 ? box.max[2] : box.min[2]) - c[2],
      ];
      const x = Math.abs(p[0] * right[0] + p[1] * right[1] + p[2] * right[2]);
      const y = Math.abs(p[0] * up[0] + p[1] * up[1] + p[2] * up[2]);
      const z = p[0] * dir[0] + p[1] * dir[1] + p[2] * dir[2];
      W = Math.max(W, x);
      H = Math.max(H, y);
      Z = Math.max(Z, z);
    }

    const vFov = ((cam.fov || 45) * Math.PI) / 180;
    const aspect = (isFinite(cam.aspect) && cam.aspect > 0) ? cam.aspect : 1.6;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const dH = H / Math.tan(vFov / 2);
    const dW = W / Math.tan(hFov / 2);
    const dist = Math.max(dH, dW, 0.35) + Z;

    this.scene.controls.target.set(c[0], c[1], c[2]);
    cam.position.set(
      c[0] + dir[0] * dist,
      c[1] + dir[1] * dist,
      c[2] + dir[2] * dist
    );
    this._lastC = c;
    this.scene.controls.update();
  }

  /** 吸附到发热最大的那根导线：中心对准它，尺寸收到导线附近 */
  snapToWire() {
    const solver = this.solver;
    if (!solver || !solver.n) return;
    let best = 0, bestP = -1;
    for (let k = 0; k < solver.n; k++) {
      const p = Math.abs(solver.eAx[k] * solver.cur[k]) * solver.len[k];
      if (p > bestP) { bestP = p; best = k; }
    }
    const i3 = 3 * best;
    const mid = [
      (solver.p0[i3] + solver.p1[i3]) / 2,
      (solver.p0[i3 + 1] + solver.p1[i3 + 1]) / 2,
      (solver.p0[i3 + 2] + solver.p1[i3 + 2]) / 2,
    ];
    const half = Math.max(0.16, (this.conductorR || 0.0005) * 100 * 5.5);
    this.box.sx = this.box.sy = this.box.sz = half;
    this.box.cx = mid[0] * 100 - this.base[0];
    this.box.cy = mid[1] * 100 - this.base[1];
    this.box.cz = mid[2] * 100 - this.base[2];
    this.applyBoxChange();
    this.frame();
  }

  /* ---------------- 可视化 ---------------- */
  requestUpdate() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      if (this._last) this.update(this._last);
    }, 90);
  }

  update({ field, mode, density, opacity, colorByPotential, sliceAxis, slicePos, interior }) {
    if (!this.solver || !this.solver.n) return;
    this._last = { field, mode, density, opacity, colorByPotential, sliceAxis, slicePos, interior };
    const box = this.worldBox;
    // 采样体块稍微放大一点，交给裁剪面去切，边缘才不会有硬边
    const pad = [
      (box.max[0] - box.min[0]) * 0.04,
      (box.max[1] - box.min[1]) * 0.04,
      (box.max[2] - box.min[2]) * 0.04,
    ];
    const sampleBox = {
      min: [box.min[0] - pad[0], box.min[1] - pad[1], box.min[2] - pad[2]],
      max: [box.max[0] + pad[0], box.max[1] + pad[1], box.max[2] + pad[2]],
    };
    this.viz.update({
      solver: this.solver,
      bounds: this.bounds,
      field,
      mode,
      // 同样多的箭头/流线落在更小的体积里，天然更密
      density: Math.max(0, Math.min(1, density)),
      opacity: opacity ?? 0.95,
      sliceAxis,
      slicePos,
      interior: !!interior,   // 导体内部的箭头也要画（之前这个参数被扔掉了）
      box: sampleBox,
    });
    this.scene.applyClipTo(this.scene.fieldGroup);
  }

  resize() {
    this.scene.resize();
    if (!this._framedOnce && this.solver) {
      this.frame();
      this._framedOnce = true;
    }
  }
}
