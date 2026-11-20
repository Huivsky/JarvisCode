// Видео-превью анимации «Кольца света» (покадрово, детерминированно): node scripts/art/ring-motion.mjs outDir
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { ringAnimated, RING_CSS } from "./ring.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const out = path.resolve(process.argv[2] || "logo-ref");
const framesDir = path.join(out, ".frames");
fs.rmSync(framesDir, { recursive: true, force: true });
fs.mkdirSync(framesDir, { recursive: true });
const fonts = fs.readFileSync(path.join(ROOT, "ui/css/00-fonts.css"), "utf8").replaceAll("url(/fonts/", `url(file://${path.join(ROOT, "assets/fonts")}/`);
const FPS = 30, DUR = Number(process.env.DUR || 8.6), THINK = 2.9;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${fonts}
html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; }
body { font-family: Inter, sans-serif; color: #eeede8; background: radial-gradient(900px 640px at 30% 50%, #261f1b, #141211 72%); }
.mark { position: absolute; left: 150px; top: 130px; width: 460px; height: 460px; }
svg { overflow: visible; display: block; }
.mark svg { width: 100%; height: 100%; }
.txt { position: absolute; left: 700px; top: 0; bottom: 0; width: 520px; display: flex; flex-direction: column; justify-content: center; }
.wm { font-family: "Source Serif 4"; font-size: 66px; font-weight: 600; letter-spacing: -0.02em; animation: rise .9s cubic-bezier(.2,.8,.2,1) 1.25s both; }
.wm span { font-weight: 400; color: #bdb5ac; }
.phases { position: relative; height: 130px; margin-top: 26px; }
.ph { position: absolute; left: 0; top: 0; }
.p1 { animation: rise .7s ease 1.45s both, gone .45s ease ${THINK - 0.5}s forwards; }
.p2 { animation: rise .7s ease ${THINK}s both; }
.label { font-size: 14px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: #f29a6c; }
.desc { font-size: 21px; color: #c6bfb7; margin-top: 12px; line-height: 1.45; }
.chip { display: inline-flex; align-items: center; gap: 10px; padding: 9px 16px 9px 11px; border-radius: 12px; background: #231f1c; border: 1px solid rgba(255,255,255,.07); font-size: 19px; color: #f4a47a; }
.chip svg { width: 24px; height: 24px; }
.chip .t { color: #9e968e; }
@keyframes rise { from { opacity: 0; transform: translateY(14px) } to { opacity: 1; transform: none } }
@keyframes gone { to { opacity: 0; transform: translateY(-8px) } }
${RING_CSS}
</style></head><body>
<div class="mark"><svg viewBox="0 0 100 100" class="intro spin" style="--intro-end:${THINK}s">${ringAnimated({ id: "big" })}</svg></div>
<div class="txt">
  <div class="wm">Jarvis <span>Code</span></div>
  <div class="phases">
    <div class="ph p1"><div class="label">Запуск</div><div class="desc">Свет обегает кольцо и зажигает<br>вспышку на краю.</div></div>
    <div class="ph p2"><div class="chip"><svg viewBox="0 0 100 100" class="spin">${ringAnimated({ id: "mini", small: true, glow: false })}</svg>Думает…<span class="t">· 1 с</span></div><div class="desc">По кольцу бежит блик и, дойдя до<br>вспышки, снова её зажигает.</div></div>
  </div>
</div>
<script>window.setT = (ms) => { document.querySelector(".t").textContent = "· " + Math.max(1, Math.floor(ms / 1000 - ${THINK}) + 1) + " с"; };</script>
</body></html>`;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM || "/usr/local/bin/chromium", args: ["--no-sandbox"] });
const p = await (await b.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })).newPage();
await p.setContent(html, { waitUntil: "load" });
await p.evaluate(() => document.fonts.ready);
const count = await p.evaluate(() => { const a = document.getAnimations(); a.forEach((x) => x.pause()); return a.length; });
console.log("animations", count);
const N = Math.round(DUR * FPS);
for (let i = 0; i < N; i++) {
  const ms = (i * 1000) / FPS;
  await p.evaluate((ms) => { for (const a of document.getAnimations()) a.currentTime = ms; window.setT(ms); }, ms);
  await p.screenshot({ path: path.join(framesDir, `f${String(i).padStart(4, "0")}.png`) });
}
await b.close();
if (!process.env.NO_VIDEO) {
  const mp4 = path.join(out, "JarvisCode-ring-motion.mp4");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(framesDir, "f%04d.png"), "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4]);
  console.log("ok", mp4, N, "frames");
}
process.exit(0);
