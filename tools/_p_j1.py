import io

p = 'js/viz.js'
s = io.open(p, encoding='utf-8').read()

old = """    const geo = makeArrowGeometry();
    const mat = new THREE.MeshBasicMaterial({
      color: 0xff5fd0, transparent: true, opacity: 1.0, depthWrite: false,
    });"""
new = """    const geo = makeArrowGeometry();
    // 洋红是「导体内部」的标识色，不跟外面那套色标走：
    // 内部场比外面弱几个数量级（E 约 0.1 V/m vs 外部上千），
    // 套外部色标会全部落到最暗端、等于看不见。
    // 亮度在内部范围内编码强弱（暗洋红 = 弱，亮洋红 = 强）。
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 1.0, depthWrite: false,
    });"""
assert old in s
s = s.replace(old, new, 1)

old = """    const dummy = new THREE.Object3D();
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
    mesh.instanceMatrix.needsUpdate = true;"""
new = """    const dummy = new THREE.Object3D();
    const up = new THREE.Vector3(0, 1, 0);
    const qq = new THREE.Quaternion();
    const dir = new THREE.Vector3();
    const col = new THREE.Color();
    const BASE = new THREE.Color(0xff5fd0);
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
      // 亮度编码内部场强：暗洋红 → 亮洋红
      const b = 0.42 + 0.58 * t;
      col.setRGB(BASE.r * b, BASE.g * b, BASE.b * b, THREE.SRGBColorSpace);
      mesh.setColorAt(n, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;"""
assert old in s
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('interior color ok')
