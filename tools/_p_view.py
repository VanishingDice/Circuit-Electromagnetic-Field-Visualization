import io

# ---------------- index.html：工具栏加「复位视角」 ----------------
p = 'index.html'
s = io.open(p, encoding='utf-8').read()
old = """      <button id="btn-rotate" class="ghost" title="让相机缓慢旋转">环绕</button>"""
new = """      <button id="btn-view" class="ghost" title="把相机重新对准电路（增删元件时视角不会自动跳）">复位视角</button>
      <button id="btn-rotate" class="ghost" title="让相机缓慢旋转">环绕</button>"""
assert old in s
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8').write(s)
print('index ok')

# ---------------- app.js：只在首次加载/载入预设时取景 ----------------
p = 'js/app.js'
s = io.open(p, encoding='utf-8').read()

old = """    const frame = !sceneData.empty && circuit.elements.length !== lastCount;
    lastCount = circuit.elements.length;"""
new = """    // 只有首次加载或用户主动「载入预设」才重新取景；
    // 平时增删元件保持当前视角，不要跳回默认机位
    const frame = forceFrame && !sceneData.empty;
    forceFrame = false;
    lastCount = circuit.elements.length;"""
assert old in s
s = s.replace(old, new, 1)

# 状态变量
old = """const circuit = createDefaultCircuit();"""
new = """const circuit = createDefaultCircuit();
let forceFrame = true;      // 下一次 rebuild 是否重新取景"""
assert old in s
s = s.replace(old, new, 1)

# 预设按钮要重新取景
old = """$('btn-simple').addEventListener('click', () => {
  circuit.elements = createSimpleLoop().elements;
  sel = null;
  lastCount = -1;
  rebuild();
});"""
new = """$('btn-simple').addEventListener('click', () => {
  circuit.elements = createSimpleLoop().elements;
  sel = null;
  lastCount = -1;
  forceFrame = true;
  rebuild();
});"""
assert old in s
s = s.replace(old, new, 1)

# 恢复默认 / 清空也取景
old = """$('btn-reset').addEventListener('click', () => {"""
new = """$('btn-view').addEventListener('click', () => {
  if (sceneData && sceneData.bounds) scene3d.frameTo(sceneData.bounds);
});

$('btn-reset').addEventListener('click', () => {"""
assert old in s
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('app ok')
