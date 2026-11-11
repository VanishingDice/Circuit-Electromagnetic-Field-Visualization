import io

p = 'js/app.js'
s = io.open(p, encoding='utf-8').read()
old = """    // 9.555 导体内部：箭头 + 流线都要能渲染"""
new = """    // 9.554 增删元件后不要跳视角
    try {
      scene3d.frameTo(sceneData.bounds);
      const camBefore = scene3d.camera.position.clone();
      const n0 = circuit.elements.length;
      circuit.elements.push({
        id: newId(), type: 'wire', a: [1, 1], b: [2, 1], value: 0,
      });
      rebuild();
      const moved = scene3d.camera.position.distanceTo(camBefore);
      ok(moved < 1e-6, `增删元件后视角不变（位移 ${moved.toExponential(1)}）`);
      circuit.elements.length = n0;
      rebuild();
    } catch (err) {
      ok(false, '视角保持测试抛错', String(err.message).slice(0, 80));
    }

    // 9.555 导体内部：箭头 + 流线都要能渲染"""
assert old in s
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8').write(s)
print('ok')
