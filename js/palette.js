/**
 * palette.js —— 配色（纯函数，不依赖 three.js，方便 Node 侧测试）
 */

const DIVERGING = [
  [0.0, [0.18, 0.42, 0.72]],
  [0.35, [0.45, 0.62, 0.78]],
  [0.5, [0.80, 0.80, 0.80]],
  [0.65, [0.85, 0.55, 0.38]],
  [1.0, [0.80, 0.22, 0.25]],
];

// 导体用「顺序色」：低电位冷蓝 → 高电位暖琥珀
const SEQUENTIAL = [
  [0.0, [0.16, 0.40, 0.90]],
  [0.35, [0.42, 0.68, 0.84]],
  [0.7, [0.86, 0.72, 0.50]],
  [1.0, [1.0, 0.70, 0.33]],
];

function lerpStops(stops, t) {
  t = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = Math.max(0, Math.min(1, (t - t0) / (t1 - t0 || 1)));
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return stops[stops.length - 1][1];
}

export function divergingColor(t) {
  return lerpStops(DIVERGING, t);
}

/** 导体电位 → 颜色（低电位蓝、高电位暖琥珀，并混入一点铜色保住「导线感」） */
export function potentialToRGB(v, minV = 0, maxV = 1) {
  const span = maxV - minV;
  const t = span > 1e-12 ? (v - minV) / span : 0.5;
  const c = lerpStops(SEQUENTIAL, t);
  const cu = [0.79, 0.55, 0.29];
  return [
    c[0] * 0.86 + cu[0] * 0.14,
    c[1] * 0.86 + cu[1] * 0.14,
    c[2] * 0.86 + cu[2] * 0.14,
  ];
}
