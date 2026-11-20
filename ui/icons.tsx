import { useId, type SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function I({ size = 18, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export const Plus = (p: P) => <I {...p}><path d="M12 5v14M5 12h14" /></I>;
export const Search = (p: P) => <I {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></I>;
export const Folder = (p: P) => <I {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></I>;
export const FolderOpen = (p: P) => <I {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1" /><path d="M3 7v10a2 2 0 0 0 2 2h12.5a2 2 0 0 0 1.9-1.4L21.6 12a1.5 1.5 0 0 0-1.4-2H8.1a2 2 0 0 0-1.9 1.4L3 19" /></I>;
export const Settings = (p: P) => <I {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></I>;
export const Sliders = (p: P) => <I {...p}><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" /></I>;
export const PanelLeft = (p: P) => <I {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></I>;
export const ChevronDown = (p: P) => <I {...p}><path d="m6 9 6 6 6-6" /></I>;
export const ChevronRight = (p: P) => <I {...p}><path d="m9 6 6 6-6 6" /></I>;
export const ChevronLeft = (p: P) => <I {...p}><path d="m15 6-6 6 6 6" /></I>;
export const ArrowUp = (p: P) => <I {...p} strokeWidth={2.2}><path d="M12 19V5M5 12l7-7 7 7" /></I>;
export const Square = (p: P) => <I {...p}><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" /></I>;
export const Paperclip = (p: P) => <I {...p}><path d="m21 11-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l8-8" /></I>;
export const X = (p: P) => <I {...p}><path d="M18 6 6 18M6 6l12 12" /></I>;
export const Check = (p: P) => <I {...p} strokeWidth={2.2}><path d="m5 12 5 5 9-10" /></I>;
export const Terminal = (p: P) => <I {...p}><path d="m5 8 4 4-4 4M12 16h7" /><rect x="2" y="3" width="20" height="18" rx="2" /></I>;
export const File = (p: P) => <I {...p}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /></I>;
export const Pencil = (p: P) => <I {...p}><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></I>;
export const Trash = (p: P) => <I {...p}><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></I>;
export const Copy = (p: P) => <I {...p}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></I>;
export const External = (p: P) => <I {...p}><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></I>;
export const Shield = (p: P) => <I {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></I>;
export const Refresh = (p: P) => <I {...p}><path d="M21 12a9 9 0 1 1-2.6-6.4L21 8" /><path d="M21 3v5h-5" /></I>;
export const LogOut = (p: P) => <I {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></I>;
export const More = (p: P) => <I {...p}><circle cx="5" cy="12" r="1.2" fill="currentColor" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><circle cx="19" cy="12" r="1.2" fill="currentColor" /></I>;
export const Code = (p: P) => <I {...p}><path d="m16 18 6-6-6-6M8 6l-6 6 6 6" /></I>;
export const Cpu = (p: P) => <I {...p}><rect x="5" y="5" width="14" height="14" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></I>;
export const Zap = (p: P) => <I {...p}><path d="M13 2 3 14h9l-1 8 10-12h-9z" /></I>;
export const Book = (p: P) => <I {...p}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z" /><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" /></I>;
export const Sparkles = (p: P) => <I {...p}><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></I>;
export const Monitor = (p: P) => <I {...p}><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></I>;
export const Lock = (p: P) => <I {...p}><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></I>;
export const Eye = (p: P) => <I {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></I>;
export const EyeOff = (p: P) => <I {...p}><path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6" /></I>;
export const Download = (p: P) => <I {...p}><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></I>;
export const Info = (p: P) => <I {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></I>;
export const Alert = (p: P) => <I {...p}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17v.5" /></I>;
export const Sun = (p: P) => <I {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></I>;
export const User = (p: P) => <I {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></I>;
export const Plug = (p: P) => <I {...p}><path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5" /></I>;
export const Globe = (p: P) => <I {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></I>;
export const Key = (p: P) => <I {...p}><circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 9.3-9.3M17 6l3 3M14.5 8.5l2.5 2.5" /></I>;
export const Power = (p: P) => <I {...p}><path d="M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0" /></I>;
export const Users = (p: P) => <I {...p}><circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 9M22 21a7 7 0 0 0-4-6.3" /></I>;
export const Swap = (p: P) => <I {...p}><path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7" /></I>;

export const Undo = (p: P) => <I {...p}><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></I>;
export const Image = (p: P) => <I {...p}><rect x="3" y="3" width="18" height="18" rx="2.5" /><circle cx="9" cy="9" r="1.8" /><path d="m21 15-4.5-4.5L6 21" /></I>;
export const Film = (p: P) => <I {...p}><rect x="3" y="3" width="18" height="18" rx="2.5" /><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4M3 12h18" /></I>;
export const Music = (p: P) => <I {...p}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></I>;
export const FileText = (p: P) => <I {...p}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M8 13h8M8 17h6" /></I>;
export const ListChecks = (p: P) => <I {...p}><path d="m3 7 2 2 4-4M3 17l2 2 4-4M13 6h8M13 12h8M13 18h8" /></I>;
export const Slash = (p: P) => <I {...p}><rect x="3" y="3" width="18" height="18" rx="4" /><path d="m14.5 7.5-5 9" /></I>;
export const AtSign = (p: P) => <I {...p}><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.9 7.9" /></I>;
export const ArrowDown = (p: P) => <I {...p} strokeWidth={2}><path d="M12 5v14M19 12l-7 7-7-7" /></I>;
export const Palette = (p: P) => <I {...p}><path d="M12 22a10 10 0 1 1 10-10c0 2.8-2.2 4-4.5 4H16a2 2 0 0 0-1.4 3.4A1.6 1.6 0 0 1 12 22z" /><circle cx="7.5" cy="11.5" r="1.2" fill="currentColor" /><circle cx="10.5" cy="7.5" r="1.2" fill="currentColor" /><circle cx="15.5" cy="8.5" r="1.2" fill="currentColor" /></I>;
export const Bell = (p: P) => <I {...p}><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></I>;
export const Bug = (p: P) => <I {...p}><rect x="8" y="6" width="8" height="14" rx="4" /><path d="M9 3l1.5 2M15 3l-1.5 2M4 13h4M16 13h4M5 7l3 2M19 7l-3 2M5 19l3-2M19 19l-3-2" /></I>;
export const Clock = (p: P) => <I {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></I>;
export const GitBranch = (p: P) => <I {...p}><circle cx="6" cy="5" r="2.2" /><circle cx="6" cy="19" r="2.2" /><circle cx="18" cy="7" r="2.2" /><path d="M6 7.2v9.6M18 9.2c0 5-6 3.5-11 7.6" /></I>;
export const Wand = (p: P) => <I {...p}><path d="m15 4 1 2.5L18.5 7.5 16 8.5 15 11l-1-2.5L11.5 7.5 14 6.5zM4 20 14 10" /></I>;
export const Maximize = (p: P) => <I {...p}><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></I>;
export const Package = (p: P) => <I {...p}><path d="M21 8 12 3 3 8v8l9 5 9-5z" /><path d="m3 8 9 5 9-5M12 13v8" /></I>;
export const Play = (p: P) => <I {...p}><path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" /></I>;

// ───── Фирменный знак Jarvis Code: «Кольцо света» — кольцо и вспышка на краю ─────
// Та же геометрия, что в scripts/art/ring.mjs (иконка приложения, презентация, видео).
// Цвета — из темы и акцента (--mk-*, ui/css/01-tokens.css).

const n2 = (v: number) => (Math.abs(v) < 1e-9 ? 0 : v).toFixed(2);
const RAD = Math.PI / 180;
/** Четырёхлучевая вспышка с вогнутыми сторонами. */
function star4(cx: number, cy: number, up: number, right: number, down: number, left: number, k: number, rot: number): string {
  const pts = [[0, -up], [right, 0], [0, down], [-left, 0]];
  const c = Math.cos(rot * RAD), sn = Math.sin(rot * RAD);
  const r = (x: number, y: number) => [cx + x * c - y * sn, cy + x * sn + y * c];
  let d = "";
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % 4];
    const [qx, qy] = r((ax + bx) * k, (ay + by) * k);
    const [sx, sy] = r(ax, ay), [ex, ey] = r(bx, by);
    d += (i ? "" : `M${n2(sx)} ${n2(sy)}`) + `Q${n2(qx)} ${n2(qy)} ${n2(ex)} ${n2(ey)}`;
  }
  return d + "Z";
}
/** big — от 28 px; small — для 13–24 px: толще кольцо, крупнее вспышка, шире зазор. */
export const RING = {
  big: { cx: 47, cy: 54, r: 30.5, w: 11.5, a: 42, flare: [23, 19, 20, 17, 0.15, -3], gap: 3.2 },
  small: { cx: 46.5, cy: 55, r: 29.5, w: 15, a: 42, flare: [27, 23, 23, 20, 0.2, -3], gap: 4.4 },
} as const;
function geom(kind: keyof typeof RING) {
  const g = RING[kind];
  const fx = g.cx + g.r * Math.sin(g.a * RAD), fy = g.cy - g.r * Math.cos(g.a * RAD);
  const ox = 2 * g.cx - fx, oy = 2 * g.cy - fy;
  const ro = g.r + g.w / 2, ri = g.r - g.w / 2;
  const [up, right, down, left, k, rot] = g.flare;
  return {
    ...g,
    fx: +n2(fx),
    fy: +n2(fy),
    // кольцо начинается у вспышки и идёт по часовой — для «прорисовки» при запуске и блика
    ring: `M${n2(fx)} ${n2(fy)}A${g.r} ${g.r} 0 1 1 ${n2(ox)} ${n2(oy)}A${g.r} ${g.r} 0 1 1 ${n2(fx)} ${n2(fy)}`,
    annulus: `M${n2(g.cx - ro)} ${n2(g.cy)}a${ro} ${ro} 0 1 0 ${n2(2 * ro)} 0a${ro} ${ro} 0 1 0 ${n2(-2 * ro)} 0ZM${n2(g.cx - ri)} ${n2(g.cy)}a${ri} ${ri} 0 1 1 ${n2(2 * ri)} 0a${ri} ${ri} 0 1 1 ${n2(-2 * ri)} 0Z`,
    flareD: star4(fx, fy, up, right, down, left, k, rot),
  };
}
const MARK = { big: geom("big"), small: geom("small") };
const stop = (offset: string, color: string, opacity?: string) => (
  <stop offset={offset} style={{ stopColor: `var(${color})`, ...(opacity ? { stopOpacity: `var(${opacity})` } : {}) }} />
);

/**
 * Знак Jarvis Code — «Кольцо света».
 * spin — «работает»: по кольцу бежит блик и, дойдя до вспышки, зажигает её.
 * intro — запуск: свет обегает кольцо от вспышки, кольцо замыкается, вспышка загорается.
 * До 24 px — упрощённый вариант (толще кольцо, крупнее вспышка), чтобы читался в маленьком размере.
 */
export function Spark({ size = 32, spin = false, intro = false, className = "" }: { size?: number; spin?: boolean; intro?: boolean; className?: string }) {
  const kind = size <= 24 ? "small" : "big";
  const m = MARK[kind];
  const id = "mk" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const glow = kind === "big";
  const origin = { transformOrigin: `${m.fx}px ${m.fy}px` };
  const cls = ["spark", kind, spin && "spin", intro && "intro", className].filter(Boolean).join(" ");
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className={cls} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}r`} gradientUnits="userSpaceOnUse" x1="18" y1="86" x2="80" y2="22">
          {stop("0", "--mk-r0")}
          {stop(".5", "--mk-r1")}
          {stop("1", "--mk-r2")}
        </linearGradient>
        <radialGradient id={`${id}f`} gradientUnits="userSpaceOnUse" cx={m.fx} cy={m.fy} r={m.flare[0]}>
          {stop("0", "--mk-f0")}
          {stop(".35", "--mk-f1")}
          {stop("1", "--mk-f2")}
        </radialGradient>
        {glow && (
          <radialGradient id={`${id}g`} gradientUnits="userSpaceOnUse" cx={m.fx} cy={m.fy} r="34">
            {stop("0", "--mk-glow", "--mk-glow-a")}
            <stop offset="1" style={{ stopColor: "var(--mk-glow)", stopOpacity: 0 }} />
          </radialGradient>
        )}
        <mask id={`${id}m`} maskUnits="userSpaceOnUse" x="-20" y="-20" width="140" height="140">
          <rect x="-20" y="-20" width="140" height="140" fill="#fff" />
          <path d={m.flareD} fill="#000" stroke="#000" strokeWidth={m.gap * 2} strokeLinejoin="round" />
        </mask>
        <clipPath id={`${id}c`}>
          <path d={m.annulus} clipRule="evenodd" />
        </clipPath>
        <filter id={`${id}b`} filterUnits="userSpaceOnUse" x="-20" y="-20" width="140" height="140">
          <feGaussianBlur stdDeviation={kind === "small" ? 1.8 : 2.6} />
        </filter>
      </defs>
      {glow && <circle className="mk-glow" style={origin} cx={m.fx} cy={m.fy} r="34" fill={`url(#${id}g)`} />}
      <g mask={`url(#${id}m)`}>
        <path className="mk-ring" d={m.ring} pathLength={100} fill="none" stroke={`url(#${id}r)`} strokeWidth={m.w} />
        <g className="mk-glint-wrap" clipPath={`url(#${id}c)`}>
          <path className="mk-glint" d={m.ring} pathLength={100} fill="none" strokeWidth={m.w + 6} strokeDasharray="7 93" filter={`url(#${id}b)`} />
        </g>
      </g>
      <g className="mk-flare" style={origin}>
        <path d={m.flareD} fill={`url(#${id}f)`} />
      </g>
    </svg>
  );
}

/** Логотип с надписью. */
export function Brand({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`brand ${className}`}>
      <Spark size={size} />
      <span className="wordmark">
        Jarvis <span>Code</span>
      </span>
    </span>
  );
}
