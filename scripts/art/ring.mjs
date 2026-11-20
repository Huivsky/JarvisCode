// «Кольцо света» — знак Jarvis Code: кольцо света и вспышка на краю (как «бриллиантовое кольцо» при затмении).
// Одна геометрия для иконки приложения (logo.mjs → render.mjs), презентации и анимации; в интерфейсе — ui/icons.tsx.
const f = (n) => (Math.abs(n) < 1e-9 ? 0 : n).toFixed(2);
const deg = Math.PI / 180;

/** Четырёхлучевая вспышка с вогнутыми сторонами (лучи разной длины), rot — поворот в градусах. */
export function star4(cx, cy, up, right, down, left, k = 0.16, rot = 0) {
  const pts = [[0, -up], [right, 0], [0, down], [-left, 0]];
  const c = Math.cos(rot * deg), s = Math.sin(rot * deg);
  const r = (x, y) => [cx + x * c - y * s, cy + x * s + y * c];
  let d = "";
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % 4];
    const [qx, qy] = r((ax + bx) * k, (ay + by) * k);
    const [sx, sy] = r(ax, ay), [ex, ey] = r(bx, by);
    d += (i ? "" : `M${f(sx)} ${f(sy)}`) + `Q${f(qx)} ${f(qy)} ${f(ex)} ${f(ey)}`;
  }
  return d + "Z";
}

/** big — от 28 px; small — для 13–24 px: толще кольцо, крупнее вспышка, шире зазор. */
export const RING = {
  big: { cx: 47, cy: 54, r: 30.5, w: 11.5, a: 42, flare: [23, 19, 20, 17, 0.15, -3], gap: 3.2 },
  small: { cx: 46.5, cy: 55, r: 29.5, w: 15, a: 42, flare: [27, 23, 23, 20, 0.2, -3], gap: 4.4 },
};

/** Цвета: кольцо (фиолет → роза → янтарь), вспышка (белое ядро → персик → коралл), ореол. */
export const COLORS = {
  dark: { r: ["#8a5cf6", "#e8507a", "#ffc27a"], f: ["#ffffff", "#ffe2b8", "#f47e4f"], glow: "#ffb070" },
  light: { r: ["#7a4be6", "#dc4672", "#f39243"], f: ["#ffc77d", "#f7a052", "#e2583a"], glow: "#f39243" },
};

export function geom(kind = "big") {
  const g = RING[kind];
  const fx = g.cx + g.r * Math.sin(g.a * deg), fy = g.cy - g.r * Math.cos(g.a * deg);
  // кольцо — путь, который начинается у вспышки и идёт по часовой (для «прорисовки» и блика)
  const ox = 2 * g.cx - fx, oy = 2 * g.cy - fy;
  const ringD = `M${f(fx)} ${f(fy)}A${g.r} ${g.r} 0 1 1 ${f(ox)} ${f(oy)}A${g.r} ${g.r} 0 1 1 ${f(fx)} ${f(fy)}`;
  const ro = g.r + g.w / 2, ri = g.r - g.w / 2;
  const annulus = `M${f(g.cx - ro)} ${f(g.cy)}a${ro} ${ro} 0 1 0 ${f(2 * ro)} 0a${ro} ${ro} 0 1 0 ${f(-2 * ro)} 0ZM${f(g.cx - ri)} ${f(g.cy)}a${ri} ${ri} 0 1 1 ${f(2 * ri)} 0a${ri} ${ri} 0 1 1 ${f(-2 * ri)} 0Z`;
  return { ...g, fx, fy, ringD, annulus, flareD: star4(fx, fy, ...g.flare) };
}

const BOX = `x="-20" y="-20" width="140" height="140"`;
const sc = (o, c, op) => `<stop offset="${o}" style="stop-color:${c}${op != null ? `;stop-opacity:${op}` : ""}"/>`;
// colors: "dark" | "light" | "css" (цвета из переменных темы --mk-*, как в приложении) | { r, f, glow }
const CSSV = { r: ["var(--mk-r0)", "var(--mk-r1)", "var(--mk-r2)"], f: ["var(--mk-f0)", "var(--mk-f1)", "var(--mk-f2)"], glow: "var(--mk-glow)" };
function defs(id, g, { mono, colors }) {
  const C = colors === "css" ? CSSV : typeof colors === "object" ? colors : COLORS[colors] || COLORS.dark;
  const grad = mono
    ? ""
    : `<linearGradient id="${id}-r" gradientUnits="userSpaceOnUse" x1="18" y1="86" x2="80" y2="22">${sc("0", C.r[0])}${sc(".5", C.r[1])}${sc("1", C.r[2])}</linearGradient>` +
      `<radialGradient id="${id}-f" cx="${f(g.fx)}" cy="${f(g.fy)}" r="${g.flare[0]}" gradientUnits="userSpaceOnUse">${sc("0", C.f[0])}${sc(".35", C.f[1])}${sc("1", C.f[2])}</radialGradient>` +
      `<radialGradient id="${id}-g" cx="${f(g.fx)}" cy="${f(g.fy)}" r="34" gradientUnits="userSpaceOnUse">${sc("0", C.glow, colors === "css" ? "var(--mk-glow-a)" : ".5")}${sc("1", C.glow, "0")}</radialGradient>`;
  const mask = `<mask id="${id}-m" maskUnits="userSpaceOnUse" ${BOX}><rect ${BOX} fill="#fff"/><path class="r-cut" d="${g.flareD}" fill="#000" stroke="#000" stroke-width="${g.gap * 2}" stroke-linejoin="round"/></mask>`;
  return grad + mask;
}

/** Статичный знак (внутренность svg 0 0 100 100). mono — один цвет; colors: "dark" | "light". */
export function ringMark({ id = "rm", small = false, mono = null, glow = false, colors = "dark" } = {}) {
  const g = geom(small ? "small" : "big");
  const R = mono ?? `url(#${id}-r)`, F = mono ?? `url(#${id}-f)`;
  return `<defs>${defs(id, g, { mono, colors })}</defs>${glow && !mono ? `<circle cx="${f(g.fx)}" cy="${f(g.fy)}" r="34" fill="url(#${id}-g)"/>` : ""}<path d="${g.ringD}" fill="none" stroke="${R}" stroke-width="${g.w}" mask="url(#${id}-m)"/><path d="${g.flareD}" fill="${F}"/>`;
}

/**
 * Знак для анимации — та же структура, что у Spark в ui/icons.tsx.
 * Классы: .r-ring (кольцо, pathLength 100), .r-glint/.r-glint-wrap (блик), .r-flare (вспышка), .r-glow (ореол).
 */
export function ringAnimated({ id = "ra", small = false, glow = true, colors = "dark" } = {}) {
  const g = geom(small ? "small" : "big");
  const o = `transform-origin:${f(g.fx)}px ${f(g.fy)}px`;
  return `<defs>${defs(id, g, { colors })}<clipPath id="${id}-c"><path d="${g.annulus}" clip-rule="evenodd"/></clipPath><filter id="${id}-b" filterUnits="userSpaceOnUse" ${BOX}><feGaussianBlur stdDeviation="${small ? 1.8 : 2.6}"/></filter></defs>${glow ? `<circle class="r-glow" style="${o}" cx="${f(g.fx)}" cy="${f(g.fy)}" r="34" fill="url(#${id}-g)"/>` : ""}<g mask="url(#${id}-m)"><path class="r-ring" d="${g.ringD}" pathLength="100" fill="none" stroke="url(#${id}-r)" stroke-width="${g.w}"/><g class="r-glint-wrap" clip-path="url(#${id}-c)"><path class="r-glint" d="${g.ringD}" pathLength="100" fill="none" stroke="#fff4e8" stroke-width="${g.w + 6}" stroke-dasharray="7 93" filter="url(#${id}-b)"/></g></g><g class="r-flare" style="${o}"><path d="${g.flareD}" fill="url(#${id}-f)"/></g>`;
}

/**
 * CSS анимаций. .intro — запуск: свет обегает кольцо от вспышки по часовой, кольцо замыкается, вспышка загорается.
 * .spin — «думает»: по кольцу бежит блик и, дойдя до вспышки, зажигает её. --intro-end — когда стартует .spin после .intro.
 */
export const RING_CSS = `
.r-flare, .r-glow { transform-box: view-box; }
.r-glint-wrap { opacity: 0; }
.intro .r-ring { stroke-dasharray: 100 100; animation: r-draw 1.05s cubic-bezier(.5,.05,.3,1) .15s both; }
.intro .r-glint { animation: r-head 1.05s cubic-bezier(.5,.05,.3,1) .15s both; }
.intro .r-glint-wrap { animation: r-head-fade 1.05s linear .15s both; }
.intro .r-flare { animation: r-pop .8s cubic-bezier(.3,1.5,.45,1) 1s both; }
.intro .r-glow { animation: r-flash 1.4s ease-out .95s both; }
.spin .r-glint-wrap { opacity: .9; }
.spin .r-glint { animation: r-orbit 2.2s linear infinite; }
.spin .r-flare { animation: r-twinkle 2.2s cubic-bezier(.45,0,.55,1) infinite; }
.spin .r-glow { animation: r-pulse 2.2s cubic-bezier(.45,0,.55,1) infinite; }
.intro.spin .r-glint-wrap { animation: r-head-fade 1.05s linear .15s both, r-show .5s ease var(--intro-end, 1.8s) forwards; }
.intro.spin .r-glint { animation: r-head 1.05s cubic-bezier(.5,.05,.3,1) .15s both, r-orbit 2.2s linear var(--intro-end, 1.8s) infinite; }
.intro.spin .r-flare { animation: r-pop .8s cubic-bezier(.3,1.5,.45,1) 1s both, r-twinkle 2.2s cubic-bezier(.45,0,.55,1) var(--intro-end, 1.8s) infinite; }
.intro.spin .r-glow { animation: r-flash 1.4s ease-out .95s both, r-pulse 2.2s cubic-bezier(.45,0,.55,1) var(--intro-end, 1.8s) infinite; }
@keyframes r-draw { from { stroke-dashoffset: 100; } to { stroke-dashoffset: 0; } }
@keyframes r-head { from { stroke-dashoffset: 7; } to { stroke-dashoffset: -93; } }
@keyframes r-head-fade { 0% { opacity: 0; } 8% { opacity: 1; } 86% { opacity: 1; } 100% { opacity: 0; } }
@keyframes r-show { from { opacity: 0; } to { opacity: .9; } }
@keyframes r-pop { 0% { transform: scale(0) rotate(-70deg); opacity: 0; } 35% { opacity: 1; } 100% { transform: none; opacity: 1; } }
@keyframes r-flash { 0% { opacity: 0; transform: scale(.3); } 35% { opacity: 1; transform: scale(1.45); } 100% { opacity: .7; transform: none; } }
@keyframes r-orbit { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -100; } }
@keyframes r-twinkle { 0% { transform: scale(1.12) rotate(10deg); } 22% { transform: none; } 78% { transform: scale(.94) rotate(-4deg); } 100% { transform: scale(1.12) rotate(10deg); } }
@keyframes r-pulse { 0% { opacity: 1; transform: scale(1.12); } 22% { opacity: .7; transform: none; } 78% { opacity: .55; transform: scale(.94); } 100% { opacity: 1; transform: scale(1.12); } }
`;
