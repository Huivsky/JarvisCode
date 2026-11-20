// Логотип Jarvis Code — «Кольцо света» (геометрия = scripts/art/ring.mjs = ui/icons.tsx).
// node scripts/art/logo.mjs — пишет icon.svg и preview.html в текущую папку.
import fs from "node:fs";
import { ringMark } from "./ring.mjs";

/** Иконка приложения: тёмная плитка, кольцо света с вспышкой. small — для 16–24 px. bg:false — только знак. */
export function icon({ small = false, bg = true, size = 256 } = {}) {
  const svg = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}">${inner}</svg>`;
  if (!bg) return svg(ringMark({ id: "m", small }));
  const rx = small ? 20 : 23, inset = small ? 8 : 12, sc = small ? 0.84 : 0.76;
  return svg(
    `<defs><radialGradient id="bg" cx="50%" cy="38%" r="75%"><stop offset="0" stop-color="#2d2723"/><stop offset="1" stop-color="#131110"/></radialGradient></defs>` +
      `<rect width="100" height="100" rx="${rx}" fill="url(#bg)"/>` +
      `<rect x=".6" y=".6" width="98.8" height="98.8" rx="${rx - 0.6}" fill="none" stroke="#fff" stroke-opacity=".09" stroke-width="1.2"/>` +
      `<g transform="translate(${inset} ${inset}) scale(${sc})">${ringMark({ id: "m", small, glow: !small })}</g>`,
  );
}

if (process.argv[1]?.endsWith("logo.mjs")) {
  fs.writeFileSync("icon.svg", icon());
  fs.writeFileSync(
    "preview.html",
    `<body style="margin:0;background:#1d1c1a;display:flex;gap:24px;padding:24px;align-items:center;flex-wrap:wrap">${[256, 128, 64].map((s) => icon({ size: s })).join("")}${[24, 16].map((s) => icon({ small: true, size: s })).join("")}${icon({ bg: false, size: 96 })}</body>`,
  );
}
