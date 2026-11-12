/**
 * editor2d.js —— 左侧的 2D 电路图编辑器
 *
 * 交互：选工具 → 在格点之间拖一条线段放置元件；选择工具可点选元件改参数；
 * 右键删除。所有端点吸附到格点，新端点若落在线段内部会自动打断（形成 T 形接点）。
 */
import { TYPES, newId, splitAt } from './circuit.js';

const GW = 12, GH = 8;      // 格点范围 0..GW-1, 0..GH-1
const PAD = 26;

export class Editor2D {
  constructor(canvas, { onChange, onSelect } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange || (() => {});
    this.onSelect = onSelect || (() => {});
    this.circuit = { elements: [] };
    this.solution = null;
    this.tool = 'select';
    this.selected = null;
    this.drag = null;      // {a:[i,j], b:[i,j]}
    this.hoverNode = null;
    this._bind();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement || canvas);
    this.resize();
  }

  setCircuit(c) { this.circuit = c; this.draw(); }
  setSolution(sol) { this.solution = sol; this.draw(); }
  setTool(t) { this.tool = t; this.canvas.style.cursor = t === 'select' ? 'default' : 'crosshair'; this.draw(); }
  select(el) { this.selected = el; this.onSelect(el); this.draw(); }

  resize() {
    const parent = this.canvas.parentElement || this.canvas;
    const w = Math.max(240, parent.clientWidth);
    const h = Math.max(200, parent.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = w; this.H = h;
    this.cell = Math.min((w - 2 * PAD) / (GW - 1), (h - 2 * PAD) / (GH - 1));
    this.ox = (w - this.cell * (GW - 1)) / 2;
    this.oy = (h - this.cell * (GH - 1)) / 2;
    this.draw();
  }

  gx(i) { return this.ox + i * this.cell; }
  gy(j) { return this.oy + j * this.cell; }

  toGrid(px, py) {
    // snap = 1 时对齐整格；关掉吸附后按 1/4 格对齐（0.25 在二进制里是精确的，
    // 连接判定仍然可用）
    const st = this.snap === false ? 0.25 : 1;
    const i = Math.round(((px - this.ox) / this.cell) / st) * st;
    const j = Math.round(((py - this.oy) / this.cell) / st) * st;
    if (i < 0 || i > GW - 1 || j < 0 || j > GH - 1) return null;
    return [i, j];
  }

  _pos(ev) {
    const r = this.canvas.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }

  _hit(px, py) {
    let best = null, bestD = 10;
    for (const el of this.circuit.elements) {
      const d = distSeg(px, py, this.gx(el.a[0]), this.gy(el.a[1]), this.gx(el.b[0]), this.gy(el.b[1]));
      if (d < bestD) { bestD = d; best = el; }
    }
    return best;
  }

  _bind() {
    const cv = this.canvas;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      const [px, py] = this._pos(e);
      const g = this.toGrid(px, py);
      if (e.button === 2) {
        const el = this._hit(px, py);
        if (el) { this._remove(el); }
        return;
      }
      if (this.tool === 'select') {
        const el = this._hit(px, py);
        this.select(el);
        return;
      }
      if (!g) return;
      this.drag = { a: g, b: g };
      cv.setPointerCapture(e.pointerId);
      this.draw();
    });
    cv.addEventListener('pointermove', (e) => {
      const [px, py] = this._pos(e);
      this.hover = [px, py];
      if (this.drag) {
        const g = this.toGrid(px, py);
        if (g) this.drag.b = g;
        this.draw();
      } else if (this.tool === 'select') {
        const el = this._hit(px, py);
        cv.style.cursor = el ? 'pointer' : 'default';
      }
    });
    cv.addEventListener('pointerup', (e) => {
      if (!this.drag) return;
      const d = this.drag;
      this.drag = null;
      if (d.a[0] !== d.b[0] || d.a[1] !== d.b[1]) this._place(d.a, d.b);
      this.draw();
    });
    window.addEventListener('keydown', (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) {
        this._remove(this.selected);
      }
    });
  }

  _place(a, b) {
    const type = this.tool;
    if (!TYPES[type]) return;
    this.solution = null;   // 结构性改动：先丢掉旧解，端点/电位别残留在画面上
    // 端点落在别的线段内部 → 打断
    splitAt(this.circuit, a);
    splitAt(this.circuit, b);
    // 同一对端点已存在元件则替换
    const dup = this.circuit.elements.find((el) =>
      (samePt(el.a, a) && samePt(el.b, b)) || (samePt(el.a, b) && samePt(el.b, a)));
    if (dup) this.circuit.elements = this.circuit.elements.filter((el) => el !== dup);
    const el = { id: newId(), type, a: a.slice(), b: b.slice(), value: TYPES[type].def };
    this.circuit.elements.push(el);
    this.selected = el;
    this.onSelect(el);
    this.onChange();
    this.draw();
  }

  _remove(el) {
    this.circuit.elements = this.circuit.elements.filter((x) => x !== el);
    if (this.selected === el) { this.selected = null; this.onSelect(null); }
    // 关键：清掉旧解。端点圆点是根据 solution.nodeV 画的，
    // 重建是异步的（setTimeout 0），不清掉的话旧端点会多留一帧甚至一直留着
    // （求解失败时 setSolution 不会被调用，就永久残留了）。
    this.solution = null;
    this.onChange();
    this.draw();
  }

  /* ---------------- 绘制 ---------------- */
  draw() {
    const ctx = this.ctx;
    if (!this.W) return;
    ctx.clearRect(0, 0, this.W, this.H);

    // 背景格点
    ctx.save();
    for (let i = 0; i < GW; i++) {
      for (let j = 0; j < GH; j++) {
        ctx.beginPath();
        ctx.arc(this.gx(i), this.gy(j), 1.6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(120,150,190,0.30)';
        ctx.fill();
      }
    }
    ctx.restore();

    // 元件
    for (const el of this.circuit.elements) {
      this.drawElement(el, el === this.selected);
    }

    // 拖拽预览
    if (this.drag) {
      const a = this.drag.a, b = this.drag.b;
      ctx.save();
      ctx.strokeStyle = 'rgba(120,200,255,0.85)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(this.gx(a[0]), this.gy(a[1]));
      ctx.lineTo(this.gx(b[0]), this.gy(b[1]));
      ctx.stroke();
      ctx.restore();
    }

    // 节点电位
    if (this.solution) {
      const V = this.solution.nodeV;
      const keys = Object.keys(V);
      const maxAbs = Math.max(1e-9, ...keys.map((k) => Math.abs(V[k])));
      for (const k of keys) {
        const [i, j] = k.split(',').map(Number);
        const t = 0.5 + 0.5 * (V[k] / maxAbs);
        ctx.beginPath();
        ctx.arc(this.gx(i), this.gy(j), 4.4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${Math.round(90 + 150 * t)},${Math.round(200 - 120 * Math.abs(t - 0.5) * 2)},${Math.round(160 + 80 * (1 - t))},0.95)`;
        ctx.fill();
        ctx.strokeStyle = 'rgba(8,11,16,0.9)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  drawElement(el, selected) {
    const ctx = this.ctx;
    const ax = this.gx(el.a[0]), ay = this.gy(el.a[1]);
    const bx = this.gx(el.b[0]), by = this.gy(el.b[1]);
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const ux = (bx - ax) / len, uy = (by - ay) / len;
    const px = -uy, py = ux;
    const col = TYPES[el.type].color;
    const lw = selected ? 3.2 : 2.2;

    ctx.save();
    if (selected) {
      ctx.shadowColor = 'rgba(120,200,255,0.9)';
      ctx.shadowBlur = 12;
    }
    ctx.strokeStyle = col;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const at = (t, off = 0) => [ax + (bx - ax) * t + px * off, ay + (by - ay) * t + py * off];
    const seg = (p, q) => { ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke(); };
    const A = 0.22, B = 0.78;

    switch (el.type) {
      case 'wire':
        seg([ax, ay], [bx, by]);
        break;
      case 'resistor': {
        seg([ax, ay], at(A));
        seg(at(B), [bx, by]);
        ctx.beginPath();
        const n = 6, amp = Math.min(9, len * 0.11);
        ctx.moveTo(...at(A));
        for (let k = 0; k < n; k++) {
          const t0 = A + (B - A) * ((k + 0.5) / n);
          const sgn = k % 2 === 0 ? 1 : -1;
          ctx.lineTo(...at(t0, amp * sgn));
          const t1 = A + (B - A) * ((k + 1) / n);
          ctx.lineTo(...at(t1, 0));
        }
        ctx.stroke();
        break;
      }
      case 'battery': {
        seg([ax, ay], at(0.44));
        seg(at(0.56), [bx, by]);
        const h = Math.min(13, len * 0.16), hs = Math.min(7, len * 0.09);
        ctx.lineWidth = lw + 0.8;
        seg(at(0.44, h), at(0.44, -h));
        ctx.lineWidth = lw * 1.6;
        seg(at(0.56, hs), at(0.56, -hs));
        ctx.lineWidth = lw;
        // 正极标号
        ctx.fillStyle = col;
        ctx.font = `600 ${Math.max(10, this.cell * 0.24)}px "Segoe UI", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('+', ...at(0.32, h + 9));
        break;
      }
      case 'capacitor': {
        seg([ax, ay], at(0.44));
        seg(at(0.56), [bx, by]);
        const h = Math.min(13, len * 0.16);
        ctx.lineWidth = lw + 0.6;
        seg(at(0.44, h), at(0.44, -h));
        seg(at(0.56, h), at(0.56, -h));
        break;
      }
      case 'inductor': {
        seg([ax, ay], at(0.24));
        seg(at(0.76), [bx, by]);
        const turns = 4;
        const r = (B - A) * len / turns / 2;
        ctx.beginPath();
        for (let k = 0; k < turns; k++) {
          const t0 = A + (B - A) * (k / turns);
          const [cx, cy] = at(t0);
          const ang = Math.atan2(uy, ux);
          ctx.arc(cx, cy, r, ang - Math.PI / 2, ang + Math.PI / 2, false);
        }
        ctx.stroke();
        break;
      }
    }

    // 数值
    if (el.type !== 'wire' && el.value !== undefined) {
      const [mx, my] = at(0.5, -Math.min(16, this.cell * 0.3));
      ctx.fillStyle = 'rgba(200,215,235,0.85)';
      ctx.font = `500 ${Math.max(10, this.cell * 0.22)}px "Segoe UI", "Microsoft YaHei", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${el.value}${TYPES[el.type].unit}`, mx, my);
    }
    ctx.restore();
  }
}

function samePt(a, b) { return a[0] === b[0] && a[1] === b[1]; }

function distSeg(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
}
