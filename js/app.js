/**
 * app.js —— 把电路编辑器、求解器、三维场景和可视化面板接在一起
 */
import { createDefaultCircuit, createSimpleLoop, solveCircuit, buildScene, TYPES, newId } from './circuit.js';
import { METER_PER_UNIT } from './field.js';
import { Editor2D } from './editor2d.js';
import { Scene3D } from './scene.js';
import { FieldViz, turbo, diverging } from './viz.js';
import { AnalysisCard } from './analysis.js';
import { SliceTool } from './slice.js';
import { SlicePane } from './slicepane.js';
import { BoxGizmo } from './boxgizmo.js';
import { VERSION, BUILD } from './version.js';

const MODE_LABEL = { arrows: '箭头', stream: '流线', slice: '切片' };
const FIELD_INFO = {
  E:   { label: '电场 E', unit: 'V/m', modes: ['arrows', 'stream'], def: 'stream' },
  B:   { label: '磁场 B', unit: 'T',   modes: ['arrows', 'stream'], def: 'stream' },
  phi: { label: '电势 φ', unit: 'V',   modes: ['slice'],             def: 'slice' },
  S:   { label: '能流 S', unit: 'W/m²', modes: ['arrows', 'stream', 'slice'], def: 'arrows' },
};
const HINTS = {
  E: '电场 E = −∇φ ：靠近导体表面近乎垂直，导线内部则沿着电流方向',
  B: '磁场 B ：每段载流导线按毕奥–萨伐尔叠加，场线绕导线闭合',
  phi: '电势 φ ：切片上的黑线就是等势线，和电场处处垂直',
  S: '能流 S = E×H ：能量从电池侧面流出，在空间里绕行，再从电阻侧面流入',
};

const state = {
  field: 'B',
  mode: 'stream',
  density: 0.45,       // 主视图
  paneDensity: 0.45,   // 截取空间（单独控制）
  opacity: 0.95,
  sliceAxis: 'y',
  slicePos: 0,
  colorByPot: true,
  interior: false,     // 是否画导体内部的场
  boxLock: { x: false, y: false, z: false },   // 锁定后拖动截取框不会改这一轴
  autoRotate: false,
  wireRadius: 0.05,     // 世界单位（1 单位 = 1 cm）
  analysisOn: false,
  sliceOn: false,
};

const circuit = createDefaultCircuit();
let forceFrame = true;      // 下一次 rebuild 是否重新取景
let sliceMode3D = false;    // 截面窗口是否用立体视图（?mode3d=1）
let solution = null;
let sceneData = null;
let lastCount = -1;
let rebuilding = false;
let pending = null;

/* ---------------- DOM ---------------- */
const $ = (id) => document.getElementById(id);
const editorCanvas = $('editorCanvas');
const scene3d = new Scene3D($('three-container'));
const viz = new FieldViz(scene3d);
const editor = new Editor2D(editorCanvas, {
  onChange: () => scheduleRebuild(true),
  onSelect: (el) => renderInspector(el),
});
editor.setCircuit(circuit);
const analysis = new AnalysisCard($('analysis'));
const slicePane = new SlicePane($('sp-container'));
slicePane.attachOutline();

// 主视图里可以拖动/缩放截取框
const boxGizmo = new BoxGizmo(scene3d, {
  onChange: (b) => {
    slicePane.setWorldBox(b.min, b.max);
    syncSpInputs();
  },
});
const slice = new SliceTool(scene3d, {
  win: $('slicewin'), head: $('sw-head'), canvas: $('sw-canvas'),
  title: $('sw-title'), res: $('sw-res'),
  progress: $('sw-progress'), progressWrap: $('sw-progress-wrap'),
  legend: $('sw-legend'), legendLo: $('sw-lo'), legendHi: $('sw-hi'), unit: $('sw-unit'),
  cx: $('sw-cx'), cy: $('sw-cy'), cz: $('sw-cz'),
  yaw: $('sw-yaw'), pitch: $('sw-pitch'), size: $('sw-size'),
  cxLabel: $('sw-cx-label'), cyLabel: $('sw-cy-label'), czLabel: $('sw-cz-label'),
  sizeLabel: $('sw-size-label'),
  field: $('sw-field'), axisButtons: [...document.querySelectorAll('#sw-axis button')],
  wireBtn: $('sw-wire'), closeBtn: $('sw-close'), probe: $('sw-probe'),
  canvas3: $('sw-canvas3'), mode3dBtn: $('sw-mode3d'),
  dens: $('sw-dens'), densWrap: $('sw-dens-wrap'), densLabel: $('sw-dens-label'),
});

/* ---------------- 求解 + 重建 ---------------- */
function rebuild() {
  if (rebuilding) { pending = true; return; }
  rebuilding = true;
  const t0 = performance.now();
  try {
    solution = solveCircuit(circuit);
    const t1 = performance.now();
    sceneData = buildScene(circuit, solution, { wireRadius: state.wireRadius });
    const t2 = performance.now();
    editor.setSolution(solution);

    // 只有首次加载或用户主动「载入预设」才重新取景；
    // 平时增删元件保持当前视角，不要跳回默认机位
    const frame = forceFrame && !sceneData.empty;
    forceFrame = false;
    lastCount = circuit.elements.length;

    scene3d.setSolver(sceneData.solver);
    scene3d.setCircuit(sceneData.parts, sceneData.bounds, { colorByPotential: state.colorByPot, frame });
    // setCircuit 会重建材质，幽灵模式（半透明）要重新应用一次，否则导体内部又被挡住
    scene3d.setGhost(state.interior);
    updateViz();
    if (state.analysisOn) updateAnalysis();
    slicePane.setScene({
      solver: sceneData.solver,
      bounds: sceneData.bounds,
      parts: sceneData.parts,
      colorByPotential: state.colorByPot,
      conductorR: state.wireRadius * METER_PER_UNIT,
    });
    slicePane.scene.setGhost(state.interior);
    updatePane();
    boxGizmo.setBox(slicePane.worldBox);
    syncSpInputs();
    if (state.sliceOn) {
      slice.setScene({
        solver: sceneData.solver,
        bounds: sceneData.bounds,
        conductorR: state.wireRadius * METER_PER_UNIT,
      });
    }
    const t3 = performance.now();
    $('stats').innerHTML =
      `导体 <b>${sceneData.solver.n}</b> 段 · 节点 <b>${Object.keys(solution.nodeV).length}</b><br>` +
      `电路 <b>${(t1 - t0).toFixed(1)}</b> ms · 场 <b>${(t2 - t1).toFixed(0)}</b> ms · 渲染 <b>${(t3 - t2).toFixed(0)}</b> ms`;
  } catch (err) {
    console.error(err);
    $('stats').innerHTML = `<b style="color:#e0645a">求解失败</b><br>${String(err.message).slice(0, 60)}`;
  } finally {
    rebuilding = false;
    if (pending) { pending = false; setTimeout(rebuild, 0); }
  }
}

let timer = null;
function scheduleRebuild(structural = false) {
  clearTimeout(timer);
  timer = setTimeout(rebuild, structural ? 0 : 130);
}

function updateAnalysis() {
  if (!sceneData) return;
  analysis.setData({ solver: sceneData.solver, radius: state.wireRadius * METER_PER_UNIT });
  $('analysis').classList.remove('hidden');
}

function updatePane() {
  if (!sceneData) return;
  slicePane.update({
    field: state.field,
    mode: state.mode,
    density: state.paneDensity,
    interior: state.interior,
    opacity: state.opacity,
    colorByPotential: state.colorByPot,
    sliceAxis: state.sliceAxis,
    slicePos: state.slicePos,
  });
  const info = FIELD_INFO[state.field];
  $('sp-sub').textContent = `${info.label} · ${MODE_LABEL[state.mode]} · 体块内加密采样`;
}

function updateViz() {
  if (!sceneData) return;
  viz.update({
    solver: sceneData.solver,
    bounds: sceneData.bounds,
    field: state.field,
    mode: state.mode,
    density: state.density,
    interior: state.interior,
    opacity: state.opacity,
    sliceAxis: state.sliceAxis,
    slicePos: state.slicePos,
  });
  if (viz.zero) {
    $('hint').textContent = '当前场强近似为零：电路里没有电流（或没有电荷），所以画不出场';
  }
  const t = $('stats');
  const n = viz.lastStats?.count ?? viz.lastStats?.lines ?? viz.lastStats?.N ?? 0;
  if (n) t.dataset.samples = n;
}

/* ---------------- 面板 ---------------- */
function renderInspector(el) {
  const box = $('inspector');
  if (!el) {
    box.innerHTML = '<div class="empty">未选中元件 · 用「选择」工具点一下元件</div>';
    return;
  }
  const info = TYPES[el.type];
  if (el.type === 'wire') {
    box.innerHTML = `
      <div class="insp-row"><span class="insp-name">导线</span>
        <span class="insp-val">0.02 Ω</span></div>
      <div class="insp-row" style="font-size:11.5px;color:#55677c">理想导线，直流的微小电阻用来产生沿导线的电位降落</div>
      <button class="ghost danger" id="insp-del">删除这条导线</button>`;
  } else {
    box.innerHTML = `
      <div class="insp-row">
        <span class="insp-name">${info.label}</span>
        <span class="insp-val" id="insp-val">${el.value} ${info.unit}</span>
      </div>
      <div class="insp-row">
        <input type="range" id="insp-range" min="0" max="1000" value="${valueToSlider(el.value, info)}" />
      </div>
      <button class="ghost danger" id="insp-del">删除${info.label}</button>`;
    const range = $('insp-range');
    range.addEventListener('input', () => {
      const v = sliderToValue(+range.value, info);
      el.value = roundNice(v);
      $('insp-val').textContent = `${el.value} ${info.unit}`;
      scheduleRebuild(false);
    });
  }
  $('insp-del').addEventListener('click', () => editor._remove(el));
}

function valueToSlider(v, info) {
  const t = (Math.log(v / info.min) / Math.log(info.max / info.min));
  return Math.round(Math.min(1, Math.max(0, t)) * 1000);
}
function sliderToValue(t, info) {
  return info.min * Math.pow(info.max / info.min, t / 1000);
}
function roundNice(v) {
  if (v >= 100) return Math.round(v / 10) * 10;
  if (v >= 10) return Math.round(v * 10) / 10;
  return Math.round(v * 100) / 100;
}

/* ---------------- 交互绑定 ---------------- */
document.querySelectorAll('#field-chips .chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.field = btn.dataset.field;
    document.querySelectorAll('#field-chips .chip').forEach((b) => b.classList.toggle('active', b === btn));
    const info = FIELD_INFO[state.field];
    if (!info.modes.includes(state.mode)) state.mode = info.def;
    syncModeChips();
    updateLegend();
    updateViz();
    updatePane();
  });
});

document.querySelectorAll('#mode-chips .chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    state.mode = btn.dataset.mode;
    syncModeChips();
    updateViz();
    updatePane();
  });
});

function syncModeChips() {
  const info = FIELD_INFO[state.field];
  document.querySelectorAll('#mode-chips .chip').forEach((b) => {
    const ok = info.modes.includes(b.dataset.mode);
    b.disabled = !ok;
    b.classList.toggle('active', ok && b.dataset.mode === state.mode);
  });
  $('slice-ctl').classList.toggle('on', state.mode === 'slice');
  $('density-label').textContent =
    state.mode === 'arrows' ? '箭头密度' : state.mode === 'stream' ? '流线数量' : '切片分辨率';
  $('hint').textContent = HINTS[state.field] || '';
}

document.querySelectorAll('#palette .tool').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#palette .tool').forEach((b) => b.classList.toggle('active', b === btn));
    editor.setTool(btn.dataset.tool);
  });
});

$('density').addEventListener('input', (e) => {
  state.density = +e.target.value / 100;
  clearTimeout(window.__dv);
  window.__dv = setTimeout(() => { updateViz(); updatePane(); }, 120);
});
$('opacity').addEventListener('input', (e) => {
  state.opacity = +e.target.value / 100;
  clearTimeout(window.__ov);
  window.__ov = setTimeout(updateViz, 60);
});
$('slice-pos').addEventListener('input', (e) => {
  state.slicePos = +e.target.value / 100;
  clearTimeout(window.__sv);
  window.__sv = setTimeout(updateViz, 90);
});
document.querySelectorAll('#axis-seg button').forEach((b) => {
  b.addEventListener('click', () => {
    state.sliceAxis = b.dataset.axis;
    document.querySelectorAll('#axis-seg button').forEach((x) => x.classList.toggle('active', x === b));
    updateViz();
  });
});
$('color-pot').addEventListener('change', (e) => {
  state.colorByPot = e.target.checked;
  if (sceneData) scene3d.setCircuit(sceneData.parts, sceneData.bounds, { colorByPotential: state.colorByPot, frame: false });
});
// 截取空间的体块滑杆
const syncSpInputs = () => {
  const b = slicePane.box;
  const map = [['sp-cx', b.cx, 20], ['sp-cy', b.cy, 20], ['sp-cz', b.cz, 20],
               ['sp-sx', b.sx, 10], ['sp-sy', b.sy, 10], ['sp-sz', b.sz, 10]];
  for (const [id, v, sc] of map) {
    const el = $(id);
    if (el && document.activeElement !== el) el.value = String(Math.round(v * sc));
  }
};

const syncSliceInputs = () => {
  const s = slice.state;
  const set = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = String(Math.round(v)); };
  set('sw-cx', s.cx * 20);
  set('sw-cy', s.cy * 20);
  set('sw-cz', s.cz * 20);
  set('sw-yaw', ((s.yaw % 360) + 360) % 360);
  set('sw-pitch', s.pitch);
  set('sw-size', s.size * 10);
  const lab = [['sw-cx-label', s.cx.toFixed(2)], ['sw-cy-label', s.cy.toFixed(2)],
               ['sw-cz-label', s.cz.toFixed(2)], ['sw-size-label', s.size.toFixed(2) + ' 格']];
  for (const [id, txt] of lab) { const el = $(id); if (el) el.textContent = txt; }
};
slice.onChange = syncSliceInputs;

const spBind = (id, key, scale) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener('input', (e) => {
    if (key === 'cx' && state.boxLock.x) return;
    if (key === 'cy' && state.boxLock.y) return;
    if (key === 'cz' && state.boxLock.z) return;
    slicePane.setBox({ [key]: +e.target.value / scale });
    boxGizmo.setBox(slicePane.worldBox);
    // 改尺寸时自动重新取景，让体块继续铺满画框
    if (key === 'sx' || key === 'sy' || key === 'sz') {
      clearTimeout(window.__spfit);
      window.__spfit = setTimeout(() => slicePane.frame(), 220);
    }
  });
};
spBind('sp-cx', 'cx', 20);
spBind('sp-cy', 'cy', 20);
spBind('sp-cz', 'cz', 20);
spBind('sp-sx', 'sx', 10);
spBind('sp-sy', 'sy', 10);
spBind('sp-sz', 'sz', 10);
// 中心轴锁定：锁住后拖动截取框 / 拖滑杆都不会改这一轴
const LOCK_SLIDER = { x: 'sp-cx', y: 'sp-cy', z: 'sp-cz' };
for (const ax of ['x', 'y', 'z']) {
  const btn = $('sp-lock-' + ax);
  if (!btn) continue;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.boxLock[ax] = !state.boxLock[ax];
    btn.classList.toggle('on', state.boxLock[ax]);
    const rng = $(LOCK_SLIDER[ax]);
    if (rng) rng.disabled = state.boxLock[ax];
    slicePane.setLocks(state.boxLock);
  });
}
slicePane.setLocks(state.boxLock);

$('sp-fit')?.addEventListener('click', () => slicePane.frame());
$('sp-snap')?.addEventListener('click', () => {
  slicePane.snapToWire();
  boxGizmo.setBox(slicePane.worldBox);
  syncSpInputs();
});
$('sp-showbox')?.addEventListener('change', (e) => boxGizmo.setVisible(e.target.checked));

const applyInterior = () => {
  scene3d.setGhost(state.interior);
  slicePane.scene.setGhost(state.interior);
  updateViz();
  updatePane();
};

$('show-inside')?.addEventListener('change', (e) => {
  state.interior = e.target.checked;
  applyInterior();
});
if ($('show-inside')) $('show-inside').checked = state.interior;
if (state.interior) applyInterior();

$('sp-density')?.addEventListener('input', (e) => {
  state.paneDensity = +e.target.value / 100;
  clearTimeout(window.__pdv);
  window.__pdv = setTimeout(updatePane, 140);
});

$('btn-slice').addEventListener('click', () => {
  state.sliceOn = !state.sliceOn;
  $('btn-slice').classList.toggle('active', state.sliceOn);
  slice.show(state.sliceOn);
  if (sliceMode3D) slice.setMode3D(true);
  if (state.sliceOn) {
    slice.setScene({
      solver: sceneData?.solver,
      bounds: sceneData?.bounds,
      conductorR: state.wireRadius * METER_PER_UNIT,
    });
  }
});

$('btn-analysis').addEventListener('click', () => {
  state.analysisOn = !state.analysisOn;
  $('btn-analysis').classList.toggle('active', state.analysisOn);
  $('analysis').classList.toggle('hidden', !state.analysisOn);
  if (state.analysisOn) updateAnalysis();
});

$('wire-radius').addEventListener('input', (e) => {
  state.wireRadius = +e.target.value / 100;   // 1..14 → 0.01..0.14
  $('wire-label').textContent = `导线半径 ${(state.wireRadius * 10).toFixed(2)} mm`;
  if ($('sp-density')) $('sp-density').value = String(Math.round(state.paneDensity * 100));
  clearTimeout(window.__wr);
  window.__wr = setTimeout(() => scheduleRebuild(false), 120);
});

$('btn-rotate').addEventListener('click', () => {
  state.autoRotate = !state.autoRotate;
  scene3d.controls.autoRotate = state.autoRotate;
  scene3d.controls.autoRotateSpeed = 0.9;
  $('btn-rotate').classList.toggle('active', state.autoRotate);
});
$('btn-edit').addEventListener('click', () => {
  const pane = $('leftCol');
  pane.classList.toggle('hidden');
  $('btn-edit').classList.toggle('active', !pane.classList.contains('hidden'));
  setTimeout(() => { scene3d.resize(); slicePane.resize(); editor.resize(); }, 60);
});
$('btn-help').addEventListener('click', () => $('help-modal').classList.remove('hidden'));
$('help-close').addEventListener('click', () => $('help-modal').classList.add('hidden'));
$('help-modal').addEventListener('click', (e) => {
  if (e.target.id === 'help-modal') $('help-modal').classList.add('hidden');
});
$('btn-simple').addEventListener('click', () => {
  circuit.elements = createSimpleLoop().elements;
  sel = null;
  lastCount = -1;
  forceFrame = true;
  rebuild();
});

$('btn-view').addEventListener('click', () => {
  if (sceneData && sceneData.bounds) scene3d.frameTo(sceneData.bounds);
});

$('btn-reset').addEventListener('click', () => {
  const fresh = createDefaultCircuit();
  forceFrame = true;
  circuit.elements = fresh.elements;
  lastCount = -1;
  editor.select(null);
  scheduleRebuild(true);
});
$('btn-clear').addEventListener('click', () => {
  circuit.elements = [];
  lastCount = -1;
  editor.select(null);
  viz.dispose();
  $('stats').textContent = '';
  scheduleRebuild(true);
});

function updateLegend() {
  const info = FIELD_INFO[state.field];
  $('legend-title').textContent = `${info.label}${info.unit ? ' · ' + info.unit : ''}`;
  const map = state.field === 'phi' ? diverging : turbo;
  const stops = [];
  for (let i = 0; i <= 12; i++) {
    const c = map(i / 12);
    stops.push(`rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)}) ${(i / 12 * 100).toFixed(0)}%`);
  }
  $('legend-bar').style.background = `linear-gradient(90deg, ${stops.join(',')})`;
  $('legend-min').textContent = state.field === 'phi' ? '低' : '弱';
  $('legend-max').textContent = state.field === 'phi' ? '高' : '强';
}

/* 键盘：数字键切场 */
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const map = { 1: 'E', 2: 'B', 3: 'phi', 4: 'S' };
  if (map[e.key]) {
    const f = map[e.key];
    state.field = f;
    document.querySelectorAll('#field-chips .chip').forEach((b) => b.classList.toggle('active', b.dataset.field === f));
    const info = FIELD_INFO[f];
    if (!info.modes.includes(state.mode)) state.mode = info.def;
    syncModeChips();
    updateLegend();
    updateViz();
  }
});

/* ---------------- 启动 ---------------- */
// 支持 ?field=E&mode=arrows&density=60&editor=0 之类的分享链接
const qs = new URLSearchParams(location.search);
(function applyQuery() {
  const f = qs.get('field');
  if (f && FIELD_INFO[f]) {
    state.field = f;
    const info = FIELD_INFO[f];
    if (!info.modes.includes(state.mode)) state.mode = info.def;
  }
  const m = qs.get('mode');
  if (m && FIELD_INFO[state.field].modes.includes(m)) state.mode = m;
  if (qs.has('density')) state.density = Math.min(1, Math.max(0, +qs.get('density') / 100));
  if (qs.has('pdensity')) state.paneDensity = Math.min(1, Math.max(0, +qs.get('pdensity') / 100));
  else if (qs.has('density')) state.paneDensity = state.density;
  if (qs.has('slicePos')) state.slicePos = Math.min(1, Math.max(-1, +qs.get('slicePos') / 100));
  if (qs.get('sliceAxis')) state.sliceAxis = qs.get('sliceAxis');
  if (qs.get('analysis') === '1') state.analysisOn = true;
  if (qs.get('slice') === '1') state.sliceOn = true;
  if (qs.get('mode3d') === '1') { state.sliceOn = true; sliceMode3D = true; }
  // 截取空间的参数
  for (const [k, id, sc] of [['cx', 'sp-cx', 20], ['cy', 'sp-cy', 20], ['cz', 'sp-cz', 20],
                             ['sx', 'sp-sx', 10], ['sy', 'sp-sy', 10], ['sz', 'sp-sz', 10]]) {
    const v = qs.get('sp' + k);
    if (v !== null) {
      slicePane.box[k] = +v / 10;
      slicePane._fitted = true;   // 别让 setScene 的默认值覆盖掉
      const el = $(id);
      if (el) el.value = String(Math.round(slicePane.box[k] * sc));
    }
  }
  if (qs.get('seeds') === 'uniform') viz.seedMode = 'uniform';
  if (qs.get('circuit') === 'simple') circuit.elements = createSimpleLoop().elements;
  if (qs.get('inside') === '1') state.interior = true;
  if (qs.get('wire')) state.wireRadius = Math.min(0.14, Math.max(0.01, +qs.get('wire') / 100));
  if (qs.get('editor') === '0') {
    $('leftCol').classList.add('hidden');
    $('btn-edit').classList.remove('active');
  }
})();

function syncUIFromState() {
  document.querySelectorAll('#field-chips .chip').forEach((b) => b.classList.toggle('active', b.dataset.field === state.field));
  $('density').value = String(Math.round(state.density * 100));
  $('slice-pos').value = String(Math.round(state.slicePos * 100));
  document.querySelectorAll('#axis-seg button').forEach((b) => b.classList.toggle('active', b.dataset.axis === state.sliceAxis));
  $('color-pot').checked = state.colorByPot;
  $('wire-radius').value = String(Math.round(state.wireRadius * 100));
  $('wire-label').textContent = `导线半径 ${(state.wireRadius * 10).toFixed(2)} mm`;
  if ($("show-inside")) $("show-inside").checked = state.interior;
  syncModeChips();
}

syncUIFromState();
updateLegend();
if (sliceMode3D) {
  state.sliceOn = true;
  $("btn-slice").classList.add("active");
  slice.show(true);
}
scene3d.setGhost(state.interior);
slicePane.scene.setGhost(state.interior);
rebuild();
if (sliceMode3D) slice.setMode3D(true);
if (state.analysisOn) {
  $('btn-analysis').classList.add('active');
  $('analysis').classList.remove('hidden');
}
if (state.sliceOn) {
  $('btn-slice').classList.add('active');
  slice.show(true);
  slice.setScene({
    solver: sceneData?.solver,
    bounds: sceneData?.bounds,
    conductorR: state.wireRadius * METER_PER_UNIT,
  });
}
$('version').textContent = 'v' + VERSION + (BUILD ? ' · ' + BUILD : '');
// 等 CSS 过渡结束后按真实尺寸重新取景一次
setTimeout(() => { scene3d.resize(); scene3d.reframe(); editor.resize(); }, 340);
console.log('%c电磁场实验台 v0.1 · 直流', 'color:#58c4ff;font-weight:bold');

/* ---------------- 浏览器内自检（?selftest=1） ---------------- */
if (new URLSearchParams(location.search).get('selftest') === '1') {
  setTimeout(runSelfTest, 600);
}

function runSelfTest() {
  const log = [];
  let fails = 0;
  const ok = (cond, msg, extra = '') => {
    if (!cond) fails++;
    log.push(`${cond ? 'PASS' : 'FAIL'} ${msg}${extra ? '  ' + extra : ''}`);
  };
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.message)));

  try {
    // 1. 默认电路
    ok(circuit.elements.length === 12, '默认电路 12 个元件', `实际 ${circuit.elements.length}`);
    ok(solution && Object.keys(solution.nodeV).length === 11, '节点数 11');
    const bat = circuit.elements.find((e) => e.type === 'battery');
    const iBat = solution.elCurrent[bat.id];
    ok(Math.abs(iBat - 0.09) < 0.005, '电池电流 ≈ 0.09 A', `实际 ${iBat.toFixed(5)}`);

    // 2. 放置元件
    const before = circuit.elements.length;
    editor.setTool('resistor');
    editor._place([10, 6], [11, 6]);
    ok(circuit.elements.length === before + 1, '放置电阻成功');
    const placed = circuit.elements[circuit.elements.length - 1];
    ok(placed.type === 'resistor' && placed.value === 100, '新元件默认参数正确');

    // 3. 同端点重复放置 → 替换而不是叠加
    const n2 = circuit.elements.length;
    editor._place([10, 6], [11, 6]);
    ok(circuit.elements.length === n2, '同端点重复放置会替换');

    // 4. T 形接点自动打断
    editor.setTool('wire');
    editor._place([9, 6], [11, 6]);   // 会打断 (10,6)-(11,6)
    const splitEls = circuit.elements.filter((e) => e.value === 100 && e.type === 'resistor');
    ok(splitEls.length === 2, '中点插入导线会自动打断元件', `电阻段数 ${splitEls.length}`);

    // 5. 删除
    const n3 = circuit.elements.length;
    editor._remove(circuit.elements[circuit.elements.length - 1]);
    ok(circuit.elements.length === n3 - 1, '删除元件生效');

    // 6. 改参数后重新求解
    const resistor = circuit.elements.find((e) => e.type === 'resistor');
    const oldR = resistor.value;
    resistor.value = 50;
    rebuild();
    const iNew = solution.elCurrent[circuit.elements.find((e) => e.type === 'battery').id];
    ok(iNew > Math.abs(iBat) + 0.02, '电阻减半后电流变大', `${iNew.toFixed(4)} vs ${iBat.toFixed(4)}`);
    resistor.value = oldR;
    rebuild();

    // 7. 所有场 × 显示方式组合都能渲染
    const combos = [];
    for (const [f, info] of Object.entries(FIELD_INFO)) {
      for (const m of info.modes) combos.push([f, m]);
    }
    for (const [f, m] of combos) {
      state.field = f;
      state.mode = m;
      try {
        updateViz();
        combos.push.length;
        ok(true, `渲染 ${f}/${m}`);
      } catch (err) {
        ok(false, `渲染 ${f}/${m} 抛错`, String(err.message).slice(0, 80));
      }
    }

    // 8. 每种元件的参数面板都能渲染
    for (const type of ['wire', 'resistor', 'battery', 'capacitor', 'inductor']) {
      const el = circuit.elements.find((e) => e.type === type) || { id: 'x', type, a: [0, 0], b: [0, 1], value: 1 };
      try {
        renderInspector(el);
        ok(true, `参数面板 ${type}`);
      } catch (err) {
        ok(false, `参数面板 ${type} 抛错`, String(err.message).slice(0, 60));
      }
    }

    // 9. 切片三种轴
    state.field = 'phi'; state.mode = 'slice';
    for (const axis of ['x', 'y', 'z']) {
      state.sliceAxis = axis;
      try { updateViz(); ok(true, `切片轴向 ${axis}`); }
      catch (err) { ok(false, `切片轴向 ${axis} 抛错`, String(err.message).slice(0, 60)); }
    }

    // 9.5 截面各种场都能算
    for (const f of ['S', 'E', 'B', 'phi']) {
      state.sliceOn = true;
      slice.state.field = f;
      try {
        slice.setScene({ solver: sceneData.solver, bounds: sceneData.bounds, conductorR: 0.0005 });
        slice.startRender(48);
        ok(true, `截面渲染 ${f}`);
      } catch (err) {
        ok(false, `截面渲染 ${f} 抛错`, String(err.message).slice(0, 80));
      }
    }
    state.sliceOn = false; slice.show(false);

    // 9.55 拖动截取框（走 setWorldBox + gizmo 回写这条路径）
    try {
      const b = slicePane.worldBox;
      slicePane.setWorldBox(
        [b.min[0] + 0.2, b.min[1] - 0.1, b.min[2]],
        [b.max[0] + 0.6, b.max[1] + 0.1, b.max[2]]
      );
      boxGizmo.setBox(slicePane.worldBox);
      syncSpInputs();
      ok(true, '拖动截取框 setWorldBox');
    } catch (err) {
      ok(false, '拖动截取框抛错', String(err.message).slice(0, 80));
    }

    // 9.554 增删元件后不要跳视角
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

    // 9.555 导体内部：箭头 + 流线都要能渲染（曾经因为漏写方法直接抛错）
    try {
      state.mode = 'stream';
      state.field = 'B';
      state.interior = true;
      updateViz();
      updatePane();
      ok(viz.lastStats && viz.lastStats.lines > 0, '导体内部流线可渲染');
      state.mode = 'arrows';
      updateViz();
      const ia = viz.interiorArrows;
      ok(!ia || ia.count > 0, '导体内部箭头可渲染');
      state.interior = false;
      state.mode = 'stream';
      updateViz();
    } catch (err) {
      ok(false, '导体内部渲染抛错', String(err.message).slice(0, 80));
      state.interior = false;
    }

    // 9.56 移动体块时，面板相机要跟着平移（画面里框在动、视角不动）
    try {
      const c0 = slicePane.worldBox.center.slice();
      const cam0 = slicePane.scene.camera.position.clone();
      slicePane.setBox({ cx: slicePane.box.cx + 0.5 });
      const c1 = slicePane.worldBox.center;
      const cam1 = slicePane.scene.camera.position;
      const dc = c1[0] - c0[0];
      const dcam = cam1.x - cam0.x;
      ok(Math.abs(dc) > 1e-6 && Math.abs(dcam - dc) < 1e-6, '体块移动时面板相机同步平移');
      slicePane.setBox({ cx: slicePane.box.cx - 0.5 });
    } catch (err) {
      ok(false, '相机同步平移测试抛错', String(err.message).slice(0, 80));
    }

    // 9.57 吸附导线
    try {
      slicePane.snapToWire();
      boxGizmo.setBox(slicePane.worldBox);
      syncSpInputs();
      ok(true, '吸附导线');
    } catch (err) {
      ok(false, '吸附导线抛错', String(err.message).slice(0, 80));
    }

    // 9.6 截取空间面板（同源渲染 + 裁剪）
    try {
      slicePane.setBox({ sx: 1.2, sy: 0.8, sz: 1.2 });
      updatePane();
      ok(true, '截取空间面板');
    } catch (err) {
      ok(false, '截取空间面板抛错', String(err.message).slice(0, 80));
    }

    // 9.58 中心轴锁定 + 独立窗口已移除
    try {
      ok(document.getElementById('sw-pop') === null, '独立窗口按钮已移除');
      const wb = slicePane.worldBox;
      const min0 = [...wb.min], max0 = [...wb.max];
      const cx0 = slicePane.box.cx;

      state.boxLock.x = true;
      slicePane.setLocks(state.boxLock);
      slicePane.setWorldBox([min0[0] + 2, min0[1], min0[2]], [max0[0] + 2, max0[1], max0[2]]);
      ok(Math.abs(slicePane.box.cx - cx0) < 1e-9, '锁定 X 后拖动不改中心 X');

      state.boxLock.x = false;
      slicePane.setLocks(state.boxLock);
      slicePane.setWorldBox([min0[0] + 2, min0[1], min0[2]], [max0[0] + 2, max0[1], max0[2]]);
      ok(Math.abs(slicePane.box.cx - cx0 - 2) < 0.05, '解锁后拖动恢复修改中心 X');

      slicePane.setWorldBox(min0, max0);
    } catch (err) {
      ok(false, '锁定轴测试抛错', String(err.message).slice(0, 80));
      state.boxLock.x = false;
      slicePane.setLocks(state.boxLock);
    }

    // 9.59 面板里的导体内部箭头
    try {
      state.interior = true;
      slicePane.update({
        field: "B", mode: "arrows", density: 0.4, interior: true,
        opacity: 0.95, sliceAxis: "y", slicePos: 0,
      });
      const ia = slicePane.viz.interiorArrows;
      ok(!!ia && ia.count > 0, `面板内部箭头 count=${ia ? ia.count : "none"}`);
      state.interior = false;
    } catch (err) {
      ok(false, "面板内部箭头测试抛错", String(err.message).slice(0, 80));
    }

    // 9.6 截面窗口的立体视图
    try {
      state.sliceOn = true;
      slice.state.field = "S";      // 前面的切片测试把场留在了 phi，矢量场才有箭头
      slice.show(true);
      slice.setMode3D(true);
      ok(slice.mode3d === true, '立体视图已开启');
      ok(!slice.dom.canvas3.classList.contains('hidden'), '立体画布可见');
      ok(slice.dom.canvas.classList.contains('hidden'), '二维画布已隐藏');
      ok(!!slice.arrGroup && slice.arrGroup.children.length > 0, '立体视图生成了箭头');
      ok(!!slice.plane3 && slice.plane3.visible, '立体视图有贴图平面');
      slice.setMode3D(false);
      ok(slice.dom.canvas3.classList.contains('hidden'), '切回二维后立体画布隐藏');
      slice.show(false);
      state.sliceOn = false;
    } catch (err) {
      ok(false, '立体视图测试抛错', String(err.message).slice(0, 80));
    }

    // 9.65 截面三维交互：合成一个 pointerdown，看是否被拾取
    try {
      state.sliceOn = true;
      slice.show(true);
      slice.state.cx = 0; slice.state.cy = 0; slice.state.cz = 0;
      slice.update();
      scene3d.camera.updateMatrixWorld();
      const p = slice.projectedCenter();
      if (!p.onScreen) {
        ok(false, '截面中心不在屏幕上（无法测交互）');
      } else {
        const target = slice.scene3d.renderer.domElement;
        target.dispatchEvent(new PointerEvent('pointerdown', {
          clientX: p.x, clientY: p.y, bubbles: true, cancelable: true, pointerId: 1,
        }));
        ok(!!slice._drag, '截面拖动事件被拾取');
        document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
        ok(!slice._drag, '松手后拖动状态被清除');

        // Shift + 拖动 = 旋转，且平面姿态真的变了
        const q0 = slice.mesh.quaternion.clone();
        const yaw0 = slice.state.yaw;
        target.dispatchEvent(new PointerEvent('pointerdown', {
          clientX: p.x, clientY: p.y, shiftKey: true, bubbles: true, cancelable: true, pointerId: 2,
        }));
        ok(!!slice._drag && slice._drag.rotate === true, 'Shift+拖动进入旋转模式');
        document.dispatchEvent(new PointerEvent('pointermove', {
          clientX: p.x + 90, clientY: p.y + 20, shiftKey: true, bubbles: true, pointerId: 2,
        }));
        document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 2 }));
        const dYaw = Math.abs(slice.state.yaw - yaw0);
        const dQ = Math.abs(q0.dot(slice.mesh.quaternion));
        ok(dYaw > 1, `Shift+拖动改变偏航角 (Δ=${dYaw.toFixed(0)}°)`);
        ok(dQ < 0.9999, '平面姿态四元数确实变了');

        // 右键拖动 = 旋转（旋转后平面位置变了，要重新取一次屏幕坐标）
        slice.state.yaw = yaw0;
        slice.update();
        scene3d.camera.updateMatrixWorld();
        const p3 = slice.projectedCenter();
        target.dispatchEvent(new PointerEvent('pointerdown', {
          clientX: p3.x, clientY: p3.y, button: 2, bubbles: true, cancelable: true, pointerId: 3,
        }));
        ok(!!slice._drag && slice._drag.rotate === true, '右键拖动进入旋转模式');
        document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 3 }));
      }
      slice.show(false);
      state.sliceOn = false;
    } catch (err) {
      ok(false, '截面交互测试抛错', String(err.message).slice(0, 80));
    }

    // 9.7 断路（电池 + 两根断头线）→ 判定为零场，不画任何东西
    try {
      const backup = circuit.elements;
      const e = (type, a, b, v) => ({ id: newId(), type, a, b, value: v });
      circuit.elements = [
        e('battery', [0, 0], [0, 3], 9),
        e('wire', [0, 3], [4, 3]),
        e('wire', [0, 0], [4, 0]),
      ];
      state.field = 'S'; state.mode = 'arrows';
      lastCount = -1;
      rebuild();
      ok(viz.zero === true, '断路时 |S| 判定为零场（不画箭头）');
      circuit.elements = backup;
      lastCount = -1;
      rebuild();
    } catch (err) {
      ok(false, '断路判定抛错', String(err.message).slice(0, 80));
    }

    // 10. 清空后不崩溃
    circuit.elements = [];
    try { rebuild(); ok(true, '清空电路后仍可渲染'); }
    catch (err) { ok(false, '清空电路后崩溃', String(err.message).slice(0, 60)); }
  } catch (err) {
    ok(false, '自检过程中抛错', String(err.stack || err.message).slice(0, 200));
  }

  ok(errors.length === 0, '无未捕获的运行时错误', errors.join(' | ').slice(0, 120));

  const out = document.createElement('pre');
  out.id = 'selftest-out';
  out.style.cssText = 'position:fixed;left:0;top:0;z-index:9999;background:#05080c;color:#cfe;padding:14px;font:11px/1.5 monospace;max-height:100vh;overflow:auto;white-space:pre-wrap;width:100%;box-sizing:border-box';
  out.textContent = `SELFTEST ${fails === 0 ? 'PASS' : 'FAIL ' + fails}\n` + log.join('\n');
  document.body.appendChild(out);
  document.title = fails === 0 ? 'SELFTEST PASS' : 'SELFTEST FAIL';
  console.log(out.textContent);
}
