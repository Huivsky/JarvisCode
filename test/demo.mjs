// Демо-ролик интерфейса (анимации): node test/demo.mjs /tmp/preview.json out.mp4
// Кадры — через CDP screencast (с реальными задержками), склейка — ffmpeg.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const [, , cfgPath, outFile = "demo.mp4"] = process.argv;
const P = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const W = 1280, H = 800;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jc-demo-"));
const browser = await chromium.launch({ executablePath: "/usr/local/bin/chromium", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: "dark" });
const p = await ctx.newPage();
const cdp = await ctx.newCDPSession(p);
const frames = [];
cdp.on("Page.screencastFrame", async (f) => {
  const file = path.join(dir, `f${String(frames.length).padStart(5, "0")}.jpg`);
  fs.writeFileSync(file, Buffer.from(f.data, "base64"));
  frames.push({ file, t: f.metadata.timestamp });
  await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
});
const wait = (ms) => p.waitForTimeout(ms);
p.setDefaultTimeout(3000);

// пустая страница-заставка, затем запуск приложения (видно раскрытие знака)
await p.setContent(`<body style="margin:0;background:#1d1c1a"></body>`);
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
await wait(400);
await p.goto(P.app);
await wait(2200);
// быстрые темы
await p.click(".chip >> nth=0");
await wait(1400);
await p.click(".suggest-item >> nth=1");
await wait(500);
// своё сообщение
await p.click(".composer textarea");
await p.keyboard.press("Control+a");
await p.keyboard.press("Delete");
await p.keyboard.type("Проверь, сколько места на дисках и что занимает больше всего", { delay: 38 });
await wait(500);
await p.keyboard.press("Enter");
await wait(6500);
// открытый шаг
await p.click(".tool-head >> nth=0").catch(() => {});
await wait(1200);
// меню режима
await p.click(".mode-btn").catch(() => {});
await wait(1300);
await p.keyboard.press("Escape");
await wait(400);
// Ctrl+V: картинка и файл прямо в поле ввода
await p.click(".composer textarea");
await p.evaluate(async () => {
  const c = document.createElement("canvas");
  c.width = 320; c.height = 200;
  const g = c.getContext("2d");
  const gr = g.createLinearGradient(0, 0, 320, 200);
  gr.addColorStop(0, "#d97757"); gr.addColorStop(1, "#3b3a36");
  g.fillStyle = gr; g.fillRect(0, 0, 320, 200);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  const paste = (files) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  };
  paste([new File([blob], "screenshot.png", { type: "image/png" })]);
  await new Promise((r) => setTimeout(r, 450));
  paste([new File(["# notes\n"], "Отчёт за квартал.pdf", { type: "application/pdf" })]);
});
await wait(1700);
// команды через «/»
await p.keyboard.type("/");
await wait(1500);
await p.keyboard.press("Escape");
await p.keyboard.press("Backspace");
await wait(300);
// ожидание разрешения
await p.click(`.sb-chat-title:has-text("Почисти")`).catch(() => {});
await wait(2200);
// настройки и смена темы
await p.keyboard.press("Control+,");
await wait(1000);
await p.click(`.settings-tab:has-text("Оформление")`).catch(() => {});
await wait(800);
await p.click(`.seg button:has-text("Светлая")`).catch(() => {});
await wait(1500);
await p.click(`.settings-tab:has-text("О программе")`).catch(() => {});
await wait(1300);
await p.click(`.settings-tab:has-text("Оформление")`).catch(() => {});
await wait(400);
await p.click(`.seg button:has-text("Тёмная")`).catch(() => {});
await wait(900);
await p.keyboard.press("Escape");
await wait(1000);
// панель
await p.keyboard.press("Control+b");
await wait(900);
await p.keyboard.press("Control+b");
await wait(1200);
await cdp.send("Page.stopScreencast");
await wait(200);
await browser.close();

// склейка с настоящими длительностями кадров → 30 fps
const list = [];
for (let i = 0; i < frames.length; i++) {
  const d = i + 1 < frames.length ? Math.max(0.001, frames[i + 1].t - frames[i].t) : 0.5;
  list.push(`file '${frames[i].file}'`, `duration ${d.toFixed(4)}`);
}
list.push(`file '${frames.at(-1).file}'`);
const listFile = path.join(dir, "list.txt");
fs.writeFileSync(listFile, list.join("\n"));
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-movflags", "+faststart", outFile]);
console.log(`frames: ${frames.length}, ${outFile}`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
