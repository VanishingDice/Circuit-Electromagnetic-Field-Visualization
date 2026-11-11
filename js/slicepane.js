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
    this.box.cx = c[0] - base[0];
    this.box.cy = c[1] - base[1];
    this.box.cz = c[2] - base[2];
    this.box.sx = Math.max(0.12, (max[0] - min[0]) / 2);
    this.box.sy = Math.max(0.12, (max[1] - min[1]) / 2);
    this.box.sz = Math.max(0.12, (max[2] - min[2]) / 2);
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
  setScene({ solver, bounds, parts, colorByPotential }) {
    this.solver = solver;
    this.bounds = bounds;
    this.parts = parts;
    if (!solver || !solver.n) return;
    this.base = [
      (bounds.min[0] + bounds.max[0]) / 2,
      0,
      (bounds.min[2] + bounds.max[2]) / 2,
    ];
    if (!this._fitted) {
      const span = Math.max(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2], 3);
      this.box.sx = this.box.sz = Math.max(1.2, span * 0.42);
      this.box.sy = Math.max(0.9, span * 0.26);
      this._fitted = true;
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
    Object.assign(this.box, patch);
    this.applyBoxChange();
  }

  applyBoxChange() {
    const box = this.worldBox;
    this.scene.setClipPlanes(SlicePane.planesFor(box));
    this.scene.applyClipTo(this.scene.circuitGroup);
    this.syncOutline();
    this.requestUpdate();
  }

  frame() {
    const box = this.worldBox;
    const c = box.center;
    const span = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2], 1);
    this.scene.controls.target.set(c[0], c[1], c[2]);
    // 用和主视图相同的方位角，方便左右对照
    const d = span * 1.15;
    this.scene.camera.position.set(c[0] + d * 0.5, c[1] + d * 0.78, c[2] + d * 0.72);
    this.scene.controls.update();
  }

  /* ---------------- 可视化 ---------------- */
  requestUpdate() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      if (this._last) this.update(this._last);
    }, 90);
  }

  update({ field, mode, density, opacity, colorByPotential, sliceAxis, slicePos }) {
    if (!this.solver || !this.solver.n) return;
    this._last = { field, mode, density, opacity, colorByPotential, sliceAxis, slicePos };
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
      box: sampleBox,
    });
    this.scene.applyClipTo(this.scene.fieldGroup);
  }

  resize() { this.scene.resize(); }
}
