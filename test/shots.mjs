// Скриншоты интерфейса: node test/shots.mjs /tmp/preview.json /data/NotionCode/shots
import fs from "node:fs";
import { chromium } from "playwright-core";

const [, , cfgPath, outDir] = process.argv;
const P = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const browser = await chromium.launch({ executablePath: "/usr/local/bin/chromium", args: ["--no-sandbox"] });
const only = process.env.ONLY?.split(",");
const want = (n) => !only || only.includes(n);

async function page(url, w = 1280, h = 800, scheme = "dark") {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  p.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
  p.on("pageerror", (e) => console.log("pageerror:", e.message));
  await p.goto(url);
  // знак на главном и при входе «прорисовывается» ~1.8 с — ждём, пока анимация запуска закончится
  await p.waitForTimeout(Number(process.env.SHOT_WAIT || 2000));
  return p;
}
const shot = (p, name) => p.screenshot({ path: `${outDir}/${name}.png` });

try {
  if (want("home")) {
    const p = await page(P.app);
    await shot(p, "01-home");
    await p.click(".chip >> nth=0");
    await p.waitForTimeout(200);
    await shot(p, "02-home-suggest");
    await p.close();
  }
  if (want("chat")) {
    const p = await page(P.app);
    await p.click(`.sb-chat-title:has-text("Проверь")`);
    await p.waitForTimeout(700);
    await shot(p, "03-chat");
    await p.click(".tool-head >> nth=0");
    await p.waitForTimeout(200);
    await shot(p, "04-chat-tool-open");
    await p.close();
  }
  if (want("pending")) {
    const p = await page(P.app);
    await p.click(`.sb-chat-title:has-text("Почисти")`);
    await p.waitForTimeout(700);
    await shot(p, "05-approval");
    await p.click(".mode-btn");
    await p.waitForTimeout(200);
    await shot(p, "06-mode-menu");
    await p.close();
  }
  if (want("settings")) {
    const p = await page(P.app);
    await p.click(".sb-user");
    await p.waitForTimeout(250);
    await shot(p, "07a-user-menu");
    await p.click(`.menu-item:has-text("Настройки")`);
    await p.waitForTimeout(300);
    await shot(p, "07-settings-general");
    await p.click(`.settings-tab:has-text("Хранилище")`);
    await p.waitForTimeout(600);
    await shot(p, "08-settings-storage");
    await p.click(`.settings-tab:has-text("Мост")`);
    await p.waitForTimeout(300);
    await shot(p, "07b-settings-bridge");
    await p.click(`.settings-tab:has-text("Доступ")`);
    await p.waitForTimeout(300);
    await shot(p, "09-settings-pc");
    await p.keyboard.press("Escape");
    await p.keyboard.press("Control+k");
    await p.waitForTimeout(300);
    await shot(p, "10-search");
    await p.keyboard.press("Escape");
    await p.click(`.sb-item:has-text("Папки")`);
    await p.waitForTimeout(300);
    await shot(p, "11-folders");
    await p.close();
  }
  if (want("storage")) {
    const p = await page(P.app);
    await p.click(".sb-user");
    await p.waitForTimeout(250);
    await p.click(`.menu-item:has-text("Хранилище")`);
    await p.waitForTimeout(600);
    await p.click(`.btn:has-text("Изменить папку")`);
    await p.waitForTimeout(500);
    await shot(p, "12-storage-pick");
    await p.click(`.browser-path .icon-btn`).catch((e) => console.log("no up", e.message));
    await p.waitForTimeout(300);
    await p.click(`.btn:has-text("Выбрать эту папку")`);
    await p.waitForTimeout(500);
    await shot(p, "12b-storage-confirm");
    await p.close();
  }
  if (want("import")) {
    const p = await page(P.app);
    await p.click(`.sb-item:has-text("Перенести чат")`);
    await p.waitForTimeout(300);
    await shot(p, "13-import-notion");
    await p.click(`.import-tabs button:has-text("текста")`);
    await p.waitForTimeout(200);
    await p.fill(".import-text textarea", "Вы: Как ускорить сборку проекта?\n\nNotion AI: Включите кэш bun и уберите лишние зависимости.\n\nВы: А тесты?\n\nNotion AI: Запускайте их параллельно.");
    await p.waitForTimeout(400);
    await shot(p, "13b-import-text");
    await p.keyboard.press("Escape");
    await p.click(`.sb-chat-title:has-text("План запуска")`);
    await p.waitForTimeout(800);
    await shot(p, "13c-imported-chat");
    await p.click(".imported-head");
    await p.waitForTimeout(300);
    await shot(p, "13d-imported-open");
    await p.close();
  }
  if (want("bridge")) {
    const p = await page(P.app, 1280, 900);
    await p.click(".sb-bridge");
    await p.waitForTimeout(800);
    await p.evaluate(() => document.querySelector(".bridge-view").scrollTo(0, 0));
    await p.waitForTimeout(150);
    await shot(p, "17-bridge");
    await p.click(".bridge-section-head");
    await p.waitForTimeout(200);
    await p.evaluate(() => document.querySelector(".bridge-view").scrollTo(0, 99999));
    await p.waitForTimeout(200);
    await shot(p, "18-bridge-bottom");
    // вызов «из Notion» через туннель → мост подключён
    await fetch(P.mcp, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.5", "user-agent": "Notion" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }) });
    await p.waitForTimeout(400);
    await p.evaluate(() => document.querySelector(".bridge-view").scrollTo(0, 0));
    await p.click(".bridge-section-head");
    await p.waitForTimeout(200);
    await shot(p, "17b-bridge-connected");
    await p.close();
  }
  if (want("effort")) {
    const p = await page(P.app);
    await p.click(`.sb-chat-title:has-text("Ревью")`);
    await p.waitForTimeout(700);
    await shot(p, "19-error-retry");
    await p.click(".effort-btn");
    await p.waitForTimeout(200);
    await shot(p, "20-effort-menu");
    await p.keyboard.press("Escape");
    await p.click(`.sb-chat-title:has-text("Вынеси")`);
    await p.waitForTimeout(700);
    await p.click(".effort-btn");
    await p.waitForTimeout(200);
    await shot(p, "20b-effort-deep");
    await p.close();
  }
  if (want("fresh")) {
    const p = await page(P.fresh, 1180, 780);
    await shot(p, "21-first-run");
    await p.close();
  }
  if (want("installer")) {
    const p = await page(P.installer, 980, 700);
    await shot(p, "14-installer");
    await p.click("button.btn.primary");
    await p.waitForTimeout(2500);
    await shot(p, "15-installer-done");
    await p.close();
  }
  if (want("extra")) {
    const p = await page(P.app);
    // вставка картинки, файла и длинного текста (Ctrl+V)
    await p.evaluate(async () => {
      const c = document.createElement("canvas");
      c.width = 320;
      c.height = 200;
      const g = c.getContext("2d");
      const gr = g.createLinearGradient(0, 0, 320, 200);
      gr.addColorStop(0, "#d97757");
      gr.addColorStop(1, "#3b3a36");
      g.fillStyle = gr;
      g.fillRect(0, 0, 320, 200);
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      const paste = (files, text) => {
        const dt = new DataTransfer();
        for (const f of files) dt.items.add(f);
        if (text) dt.setData("text/plain", text);
        document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      };
      paste([new File([blob], "image.png", { type: "image/png" })]);
      paste([new File(["# notes\n"], "Отчёт за квартал.pdf", { type: "application/pdf" })]);
      paste([], Array.from({ length: 80 }, (_, i) => `строка ${i + 1}: const value = compute(${i});`).join("\n"));
    });
    await p.waitForTimeout(900);
    await shot(p, "29-attachments");
    await p.click(".composer textarea");
    await p.keyboard.press("Control+a");
    await p.keyboard.press("Delete");
    await p.keyboard.type("/");
    await p.waitForTimeout(300);
    await shot(p, "30-slash");
    await p.keyboard.type("d");
    await p.waitForTimeout(250);
    await shot(p, "30b-slash-custom");
    await p.keyboard.press("Escape");
    await p.click(".sb-user");
    await p.waitForTimeout(250);
    await p.click(`.menu-item:has-text("Настройки")`);
    await p.waitForTimeout(300);
    for (const [tab, name] of [
      ["Безопасность", "31-settings-security"],
      ["Оформление", "32-settings-look"],
      ["О программе", "33-settings-about"],
    ]) {
      await p.click(`.settings-tab:has-text("${tab}")`);
      await p.waitForTimeout(300);
      await shot(p, name);
    }
    await p.close();
    const q = await page(P.app, 1280, 800, "light");
    await q.evaluate(() => (document.documentElement.dataset.theme = "light"));
    await q.waitForTimeout(200);
    await shot(q, "34-light-home");
    await q.close();
    const n = await page(P.app, 900, 760);
    await n.click(`.sb-chat-title:has-text("Проверь")`).catch(() => {});
    await n.waitForTimeout(600);
    await shot(n, "35-narrow");
    await n.close();
  }
  if (want("light")) {
    const p = await page(P.app);
    await p.evaluate(() => (document.documentElement.dataset.theme = "light"));
    await p.click(`.sb-chat-title:has-text("Проверь")`);
    await p.waitForTimeout(700);
    await p.evaluate(() => (document.documentElement.dataset.theme = "light"));
    await shot(p, "16-light");
    await p.close();
  }
  if (want("v31")) {
    const p = await page(P.app);
    await p.click(`.sb-chat-title:has-text("Что за ошибка")`);
    await p.waitForTimeout(800);
    await shot(p, "40-screenshot-tool");
    await p.click(".tool-shot").catch((e) => console.log("no .tool-shot", e.message));
    await p.waitForTimeout(500);
    await shot(p, "41-screenshot-lightbox");
    await p.keyboard.press("Escape");
    await p.waitForTimeout(200);
    await p.click(`.sb-chat-title:has-text("Вынеси")`);
    await p.waitForTimeout(900);
    await shot(p, "42-turn-changes");
    await p.click(".tc-head").catch((e) => console.log("no .tc-head", e.message));
    await p.waitForTimeout(300);
    await shot(p, "43-turn-changes-open");
    await p.click(".composer textarea");
    await p.keyboard.type("Добавь тест для @rea");
    await p.waitForTimeout(700);
    await shot(p, "44-mention");
    await p.keyboard.press("Escape");
    await p.click(`.sb-chat-title:has-text("Почисти")`);
    await p.waitForTimeout(800);
    await p.click(".composer textarea");
    await p.keyboard.type("И ещё очисти кэш браузера");
    await p.keyboard.press("Enter");
    await p.waitForTimeout(700);
    await shot(p, "45-queue");
    await p.close();
  }
} finally {
  await browser.close();
}
process.exit(0);
