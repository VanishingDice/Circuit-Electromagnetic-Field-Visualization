import * as THREE from '../lib/three.module.js';

// 从 scene.js 抄一份 tubeGeometry（那边 import 'three'，Node 解析不了）
function tubeGeometry(points, radius, radialSegments = 8) {
  const n = points.length;
  const pos = [], nor = [], idx = [];
  const tangents = [];
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(n - 1, i + 1)];
    const t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l = Math.hypot(...t) || 1;
    tangents.push([t[0] / l, t[1] / l, t[2] / l]);
  }
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
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

function check(g, label) {
  const pos = g.getAttribute('position');
  const idx = g.getIndex();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let out = 0, inn = 0;
  for (let t = 0; t < idx.count; t += 3) {
    a.fromBufferAttribute(pos, idx.getX(t));
    b.fromBufferAttribute(pos, idx.getX(t + 1));
    c.fromBufferAttribute(pos, idx.getX(t + 2));
    const fn = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    const cen = a.clone().add(b).add(c).multiplyScalar(1 / 3);
    const radial = new THREE.Vector3(cen.x, 0, cen.z).normalize();
    if (fn.dot(radial) > 0) out++; else inn++;
  }
  console.log(`${label}: 朝外 ${out}，朝内 ${inn}  → ${inn > out ? '反了' : '正确'}`);
}

check(tubeGeometry([[0, 0, 0], [0, 1, 0]], 1, 8), '当前实现');
