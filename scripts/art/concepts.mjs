// Знак Jarvis Code по референсу (язык ИИ-брендов: один сильный знак, градиент, объём), без радиальной симметрии.
const f = (n) => (Math.abs(n) < 1e-9 ? 0 : n).toFixed(2);
const deg = Math.PI / 180;

/** Четырёхлучевая искра с вогнутыми сторонами (лучи разной длины). */
export function star4(cx, cy, up, right, down, left, k = 0.16, rot = 0) {
  const pts = [[0, -up], [right, 0], [0, down], [-left, 0]];
  const r = (x, y) => [cx + x * Math.cos(rot * deg) - y * Math.sin(rot * deg), cy + x * Math.sin(rot * deg) + y * Math.cos(rot * deg)];
  let d = "";
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % 4];
    const [qx, qy] = r((ax + bx) * k, (ay + by) * k);
    const [sx, sy] = r(ax, ay), [ex, ey] = r(bx, by);
    d += (i ? "" : `M${f(sx)} ${f(sy)}`) + `Q${f(qx)} ${f(qy)} ${f(ex)} ${f(ey)}`;
  }
  return d + "Z";
}

/** Кольцо-эллипс переменной толщины. part: "all" | "back" | "front". Возвращает path. */
export function ellipseRing(cx, cy, rx, ry, rot, wBack, wFront, part = "all", steps = 180) {
  const R = (x, y) => [cx + x * Math.cos(rot * deg) - y * Math.sin(rot * deg), cy + x * Math.sin(rot * deg) + y * Math.cos(rot * deg)];
  // задняя половина чуть заходит под переднюю — иначе на стыках видна тонкая «шовная» линия сглаживания
  const ov = part === "back" ? 0.035 : 0;
  const t0 = part === "back" ? Math.PI - ov : 0;
  const t1 = part === "all" ? 2 * Math.PI : part === "back" ? 2 * Math.PI + ov : Math.PI;
  const outer = [], inner = [];
  for (let i = 0; i <= steps; i++) {
    const t = t0 + ((t1 - t0) * i) / steps;
    const x = rx * Math.cos(t), y = ry * Math.sin(t);
    // нормаль к эллипсу
    let nx = Math.cos(t) / rx, ny = Math.sin(t) / ry;
    const nl = Math.hypot(nx, ny);
    nx /= nl; ny /= nl;
    const s = Math.sin(t); // >0 — передняя (нижняя) половина
    const w = (wBack + (wFront - wBack) * (s + 1) / 2) / 2;
    outer.push(R(x + nx * w, y + ny * w));
    inner.push(R(x - nx * w, y - ny * w));
  }
  const L = (p) => `${f(p[0])} ${f(p[1])}`;
  if (part === "all") return `M${outer.map(L).join("L")}ZM${inner.reverse().map(L).join("L")}Z`;
  return `M${outer.map(L).join("L")}L${inner.reverse().map(L).join("L")}Z`;
}

export const PAL = { amber: "#ffc27a", coral: "#f47e4f", rose: "#e8507a", violet: "#8a5cf6", cream: "#fff5ec" };

const BOX = `x="-20" y="-20" width="140" height="140"`;
/** Маска «вырезать вокруг фигуры d зазор gap» (+ необязательная область clip). */
function cutMask(id, d, gap, { fill = true, stroke = 0, clip = null } = {}) {
  const shape = `<path d="${d}" fill="${fill ? "#000" : "none"}" stroke="#000" stroke-width="${stroke + gap * 2}" stroke-linejoin="round" stroke-linecap="round"/>`;
  const body = clip ? `<g clip-path="url(#${id}-c)">${shape}</g>` : shape;
  const cp = clip ? `<clipPath id="${id}-c"><circle cx="${clip[0]}" cy="${clip[1]}" r="${clip[2]}"/></clipPath>` : "";
  return `${cp}<mask id="${id}" maskUnits="userSpaceOnUse" ${BOX}><rect ${BOX} fill="#fff"/>${body}</mask>`;
}
const lg = (id, x1, y1, x2, y2, stops) =>
  `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join("")}</linearGradient>`;

export const CONCEPTS = {
  /** 1. Орбита: искра внутри наклонённого кольца — кольцо проходит за искрой и перед ней. */
  halo({ mono = null, id = "h", glow = false, gap = 3.2, small = false } = {}) {
    // small — для 16–24 px: толще кольцо, полнее искра, шире зазор
    const ring = small ? [50, 59, 46, 15.5, -16, 8, 13.5] : [50, 58.5, 45.5, 14, -16, 4.8, 9.6];
    const star = small ? star4(50, 45, 39, 25, 34, 23, 0.23, 0) : star4(50, 46, 37, 22.5, 33, 20.5, 0.19, 0);
    if (small) gap = 4.4;
    const back = ellipseRing(...ring, "back");
    const front = ellipseRing(...ring, "front");
    const S = mono ?? `url(#${id}-gs)`, R = mono ?? `url(#${id}-gr)`;
    const defs = `<defs>${mono ? "" : lg(`${id}-gs`, 44, 9, 56, 80, [[0, "#ffd9a8"], [0.42, PAL.coral], [1, PAL.rose]]) + lg(`${id}-gr`, 6, 74, 94, 44, [[0, PAL.violet], [0.55, PAL.rose], [1, PAL.amber]]) + `<radialGradient id="${id}-gl" cx="50" cy="48" r="42" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${PAL.coral}" stop-opacity=".36"/><stop offset="1" stop-color="${PAL.coral}" stop-opacity="0"/></radialGradient>`}${cutMask(`${id}-mb`, star, gap)}${cutMask(`${id}-ms`, front, gap)}</defs>`;
    return `${defs}${glow && !mono ? `<circle cx="50" cy="48" r="42" fill="url(#${id}-gl)"/>` : ""}<g class="ring-back"><path d="${back}" fill="${R}" mask="url(#${id}-mb)"/></g><g class="star"><path d="${star}" fill="${S}" mask="url(#${id}-ms)"/></g><g class="ring-front"><path d="${front}" fill="${R}"/></g>`;
  },
  /** 2. Затмение: кольцо света и вспышка на краю («кольцо с бриллиантом»). */
  eclipse({ mono = null, id = "e", glow = false, gap = 3.2 } = {}) {
    const cx = 47, cy = 54, r = 30.5, a = 42 * deg;
    const fx = cx + r * Math.sin(a), fy = cy - r * Math.cos(a);
    const flare = star4(fx, fy, 23, 19, 20, 17, 0.15, 8);
    const ringD = `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
    const R = mono ?? `url(#${id}-gr)`, F = mono ?? `url(#${id}-gf)`;
    const defs = `<defs>${mono ? "" : lg(`${id}-gr`, 18, 86, 80, 22, [[0, PAL.violet], [0.5, PAL.rose], [1, PAL.amber]]) + `<radialGradient id="${id}-gf" cx="${f(fx)}" cy="${f(fy)}" r="22" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset=".35" stop-color="#ffe2b8"/><stop offset="1" stop-color="${PAL.coral}"/></radialGradient><radialGradient id="${id}-gl" cx="${f(fx)}" cy="${f(fy)}" r="34" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${PAL.amber}" stop-opacity=".45"/><stop offset="1" stop-color="${PAL.amber}" stop-opacity="0"/></radialGradient>`}${cutMask(`${id}-m`, flare, gap)}</defs>`;
    return `${defs}${glow && !mono ? `<circle cx="${f(fx)}" cy="${f(fy)}" r="34" fill="url(#${id}-gl)"/>` : ""}<g class="ring"><path d="${ringD}" fill="none" stroke="${R}" stroke-width="11.5" mask="url(#${id}-m)"/></g><g class="star"><path d="${flare}" fill="${F}"/></g>`;
  },
  /** 3. Связка: окно (ПК) и кольцо (агент) сцеплены, как звенья, — мост Notion ↔ ПК. */
  link({ mono = null, id = "l", glow = false, gap = 3 } = {}) {
    const sq = { x: 14, y: 33, s: 52, r: 16 }, ring = { cx: 66, cy: 34, r: 19 };
    const sqD = `M${sq.x + sq.r} ${sq.y}H${sq.x + sq.s - sq.r}Q${sq.x + sq.s} ${sq.y} ${sq.x + sq.s} ${sq.y + sq.r}V${sq.y + sq.s - sq.r}Q${sq.x + sq.s} ${sq.y + sq.s} ${sq.x + sq.s - sq.r} ${sq.y + sq.s}H${sq.x + sq.r}Q${sq.x} ${sq.y + sq.s} ${sq.x} ${sq.y + sq.s - sq.r}V${sq.y + sq.r}Q${sq.x} ${sq.y} ${sq.x + sq.r} ${sq.y}Z`;
    const ringD = `M${ring.cx - ring.r} ${ring.cy}a${ring.r} ${ring.r} 0 1 0 ${2 * ring.r} 0a${ring.r} ${ring.r} 0 1 0 ${-2 * ring.r} 0`;
    const W1 = 11, W2 = 10;
    // точки пересечения: верхняя сторона квадрата (y=33) и правая (x=66)
    const A = [ring.cx - Math.sqrt(ring.r ** 2 - (sq.y - ring.cy) ** 2), sq.y];
    const B = [sq.x + sq.s, ring.cy + Math.sqrt(ring.r ** 2 - (sq.x + sq.s - ring.cx) ** 2)];
    const Q = mono ?? `url(#${id}-gq)`, C = mono ?? `url(#${id}-gc)`;
    const defs = `<defs>${mono ? "" : lg(`${id}-gq`, 14, 85, 66, 33, [[0, PAL.violet], [0.6, PAL.rose], [1, PAL.coral]]) + lg(`${id}-gc`, 50, 52, 82, 16, [[0, PAL.coral], [1, PAL.amber]])}${cutMask(`${id}-mq`, ringD, gap, { fill: false, stroke: W2, clip: [A[0], A[1], 12] })}${cutMask(`${id}-mc`, sqD, gap, { fill: false, stroke: W1, clip: [B[0], B[1], 12] })}</defs>`;
    return `${defs}<g class="square"><path d="${sqD}" fill="none" stroke="${Q}" stroke-width="${W1}" mask="url(#${id}-mq)"/></g><g class="ring"><path d="${ringD}" fill="none" stroke="${C}" stroke-width="${W2}" mask="url(#${id}-mc)"/></g>`;
  },
};

/**
 * «Орбита» для анимации. Маски вынесены на внешние группы, а их содержимое анимируется теми же
 * классами, что и фигуры, — поэтому зазоры между кольцом и искрой остаются точными в любой момент.
 * Классы: .o-ring (кольцо и его вырез в искре), .o-star (искра и её вырез в кольце), .o-glint (блик), .o-glow.
 * На корневом <svg> задайте --oy: центр кольца по Y (58.5px, для small — 59px).
 */
export function haloAnimated({ id = "ha", small = false, glow = true, gap = 3.2 } = {}) {
  const ring = small ? [50, 59, 46, 15.5, -16, 8, 13.5] : [50, 58.5, 45.5, 14, -16, 4.8, 9.6];
  const star = small ? star4(50, 45, 39, 25, 34, 23, 0.23, 0) : star4(50, 46, 37, 22.5, 33, 20.5, 0.19, 0);
  if (small) gap = 4.4;
  const back = ellipseRing(...ring, "back"), front = ellipseRing(...ring, "front"), all = ellipseRing(...ring, "all");
  const [cx, cy, rx, ry, rot] = ring;
  const cut = (cls, d) => `<g class="${cls}"><path d="${d}" fill="#000" stroke="#000" stroke-width="${gap * 2}" stroke-linejoin="round"/></g>`;
  const mask = (mid, inner) => `<mask id="${mid}" maskUnits="userSpaceOnUse" ${BOX}><rect ${BOX} fill="#fff"/>${inner}</mask>`;
  // блик — один слой поверх всего кольца (без швов на стыках половин); за искрой его прячет маска
  const glint = `<g mask="url(#${id}-mg)"><g class="o-ring"><g clip-path="url(#${id}-ca)"><ellipse class="o-glint" cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" transform="rotate(${rot} ${cx} ${cy})" pathLength="100" fill="none" stroke="#fff7ef" stroke-width="${small ? 18 : 15}" stroke-linecap="round" stroke-dasharray="3 97" filter="url(#${id}-bl)"/></g></g></g>`;
  const defs = `<defs>${lg(`${id}-gs`, 44, 9, 56, 80, [[0, "#ffd9a8"], [0.42, PAL.coral], [1, PAL.rose]])}${lg(`${id}-gr`, 6, 74, 94, 44, [[0, PAL.violet], [0.55, PAL.rose], [1, PAL.amber]])}<radialGradient id="${id}-gl" cx="50" cy="48" r="42" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${PAL.coral}" stop-opacity=".42"/><stop offset="1" stop-color="${PAL.coral}" stop-opacity="0"/></radialGradient><filter id="${id}-bl" filterUnits="userSpaceOnUse" ${BOX}><feGaussianBlur stdDeviation="${small ? 1.6 : 2.2}"/></filter>${mask(`${id}-mb`, cut("o-star", star))}${mask(`${id}-ms`, cut("o-ring", front))}${mask(`${id}-mg`, cut("o-star", star) + `<g class="o-ring"><path d="${front}" fill="#fff"/></g>`)}<clipPath id="${id}-ca"><path d="${all}"/></clipPath></defs>`;
  return `${defs}${glow ? `<circle class="o-glow" cx="50" cy="48" r="42" fill="url(#${id}-gl)"/>` : ""}<g mask="url(#${id}-mb)"><g class="o-ring"><path d="${back}" fill="url(#${id}-gr)"/></g></g><g mask="url(#${id}-ms)"><g class="o-star"><path d="${star}" fill="url(#${id}-gs)"/></g></g><g class="o-ring"><path d="${front}" fill="url(#${id}-gr)"/></g>${glint}`;
}

/** CSS анимации «Орбиты»: запуск (кольцо раскрывается, искра вспыхивает) и «думает» (.thinking — блик и дыхание). */
export const ORBIT_CSS = `
.o-ring, .o-star, .o-glow, .o-glint { transform-box: view-box; }
.o-ring { transform-origin: 50px var(--oy, 58.5px); animation: o-open 1.25s cubic-bezier(.16,1,.3,1) .3s both; }
.o-star { transform-origin: 50px 56px; animation: o-pop .95s cubic-bezier(.3,1.45,.45,1) .12s both; }
.o-glow { transform-origin: 50px 48px; animation: o-flare 1.5s ease-out .25s both; }
.o-glint { opacity: 0; }
.thinking .o-star { animation: o-pop .95s cubic-bezier(.3,1.45,.45,1) .12s both, o-breathe 2.4s ease-in-out var(--think, 0s) infinite; }
.thinking .o-glow { animation: o-flare 1.5s ease-out .25s both, o-pulse 2.4s ease-in-out var(--think, 0s) infinite; }
.thinking .o-glint { animation: o-glint-in .7s ease var(--think, 0s) forwards, o-orbit 2.4s linear var(--think, 0s) infinite; }
@keyframes o-open { 0% { transform: rotate(-44deg) scale(.3, .04) rotate(16deg); opacity: 0 } 30% { opacity: 1 } 100% { transform: rotate(-16deg) scale(1, 1) rotate(16deg); opacity: 1 } }
@keyframes o-pop { 0% { transform: scale(.15) rotate(-35deg); opacity: 0 } 55% { opacity: 1 } 100% { transform: scale(1) rotate(0deg); opacity: 1 } }
@keyframes o-flare { 0% { opacity: 0; transform: scale(.35) } 45% { opacity: 1; transform: scale(1.3) } 100% { opacity: .6; transform: scale(1) } }
@keyframes o-breathe { 0%, 100% { transform: scale(1) } 50% { transform: scale(1.04) } }
@keyframes o-pulse { 0%, 100% { opacity: .6; transform: scale(1) } 50% { opacity: 1; transform: scale(1.08) } }
@keyframes o-glint-in { to { opacity: .92 } }
@keyframes o-orbit { from { stroke-dashoffset: 0 } to { stroke-dashoffset: 100 } }
`;
