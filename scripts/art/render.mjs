// Рендер логотипа и обложки: node scripts/art/render.mjs [outDir]
// Иконки → assets/ (icon.ico, icon-128.png, icon-256.png), обложка и крупный логотип → outDir.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { icon } from "./logo.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const out = path.resolve(process.argv[2] || path.join(ROOT, "dist", "art"));
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jc-art-"));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/usr/local/bin/chromium", args: ["--no-sandbox"] });

async function svgPng(svg, size, file) {
  const ctx = await browser.newContext({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  await p.setContent(`<html><body style="margin:0;background:transparent">${svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)}</body></html>`);
  await p.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  await ctx.close();
}

const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const pngs = [];
for (const s of sizes) {
  const f = path.join(tmp, `icon-${s}.png`);
  await svgPng(icon({ small: s <= 24 }), s, f);
  pngs.push(f);
}
// ICO: маленькие размеры — BMP (для значка в трее), 256 — PNG (меньше файл)
const icoTmp = path.join(tmp, "icon.ico");
execFileSync("magick", [...pngs, icoTmp]);
{
  const d = fs.readFileSync(icoTmp);
  const n = d.readUInt16LE(4);
  const imgs = [];
  for (let i = 0; i < n; i++) {
    const e = 6 + 16 * i;
    const w = d[e] || 256;
    const size = d.readUInt32LE(e + 8), off = d.readUInt32LE(e + 12);
    imgs.push({ e: d.subarray(e, e + 16), data: w === 256 ? fs.readFileSync(path.join(tmp, "icon-256.png")) : d.subarray(off, off + size) });
  }
  const head = Buffer.alloc(6 + 16 * n);
  d.copy(head, 0, 0, 6);
  let off = head.length;
  imgs.forEach((im, i) => {
    im.e.copy(head, 6 + 16 * i);
    head.writeUInt32LE(im.data.length, 6 + 16 * i + 8);
    head.writeUInt32LE(off, 6 + 16 * i + 12);
    off += im.data.length;
  });
  fs.writeFileSync(path.join(ROOT, "assets", "icon.ico"), Buffer.concat([head, ...imgs.map((x) => x.data)]));
}
fs.copyFileSync(path.join(tmp, "icon-128.png"), path.join(ROOT, "assets", "icon-128.png"));
fs.copyFileSync(path.join(tmp, "icon-256.png"), path.join(ROOT, "assets", "icon-256.png"));
await svgPng(icon(), 1024, path.join(out, "JarvisCode-logo-1024.png"));
fs.writeFileSync(path.join(out, "JarvisCode-logo.svg"), icon());

// обложка: COVER_SHOT=скриншот главного экрана (1280×800) для окна справа
const cover = path.join(import.meta.dirname, "cover.html");
if (fs.existsSync(cover)) {
  const shotFile = process.env.COVER_SHOT || path.join(ROOT, "shots", "03-chat.png");
  const shot = fs.existsSync(shotFile) ? "file://" + path.resolve(shotFile) : "";
  const html = fs
    .readFileSync(cover, "utf8")
    .replaceAll("__ASSETS__", "file://" + path.join(ROOT, "assets"))
    .replace("__LOGO__", icon({ bg: false }))
    .replace("__SMALLLOGO__", icon({ small: true, size: 18 }).replaceAll('id="', 'id="s-').replaceAll("url(#", "url(#s-"))
    .replace("__SHOT__", shot);
  const tmpHtml = path.join(tmp, "cover.html");
  fs.writeFileSync(tmpHtml, html);
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  await p.goto("file://" + tmpHtml);
  await p.waitForTimeout(700);
  await p.screenshot({ path: path.join(out, "JarvisCode-cover.png") });
  await ctx.close();
}
await browser.close();
console.log("ok", out);
process.exit(0);
