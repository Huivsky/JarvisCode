// Презентация знака «Кольцо света»: node scripts/art/ring-sheet.mjs shotsDir framesDir outDir
// shotsDir — скриншоты приложения (+ boxes.json), framesDir — кадры ring-motion.mjs.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { ringMark } from "./ring.mjs";
import { icon } from "./logo.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const [shots, frames, outArg] = process.argv.slice(2);
const out = path.resolve(outArg || "logo-ring");
fs.mkdirSync(out, { recursive: true });
const fonts = fs.readFileSync(path.join(ROOT, "ui/css/00-fonts.css"), "utf8").replaceAll("url(/fonts/", `url(file://${path.join(ROOT, "assets/fonts")}/`);
const tokens = fs.readFileSync(path.join(ROOT, "ui/css/01-tokens.css"), "utf8");
const markVars = tokens.slice(tokens.indexOf("/* ───── знак «Кольцо света»"), tokens.indexOf("/* ───── основа ───── */"));
let n = 0;
const uid = () => "u" + n++;

/** Плитки иконки: dark (основная), warm (яркая), light (светлая). */
function tile(kind, size) {
  const id = uid(), small = size <= 24, sm = size <= 32;
  const inset = sm ? 8 : 12, sc = sm ? 0.84 : 0.76;
  let bg, colors = "dark", mono = null, glow = false;
  if (kind === "dark") {
    bg = `<defs><radialGradient id="${id}-bg" cx="50%" cy="38%" r="75%"><stop offset="0" stop-color="#2d2723"/><stop offset="1" stop-color="#131110"/></radialGradient></defs><rect width="100" height="100" rx="23" fill="url(#${id}-bg)"/><rect x=".6" y=".6" width="98.8" height="98.8" rx="22.4" fill="none" stroke="#fff" stroke-opacity=".09" stroke-width="1.2"/>`;
    glow = !sm;
  } else if (kind === "warm") {
    bg = `<defs><linearGradient id="${id}-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffbb82"/><stop offset=".5" stop-color="#f0714f"/><stop offset="1" stop-color="#b6407c"/></linearGradient><radialGradient id="${id}-hl" cx="28%" cy="16%" r="70%"><stop offset="0" stop-color="#fff" stop-opacity=".25"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><rect width="100" height="100" rx="23" fill="url(#${id}-bg)"/><rect width="100" height="100" rx="23" fill="url(#${id}-hl)"/>`;
    mono = "#fff8f1";
  } else {
    bg = `<rect width="100" height="100" rx="23" fill="#fff8f1"/><rect x=".6" y=".6" width="98.8" height="98.8" rx="22.4" fill="none" stroke="#000" stroke-opacity=".07" stroke-width="1.2"/>`;
    colors = "light";
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}">${bg}<g transform="translate(${inset} ${inset}) scale(${sc})">${ringMark({ id: id + "m", small, glow, mono, colors })}</g></svg>`;
}
const mark = (size, opt = {}) => `<svg viewBox="0 0 100 100" width="${size}" height="${size}">${ringMark({ id: uid(), small: size <= 24, ...opt })}</svg>`;
const appIcon = (size) => icon({ small: size <= 24, size }).replaceAll('id="', `id="${uid()}-`).replace(/url\(#/g, () => "url(#").replace(/id="(u\d+)-(\w+)"/g, 'id="$1-$2"');
// у icon() фиксированные id — делаем их уникальными для каждой вставки
const iconSvg = (size) => {
  const p = uid();
  return icon({ small: size <= 24, size }).replace(/id="([^"]+)"/g, `id="${p}$1"`).replace(/url\(#([^)]+)\)/g, `url(#${p}$1)`);
};

const boxes = JSON.parse(fs.readFileSync(path.join(shots, "boxes.json"), "utf8"));
const img = (name) => `file://${path.join(shots, name + ".png")}`;
/** Кусок скриншота (координаты в CSS-пикселях исходного окна), увеличенный в scale раз. */
const crop = (name, [x, y, w, h], scale, vw = 1280, vh = 800) =>
  `<div class="crop" style="width:${w * scale}px;height:${h * scale}px;background-image:url(${img(name)});background-size:${vw * scale}px ${vh * scale}px;background-position:-${x * scale}px -${y * scale}px"></div>`;
const frame = (t) => {
  const i = Math.round(t * 30);
  const f = `file://${path.join(frames, `f${String(i).padStart(4, "0")}.png`)}`;
  const s = 0.36; // кадр 1280×720, знак в квадрате 130..630 × 110..610
  return `<div class="crop fr" style="width:${500 * s}px;height:${500 * s}px;background-image:url(${f});background-size:${1280 * s}px ${720 * s}px;background-position:-${130 * s}px -${110 * s}px"></div>`;
};
const bl = boxes["busy-dark"][".busy-line"];

const ACC = [["ember", "Янтарь"], ["arc", "Лазурь"], ["jade", "Нефрит"], ["violet", "Аметист"], ["graphite", "Графит"]];

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${fonts}
${markVars}
* { box-sizing: border-box; }
body { margin: 0; background: #1b1a18; color: #eeede8; font-family: Inter, sans-serif; width: 1944px; padding: 60px 64px 56px; }
h1 { font-family: "Source Serif 4"; font-weight: 500; font-size: 46px; letter-spacing: -0.015em; margin: 0 0 10px; }
h1 em { font-style: normal; color: #f39a6c; }
.sub { color: #a9a59c; font-size: 18px; margin: 0 0 40px; max-width: 1380px; line-height: 1.5; }
h2 { font-family: "Source Serif 4"; font-weight: 500; font-size: 28px; margin: 56px 0 18px; }
h2 small { font-family: Inter; font-size: 15px; color: #8f8b83; font-weight: 400; margin-left: 12px; }
.hero-row { display: flex; gap: 34px; align-items: flex-end; }
.fig { display: flex; flex-direction: column; gap: 14px; align-items: center; }
.fig svg { display: block; filter: drop-shadow(0 18px 40px rgba(0,0,0,.45)); }
.fig span { color: #a9a59c; font-size: 14.5px; }
.story { margin-left: 30px; align-self: center; display: grid; grid-template-columns: 1fr 1fr; gap: 20px 30px; max-width: 900px; }
.story div { font-size: 16px; line-height: 1.5; color: #d9d6ce; padding-left: 18px; border-left: 2px solid #3a3631; }
.story b { color: #fff; font-weight: 600; display: block; margin-bottom: 3px; }
.shots { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.shot { border-radius: 16px; overflow: hidden; border: 1px solid #34312c; background: #111; }
.shot img { display: block; width: 100%; }
.cap { color: #8f8b83; font-size: 14px; margin-top: 10px; }
.details { display: flex; gap: 18px; justify-content: space-between; margin-top: 22px; align-items: stretch; }
.det { background: #23211e; border: 1px solid #34312c; border-radius: 16px; padding: 16px; display: flex; flex-direction: column; gap: 10px; justify-content: space-between; }
.det .crop { border-radius: 10px; }
.crop { background-repeat: no-repeat; flex: none; }
.det span { color: #a9a59c; font-size: 13.5px; }
.row3 { display: grid; grid-template-columns: 1.25fr 1fr; gap: 24px; }
.box { background: #23211e; border: 1px solid #34312c; border-radius: 20px; padding: 24px 26px; }
.box h3 { font-family: "Source Serif 4"; font-weight: 500; font-size: 22px; margin: 0 0 16px; }
.box p { color: #bdb9b0; font-size: 14.5px; line-height: 1.5; margin: 14px 0 0; }
.taskbar { height: 52px; border-radius: 12px; display: flex; align-items: center; padding: 0 16px; gap: 10px; }
.taskbar.dk { background: #1f2023; border: 1px solid #2d2e33; } .taskbar.lt { background: #eef0f4; border: 1px solid #d9dce2; margin-top: 12px; }
.tb-ph { width: 30px; height: 30px; border-radius: 8px; } .dk .tb-ph { background: #34353b; } .lt .tb-ph { background: #d3d7de; }
.tb-on { position: relative; padding: 5px; border-radius: 8px; display: flex; } .dk .tb-on { background: #2e3036; } .lt .tb-on { background: #dfe3ea; }
.tb-on::after { content: ""; position: absolute; left: 50%; bottom: -4px; width: 16px; height: 3px; margin-left: -8px; border-radius: 2px; background: #f39a6c; }
.tb-gap { flex: 1; }
.tray { display: flex; align-items: center; gap: 12px; font-size: 13px; } .dk .tray { color: #d7d8dc; } .lt .tray { color: #2a2b2f; }
.tray svg, .tb-on svg { display: block; }
.desk { margin-top: 16px; height: 150px; border-radius: 12px; background: radial-gradient(600px 200px at 20% 0%, #3a2f4f, #1a1726 70%); display: flex; gap: 34px; align-items: flex-end; justify-content: space-around; padding: 0 30px 26px; }
.sc { display: flex; flex-direction: column; align-items: center; gap: 8px; color: #fff; font-size: 13px; text-shadow: 0 1px 3px rgba(0,0,0,.6); width: 90px; text-align: center; }
.sc svg { display: block; filter: drop-shadow(0 4px 10px rgba(0,0,0,.4)); }
.acc { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
.ac { border-radius: 14px; padding: 14px 10px 12px; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.ac.d { background: #1d1c1a; border: 1px solid #34312c; } .ac.l { background: #faf9f5; border: 1px solid #e3dfd5; }
.ac .ms { display: flex; align-items: center; gap: 10px; } .ac svg { display: block; }
.ac span { font-size: 13px; } .ac.d span { color: #bdb9b0; } .ac.l span { color: #55524b; }
.acc-grid { display: grid; grid-template-rows: auto auto; gap: 12px; }
.motion { display: flex; gap: 14px; align-items: flex-start; }
.mf { display: flex; flex-direction: column; gap: 8px; align-items: center; }
.mf .crop { border-radius: 14px; border: 1px solid #34312c; }
.mf span { color: #a9a59c; font-size: 13px; }
.msep { width: 1px; align-self: stretch; background: #3a3631; margin: 0 8px; }
.mh { color: #f39a6c; font-size: 13px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; margin: 0 0 10px; }
.foot { margin-top: 30px; color: #a9a59c; font-size: 15px; line-height: 1.6; }
.foot b { color: #eeede8; font-weight: 600; }
</style></head><body>
<h1>Jarvis Code — знак <em>«Кольцо света»</em></h1>
<p class="sub">Кольцо света со вспышкой на краю, как «бриллиантовое кольцо» во время солнечного затмения, когда появляется первый луч. Вспышка стоит на краю, а не в центре, поэтому знак асимметричный, и в нём есть движение.</p>
<div class="hero-row">
  <div class="fig">${tile("dark", 320)}<span>Основная — тёмная плитка</span></div>
  <div class="fig">${tile("warm", 230)}<span>Яркая</span></div>
  <div class="fig">${tile("light", 230)}<span>Светлая</span></div>
  <div class="story">
    <div><b>Кольцо — ваш компьютер</b>Файлы, программы и команды, с которыми работает агент. Контур замкнут: всё под вашим контролем.</div>
    <div><b>Вспышка — ИИ Notion</b>Агент «загорается» на краю вашего мира, подключается к ПК через мост и берётся за дело.</div>
    <div><b>Свет бежит по кольцу</b>Так знак показывает, что агент думает: блик обегает кольцо и снова зажигает вспышку.</div>
    <div><b>Тёплый закат</b>Фиолет → роза → янтарь. В приложении знак меняет цвет вместе с выбранным акцентом.</div>
  </div>
</div>

<h2>В приложении <small>настоящие экраны Jarvis Code 3.0 со знаком</small></h2>
<div class="shots">
  <div><div class="shot"><img src="${img("home-dark")}"></div><div class="cap">Тёмная тема: логотип в боковой панели, приветствие, «работает» у моста и в чатах</div></div>
  <div><div class="shot"><img src="${img("home-light")}"></div><div class="cap">Светлая тема: кольцо темнее и насыщеннее, вспышка янтарная</div></div>
</div>
<div class="details">
  <div class="det">${crop("home-dark", [8, 6, 142, 40], 2)}<span>Боковая панель, 22 px</span></div>
  <div class="det">${crop("home-dark", [535, 243, 470, 56], 0.95)}<span>Приветствие, 40 px — знак «прорисовывается» при открытии</span></div>
  <div class="det">${crop("busy-dark", [bl.x - 4, bl.y - 3, 290, bl.height + 6], 1.3)}<span>Агент работает — по кольцу бежит блик</span></div>
  <div class="det">${crop("home-light", [8, 286, 222, 98], 1.15)}<span>Чаты в работе, 13 px</span></div>
  <div class="det">${crop("installer-dark", [22, 30, 262, 168], 0.8, 1100, 700)}<span>Установщик, 88 px</span></div>
</div>

<div class="row3">
  <div><h2>Иконка в Windows</h2>
    <div class="box">
      <div class="taskbar dk"><div class="tb-ph"></div><div class="tb-ph"></div><div class="tb-on">${iconSvg(32)}</div><div class="tb-ph"></div><div class="tb-ph"></div><div class="tb-gap"></div><div class="tray">${iconSvg(16)}<span>ENG</span><span>21:47</span></div></div>
      <div class="taskbar lt"><div class="tb-ph"></div><div class="tb-ph"></div><div class="tb-on">${iconSvg(32)}</div><div class="tb-ph"></div><div class="tb-ph"></div><div class="tb-gap"></div><div class="tray">${iconSvg(16)}<span>ENG</span><span>21:47</span></div></div>
      <div class="desk"><div class="sc">${iconSvg(48)}<span>Jarvis Code</span></div><div class="sc">${iconSvg(64)}<span>Jarvis Code</span></div><div class="sc">${iconSvg(24)}<span>24 px</span></div><div class="sc">${iconSvg(20)}<span>20 px</span></div><div class="sc">${iconSvg(16)}<span>16 px</span></div></div>
      <p>Панель задач, трей и ярлык. В размерах до 24&nbsp;px знак упрощается: кольцо толще, вспышка крупнее, поэтому он читается и в 16&nbsp;px.</p>
    </div>
  </div>
  <div><h2>Под акцент интерфейса</h2>
    <div class="box">
      <div class="acc-grid">
        <div class="acc">${ACC.map(([k, name]) => `<div class="ac d" data-theme="dark" data-accent="${k}"><div class="ms">${mark(56, { colors: "css", glow: true })}${mark(20, { colors: "css" })}</div><span>${name}</span></div>`).join("")}</div>
        <div class="acc">${ACC.map(([k, name]) => `<div class="ac l" data-theme="light" data-accent="${k}"><div class="ms">${mark(56, { colors: "css", glow: true })}${mark(20, { colors: "css" })}</div><span>${name}</span></div>`).join("")}</div>
      </div>
      <p>В «Оформлении» пять акцентов, и знак меняет цвет вместе с ними. Янтарь — основной фирменный цвет, он же на иконке.</p>
    </div>
  </div>
</div>

<h2>Анимация <small>видео — в файле JarvisCode-ring-motion.mp4</small></h2>
<div class="box">
  <div class="motion">
    <div><div class="mh">Запуск</div><div class="motion">${[[0.47, "свет выходит из вспышки"], [0.6, "бежит по часовой"], [0.85, "кольцо почти замкнуто"], [1.08, "вспышка загорается"], [1.3, "вспышка вспыхивает"], [2.3, "покой"]].map(([t, c]) => `<div class="mf">${frame(t)}<span>${c}</span></div>`).join("")}</div></div>
    <div class="msep"></div>
    <div><div class="mh">Думает</div><div class="motion">${[[3.15, "блик стартует"], [3.6, "обегает кольцо"], [4.3, "возвращается к вспышке"]].map(([t, c]) => `<div class="mf">${frame(t)}<span>${c}</span></div>`).join("")}</div></div>
  </div>
</div>
<p class="foot"><b>Что меняется в приложении:</b> иконка (exe, ярлыки, трей), логотип в боковой панели, на входе, в установщике и в «О программе», а также индикатор «агент работает». Если в системе включено «уменьшение движения», анимация заменяется мягким миганием вспышки.</p>
</body></html>`;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM || "/usr/local/bin/chromium", args: ["--no-sandbox", "--allow-file-access-from-files"] });
const ctx = await b.newContext({ viewport: { width: 1944, height: 900 }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
const tmpHtml = path.join(out, ".ring-sheet.html");
fs.writeFileSync(tmpHtml, html);
await p.goto("file://" + tmpHtml, { waitUntil: "load" });
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(400);
await p.screenshot({ path: path.join(out, "JarvisCode-logo-ring.png"), fullPage: true });
for (const kind of ["dark", "warm", "light"]) {
  await p.setViewportSize({ width: 1024, height: 1024 });
  await p.setContent(`<body style="margin:0;background:transparent">${tile(kind, 1024)}</body>`);
  await p.screenshot({ path: path.join(out, `ring-${kind}-1024.png`), omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
}
fs.writeFileSync(path.join(out, "ring-mark.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="512" height="512">${ringMark({ id: "m" })}</svg>`);
fs.writeFileSync(path.join(out, "ring-icon-dark.svg"), icon({ size: 512 }));
fs.rmSync(tmpHtml);
await b.close();
console.log("ok", out);
process.exit(0);
