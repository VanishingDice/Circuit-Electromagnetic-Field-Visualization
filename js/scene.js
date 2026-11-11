/**
 * scene.js —— 三维场景：把 circuit.js 展开出来的图元画成电路
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { potentialToRGB } from './palette.js';

export const MAT_COLORS = {
  copper: 0xc98b4b,
  body: 0xd8cfc0,
  battery: 0x39435a,
  batteryBody: 0x2a3346,
  batteryPlus: 0xe06c5a,
  batteryMinus: 0x4a6ea8,
  plate: 0x9fb0c0,
  plate2: 0x708496,
  coil: 0xb08bd6,
};

/* ---------------- 管子几何（自己搭，省一个依赖） ---------------- */
export function tubeGeometry(points, radius, radialSegments = 8) {
  const n = points.length;
  const pos = [];
  const nor = [];
  const idx = [];
  const tangents = [];
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(n - 1, i + 1)];
    let t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l = Math.hypot(...t) || 1;
    tangents.push([t[0] / l, t[1] / l, t[2] / l]);
  }
  // 平行传输，避免管子在地线附近扭曲
  let nrm = (() => {
    const t = tangents[0];
    const ref = Math.abs(t[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
    const c = [t[1] * ref[2] - t[2] * ref[1], t[2] * ref[0] - t[0] * ref[2], t[0] * ref[1] - t[1] * ref[0]];
    const l = Math.hypot(...c) || 1;
    return [c[0] / l, c[1] / l, c[2] / l];
  })();
  for (let i = 0; i < n; i++) {
    const t = tangents[i];
    const d = nrm[0] * t[0] + nrm[1] * t[1] + nrm[2] * t[2];
    let v = [nrm[0] - t[0] * d, nrm[1] - t[1] * d, nrm[2] - t[2] * d];
    let vl = Math.hypot(...v);
    if (vl < 1e-6) { v = [0, 1, 0]; vl = 1; }
    nrm = [v[0] / vl, v[1] / vl, v[2] / vl];
    const bi = [t[1] * nrm[2] - t[2] * nrm[1], t[2] * nrm[0] - t[0] * nrm[2], t[0] * nrm[1] - t[1] * nrm[0]];
    for (let s = 0; s < radialSegments; s++) {
      const ang = (s / radialSegments) * Math.PI * 2;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const nx = nrm[0] * ca + bi[0] * sa;
      const ny = nrm[1] * ca + bi[1] * sa;
      const nz = nrm[2] * ca + bi[2] * sa;
      pos.push(points[i][0] + nx * radius, points[i][1] + ny * radius, points[i][2] + nz * radius);
      nor.push(nx, ny, nz);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let s = 0; s < radialSegments; s++) {
      const a = i * radialSegments + s;
      const b = i * radialSegments + ((s + 1) % radialSegments);
      const c = (i + 1) * radialSegments + s;
      const d = (i + 1) * radialSegments + ((s + 1) % radialSegments);
      idx.push(a, b, c, b, d, c);   // 逆时针（从外侧看）→ 法向朝外
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

/* ---------------- 场景 ---------------- */
export class Scene3D {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setClearColor(0x080b10);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x080b10, 0.012);

    this.camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 500);
    this.camera.position.set(9, 11, 13);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 60;

    const hemi = new THREE.HemisphereLight(0x9fc4ff, 0x131a24, 1.15);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(6, 14, 8);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.9);
    fill.position.set(-8, 6, -10);
    this.scene.add(fill);

    this.grid = new THREE.GridHelper(24, 24, 0x223046, 0x16202e);
    this.grid.position.y = -0.35;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.55;
    this.scene.add(this.grid);

    this.circuitGroup = new THREE.Group();
    this.scene.add(this.circuitGroup);
    this.fieldGroup = new THREE.Group();
    this.scene.add(this.fieldGroup);

    this.clock = new THREE.Clock();
    this._running = true;
    this._bounds = null;
    // 可选的裁剪平面（「截取空间」面板用：只显示选定的那个体块）
    this.clipPlanes = null;
    this.renderer.localClippingEnabled = true;
    this._loop();
    window.addEventListener('resize', () => this.resize());
    // 面板折叠 / 窗口改变时容器尺寸会变，用 ResizeObserver 兜住
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => {
        // 放到下一帧再做，避免在观察回调里同步改尺寸引发的 ResizeObserver 循环警告
        if (this._roPending) return;
        this._roPending = true;
        requestAnimationFrame(() => { this._roPending = false; this.resize(); });
      });
      this._ro.observe(container);
    }
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    if (w === this._lastW && h === this._lastH) return;
    this._lastW = w; this._lastH = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  /** 设置/清除裁剪平面（世界坐标） */
  setClipPlanes(planes) {
    this.clipPlanes = planes && planes.length ? planes : null;
    this.applyClipTo(this.scene);
  }

  /** 把当前裁剪平面套到一棵子树上的所有材质 */
  applyClipTo(root) {
    if (!this.clipPlanes) return;
    root.traverse((o) => {
      if (o.userData && o.userData.noClip) return;
      const apply = (m) => { if (m) m.clippingPlanes = this.clipPlanes; };
      if (Array.isArray(o.material)) o.material.forEach(apply);
      else apply(o.material);
    });
  }

  frameTo(bounds) {
    if (!bounds) return;
    const c = new THREE.Vector3(
      (bounds.min[0] + bounds.max[0]) / 2,
      0,
      (bounds.min[2] + bounds.max[2]) / 2
    );
    const size = Math.max(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2], 3);
    this.controls.target.copy(c);
    const d = size * 1.18;
    this.camera.position.set(c.x + d * 0.5, d * 0.78, c.z + d * 0.72);
    this.controls.update();
  }

  clearGroup(group) {
    while (group.children.length) {
      const o = group.children.pop();
      o.traverse?.((n) => {
        if (n.geometry) n.geometry.dispose();
        if (n.material && n.material.map) n.material.map.dispose();
        if (n.material) n.material.dispose();
      });
    }
  }

  /* 重建电路本体 */
  setCircuit(parts, bounds, { colorByPotential = true, frame = false } = {}) {
    this.clearGroup(this.circuitGroup);
    let minV = Infinity, maxV = -Infinity;
    for (const p of parts) {
      if (p.kind === 'node') {
        minV = Math.min(minV, p.pot || 0);
        maxV = Math.max(maxV, p.pot || 0);
      }
    }
    if (!isFinite(minV)) { minV = 0; maxV = 1; }
    if (maxV - minV < 1e-12) { minV = 0; maxV = 1; }
    this._potRange = [minV, maxV];

    const matCache = new Map();
    const getMat = (key, opts) => {
      if (!matCache.has(key)) {
        matCache.set(key, new THREE.MeshStandardMaterial(opts));
      }
      return matCache.get(key);
    };
    // 按电位着色的导线用不受光材质：深色背景上才够醒目
    const potMat = new THREE.MeshBasicMaterial({ vertexColors: true });

    for (const p of parts) {
      if (p.kind === 'tube') {
        const geo = tubeGeometry(p.pts, p.radius, 10);
        let mat;
        const base = new THREE.Color(MAT_COLORS[p.mat] ?? 0xffffff);
        if (colorByPotential && (p.mat === 'copper' || p.mat === 'coil')) {
          // 用最近导体线段的电位给顶点上色
          const colors = [];
          const posAttr = geo.getAttribute('position');
          for (let i = 0; i < posAttr.count; i++) {
            const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
            let bestD = Infinity, bestPot = 0;
            const s = this._solverSegs;
            if (s) {
              for (let k = 0; k < s.n; k++) {
                const d = distPointSeg3(x * 0.01, y * 0.01, z * 0.01, s, k);
                if (d < bestD) { bestD = d; bestPot = s.vpot[k]; }
              }
            }
            const c = potentialToRGB(bestPot, minV, maxV);
            colors.push(c[0], c[1], c[2]);
          }
          geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
          mat = potMat;
        } else {
          mat = getMat(p.mat, { color: base, metalness: 0.65, roughness: 0.4 });
        }
        const mesh = new THREE.Mesh(geo, mat);
        this.circuitGroup.add(mesh);
      } else if (p.kind === 'box' || p.kind === 'plate') {
        const size = p.kind === 'plate' ? [0.035, p.half * 2, p.half * 2] : p.size;
        const geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
        const col = new THREE.Color(MAT_COLORS[p.mat] ?? 0xffffff);
        const mesh = new THREE.Mesh(geo, getMat(p.mat, { color: col, metalness: 0.4, roughness: 0.5 }));
        // 用右手正交基构造姿态：Z 由 X×Y 算出来。
        // 直接拿 (axis, up, side) 拼矩阵时行列式可能是 −1（左手系），
        // setFromRotationMatrix 会给出一个无效的四元数，极板朝向就乱了。
        const ax = new THREE.Vector3(...p.axis).normalize();
        const uy = new THREE.Vector3(...p.up);
        uy.addScaledVector(ax, -ax.dot(uy)).normalize();      // 与 ax 正交化
        const sz = new THREE.Vector3().crossVectors(ax, uy).normalize();
        const m = new THREE.Matrix4().makeBasis(ax, uy, sz);
        mesh.quaternion.setFromRotationMatrix(m);
        mesh.position.set(...p.center);
        this.circuitGroup.add(mesh);
      } else if (p.kind === 'node') {
        const c = potentialToRGB(p.pot || 0, minV, maxV);
        const geo = new THREE.SphereGeometry(0.045, 12, 10);
        const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(c[0], c[1], c[2]) });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(...p.pos);
        this.circuitGroup.add(mesh);
      } else if (p.kind === 'label') {
        const sprite = makeLabel(p.text);
        sprite.position.set(...p.pos);
        this.circuitGroup.add(sprite);
      }
    }
    if (bounds && frame) { this._bounds = bounds; this.frameTo(bounds); }
    this.applyClipTo(this.circuitGroup);
  }

  /** 重新按当前场景取景（布局变化后调用） */
  reframe() {
    if (this._bounds) this.frameTo(this._bounds);
  }

  setSolver(solver) {
    this._solverSegs = solver;
  }

  _loop() {
    if (!this._running) return;
    requestAnimationFrame(() => this._loop());
    const dt = this.clock.getDelta();
    this.controls.update();
    if (this.onFrame) this.onFrame(dt);
    this.renderer.render(this.scene, this.camera);
  }
}

function distPointSeg3(x, y, z, s, k) {
  const x0 = s.p0[3 * k], y0 = s.p0[3 * k + 1], z0 = s.p0[3 * k + 2];
  const x1 = s.p1[3 * k], y1 = s.p1[3 * k + 1], z1 = s.p1[3 * k + 2];
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const l2 = dx * dx + dy * dy + dz * dz;
  let t = l2 > 0 ? ((x - x0) * dx + (y - y0) * dy + (z - z0) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (x0 + dx * t), y - (y0 + dy * t), z - (z0 + dz * t));
}

/* ---------------- 文字标签 ---------------- */
function makeLabel(text) {
  const canvas = document.createElement('canvas');
  const dpr = 2;
  canvas.width = 256 * dpr;
  canvas.height = 64 * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.font = '600 34px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // 只描边不铺底，避免把导线遮断
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(4, 7, 11, 0.92)';
  ctx.strokeText(text, 128, 33);
  ctx.fillStyle = '#e6f0fa';
  ctx.fillText(text, 128, 33);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(1.25, 0.3125, 1);
  sp.renderOrder = 5;
  return sp;
}


