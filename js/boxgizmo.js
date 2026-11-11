/**
 * boxgizmo.js —— 主视图里可以直接拖的截取框
 *
 * 交互：
 *   拖中心的小八面体 → 整体平移
 *   拖六个面上的方块 → 沿该轴缩放（对面的面不动）
 * 拖动时会临时关掉 OrbitControls，松手再打开。
 */
import * as THREE from 'three';

const MIN_HALF = 0.01;   // 半边长下限（格），允许压成很薄的一层
const MAX_HALF = 20.0;

export class BoxGizmo {
  constructor(scene3d, { onChange } = {}) {
    this.scene3d = scene3d;
    this.onChange = onChange || (() => {});
    this.box = { min: [-2, -1, -2], max: [2, 1, 2] };
    this.visible = true;
    this.drag = null;

    this.group = new THREE.Group();
    scene3d.scene.add(this.group);

    this._build();
    this._bind();
  }

  _build() {
    // 线框
    const eg = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    this.edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({
      color: 0x7ee0ff, transparent: true, opacity: 0.75,
    }));
    this.group.add(this.edges);

    // 六个面把手 + 中心把手
    this.handleMat = new THREE.MeshBasicMaterial({
      color: 0x7ee0ff, transparent: true, opacity: 0.38,
      side: THREE.DoubleSide, depthWrite: false,
    });
    this.handleMatHover = new THREE.MeshBasicMaterial({
      color: 0xbdf0ff, transparent: true, opacity: 0.85,
      side: THREE.DoubleSide, depthWrite: false,
    });
    this.handles = [];
    const defs = [
      { axis: 'x', sign: 1, pos: [1, 0, 0], rot: [0, Math.PI / 2, 0] },
      { axis: 'x', sign: -1, pos: [-1, 0, 0], rot: [0, Math.PI / 2, 0] },
      { axis: 'y', sign: 1, pos: [0, 1, 0], rot: [Math.PI / 2, 0, 0] },
      { axis: 'y', sign: -1, pos: [0, -1, 0], rot: [Math.PI / 2, 0, 0] },
      { axis: 'z', sign: 1, pos: [0, 0, 1], rot: [0, 0, 0] },
      { axis: 'z', sign: -1, pos: [0, 0, -1], rot: [0, 0, 0] },
    ];
    for (const d of defs) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.handleMat);
      m.userData = { kind: 'face', axis: d.axis, sign: d.sign };
      m.rotation.set(d.rot[0], d.rot[1], d.rot[2]);
      this.handles.push(m);
      this.group.add(m);
    }
    // 中心的移动手柄：八面体 + 三根轴向短杆，一眼能看出是「三维移动」，
    // 而且关掉深度测试，永远浮在最上层（不会被导体挡住）
    this.moveGroup = new THREE.Group();
    this.group.add(this.moveGroup);

    this.centerHandle = new THREE.Mesh(
      new THREE.OctahedronGeometry(1, 0),
      new THREE.MeshBasicMaterial({ color: 0xd7f1ff, transparent: true, opacity: 0.95, depthTest: false })
    );
    this.centerHandle.userData = { kind: 'move' };
    this.centerHandle.renderOrder = 30;
    this.moveGroup.add(this.centerHandle);
    this.handles.push(this.centerHandle);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
  }

  setBox(box) {
    this.box = { min: [...box.min], max: [...box.max] };
    this._layout();
  }

  setVisible(v) {
    this.visible = v;
    this.group.visible = v;
  }

  _layout() {
    const { min, max } = this.box;
    const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const s = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    this.group.position.set(c[0], c[1], c[2]);
    this.edges.scale.set(s[0], s[1], s[2]);

    const hs = Math.min(0.4, Math.max(0.1, Math.min(s[0], s[1], s[2]) * 0.18));
    for (const h of this.handles) {
      if (h.userData.kind === 'face') {
        const { axis, sign } = h.userData;
        const k = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
        const p = [0, 0, 0];
        p[k] = sign * s[k] / 2;
        h.position.set(p[0], p[1], p[2]);
        h.scale.set(hs, hs, 1);
      } else if (h === this.centerHandle) {
        h.position.set(0, 0, 0);
        h.scale.setScalar(hs * 0.85);
      }
    }
    this.center = c;
  }

  /* ---------------- 交互 ---------------- */
  _bind() {
    const dom = this.scene3d.renderer.domElement;

    // 用捕获阶段，抢在 OrbitControls 之前把事件吃掉，避免边拖边转
    document.addEventListener('pointerdown', (ev) => {
      if (!this.visible || !dom.contains(ev.target)) return;
      const hit = this._pick(ev);
      if (!hit) return;
      ev.stopPropagation();
      ev.preventDefault();
      this.scene3d.controls.enabled = false;
      this.drag = {
        handle: hit.object,
        start: { min: [...this.box.min], max: [...this.box.max] },
        startHit: hit.point.clone(),
        plane: this._dragPlane(hit),
      };
      dom.style.cursor = 'grabbing';
    }, true);

    document.addEventListener('pointermove', (ev) => {
      if (this.drag) {
        ev.stopPropagation();
        this._updateDrag(ev);
        return;
      }
      if (!this.visible || !dom.contains(ev.target)) return;
      const hit = this._pick(ev);
      dom.style.cursor = hit ? 'grab' : '';
    }, true);

    const end = () => {
      if (!this.drag) return;
      this.drag = null;
      this.scene3d.controls.enabled = true;
      dom.style.cursor = '';
    };
    document.addEventListener('pointerup', end, true);
    document.addEventListener('pointercancel', end, true);
  }

  _pick(ev) {
    const r = this.scene3d.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((ev.clientX - r.left) / r.width) * 2 - 1,
      -((ev.clientY - r.top) / r.height) * 2 + 1
    );
    this.raycaster.setFromCamera(this.pointer, this.scene3d.camera);
    const hits = this.raycaster.intersectObjects(this.handles, false);
    return hits.length ? hits[0] : null;
  }

  _dragPlane(hit) {
    const cam = this.scene3d.camera;
    const n = new THREE.Vector3();
    cam.getWorldDirection(n);
    if (hit.object.userData.kind === 'move') {
      return { point: hit.point.clone(), normal: n.clone().multiplyScalar(-1) };
    }
    // 面把手：拖动平面就是该面本身
    const { axis, sign } = hit.object.userData;
    const n2 = new THREE.Vector3(
      axis === 'x' ? sign : 0, axis === 'y' ? sign : 0, axis === 'z' ? sign : 0
    );
    const p = hit.object.getWorldPosition(new THREE.Vector3());
    return { point: p, normal: n2 };
  }

  _updateDrag(ev) {
    const d = this.drag;
    const r = this.scene3d.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((ev.clientX - r.left) / r.width) * 2 - 1,
      -((ev.clientY - r.top) / r.height) * 2 + 1
    );
    this.raycaster.setFromCamera(this.pointer, this.scene3d.camera);

    const kind = d.handle.userData.kind;
    if (kind === 'move') {
      const p = this._rayPlane(d.plane.point, d.plane.normal);
      if (!p) return;
      const delta = p.clone().sub(d.startHit);
      const d3 = [delta.x, delta.y, delta.z];
      const min = [0, 0, 0], max = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        min[k] = d.start.min[k] + d3[k];
        max[k] = d.start.max[k] + d3[k];
      }
      this.setBox({ min, max });
      this.onChange(this.box);
      return;
    }

    // 面把手：把射线投到「过初始面心、沿轴线」的直线上
    const { axis, sign } = d.handle.userData;
    const k = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
    const axisDir = new THREE.Vector3(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0);
    const faceCenter0 = d.handle.getWorldPosition(new THREE.Vector3());
    const hitP = this._closestOnAxis(faceCenter0, axisDir);
    if (!hitP) return;
    const coord = axis === 'x' ? hitP.x : axis === 'y' ? hitP.y : hitP.z;

    const min = [...d.start.min], max = [...d.start.max];
    if (sign > 0) {
      max[k] = Math.max(min[k] + MIN_HALF * 2, Math.min(coord, d.start.min[k] + MAX_HALF * 2));
    } else {
      min[k] = Math.min(max[k] - MIN_HALF * 2, Math.max(coord, d.start.max[k] - MAX_HALF * 2));
    }
    this.setBox({ min, max });
    this.onChange(this.box);
  }

  _rayPlane(point, normal) {
    const ray = this.raycaster.ray;
    const denom = ray.direction.dot(normal);
    if (Math.abs(denom) < 1e-6) return null;
    const t = point.clone().sub(ray.origin).dot(normal) / denom;
    if (t < 0) return null;
    return ray.origin.clone().addScaledVector(ray.direction, t);
  }

  /** 射线与一条直线的最近点（在直线上） */
  _closestOnAxis(axisPoint, axisDir) {
    const ray = this.raycaster.ray;
    const p1 = axisPoint, d1 = axisDir;
    const p2 = ray.origin, d2 = ray.direction;
    const w0 = new THREE.Vector3().subVectors(p1, p2);
    const a = d1.dot(d1), b = d1.dot(d2), c = d2.dot(d2);
    const d = d1.dot(w0), e = d2.dot(w0);
    const denom = a * c - b * b;
    if (Math.abs(denom) < 1e-9) {
      // 近乎平行：直接投影到平面上
      return this._rayPlane(axisPoint, d2.clone().negate());
    }
    const t1 = (b * e - c * d) / denom;
    return p1.clone().addScaledVector(d1, t1);
  }
}
